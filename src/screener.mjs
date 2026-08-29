// ─────────────────────────────────────────────────────────────────────────────
// screener.mjs — Market-wide screeners (Top Gainers/Losers, Volume Shockers,
// 52-Week breakouts, momentum/pattern scans) across the full Nifty 500.
// ─────────────────────────────────────────────────────────────────────────────
// Reuses buildSignal (same indicator math as the main scanner) so results are
// directly comparable. UNIVERSE (src/universe.mjs) now covers nearly all of
// Nifty 500, but Stage 2 only deep-scans a capped subset each cycle — so
// reuse is decided per-symbol by whether the main scan has ACTUALLY produced
// a row yet, not by UNIVERSE membership alone (a symbol can sit in UNIVERSE
// for a while before its first Stage-2/rotation turn comes up). Only
// symbols with no row anywhere yet cost a real API call here. Runs on its
// own, slower cadence (not every ~30s like the main scan) since these
// categories don't need second-by-second freshness, and to keep total load
// on the shared rate limiter reasonable.
// ─────────────────────────────────────────────────────────────────────────────
import { getOrFetchCandles } from "./candle_cache.mjs";
import { buildSignal, state as mainState, isMarketOpen } from "./scanner.mjs";
import { SCREENER_UNIVERSE } from "./screener_universe.mjs";
import { getLtpWithFreshness } from "./feed.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
// All 7 real candle timeframes — every category below except 52W High/Low
// (inherently a "vs 52-week extreme" concept, not a chart-timeframe concept,
// same reasoning as Price/Change% in the All Stocks tab) now needs data
// across all of them: Gainers/Losers show 4 groupings (GAINER_LOSER_TFS) at
// once, and the rest are timeframe-dropdown-driven, needing whichever one
// the frontend currently has selected on demand. This runs on a slow 15-min
// cycle (not a 2s/20s loop), so precomputing all 7 up front each cycle is
// cheap relative to it — unlike the "1 symbol at a time, 500x cost"
// consideration for All Stocks' ALL mode, this is "500 symbols, ~2.3x the
// fetches of the old 3-tf setup, once every 15 minutes."
const SCREENER_TFS = ["1m", "5m", "10m", "15m", "30m", "1h", "1d"];
const GAINER_LOSER_TFS = ["5m", "10m", "15m", "1d"];
const REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes between full refreshes
const TOP_N = 15;

function emptyByTf(tfs) {
    return Object.fromEntries(tfs.map(tf => [tf, []]));
}

export let screenerState = {
    lastUpdated: null,
    dataAsOf: null,
    universeSize: SCREENER_UNIVERSE.length,
    gainers: emptyByTf(GAINER_LOSER_TFS), losers: emptyByTf(GAINER_LOSER_TFS),
    volumeShockers: emptyByTf(SCREENER_TFS),
    high52w: [], low52w: [],
    bullishCrossover: emptyByTf(SCREENER_TFS), momentumBurst: emptyByTf(SCREENER_TFS),
    rsiOversold: emptyByTf(SCREENER_TFS), rsiOverbought: emptyByTf(SCREENER_TFS),
};

let scanning = false;
export function isScreenerScanning() { return scanning; }

async function scanNewSymbol(symbol, rowsByTf) {
    for (const tf of SCREENER_TFS) {
        try {
            // getOrFetchCandles rate-limits internally only on an actual
            // cache miss — see the same note in scanner.mjs's scanSymbol().
            const candles = await getOrFetchCandles(symbol, tf);
            const row = buildSignal(candles, tf, symbol, getLtpWithFreshness(symbol));
            if (row) rowsByTf[tf].push(row);
        } catch (e) {
            // Best-effort — skip this symbol/timeframe rather than aborting
            // the whole screener refresh over one bad symbol.
        }
    }
}

