import { fetchCandles, fetchBulkLtp, rateLimit } from "./upstox.mjs";
import { ema, macd, rsi, vwap, vwapSeries, historicalVolatility, atr, emaSlopePct } from "./indicators.mjs";
import { analyzeStructure, detectBreakout, detectRetest, detectRejection, detectConsolidation } from "./price_action.mjs";
import { TF_MAP } from "./config.mjs";
import { UNIVERSE, getSector } from "./universe.mjs";
import { optionsCache } from "./options_feed.mjs";
import { getLtp } from "./feed.mjs";

import { fetchDividend, formatDividendInfo } from "./dividend.mjs";
import { enrichOpportunities } from "./entry_score.mjs";
import { computeMarketRegime, regimeMinOpportunityScore } from "./market_regime.mjs";
import { onScanComplete } from "./critical_trades.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));

export let state = emptyState();
const prevSigs = new Map();
export let scanning = false;
export let isAuthenticated = false;
export let scanProgress = { done: 0, total: UNIVERSE.length };

export function setIsAuthenticated(val) {
    isAuthenticated = val;
}

export function isMarketOpen() {
    const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const h = ist.getHours(), m = ist.getMinutes(), d = ist.getDay();
    return d > 0 && d < 6 && (h > 9 || (h === 9 && m >= 15)) && (h < 15 || (h === 15 && m <= 30));
}

export function getState() {
    return state;
}

export function emptyState() {
    const data = {};
    for (const tf of Object.keys(TF_MAP)) { data[`${tf}_BUY`] = []; data[`${tf}_SELL`] = []; data[`${tf}_ALL`] = []; data[`${tf}_GOLDEN`] = []; }
    return { lastUpdated: null, data, errors: [], universe: UNIVERSE.length, marketRegime: null, intradayOpportunities: [] };
}

// Local rateLimit removed in favor of global one in upstox.mjs

