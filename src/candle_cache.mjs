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
// Each timeframe is fetched directly and cached under its own key — no
// shared 1-minute base. A wide 1m base (~20 days, ~7,500 bars/symbol) held
// in memory for every symbol in the scan universe OOM'd Render's 512Mi
// instance; a native 15m fetch over the same 20-day window is ~500 bars,
// roughly 15x smaller. Direct-fetch-per-timeframe costs more API calls but
// keeps each cache entry small.
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

// Bounded LRU — caps the cache's own footprint regardless of how many
// symbols the scan universe touches over a trading day.
//
// 150 was sized for the old Render deployment (512Mi instance) and only
// Stage-2's own fetch pattern. Now self-hosted (no more OOM ceiling) and
// with stage1_filter.mjs's fast loop also peeking every universe symbol's
// "5m" entry every 2s (on top of Stage-2's ~150-symbol rotation across up
// to 7 timeframes each, plus screener.mjs's own fetches — all sharing this
// same cache), 150 was thrashing constantly: a later symbol's fetch would
// evict an earlier symbol's still-relevant candles well before its own TTL
// expired, which is what made "All Stocks" chart/volume/EMA data visibly
// disappear from already-populated rows as later rows finished warming up.
// 4000 comfortably covers the realistic worst case (~505 symbols x 7
// timeframes = ~3535 possible distinct keys) without meaningfully thrashing
// under normal operation; a few thousand small candle arrays is a trivial
// memory footprint on a real machine.
const MAX_ENTRIES = 4000;
const cache = new Map(); // `${symbol}|${tf}` -> { candles, fetchedAt, tf }
let hits = 0, misses = 0;

const key = (symbol, tf) => `${symbol}|${tf}`;

function cacheGet(k) {
    if (!cache.has(k)) return undefined;
    const v = cache.get(k);
    cache.delete(k);
    cache.set(k, v); // re-insert: Map iteration order tracks LRU order
    return v;
}

function cacheSet(k, v) {
    cache.delete(k);
    cache.set(k, v);
    if (cache.size > MAX_ENTRIES) {
        cache.delete(cache.keys().next().value); // evict least-recently-used
    }
}

/**
 * Cache-only read — NEVER triggers a network fetch. Returns null if nothing
 * is cached yet for this symbol/timeframe. Used by the Stage-1 cheap filter,
 * which must have near-zero REST cost.
 */
export function peekCandles(symbol, tf) {
    return cacheGet(key(symbol, tf)) || null;
}

/**
 * Get candles for symbol/tf, using the cache when fresh enough.
 * @param {{forceRefresh?: boolean, range?: object, priority?: boolean}} [opts]
 *   `range` (explicit {to,from} window, as backtest.mjs uses) always bypasses
 *   the cache — a specific historical window isn't "the current series."
 *   `forceRefresh` bypasses the TTL check (used by the Critical-trade monitor).
 *   `priority` is forwarded to upstox.mjs's rate limiter.
 */
export async function getOrFetchCandles(symbol, tf, { forceRefresh = false, range = null, priority = false } = {}) {
    if (range) return fetchCandlesRaw(symbol, tf, range, { priority });

    const k = key(symbol, tf);
    const entry = cacheGet(k);
    const ttl = TTL_MS[tf] ?? 300_000;
    if (!forceRefresh && entry && Date.now() - entry.fetchedAt < ttl) {
        hits++;
        return entry.candles;
    }

    misses++;
    const candles = await fetchCandlesRaw(symbol, tf, null, { priority });
    cacheSet(k, { candles, fetchedAt: Date.now(), tf });
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
