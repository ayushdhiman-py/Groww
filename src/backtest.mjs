// ─────────────────────────────────────────────────────────────────────────────
// backtest.mjs — Historical replay of the Entry Score + Trade Health engines
// against REAL Upstox historical candles (no synthetic data).
//
// NO-LOOK-AHEAD, structurally: at simulated time T, every buildSignal() call
// is fed candles.slice(0, i+1) where candles[i].ts <= T — never anything
// later. This reuses the exact scoring functions from entry_score.mjs and
// trade_health.mjs used by the live scanner; only the orchestration (walking
// through historical time for one symbol at a time, instead of across the
// whole universe once per ~30s tick) differs out of necessity.
//
// Run: node src/backtest.mjs --symbols=RELIANCE,TCS,INFY \
//        --devFrom=2026-06-01 --devTo=2026-07-15 \
//        --valFrom=2026-07-16 --valTo=2026-08-20
//
// Limitations, stated plainly:
//   - Sector-breadth context isn't meaningful for a small symbol subset, so
//     the sector-strength part of the score is a no-op here (same functions,
//     just no sector peers supplied) — real live scoring has full breadth.
//   - Every simulated trade force-closes at end of day (intraday-only, no
//     overnight carry), and there is exactly one entry attempt per symbol
//     per day (no re-entry same day) to keep the simulation from overfitting
//     to noise.
//   - Exit rule is a fixed, explicit systematic rule (see EXIT_RULE below) —
//     a deliberately simpler stand-in for a human reading notifications live.
// ─────────────────────────────────────────────────────────────────────────────
import { fetchCandles } from "./upstox.mjs";
import { buildSignal } from "./scanner.mjs";
import { atr } from "./indicators.mjs";
import { computeOpportunityScore, computeEntryAttractiveness, computeUpsidePotential } from "./entry_score.mjs";
import { computeTradeHealth, classifyDeteriorationPattern } from "./trade_health.mjs";
import { UNIVERSE } from "./universe.mjs";

const ENTRY_MIN_SCORE = 70; // WATCH+ on both 5m and 15m, same bar as live confluence gate
const EXIT_RULE = "Two consecutive evaluated bars both showing Trade Health < 60 (mirrors the live 'confirmed, not a single blip' notification rule).";

function istDateKey(ts) {
    return new Date(ts).toLocaleDateString("en-US", { timeZone: "Asia/Kolkata" });
}

function parseDate(s) { return new Date(`${s}T00:00:00.000Z`); }

/** Index of the last candle with ts <= targetTs, or -1. Candles must be chronological. */
function lastIndexAtOrBefore(candles, targetTs) {
    let lo = 0, hi = candles.length - 1, ans = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (candles[mid].ts <= targetTs) { ans = mid; lo = mid + 1; }
        else hi = mid - 1;
    }
    return ans;
}

function uniqueDayKeysInRange(candles, fromDate, toDate) {
    const keys = [];
    const seen = new Set();
    for (const c of candles) {
        if (c.ts < fromDate.getTime() || c.ts > toDate.getTime()) continue;
        const k = istDateKey(c.ts);
        if (!seen.has(k)) { seen.add(k); keys.push(k); }
    }
    return keys;
}

/**
 * Simulate one symbol across one date range using already-fetched candle
 * series (5m/15m/1d for the symbol and for NIFTY). Returns completed
 * hypothetical trades AND health-score calibration samples.
 */
