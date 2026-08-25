// ─────────────────────────────────────────────────────────────────────────────
// candle_cache.mjs — TTL cache around upstox.mjs's fetchCandles.
//
// Upstox's daily-candle endpoint only ever returns COMPLETED days — today's
// still-forming session isn't a distinct daily row — so a 24h TTL on "1d" is
// byte-identical to a fresh fetch until the next day's bar actually closes.
// For intraday timeframes the TTL matches that timeframe's own bar duration,
// so caching adds no staleness beyond what's already inherent to that bar's
// granularity. This removes the vast majority of redundant re-fetches a full
// scan cycle used to make (most of a symbol's history doesn't change
// intraday) without introducing a new class of staleness.
//
// ── 1-minute base consolidation (1m/5m/10m/15m) ───────────────────────────
// Upstox's v3 historical-candle endpoint bakes the interval into the request
// path — 5m/10m/15m are NOT free alternate views of one shared dataset, each
// used to be its own independent network call. But standard OHLCV
// aggregation (open=first bar's open, high=max, low=min, close=last bar's
// close, volume=sum, bucketed into NSE-session-aligned windows starting
// 9:15 IST) produces bars byte-identical to Upstox's own native 5m/10m/15m
// candles — verified live against RELIANCE (5m) and HDFCBANK (10m/15m/30m/1h),
// every field matching exactly across the last several bars of each.
//
// So instead of 4 separate calls (1m native + 5m native + 10m native + 15m
// native) per symbol per cycle, this fetches ONE 1-minute base series wide
// enough for the neediest of the four (15m's own 20-day window, still safely
// under Upstox's ~24-day intraday chunking limit — a single request, no
// chunking) and derives the other three in-memory. The very next call in the
// same scan iteration for a different consolidated timeframe hits the
// now-fresh base and costs zero network calls.
//
// 30m/1h/1d are deliberately NOT part of this: their own TF_DAYS windows
// (30/60/365 days) already exceed the intraday chunking limit on their OWN
// granularity, so fetching THAT much history at 1-minute granularity would
// need just as many chunked requests as fetching 30m/1h directly already
// does — no call-count win, only a much heavier payload. They keep their
// original direct-fetch-and-cache behavior, unchanged below.
// ─────────────────────────────────────────────────────────────────────────────
import { fetchCandles as fetchCandlesRaw } from "./upstox.mjs";

const TTL_MS = {
    "1m": 60_000,
    "5m": 300_000,
    "10m": 600_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "1h": 3_600_000,
    "1d": 86_400_000,
};

const BASE_TF = "1m";
const BASE_DAYS = 20; // matches 15m's own TF_DAYS — the widest need in the consolidated group, still < the ~24-day intraday chunk limit
const CONSOLIDATED_TFS = new Set(["1m", "5m", "10m", "15m"]);
const BUCKET_MS = { "1m": 60_000, "5m": 300_000, "10m": 600_000, "15m": 900_000 };
const IST_OFFSET_MS = 5.5 * 3600000; // India has no DST, so a fixed offset is exact, not an approximation.

function baseKey(symbol) { return `${symbol}|1m_base`; }

/**
 * NSE-session-aligned OHLCV aggregation from 1-minute bars — exact, not an
 * approximation (see the header comment for the live verification this is
 * based on). Buckets start at 9:15 IST each day and step forward in
 * `bucketMs`-sized windows, matching how Upstox's own native intraday
 * candles are bucketed.
 */
export function resampleFrom1m(oneMinCandles, bucketMs) {
    if (!oneMinCandles?.length || bucketMs === BUCKET_MS["1m"]) return oneMinCandles;
    const buckets = new Map();
    for (const c of oneMinCandles) {
        const ist = c.ts + IST_OFFSET_MS;
        const dayStart = Math.floor(ist / 86400000) * 86400000;
        const sessionOpen = dayStart + 9 * 3600000 + 15 * 60000; // 9:15 IST
        const offset = ist - sessionOpen;
        const bucketStart = sessionOpen + Math.floor(offset / bucketMs) * bucketMs - IST_OFFSET_MS;
        let bucket = buckets.get(bucketStart);
        if (!bucket) { bucket = []; buckets.set(bucketStart, bucket); }
        bucket.push(c);
    }
    return [...buckets.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([ts, cs]) => ({
            ts,
            open: cs[0].open,
            high: Math.max(...cs.map(c => c.high)),
            low: Math.min(...cs.map(c => c.low)),
            close: cs[cs.length - 1].close,
            volume: cs.reduce((s, c) => s + c.volume, 0),
        }));
}