export function buildSignal(candles, tf, symbol, ltp = null) {
    const cls = candles.map(c => c.close).filter(Number.isFinite);
    const vol = candles.map(c => c.volume).filter(Number.isFinite);
    if (cls.length < 55 || vol.length < 15) return null;

    const e9 = ema(cls, 9), e21 = ema(cls, 21), e50 = ema(cls, 50);
    const { macd: ml, signal: sl } = macd(cls, 12, 26, 9);
    const rsiVal = rsi(cls);
    const vwapVal = vwap(candles);
    const hv = historicalVolatility(cls, 20);
    const n = cls.length;

    const c9 = e9[n - 1];
    const c21 = e21[n - 1], p21 = e21[n - 2];
    const c50 = e50[n - 1], p50 = e50[n - 2];
    const cM = ml[n - 1], pM = ml[n - 2];
    const cS = sl[n - 1], pS = sl[n - 2];
    const macdHist = cM !== null && cS !== null ? cM - cS : null;
    const macdHistPrev = pM !== null && pS !== null ? pM - pS : null;
    const macdHistAccel = macdHist !== null && macdHistPrev !== null ? macdHist - macdHistPrev : null;
    const ema9Slope = emaSlopePct(e9, 5);
    const ema21Slope = emaSlopePct(e21, 5);
    const ema50Slope = emaSlopePct(e50, 5);
    const emaBullAligned = c9 !== null && c21 !== null && c50 !== null ? (c9 > c21 && c21 > c50) : null;

    const goldenCross = p21 !== null && p50 !== null && p21 <= p50 && c21 > c50;
    const deathCross = p21 !== null && p50 !== null && p21 >= p50 && c21 < c50;
    const ema21above = c21 > c50;
    const macdBull = pM !== null && pS !== null && pM <= pS && cM > cS;
    const macdBear = pM !== null && pS !== null && pM >= pS && cM < cS;
    const macdAbove = cM !== null && cS !== null && cM > cS;

    const recentVol = vol.slice(-10);
    const avgVol = recentVol.reduce((a, b) => a + b, 0) / recentVol.length;
    const lastVol = vol[vol.length - 1];
    const prevVol = vol[vol.length - 2] || 0;
    const volSpike = lastVol > avgVol * 1.5;

    const last = candles[candles.length - 1];
    const livePrice = ltp || last.close;
    const emaGap = c50 ? +(((c21 - c50) / c50) * 100).toFixed(3) : 0;

    const normalizeTs = ts => ts < 10000000000 ? ts * 1000 : ts;
    const lastTs = normalizeTs(last.ts);
    const tzStr = new Date(lastTs).toLocaleDateString("en-US", { timeZone: "Asia/Kolkata" });

    // Day High/Low
    let dayH = -Infinity, dayL = Infinity;
    // Weekly High/Low (last 7 days)
    let weekH = -Infinity, weekL = Infinity;
    // 52-Week High/Low (only calculated correctly on 1d TF)
    let h52w = -Infinity, l52w = Infinity;

    let prevClose = null;
    let prevDayStr = null;
    let prevDayH = -Infinity, prevDayL = Infinity;
    const todayCandlesRev = []; // filled newest-first, reversed below
    const weekThresh = lastTs - (7 * 86400000);
    const yearThresh = lastTs - (365 * 86400000);

    for (let i = n - 1; i >= 0; i--) {
        const c = candles[i];
        const ts = normalizeTs(c.ts);

        // 52-Week logic (only if 1d timeframe)
        if (tf === "1d" && ts >= yearThresh) {
            h52w = Math.max(h52w, c.high);
            l52w = Math.min(l52w, c.low);
        }

        // Weekly logic
        if (ts >= weekThresh) {
            weekH = Math.max(weekH, c.high);
            weekL = Math.min(weekL, c.low);
        }

        const cTzStr = new Date(ts).toLocaleDateString("en-US", { timeZone: "Asia/Kolkata" });
        if (cTzStr === tzStr) {
            dayH = Math.max(dayH, c.high);
            dayL = Math.min(dayL, c.low);
            todayCandlesRev.push(c);
        } else if (prevDayStr === null) {
            // First non-today candle encountered scanning backward from the
            // most recent bar — this is the previous trading day's LAST bar,
            // so its close is the exact previous close.
            prevDayStr = cTzStr;
            prevClose = c.close;
            prevDayH = c.high;
            prevDayL = c.low;
        } else if (cTzStr === prevDayStr) {
            prevDayH = Math.max(prevDayH, c.high);
            prevDayL = Math.min(prevDayL, c.low);
        }
        // else: an earlier day — only relevant to the week/year windows above.
    }

    const todayCandles = todayCandlesRev.slice().reverse(); // chronological order, today's session only
    if (prevDayH === -Infinity) prevDayH = null;
    if (prevDayL === Infinity) prevDayL = null;

    // Fallbacks and incorporating livePrice
    if (dayH === -Infinity) { dayH = Math.max(last.high, livePrice); dayL = Math.min(last.low, livePrice); }
    else { dayH = Math.max(dayH, livePrice); dayL = Math.min(dayL, livePrice); }

    if (weekH === -Infinity) { weekH = dayH; weekL = dayL; }
    if (h52w === -Infinity && tf === "1d") { h52w = dayH; l52w = dayL; }

    if (prevClose === null && n > 1) prevClose = candles[n - 2].close;
    if (prevClose === null) prevClose = last.open;

    const priceChange = livePrice - prevClose;
    const chgPct = (priceChange / prevClose) * 100;

    // ── Intraday-only derived fields: opening strength, ORB, structure ────────
    // Meaningless for tf === "1d" (there is no "session" within a daily bar),
    // so left null there rather than computed from something that isn't
    // actually today's opening range.
    const isIntradayTf = tf !== "1d";
    let dayOpen = null, pctFromOpen = null;
    let orbHigh = null, orbLow = null, orbBrokenAbove = false, orbVolConfirmed = false, orbRetest = { retested: false, held: null, failed: false };
    let structure = { higherHighs: null, higherLows: null, bullishStructure: null, brokeStructure: null, lastSwingHigh: null, lastSwingLow: null, insufficientData: true };
    let rejection = { rejected: false, upperWickRatio: 0 };
    let consolidation = { consolidating: false, rangePct: null };
    let sessionVwap = null, sessionVwapSlope = null, aboveSessionVwap = null;

    if (isIntradayTf && todayCandles.length > 0) {
        dayOpen = todayCandles[0].open;
        pctFromOpen = dayOpen ? ((livePrice - dayOpen) / dayOpen) * 100 : null;

        orbHigh = todayCandles[0].high;
        orbLow = todayCandles[0].low;
        orbBrokenAbove = orbHigh !== null && livePrice > orbHigh;
        const orbBreakoutInfo = detectBreakout(todayCandles, orbHigh);
        orbVolConfirmed = orbBreakoutInfo.volConfirmed;
        if (orbBreakoutInfo.broke) {
            orbRetest = detectRetest(todayCandles, orbHigh, orbBreakoutInfo.barIndex);
        }

        structure = analyzeStructure(todayCandles);
        rejection = detectRejection(todayCandles[todayCandles.length - 1]);
        consolidation = detectConsolidation(todayCandles, 10, 1.5);

        const sessionVwapArr = vwapSeries(todayCandles);
        sessionVwap = sessionVwapArr.length ? sessionVwapArr[sessionVwapArr.length - 1] : null;
        if (sessionVwapArr.length >= 6) {
            const prior = sessionVwapArr[sessionVwapArr.length - 6];
            sessionVwapSlope = prior ? ((sessionVwap - prior) / prior) * 100 / 5 : null;
        }
        aboveSessionVwap = sessionVwap !== null ? livePrice > sessionVwap : null;
    }

    const histLen = 60;
    const priceHist = cls.slice(-histLen);
    const ema21Hist = e21.slice(-histLen);
    const ema50Hist = e50.slice(-histLen);

    const aboveVwap = vwapVal !== null && livePrice > vwapVal;

    const checks = {
        "Golden Cross (EMA 21>50)": goldenCross,
        "EMA 21 above 50": ema21above,
        "MACD Bull cross": macdBull,
        "MACD above signal": macdAbove,
        "Vol spike + price up": volSpike && chgPct > 0,
        "RSI healthy (45-75)": rsiVal !== null && rsiVal >= 45 && rsiVal <= 75,
        "Price > VWAP": aboveVwap,
    };

    const redFlags = {
        "Death Cross": deathCross,
        "MACD Bear cross": macdBear,
        "RSI overbought >80": rsiVal !== null && rsiVal > 80,
        "RSI oversold <25": rsiVal !== null && rsiVal < 25,
        "Volume collapsing": lastVol < avgVol * 0.4,
    };

    const techScore = Object.values(checks).filter(Boolean).length;
    const redCount = Object.values(redFlags).filter(Boolean).length;

    let signal = "NONE";
    if (goldenCross) signal = "BUY";
    else if (deathCross) signal = "SELL";
    else if (ema21above && macdBull) signal = "BUY";
    else if (!ema21above && macdBear) signal = "SELL";

    const rating = techScore >= 5 ? "STRONG BUY" : techScore >= 3 ? "MODERATE" : "SKIP";

    return {
        symbol, sector: getSector(symbol), tf, signal,
        goldenCross, deathCross,
        price: Number.isFinite(livePrice) ? +livePrice.toFixed(2) : livePrice,
        open: Number.isFinite(last.open) ? +last.open.toFixed(2) : last.open,
        prevClose: Number.isFinite(prevClose) ? +prevClose.toFixed(2) : prevClose,
        high: Number.isFinite(last.high) ? +last.high.toFixed(2) : last.high,
        low: Number.isFinite(last.low) ? +last.low.toFixed(2) : last.low,
        dayH, dayL, weekH, weekL, h52w, l52w,
        prevDayH: prevDayH !== null ? +prevDayH.toFixed(2) : null,
        prevDayL: prevDayL !== null ? +prevDayL.toFixed(2) : null,
        chgPct: Number.isFinite(chgPct) ? +chgPct.toFixed(2) : chgPct,
        volume: lastVol, volumeChange: lastVol - prevVol, volSpike,
        ema9: c9 !== null && Number.isFinite(c9) ? +c9.toFixed(2) : null,
        ema21: c21 !== null && Number.isFinite(c21) ? +c21.toFixed(2) : null,
        ema50: c50 !== null && Number.isFinite(c50) ? +c50.toFixed(2) : null,
        ema9Slope, ema21Slope, ema50Slope, emaBullAligned,
        emaGap, ema21above,
        ema21Hist, ema50Hist, priceHist,
        macdBull, macdBear, macdAbove,
        macdVal: cM !== null && Number.isFinite(cM) ? +cM.toFixed(4) : null,
        macdHist: macdHist !== null && Number.isFinite(macdHist) ? +macdHist.toFixed(4) : null,
        macdHistAccel: macdHistAccel !== null && Number.isFinite(macdHistAccel) ? +macdHistAccel.toFixed(4) : null,
        vwap: vwapVal, aboveVwap,
        sessionVwap, sessionVwapSlope, aboveSessionVwap,
        rsi: rsiVal,
        checks, redFlags,
        techScore, redCount,
        rating,
        ts: last.ts,
        hv,
        atr: null, atrPct: null, // filled in by scanSymbol() from the 1d-pass cache
        dayOpen: dayOpen !== null ? +dayOpen.toFixed(2) : null,
        pctFromOpen: pctFromOpen !== null && Number.isFinite(pctFromOpen) ? +pctFromOpen.toFixed(2) : null,
        orb: {
            high: orbHigh !== null ? +orbHigh.toFixed(2) : null,
            low: orbLow !== null ? +orbLow.toFixed(2) : null,
            brokenAbove: orbBrokenAbove,
            volConfirmed: orbVolConfirmed,
            retested: orbRetest.retested, retestHeld: orbRetest.held, retestFailed: orbRetest.failed,
        },
        structure,
        rejection,
        consolidation,
        isNew: false, isNewGolden: false,
        options: optionsCache.get(symbol) || null,
        w52H: h52w, w52L: l52w,
        priceChange: +priceChange.toFixed(2),
        dividend: null,
    };
}