function simulateSymbol(symbol, series, niftySeries, fromDate, toDate) {
    const { c5, c15, c1d } = series;
    const dayKeys = uniqueDayKeysInRange(c5, fromDate, toDate);
    const trades = [];
    // Calibration samples: { score, forwardReturnToEODPct }. Using the
    // REAL end-of-day close here is intentional and does NOT reintroduce
    // look-ahead into the trading simulation above — this is the standard
    // backtesting technique of using a known outcome to check whether a
    // score computed from only-past data was actually predictive.
    const healthSamples = [];

    for (const dayKey of dayKeys) {
        const dayBars5 = c5.filter(c => istDateKey(c.ts) === dayKey);
        if (dayBars5.length < 5) continue;
        const eodClose = dayBars5[dayBars5.length - 1].close;

        let openTrade = null;
        let enteredToday = false;

        for (const bar of dayBars5) {
            const t = bar.ts;
            const idx5 = lastIndexAtOrBefore(c5, t);
            const idx15 = lastIndexAtOrBefore(c15, t);
            const idx1d = lastIndexAtOrBefore(c1d, t - 86400000); // strictly PRIOR completed days only
            const niftyIdx5 = lastIndexAtOrBefore(niftySeries.c5, t);

            if (idx5 < 55 || idx15 < 55) continue; // not enough warmup yet (matches buildSignal's own >=55 guard)

            const slice5 = c5.slice(0, idx5 + 1);
            const slice15 = c15.slice(0, idx15 + 1);
            const price = slice5[slice5.length - 1].close;

            const row5 = buildSignal(slice5, "5m", symbol, price);
            const row15 = buildSignal(slice15, "15m", symbol, price);
            if (!row5 || !row15) continue;

            // Attach ATR the same way scanSymbol() does live, from strictly
            // prior completed daily candles only.
            if (idx1d >= 14) {
                const dailySlice = c1d.slice(0, idx1d + 1);
                const a = atr(dailySlice, 14);
                row5.atr = row15.atr = a;
                row5.atrPct = row15.atrPct = a != null ? +(a / price * 100).toFixed(2) : null;
            }

            let niftyRow5 = null;
            if (niftyIdx5 >= 55) {
                const niftySlice5 = niftySeries.c5.slice(0, niftyIdx5 + 1);
                niftyRow5 = buildSignal(niftySlice5, "5m", "NIFTY", niftySlice5[niftySlice5.length - 1].close);
            }
            const ctx = { niftyRow: niftyRow5, sectorStats: {} };

            if (!openTrade) {
                if (enteredToday) continue; // one entry attempt per symbol per day
                const opp5 = computeOpportunityScore(row5, ctx, "5m");
                const opp15 = computeOpportunityScore(row15, ctx, "15m");
                if (opp5.score < ENTRY_MIN_SCORE || opp15.score < ENTRY_MIN_SCORE) continue;

                const attract = computeEntryAttractiveness(row5);
                const upside = computeUpsidePotential(row5, ctx);
                enteredToday = true;
                openTrade = {
                    symbol, entryTime: new Date(t).toISOString(), entryPrice: price,
                    entryOpportunityScore: Math.round((opp5.score + opp15.score) / 2),
                    entryBand: opp5.score >= 90 && opp15.score >= 90 ? "VERY STRONG" : opp5.score >= 80 && opp15.score >= 80 ? "STRONG" : "WATCH",
                    entryAttractiveness: attract.score,
                    upsideZoneHighPct: upside.zoneHighPct,
                    peakPrice: price, troughPrice: price,
                    minuteHistory: [],
                };
                continue;
            }

            // Already holding — mark-to-market and evaluate Trade Health.
            if (price > openTrade.peakPrice) openTrade.peakPrice = price;
            if (price < openTrade.troughPrice) openTrade.troughPrice = price;

            const health = computeTradeHealth(openTrade, { row5m: row5, row15m: row15, niftyRow5m: niftyRow5, sectorStats5m: {}, livePrice: price });
            openTrade.minuteHistory.push({ minuteKey: String(t), health: health.score, price });

            const forwardReturnToEODPct = ((eodClose - price) / price) * 100;
            healthSamples.push({ score: health.score, forwardReturnToEODPct: +forwardReturnToEODPct.toFixed(2) });

            const lastTwo = openTrade.minuteHistory.slice(-2);
            const confirmedExit = lastTwo.length === 2 && lastTwo.every(m => m.health < 60);
            const isLastBarOfDay = bar === dayBars5[dayBars5.length - 1];

            if (confirmedExit || isLastBarOfDay) {
                trades.push(finalizeTrade(openTrade, price, confirmedExit ? health.state : "END_OF_DAY", t));
                openTrade = null;
            }
        }

        if (openTrade) {
            const lastBar = dayBars5[dayBars5.length - 1];
            trades.push(finalizeTrade(openTrade, lastBar.close, "END_OF_DAY", lastBar.ts));
        }
    }

    return { trades, healthSamples };
}