const cache = new Map(); // `${symbol}|${tf}` -> { candles, fetchedAt, tf } — holds the 1m_base entries plus 30m/1h/1d
let hits = 0, misses = 0;

const key = (symbol, tf) => `${symbol}|${tf}`;

/**
 * Cache-only read — NEVER triggers a network fetch. Returns null if nothing
 * is cached yet for this symbol/timeframe. Used by the Stage-1 cheap filter,
 * which must have near-zero REST cost.
 */
export function peekCandles(symbol, tf) {
    if (CONSOLIDATED_TFS.has(tf)) {
        const base = cache.get(baseKey(symbol));
        if (!base) return null;
        return { candles: resampleFrom1m(base.candles, BUCKET_MS[tf]), fetchedAt: base.fetchedAt, tf };
    }
    return cache.get(key(symbol, tf)) || null;
}

/**
 * Get candles for symbol/tf, using the cache when fresh enough.
 * @param {{forceRefresh?: boolean, range?: object, priority?: boolean}} [opts]
 *   `range` (explicit {to,from} window, as backtest.mjs uses) always bypasses
 *   the cache AND the base-consolidation path — a specific historical window
 *   isn't "the current series," and a backtest needs the exact native
 *   granularity it explicitly asked for, not a derived approximation of it.
 *   `forceRefresh` bypasses the TTL check (used by the Critical-trade monitor).
 *   `priority` is forwarded to upstox.mjs's rate limiter.
 */
export async function getOrFetchCandles(symbol, tf, { forceRefresh = false, range = null, priority = false } = {}) {
    if (range) return fetchCandlesRaw(symbol, tf, range, { priority });

    if (CONSOLIDATED_TFS.has(tf)) {
        const bk = baseKey(symbol);
        const entry = cache.get(bk);
        const ttl = TTL_MS[BASE_TF];
        if (!forceRefresh && entry && Date.now() - entry.fetchedAt < ttl) {
            hits++;
            return resampleFrom1m(entry.candles, BUCKET_MS[tf]);
        }

        misses++;
        try {
            const base = await fetchCandlesRaw(
                symbol, BASE_TF,
                { from: new Date(Date.now() - BASE_DAYS * 86400000), to: new Date() },
                { priority }
            );
            cache.set(bk, { candles: base, fetchedAt: Date.now(), tf: BASE_TF });
            return resampleFrom1m(base, BUCKET_MS[tf]);
        } catch (e) {
            // Base fetch failed — fall back to asking Upstox for exactly the
            // requested timeframe directly rather than failing all four
            // consolidated timeframes over what might be an issue specific
            // to the wider base window (e.g. a transient chunk-boundary
            // problem), never surfacing a "no data" that a direct fetch
            // would have avoided.
            console.error(`[CandleCache] Base 1m fetch failed for ${symbol}, falling back to direct ${tf} fetch:`, e.message);
            return fetchCandlesRaw(symbol, tf, null, { priority });
        }
    }

    const k = key(symbol, tf);
    const entry = cache.get(k);
    const ttl = TTL_MS[tf] ?? 300_000;
    if (!forceRefresh && entry && Date.now() - entry.fetchedAt < ttl) {
        hits++;
        return entry.candles;
    }

    misses++;
    const candles = await fetchCandlesRaw(symbol, tf, null, { priority });
    cache.set(k, { candles, fetchedAt: Date.now(), tf });
    return candles;
}

export function cacheStats() {
    return { size: cache.size, hits, misses };
}

/** Test/ops helper — clears all cached entries. */
export function clearCandleCache() {
    cache.clear();
    hits = 0;
    misses = 0;
}