const w52Cache = new Map();
const atrCache = new Map(); // symbol -> { atr, atrPct } — computed once on the 1d pass, applied to every tf
const symbolErrorCount = new Map(); // Track consecutive errors per symbol
const MAX_CONSECUTIVE_ERRORS = 3; // Skip symbol after this many consecutive errors

async function scanSymbol(symbol, buckets, errors, progressInfo, ltp) {
    // Skip symbols with too many consecutive errors (likely invalid symbols)
    const consecutiveErrors = symbolErrorCount.get(symbol) || 0;
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        process.stdout.write(`\r\x1b[K⏭️ Skipping ${symbol} (${consecutiveErrors} consecutive errors)\n`);
        return;
    }

    // Process 1d first to cache the 52-week high/low
    const tfs = Object.keys(TF_MAP).sort((a, b) => a === "1d" ? -1 : (b === "1d" ? 1 : 0));
    let okCount = 0;
    let symbolHadError = false;

    for (const tf of tfs) {
        try {
            // Scanner has lower priority, so we wait longer if needed
            await rateLimit();
            process.stdout.write(`\r\x1b[K⏳ ${progressInfo} ${symbol}: [${okCount}/${tfs.length}] Scanning ${tf}...`);
            const candles = await fetchCandles(symbol, tf);

            // Reset error count on successful fetch
            symbolErrorCount.set(symbol, 0);

            const row = buildSignal(candles, tf, symbol, ltp);
            if (!row) continue;

            if (tf === "1d") {
                w52Cache.set(symbol, { w52H: row.w52H, w52L: row.w52L });
                const dailyAtr = atr(candles, 14);
                const atrPct = dailyAtr !== null && row.price ? (dailyAtr / row.price) * 100 : null;
                atrCache.set(symbol, { atr: dailyAtr !== null ? +dailyAtr.toFixed(2) : null, atrPct: atrPct !== null ? +atrPct.toFixed(2) : null });
                row.atr = atrCache.get(symbol).atr;
                row.atrPct = atrCache.get(symbol).atrPct;
            } else {
                const cached = w52Cache.get(symbol);
                if (cached) {
                    row.w52H = cached.w52H;
                    row.w52L = cached.w52L;
                }
                const cachedAtr = atrCache.get(symbol);
                if (cachedAtr) {
                    row.atr = cachedAtr.atr;
                    row.atrPct = cachedAtr.atrPct;
                }
            }

            const key = `${symbol}|${tf}`;
            const prev = prevSigs.get(key);
            row.isNew = prev && prev !== row.signal;
            row.isNewGolden = row.goldenCross && row.isNew;
            prevSigs.set(key, row.signal);

            buckets[`${tf}_ALL`].push(row);
            if (row.signal === "BUY") buckets[`${tf}_BUY`].push(row);
            if (row.signal === "SELL") buckets[`${tf}_SELL`].push(row);
            if (row.goldenCross) buckets[`${tf}_GOLDEN`].push(row);
            okCount++;
        } catch (e) {
            let errMsg = e.response?.data?.message || e.response?.data?.error || e.message;
            if (typeof errMsg === 'object') errMsg = JSON.stringify(errMsg);
            errors.push(`${symbol}/${tf}: ${errMsg}`);
            symbolHadError = true;

            // Check if it's a GA001 error (invalid symbol)
            if (errMsg.includes("GA001") || errMsg.includes("trading symbol")) {
                // Mark as invalid immediately
                symbolErrorCount.set(symbol, MAX_CONSECUTIVE_ERRORS);
                process.stdout.write(`\n\x1b[33m⚠️ Invalid symbol: ${symbol} - will skip in future scans\x1b[0m\n`);
                break; // Stop processing this symbol entirely
            }

            // Force a new line for actual errors so they don't get overwritten
            process.stdout.write(`\n\x1b[31m❌ Error: ${symbol}/${tf} → ${errMsg}\x1b[0m\n`);
        }
    }

    // Update error count for this symbol
    if (symbolHadError) {
        const currentErrors = symbolErrorCount.get(symbol) || 0;
        symbolErrorCount.set(symbol, currentErrors + 1);
    }
}