export function computeScreenerCategories(rowsByTf) {
    const daily = rowsByTf["1d"] || [];

    // Gainers/Losers — NOT timeframe-dropdown-driven. Shows all four
    // groupings (5m/10m/15m/1d) at once, each computed independently from
    // that timeframe's own rows, rather than picking one via the dropdown.
    const gainers = {}, losers = {};
    for (const tf of GAINER_LOSER_TFS) {
        const rows = rowsByTf[tf] || [];
        const byChgDesc = rows.filter(r => Number.isFinite(r.chgPct)).sort((a, b) => b.chgPct - a.chgPct);
        gainers[tf] = byChgDesc.slice(0, TOP_N);
        losers[tf] = byChgDesc.slice(-TOP_N).reverse();
    }

    // Within 1% of the 52-week extreme counts as "at/near" the breakout
    // level. Daily-only, unchanged — a 52-week extreme has no meaningful
    // per-intraday-timeframe variant (same reasoning as Price/Change% in
    // the All Stocks tab).
    const high52w = daily
        .filter(r => r.w52H && r.price >= r.w52H * 0.99)
        .sort((a, b) => b.chgPct - a.chgPct)
        .slice(0, TOP_N);
    const low52w = daily
        .filter(r => r.w52L && r.price <= r.w52L * 1.01)
        .sort((a, b) => a.chgPct - b.chgPct)
        .slice(0, TOP_N);

    // Volume Shockers / Bullish Crossover / Momentum Burst / RSI Oversold /
    // RSI Overbought — timeframe-dropdown-driven: computed for every real
    // timeframe so the frontend can select whichever one the dropdown is
    // currently set to without a separate fetch.
    const volumeShockers = {}, bullishCrossover = {}, momentumBurst = {}, rsiOversold = {}, rsiOverbought = {};
    for (const tf of SCREENER_TFS) {
        const rows = rowsByTf[tf] || [];
        volumeShockers[tf] = rows.filter(r => r.volSpike).sort((a, b) => Math.abs(b.volumeChange) - Math.abs(a.volumeChange)).slice(0, TOP_N);
        bullishCrossover[tf] = rows.filter(r => r.goldenCross).sort((a, b) => b.techScore - a.techScore).slice(0, TOP_N);
        momentumBurst[tf] = rows.filter(r => r.volSpike && r.macdBull).sort((a, b) => Math.abs(b.volumeChange) - Math.abs(a.volumeChange)).slice(0, TOP_N);
        // Standard 70/30 thresholds — distinct from scanner.mjs's own
        // unrelated >80/<25 per-row flags, which are stricter "extreme"
        // callouts on individual rows, not this category's own definition.
        rsiOversold[tf] = rows.filter(r => r.rsi !== null && r.rsi < 30).sort((a, b) => a.rsi - b.rsi).slice(0, TOP_N);
        rsiOverbought[tf] = rows.filter(r => r.rsi !== null && r.rsi > 70).sort((a, b) => b.rsi - a.rsi).slice(0, TOP_N);
    }

    // `lastUpdated` is when this refresh cycle ran, not a claim that every
    // row is that fresh — rows reused from the main scan can be up to ~30s
    // old, and symbols the main scan hasn't produced a row for yet are only
    // refreshed once per REFRESH_INTERVAL_MS (15 min). `dataAsOf` is the
    // actual oldest priceTs among everything just categorized.
    const allRows = SCREENER_TFS.flatMap(tf => rowsByTf[tf] || []);
    const priceTimes = allRows.map(r => r.priceTs).filter(ts => ts != null);
    const dataAsOf = priceTimes.length ? Math.min(...priceTimes) : null;

    screenerState = {
        lastUpdated: new Date().toISOString(),
        dataAsOf,
        universeSize: SCREENER_UNIVERSE.length,
        gainers, losers, volumeShockers, high52w, low52w,
        bullishCrossover, momentumBurst, rsiOversold, rsiOverbought,
    };
}

export async function runScreenerScan() {
    if (scanning) return;
    scanning = true;
    try {
        const rowsByTf = emptyByTf(SCREENER_TFS);
        const newSymbols = [];

        // Reuse only when the main scan has ACTUALLY produced a row for this
        // symbol — not merely when it's nominally in UNIVERSE. UNIVERSE now
        // covers nearly all of Nifty 500 (see universe.mjs), but Stage 2 only
        // deep-scans a capped subset each cycle; a symbol can sit in UNIVERSE
        // for a while before its first Stage-2 scan/fairness-rotation turn
        // comes up. Gating on UNIVERSE membership alone would silently leave
        // those symbols with zero data — neither reused (no row exists yet)
        // nor freshly fetched (membership check skipped them) — until
        // rotation happened to reach them.
        for (const sym of SCREENER_UNIVERSE) {
            let foundAny = false;
            for (const tf of SCREENER_TFS) {
                const row = (mainState.data[`${tf}_ALL`] || []).find(r => r.symbol === sym);
                if (row) { rowsByTf[tf].push(row); foundAny = true; }
            }
            if (!foundAny) newSymbols.push(sym);
        }

        console.log(`[Screener] Refreshing — ${newSymbols.length} new symbol(s) to fetch, ${SCREENER_UNIVERSE.length - newSymbols.length} reused from main scan`);
        for (const sym of newSymbols) {
            await scanNewSymbol(sym, rowsByTf);
        }

        computeScreenerCategories(rowsByTf);
        console.log(`[Screener] ✅ Refresh complete: ${screenerState.gainers.length} gainers, ${screenerState.losers.length} losers, ${screenerState.volumeShockers.length} volume shockers, ${screenerState.high52w.length} near 52W high, ${screenerState.low52w.length} near 52W low`);
    } catch (e) {
        console.error("[Screener] Refresh error:", e.message);
    } finally {
        scanning = false;
    }
}

export async function startScreenerScan() {
    while (true) {
        try {
            if (isMarketOpen() || screenerState.lastUpdated === null) {
                await runScreenerScan();
            }
        } catch (e) {
            console.error("[Screener] Critical error in scan loop:", e.message);
        }
        await sleep(REFRESH_INTERVAL_MS);
    }
}
