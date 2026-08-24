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

const cache = new Map(); // `${symbol}|${tf}` -> { candles, fetchedAt, tf }
let hits = 0, misses = 0;

const key = (symbol, tf) => `${symbol}|${tf}`;

/**
 * Cache-only read — NEVER triggers a network fetch. Returns null if nothing
 * is cached yet for this symbol/timeframe. Used by the Stage-1 cheap filter,
 * which must have near-zero REST cost.
 */
export function peekCandles(symbol, tf) {
    return cache.get(key(symbol, tf)) || null;
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