export async function scanAll() {
    if (!isAuthenticated || scanning) return;
    scanning = true;
    scanProgress = { done: 0, total: UNIVERSE.length };
    console.log("Scan started:", new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }));
    const next = emptyState();

    try {
        const sortFn = (a, b) => {
            if (a.goldenCross !== b.goldenCross) return a.goldenCross ? -1 : 1;
            if (b.techScore !== a.techScore) return b.techScore - a.techScore;
            return Math.abs(b.volumeChange) - Math.abs(a.volumeChange);
        };

        // Cloning + sorting the full accumulated state is O(size-so-far) work.
        // Doing it after every single symbol made the whole scan O(n^2) and,
        // since JSON.stringify/parse run synchronously, blocked Node's event
        // loop for longer stretches as the scan progressed — starving HTTP
        // responses and WebSocket handling, which is what made prices/rows
        // appear to "freeze". Throttle the sync to roughly once every 2s
        // (still frequent enough for the UI to see progress), plus always
        // once more on the final symbol.
        const SYNC_INTERVAL_MS = 2000;
        let lastSyncTs = 0;

        for (let scanIdx = 0; scanIdx < UNIVERSE.length; scanIdx++) {
            const sym = UNIVERSE[scanIdx];
            const pInfo = `[${scanProgress.done + 1}/${UNIVERSE.length}]`;
            try {
                await scanSymbol(sym, next.data, next.errors, pInfo, getLtp(sym));
            } catch (e) {
                console.error(`\n❌ Critical error scanning ${sym}:`, e.message);
            }
            scanProgress.done++;

            const now = Date.now();
            const isLast = scanIdx === UNIVERSE.length - 1;
            if (!isLast && now - lastSyncTs < SYNC_INTERVAL_MS) continue;
            lastSyncTs = now;

            // Periodically sync progress to global state (so UI updates)
            for (const tf of Object.keys(TF_MAP)) {
                next.data[`${tf}_BUY`].sort(sortFn);
                next.data[`${tf}_GOLDEN`].sort(sortFn);
                next.data[`${tf}_ALL`].sort((a, b) => b.techScore - a.techScore);
            }

            // Cross-sectional passes (need every symbol scanned SO FAR, not
            // the whole universe) run on every periodic sync, not just once
            // at the very end — a full 241-symbol scan can take minutes, and
            // both the Intraday tab and Critical-trade monitoring should
            // update progressively rather than sit blank/stale until the
            // entire universe finishes.
            next.marketRegime = computeMarketRegime(next.data);
            const minOppScore = regimeMinOpportunityScore(next.marketRegime);
            next.intradayOpportunities = enrichOpportunities(next.data, minOppScore);

            next.lastUpdated = new Date().toISOString();
            state = JSON.parse(JSON.stringify(next));

            onScanComplete(next).catch(e => console.error("[CriticalTrades] onScanComplete error:", e.message));
        }
        process.stdout.write(`\r\x1b[K✅ Scan complete | Time: ${new Date().toLocaleTimeString()} | Total Errors: ${state.errors.length} | Regime: ${next.marketRegime?.regime}\n`);

        // Fetch dividend data in background after scan completes
        fetchDividendsInBackground(next.data);
    } finally { scanning = false; }
}

