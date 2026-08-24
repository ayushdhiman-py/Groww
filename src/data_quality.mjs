// ─────────────────────────────────────────────────────────────────────────────
// data_quality.mjs — the one shared freshness/data-quality primitive.
//
// Every "live" value shown anywhere in the dashboard must be able to answer
// "as of when, and how do we know?" This module is the single place that
// answers that question so the rule stays enforceable in one spot instead of
// each layer inventing its own silent fallback.
//
// Never fabricate a value: if the input is missing/invalid, the result is
// UNAVAILABLE with value:null — callers must handle that explicitly, not
// coalesce it into a number that looks the same as a live one.
// ─────────────────────────────────────────────────────────────────────────────

export const SOURCE = Object.freeze({
    LIVE: "LIVE",
    DELAYED: "DELAYED",
    HISTORICAL: "HISTORICAL",
    ESTIMATED: "ESTIMATED",
    UNAVAILABLE: "UNAVAILABLE",
});

/** India cash-market session: Mon–Fri, 09:15–15:30 IST. */
export function isMarketOpen(now = new Date()) {
    const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const h = ist.getHours(), m = ist.getMinutes(), d = ist.getDay();
    return d > 0 && d < 6 && (h > 9 || (h === 9 && m >= 15)) && (h < 15 || (h === 15 && m <= 30));
}

/**
 * Max age (ms) a tick can be and still count as LIVE. During market hours
 * Upstox pushes ticks roughly every ~1s for liquid symbols, so anything
 * older than a few seconds indicates the feed has actually gone stale, not
 * just "the stock is quiet." Outside market hours no tick is "live" by
 * definition — the last real print is DELAYED/HISTORICAL, never LIVE, no
 * matter how recently it was received or read.
 */
export function maxLiveAgeMs(now = new Date()) {
    return isMarketOpen(now) ? 5_000 : Infinity;
}

/**
 * Classify a (value, tickTs) pair. `tickTs` must be the timestamp the
 * exchange/source actually generated the value at — never `Date.now()`
 * standing in for an unknown data time.
 */
export function freshness(value, tickTs, { now = Date.now(), sourceOverride } = {}) {
    if (value == null || !Number.isFinite(value) || tickTs == null || !Number.isFinite(tickTs)) {
        return { value: null, ts: null, ageMs: null, source: SOURCE.UNAVAILABLE };
    }
    const ageMs = now - tickTs;
    if (sourceOverride) return { value, ts: tickTs, ageMs, source: sourceOverride };
    if (!isMarketOpen(new Date(now))) return { value, ts: tickTs, ageMs, source: SOURCE.DELAYED };
    return { value, ts: tickTs, ageMs, source: ageMs <= maxLiveAgeMs(new Date(now)) ? SOURCE.LIVE : SOURCE.DELAYED };
}

/** A value known only "as of" some past candle/scan — never claimed live. */
export function historical(value, ts) {
    if (value == null || !Number.isFinite(value) || ts == null) return UNAVAILABLE("no historical value");
    return { value, ts, ageMs: Date.now() - ts, source: SOURCE.HISTORICAL };
}

/** A model-derived (e.g. theoretical/Black-Scholes) value — never live data. */
export function estimated(value, ts = null, reason = null) {
    if (value == null || !Number.isFinite(value)) return UNAVAILABLE(reason || "estimate unavailable");
    return { value, ts, ageMs: ts != null ? Date.now() - ts : null, source: SOURCE.ESTIMATED, reason };
}

export function UNAVAILABLE(reason = null) {
    return { value: null, ts: null, ageMs: null, source: SOURCE.UNAVAILABLE, reason };
}