function finalizeTrade(openTrade, exitPrice, exitReason, exitTs) {
    const returnPct = ((exitPrice - openTrade.entryPrice) / openTrade.entryPrice) * 100;
    const mfePct = ((openTrade.peakPrice - openTrade.entryPrice) / openTrade.entryPrice) * 100;
    const maePct = ((openTrade.troughPrice - openTrade.entryPrice) / openTrade.entryPrice) * 100;
    const peakPct = mfePct;
    const givebackPct = peakPct > 0.3 ? ((openTrade.peakPrice - exitPrice) / (openTrade.peakPrice - openTrade.entryPrice)) * 100 : null;
    return {
        symbol: openTrade.symbol, entryTime: openTrade.entryTime, exitTime: new Date(exitTs).toISOString(),
        entryPrice: +openTrade.entryPrice.toFixed(2), exitPrice: +exitPrice.toFixed(2),
        entryOpportunityScore: openTrade.entryOpportunityScore, entryBand: openTrade.entryBand,
        entryAttractiveness: openTrade.entryAttractiveness, upsideZoneHighPct: openTrade.upsideZoneHighPct,
        returnPct: +returnPct.toFixed(2), mfePct: +mfePct.toFixed(2), maePct: +maePct.toFixed(2),
        peakPct: +peakPct.toFixed(2), givebackPct: givebackPct != null ? +givebackPct.toFixed(1) : null,
        exitReason,
    };
}