// Fetch dividend data for all stocks in background
async function fetchDividendsInBackground(data) {
    try {
        const allStocks = data["1d_ALL"] || [];
        console.log(`\n💰 Fetching dividend data for ${allStocks.length} stocks...`);

        // Fetch dividends in batches of 10 to avoid overwhelming the API
        const batchSize = 10;
        for (let i = 0; i < allStocks.length; i += batchSize) {
            const batch = allStocks.slice(i, i + batchSize);
            const promises = batch.map(async (stock) => {
                try {
                    const dividendData = await fetchDividend(stock.symbol);
                    if (dividendData) {
                        stock.dividend = formatDividendInfo(dividendData, stock.price);
                    }
                } catch (e) {
                    // Silent fail for individual stocks
                }
            });
            await Promise.all(promises);
            console.log(`  💰 Dividend progress: ${Math.min(i + batchSize, allStocks.length)}/${allStocks.length}`);
        }

        console.log(`✅ Dividend fetch complete.`);
    } catch (e) {
        console.error("❌ Error fetching dividends:", e.message);
    }
}

export async function startScan() {
    while (true) {
        try {
            if (isMarketOpen() || state.lastUpdated === null) {
                await scanAll();
            }
        } catch (e) {
            console.error("Critical error in startScan background loop:", e.message);
        }

        await sleep(30000);
    }
}
