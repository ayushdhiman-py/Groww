// ─────────────────────────────────────────────────────────────────────────────
// screener.mjs — Market-wide screeners (Top Gainers/Losers, Volume Shockers,
// 52-Week breakouts, momentum/pattern scans) across the Nifty 500, not just
// the curated 241-symbol UNIVERSE.
// ─────────────────────────────────────────────────────────────────────────────
// Reuses buildSignal (same indicator math as the main scanner) so results are
// directly comparable. For the ~40% of Nifty 500 already covered by the main
// UNIVERSE scan, reuses its already-computed rows instead of re-fetching —
// only the remaining symbols cost real API calls here. Runs on its own,
// slower cadence (not every ~30s like the main scan) since these categories
// don't need second-by-second freshness, and to keep total load on the
// shared rate limiter reasonable.
// ─────────────────────────────────────────────────────────────────────────────
import { getOrFetchCandles } from "./candle_cache.mjs";
import { buildSignal, state as mainState, isMarketOpen } from "./scanner.mjs";
import { SCREENER_UNIVERSE } from "./screener_universe.mjs";
import { UNIVERSE } from "./universe.mjs";
import { getLtpWithFreshness } from "./feed.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SCREENER_TFS = ["5m", "15m", "1d"];
const REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes between full refreshes
const TOP_N = 15;

const mainUniverseSet = new Set(UNIVERSE);

export let screenerState = {
    lastUpdated: null,
    dataAsOf: null,
    universeSize: SCREENER_UNIVERSE.length,
    gainers: [], losers: [], volumeShockers: [],
    high52w: [], low52w: [],
    bullishCrossover: [], momentumBurst: [], rsiOversold: [],
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
    const daily = rowsByTf["1d"];
    const fiveMin = rowsByTf["5m"];

    const byChgDesc = daily.filter(r => Number.isFinite(r.chgPct)).sort((a, b) => b.chgPct - a.chgPct);
    const gainers = byChgDesc.slice(0, TOP_N);
    const losers = byChgDesc.slice(-TOP_N).reverse();

    const volumeShockers = fiveMin
        .filter(r => r.volSpike)
        .sort((a, b) => Math.abs(b.volumeChange) - Math.abs(a.volumeChange))
        .slice(0, TOP_N);

    // Within 1% of the 52-week extreme counts as "at/near" the breakout level.
    const high52w = daily
        .filter(r => r.w52H && r.price >= r.w52H * 0.99)
        .sort((a, b) => b.chgPct - a.chgPct)
        .slice(0, TOP_N);
    const low52w = daily
        .filter(r => r.w52L && r.price <= r.w52L * 1.01)
        .sort((a, b) => a.chgPct - b.chgPct)
        .slice(0, TOP_N);

    // Daily, not 5m — "Golden Cross"/"RSI Oversold"/"Momentum" are
    // conventionally daily-timeframe concepts on every broker app (Upstox
    // included); computing them from 5-minute candles instead produced a
    // completely different, much noisier list (5m RSI dips under 30 many
    // times a day as ordinary intraday noise, while a genuine daily RSI
    // oversold reading is rare and significant) — not wrong data, just a
    // different definition than what these category names imply.
    // Volume Shockers stays 5m deliberately: an intraday relative-volume
    // spike is itself an inherently intraday concept, unlike these three.
    const bullishCrossover = daily
        .filter(r => r.goldenCross)
        .sort((a, b) => b.techScore - a.techScore)
        .slice(0, TOP_N);
    const momentumBurst = daily
        .filter(r => r.volSpike && r.macdBull)
        .sort((a, b) => Math.abs(b.volumeChange) - Math.abs(a.volumeChange))
        .slice(0, TOP_N);
    const rsiOversold = daily
        .filter(r => r.rsi !== null && r.rsi < 30)
        .sort((a, b) => a.rsi - b.rsi)
        .slice(0, TOP_N);

    // `lastUpdated` is when this refresh cycle ran, not a claim that every
    // row is that fresh — rows reused from the main scan can be up to ~30s
    // old, and rows for symbols outside the main UNIVERSE are only refreshed
    // once per REFRESH_INTERVAL_MS (15 min). `dataAsOf` is the actual oldest
    // priceTs among everything just categorized.
    const allRows = [...daily, ...fiveMin];
    const priceTimes = allRows.map(r => r.priceTs).filter(ts => ts != null);
    const dataAsOf = priceTimes.length ? Math.min(...priceTimes) : null;

    screenerState = {
        lastUpdated: new Date().toISOString(),
        dataAsOf,
        universeSize: SCREENER_UNIVERSE.length,
        gainers, losers, volumeShockers, high52w, low52w,
        bullishCrossover, momentumBurst, rsiOversold,
    };
}

export async function runScreenerScan() {
    if (scanning) return;
    scanning = true;
    try {
        const rowsByTf = { "5m": [], "15m": [], "1d": [] };
        const newSymbols = [];

        for (const sym of SCREENER_UNIVERSE) {
            if (mainUniverseSet.has(sym)) {
                for (const tf of SCREENER_TFS) {
                    const row = (mainState.data[`${tf}_ALL`] || []).find(r => r.symbol === sym);
                    if (row) rowsByTf[tf].push(row);
                }
            } else {
                newSymbols.push(sym);
            }
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