function computeMetrics(trades) {
    if (!trades.length) return { count: 0 };
    const returns = trades.map(t => t.returnPct);
    const wins = trades.filter(t => t.returnPct > 0);
    const losses = trades.filter(t => t.returnPct <= 0);
    const winRate = wins.length / trades.length;
    const grossProfit = wins.reduce((s, t) => s + t.returnPct, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.returnPct, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
    const avgReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
    const sorted = [...returns].sort((a, b) => a - b);
    const medianReturn = sorted[Math.floor(sorted.length / 2)];

    const strongEntries = trades.filter(t => t.entryBand === "VERY STRONG" || t.entryBand === "STRONG");
    const falsePositiveRate = strongEntries.length ? strongEntries.filter(t => t.returnPct <= 0).length / strongEntries.length : null;

    const avgMfe = trades.reduce((s, t) => s + t.mfePct, 0) / trades.length;
    const avgMae = trades.reduce((s, t) => s + t.maePct, 0) / trades.length;
    const givebacks = trades.map(t => t.givebackPct).filter(v => v != null);
    const avgGiveback = givebacks.length ? givebacks.reduce((s, v) => s + v, 0) / givebacks.length : null;

    let equity = 0, peak = 0, maxDD = 0;
    for (const r of returns) { equity += r; if (equity > peak) peak = equity; maxDD = Math.max(maxDD, peak - equity); }

    return {
        count: trades.length,
        winRatePct: +(winRate * 100).toFixed(1),
        precisionPct: +(winRate * 100).toFixed(1), // one signal = one hypothetical trade here, so precision == win rate
        expectancyPct: +avgReturn.toFixed(2),
        profitFactor: Number.isFinite(profitFactor) ? +profitFactor.toFixed(2) : "inf (no losing trades)",
        avgReturnPct: +avgReturn.toFixed(2),
        medianReturnPct: +medianReturn.toFixed(2),
        maxDrawdownPct: +maxDD.toFixed(2),
        falsePositiveRatePct: falsePositiveRate != null ? +(falsePositiveRate * 100).toFixed(1) : null,
        avgMfePct: +avgMfe.toFixed(2),
        avgMaePct: +avgMae.toFixed(2),
        avgProfitGivebackPct: avgGiveback != null ? +avgGiveback.toFixed(1) : null,
    };
}

function metricsByBand(trades) {
    const bands = ["VERY STRONG", "STRONG", "WATCH"];
    const out = {};
    for (const band of bands) out[band] = computeMetrics(trades.filter(t => t.entryBand === band));
    return out;
}

// Trade Health state bands per spec: 90-100 STRONG HOLD .. <50 THESIS
// INVALIDATED. This measures whether a LOWER band, while a position is
// still open, actually predicted a WORSE subsequent return to end-of-day —
// i.e. whether the thresholds are placed somewhere real, not just plausible.
const HEALTH_BANDS = [
    { label: "90-100 (STRONG HOLD)", min: 90, max: 100 },
    { label: "80-89 (HOLD)", min: 80, max: 89 },
    { label: "70-79 (MOMENTUM WEAKENING)", min: 70, max: 79 },
    { label: "60-69 (PROFIT PROTECTION)", min: 60, max: 69 },
    { label: "50-59 (STRONG EXIT WARNING)", min: 50, max: 59 },
    { label: "<50 (THESIS INVALIDATED)", min: -Infinity, max: 49 },
];

function computeHealthCalibration(samples) {
    return HEALTH_BANDS.map(b => {
        const inBand = samples.filter(s => s.score >= b.min && s.score <= b.max);
        if (!inBand.length) return { band: b.label, count: 0, avgForwardReturnToEODPct: null, medianForwardReturnToEODPct: null };
        const returns = inBand.map(s => s.forwardReturnToEODPct);
        const avg = returns.reduce((s, r) => s + r, 0) / returns.length;
        const sorted = [...returns].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        return {
            band: b.label, count: inBand.length,
            avgForwardReturnToEODPct: +avg.toFixed(2),
            medianForwardReturnToEODPct: +median.toFixed(2),
        };
    });
}

/** Is avgForwardReturnToEODPct monotonically non-increasing as bands go from 90-100 down to <50? */
function isCalibrationMonotonic(calibration) {
    const withData = calibration.filter(c => c.count > 0);
    for (let i = 1; i < withData.length; i++) {
        if (withData[i].avgForwardReturnToEODPct > withData[i - 1].avgForwardReturnToEODPct) return false;
    }
    return withData.length >= 2;
}

/**
 * @param {object} opts — { symbols, devFrom, devTo, valFrom, valTo }
 * Dates are "YYYY-MM-DD" strings. Fetches each symbol's 5m/15m/1d candles
 * ONCE (covering the widest needed window + warmup buffer) and reuses that
 * same data for both the dev and validation replay — zero extra API calls
 * per period.
 */
export async function runBacktest(opts) {
    const { symbols, devFrom, devTo, valFrom, valTo } = opts;
    const earliest = [devFrom, valFrom].filter(Boolean).sort()[0];
    const latest = [devTo, valTo].filter(Boolean).sort().slice(-1)[0];

    const fetchFrom5m15m = new Date(parseDate(earliest).getTime() - 15 * 86400000); // warmup buffer
    const fetchFrom1d = new Date(parseDate(earliest).getTime() - 90 * 86400000);
    const fetchTo = parseDate(latest);
    fetchTo.setUTCDate(fetchTo.getUTCDate() + 1);

    console.log(`[Backtest] Fetching NIFTY reference candles (${earliest} .. ${latest})...`);
    const niftySeries = {
        c5: await fetchCandles("NIFTY", "5m", { from: fetchFrom5m15m, to: fetchTo }),
    };

    const devResults = {}, valResults = {};
    for (const symbol of symbols) {
        console.log(`[Backtest] Fetching ${symbol}...`);
        let c5, c15, c1d;
        try {
            [c5, c15, c1d] = await Promise.all([
                fetchCandles(symbol, "5m", { from: fetchFrom5m15m, to: fetchTo }),
                fetchCandles(symbol, "15m", { from: fetchFrom5m15m, to: fetchTo }),
                fetchCandles(symbol, "1d", { from: fetchFrom1d, to: fetchTo }),
            ]);
        } catch (e) {
            console.error(`[Backtest] ${symbol}: fetch failed — ${e.message}. Skipping.`);
            continue;
        }
        if (c5.length < 60 || c15.length < 60) {
            console.warn(`[Backtest] ${symbol}: not enough candle history in this window. Skipping.`);
            continue;
        }
        const series = { c5, c15, c1d };

        if (devFrom && devTo) {
            devResults[symbol] = simulateSymbol(symbol, series, niftySeries, parseDate(devFrom), parseDate(devTo));
        }
        if (valFrom && valTo) {
            valResults[symbol] = simulateSymbol(symbol, series, niftySeries, parseDate(valFrom), parseDate(valTo));
        }
    }

    const allDevTrades = Object.values(devResults).flatMap(r => r.trades);
    const allValTrades = Object.values(valResults).flatMap(r => r.trades);
    const allDevHealthSamples = Object.values(devResults).flatMap(r => r.healthSamples);
    const allValHealthSamples = Object.values(valResults).flatMap(r => r.healthSamples);

    const devCalibration = allDevHealthSamples.length ? computeHealthCalibration(allDevHealthSamples) : null;
    const valCalibration = allValHealthSamples.length ? computeHealthCalibration(allValHealthSamples) : null;

    return {
        exitRule: EXIT_RULE,
        dev: devFrom && devTo ? {
            range: { from: devFrom, to: devTo },
            overall: computeMetrics(allDevTrades),
            byBand: metricsByBand(allDevTrades),
            healthCalibration: devCalibration,
            healthCalibrationMonotonic: devCalibration ? isCalibrationMonotonic(devCalibration) : null,
            trades: allDevTrades,
        } : null,
        validation: valFrom && valTo ? {
            range: { from: valFrom, to: valTo },
            overall: computeMetrics(allValTrades),
            byBand: metricsByBand(allValTrades),
            healthCalibration: valCalibration,
            healthCalibrationMonotonic: valCalibration ? isCalibrationMonotonic(valCalibration) : null,
            trades: allValTrades,
        } : null,
        caveats: [
            "Small/isolated symbol sets have no meaningful sector breadth — sector-strength scoring is a no-op in this mode.",
            "Every simulated trade force-closes at end of day (intraday only).",
            "Exit rule is a fixed systematic rule, not a human reading live notifications — treat as a lower bound on what disciplined execution of the Trade Health engine's warnings would have done.",
            "healthCalibration buckets EVERY evaluated bar of every open simulated trade by its health score and reports the average/median return from that bar's price to that day's actual close — this checks whether lower health scores really did predict worse outcomes, not just whether they look reasonable. Bucket counts are typically small (quality setups are rare by design) — treat this as a directional check, not a precise calibration, unless a bucket's count is at least in the dozens.",
            "Past performance of this scoring logic on historical data is not a guarantee of future results.",
        ],
    };
}

// ── CLI entry point ───────────────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith("backtest.mjs")) {
    const args = {};
    for (const arg of process.argv.slice(2)) {
        const m = arg.match(/^--([\w]+)=(.*)$/);
        if (m) args[m[1]] = m[2];
    }
    const symbols = args.symbols
        ? args.symbols.split(",").map(s => s.trim().toUpperCase())
        : UNIVERSE.filter(s => !["NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX", "MIDCPNIFTY"].includes(s));

    if (!args.symbols) {
        console.warn(`[Backtest] No --symbols given — defaulting to the FULL ${symbols.length}-symbol universe. This will take a while and use a lot of API calls. Pass --symbols=RELIANCE,TCS to scope it down.`);
    }
    if (!args.devFrom || !args.devTo) {
        console.error("Usage: node src/backtest.mjs --symbols=A,B --devFrom=YYYY-MM-DD --devTo=YYYY-MM-DD [--valFrom=YYYY-MM-DD --valTo=YYYY-MM-DD]");
        process.exit(1);
    }

    runBacktest({ symbols, devFrom: args.devFrom, devTo: args.devTo, valFrom: args.valFrom, valTo: args.valTo })
        .then(result => {
            console.log("\n" + "=".repeat(70));
            console.log("BACKTEST RESULTS");
            console.log("=".repeat(70));
            console.log(`Exit rule: ${result.exitRule}\n`);
            if (result.dev) {
                console.log(`-- DEV period ${result.dev.range.from} .. ${result.dev.range.to} --`);
                console.log(JSON.stringify(result.dev.overall, null, 2));
                console.log("By entry band:", JSON.stringify(result.dev.byBand, null, 2));
                console.log(`Trade Health calibration (monotonic: ${result.dev.healthCalibrationMonotonic}):`, JSON.stringify(result.dev.healthCalibration, null, 2));
            }
            if (result.validation) {
                console.log(`\n-- VALIDATION period ${result.validation.range.from} .. ${result.validation.range.to} --`);
                console.log(JSON.stringify(result.validation.overall, null, 2));
                console.log("By entry band:", JSON.stringify(result.validation.byBand, null, 2));
                console.log(`Trade Health calibration (monotonic: ${result.validation.healthCalibrationMonotonic}):`, JSON.stringify(result.validation.healthCalibration, null, 2));
            }
            console.log("\nCaveats:");
            result.caveats.forEach(c => console.log(`  - ${c}`));
            process.exit(0);
        })
        .catch(e => {
            console.error("[Backtest] Fatal error:", e);
            process.exit(1);
        });
}
