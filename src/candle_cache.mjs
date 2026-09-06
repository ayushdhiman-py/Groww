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

// ── 1m tick-to-candle helpers (used by trial worker) ───────────────��─────────

const ONE_MIN_MAX_BARS = 2400; // ~40 hours of 1m bars — bounded to avoid unbounded memory growth

const floorToMinute = ts => Math.floor(ts / 60000) * 60000;

/**
 * Append a live tick to the in-memory 1m candle series for `symbol`.
 * - price: required (number)
 * - volume: optional (number) — if null, volume is treated as 0
 * - ts: optional (ms epoch). Defaults to Date.now()
 *
 * This updates (mutates) the cached candles for `${symbol}|1m` and resets the
 * fetchedAt to now so subsequent readers see it as fresh. It NEVER triggers a
 * network fetch and is safe to call frequently.
 */
export function appendTickTo1m(symbol, price, volume = null, ts = Date.now()) {
    if (price == null || Number.isNaN(price)) return;
    const k = key(symbol, "1m");
    const minuteTs = floorToMinute(ts);

    // Try to read existing entry from the cache (LRU semantics preserved)
    let entry = cacheGet(k);
    let candles = entry?.candles ?? [];

    const last = candles.length ? candles[candles.length - 1] : null;
    if (last && floorToMinute(last.ts) === minuteTs) {
        // Update existing minute candle
        if (price > last.high) last.high = price;
        if (price < last.low) last.low = price;
        last.close = price;
        if (volume != null) last.volume = (last.volume || 0) + volume;
    } else {
        // Create a new minute candle
        const newCandle = {
            open: price,
            high: price,
            low: price,
            close: price,
            volume: volume != null ? volume : (last?.volume ? 0 : 0),
            ts: minuteTs,
        };
        candles.push(newCandle);
        // Keep bounded history
        if (candles.length > ONE_MIN_MAX_BARS) candles.shift();
    }

    // Write back into the cache — update fetchedAt to now so TTL logic treats it fresh
    cacheSet(k, { candles, fetchedAt: Date.now(), tf: "1m" });
}

/**
 * Read the most recent `count` candles for symbol/tf from the cache ONLY.
 * Returns an array (possibly shorter than `count`) — never triggers a network fetch.
 */
export function getRecentCandles(symbol, tf = "1m", count = 60) {
    const entry = cacheGet(key(symbol, tf));
    if (!entry || !Array.isArray(entry.candles)) return [];
    const arr = entry.candles;
    if (count >= arr.length) return arr.slice();
    return arr.slice(arr.length - count);
}

// ── end 1m helpers ───────────────────────────────────────────────────────────
