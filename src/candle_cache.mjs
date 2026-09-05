// ────────────────────────────────────────────────────────────────
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
// ────────────────────────────────────────────────────────────────
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

// -------------------- Trial incremental 1m helpers --------------------
// These helpers implement a bounded, in-memory recent 1m store used by the
// Trial minute-worker. They do not replace the existing per-timeframe TTL
// cache used elsewhere; they are additive and optional (configurable via
// src/config.mjs). The store keeps only a recent window per symbol to avoid
// unbounded memory growth.

const trial1mStore = new Map(); // symbol -> Array of { ts, open, high, low, close, volume }
const TRIAL_DEFAULT_HISTORY = 240; // configurable via env (4 hours)

function minuteBucket(ts) {
    return Math.floor(ts / 60000) * 60000;
}

export function appendTickTo1m(symbol, price, volume = null, ts = Date.now(), maxBars = TRIAL_DEFAULT_HISTORY) {
    if (price == null || !Number.isFinite(price)) return null;
    const mTs = minuteBucket(ts);
    const arr = trial1mStore.get(symbol) || [];
    const last = arr[arr.length - 1];
    if (!last || last.ts !== mTs) {
        // start new candle
        const newC = { ts: mTs, open: price, high: price, low: price, close: price, volume: volume == null ? null : volume };
        arr.push(newC);
        // trim history
        if (arr.length > maxBars) arr.splice(0, arr.length - maxBars);
        trial1mStore.set(symbol, arr);
        return newC;
    } else {
        // update existing
        last.high = Math.max(last.high, price);
        last.low = Math.min(last.low, price);
        last.close = price;
        if (volume != null) last.volume = (last.volume || 0) + volume;
        return last;
    }
}

export function getRecentCandles(symbol, tf = "1m", bars = 120) {
    if (tf === "1m") {
        const arr = trial1mStore.get(symbol) || [];
        return arr.slice(-bars);
    }
    // derive from 1m
    const base = trial1mStore.get(symbol) || [];
    if (!base.length) return [];
    if (tf === "5m" || tf === "15m") {
        const factor = parseInt(tf.replace('m',''));
        const groups = [];
        // align to tf boundary by minute timestamp
        for (let i = base.length - 1; i >= 0 && groups.length < bars; i--) {
            // build windows backward then reverse
        }
        // simpler approach: rebuild sequentially
        const out = [];
        for (let i = 0; i < base.length; i += factor) {
            const slice = base.slice(Math.max(0, i - factor + 1), i + 1);
            if (!slice.length) continue;
            const ts = slice[0].ts;
            const open = slice[0].open;
            const high = Math.max(...slice.map(s => s.high));
            const low = Math.min(...slice.map(s => s.low));
            const close = slice[slice.length - 1].close;
            const volArr = slice.map(s => s.volume).filter(v => v != null);
            const volume = volArr.length ? volArr.reduce((a,b)=>a+b,0) : null;
            out.push({ ts, open, high, low, close, volume });
        }
        return out.slice(-bars);
    }
    // other TFs not supported in trial store
    return [];
}

export function clearTrial1mStore() {
    trial1mStore.clear();
}
