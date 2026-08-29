// ─────────────────────────────────────────────────────────────────────────────
// historical_data_layer.mjs — the as-of-T data layer for the historical
// dataset builder (src/ai_dataset_builder.mjs). Turns a pre-fetched, full
// historical candle series per symbol/timeframe into a `ctx` object with the
// EXACT SAME shape ai_scanner.mjs's Layer 0/3 already expect (candleSource,
// getPrice, now, historical) — so Layers 0-3 run through literally the same
// code historically as live, never a parallel reimplementation.
//
// ZERO-LOOKAHEAD GUARANTEE: a candle is only visible "as of T" once its
// CLOSE time (ts + interval duration) is <= T — not its open time. A 5m
// candle opening at 10:00 isn't actually known to exist until 10:05; using
// it at T=10:02 would be lookahead. Every slice in this file enforces that.
// ─────────────────────────────────────────────────────────────────────────────
import { classify as classifyIndexRegime } from "./index_regime.mjs";

export const INTERVAL_MS = { "1m": 60_000, "5m": 5 * 60_000, "15m": 15 * 60_000, "1d": 24 * 60 * 60_000 };

/**
 * Builds a stateful as-of-T context over a pre-fetched candle universe.
 * `seriesBySymbolTf` — Map<"SYMBOL|tf", candles[]> (each array full history,
 * sorted ascending by ts). Call `.setAsOf(t)` before each synthetic
 * timestamp, then pass `.ctx` (or `.ctx` reused across symbols — it's a thin
 * closure, safe to share) into ai_scanner.mjs's layer0/layer3/classify.
 */
export function createHistoricalContext(seriesBySymbolTf) {
    let asOfT = null;

    // Binary search for the index of the last candle whose CLOSE time <= T.
    function lastClosedIndex(series, intervalMs, t) {
        let lo = 0, hi = series.length - 1, ans = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (series[mid].ts + intervalMs <= t) { ans = mid; lo = mid + 1; }
            else hi = mid - 1;
        }
        return ans;
    }

    function candleSource(symbol, tf) {
        const series = seriesBySymbolTf.get(`${symbol}|${tf}`);
        if (!series || !series.length) return null;
        const intervalMs = INTERVAL_MS[tf];
        const idx = lastClosedIndex(series, intervalMs, asOfT);
        if (idx === -1) return { candles: [], fetchedAt: asOfT };
        // .slice() copies — callers (isolateTodaySession etc.) sometimes
        // treat the array as safe to read freely; never hand out a live
        // view into the full series that a caller could accidentally
        // widen.
        return { candles: series.slice(0, idx + 1), fetchedAt: asOfT };
    }

    // Historical "entry price" proxy: the close of the most recent fully
    // closed 1m candle as of T. Honestly labeled source="HISTORICAL" (never
    // "LIVE"/"DELAYED") — this is real, known-in-hindsight OHLCV data, not a
    // live tick, and layer0's feed-latency check never fires on this source.
    function getPrice(symbol) {
        const c1 = candleSource(symbol, "1m");
        if (!c1?.candles?.length) return { value: null, ts: null, ageMs: null, source: "UNAVAILABLE" };
        const last = c1.candles[c1.candles.length - 1];
        return { value: last.close, ts: last.ts + INTERVAL_MS["1m"], ageMs: 0, source: "HISTORICAL" };
    }

    const ctx = {
        candleSource,
        getPrice,
        now: () => new Date(asOfT),
        historical: true,
    };

    return {
        ctx,
        setAsOf(t) { asOfT = t; },
        // Exposed for the outcome-labeling step, which needs the RAW forward
        // 1m series (candles AFTER T, deliberately NOT going through
        // candleSource/lastClosedIndex, which only ever look backward).
        getFullSeries(symbol, tf) { return seriesBySymbolTf.get(`${symbol}|${tf}`) || []; },
    };
}

/**
 * Historical market-regime reconstruction — reuses index_regime.mjs's own
 * classify() (parameterized, see that file) against as-of-T index candles.
 * PCR has no historical source (options_feed.mjs is live-only; Upstox's
 * historical API doesn't cover option chains) — classify() already handles
 * a null optionsSource result as "no PCR available," which is what every
 * historical row will honestly show, never a fabricated value.
 */
export function historicalMarketRegime(histCtx, indexSymbol = "NIFTY") {
    const noOptions = () => ({ data: null, stale: true });
    const result = classifyIndexRegime(indexSymbol, histCtx.ctx.candleSource, noOptions);
    return { indexRegime: result.regime, atrPct: result.atrPct, emaSlope: result.emaSlope };
}

/**
 * Historical India VIX as-of-T — India VIX resolves as a normal instrument
 * (NSE_INDEX|India VIX) and is fetchable via the same historical-candle API
 * as any equity/index (verified live before this file was written), so this
 * is a REAL historical value, not an estimate — unlike vix_manager.mjs's
 * live estimateVIX() fallback (option-chain IV based), which has no
 * historical equivalent and is never used here.
 */
export function historicalVix(histCtx, vixSymbol = "INDIA VIX") {
    const c1d = histCtx.ctx.candleSource(vixSymbol, "1d");
    if (!c1d?.candles?.length) return null;
    return c1d.candles[c1d.candles.length - 1].close;
}
