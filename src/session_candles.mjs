// ─────────────────────────────────────────────────────────────────────────────
// session_candles.mjs — isolate "today's session" + prev-day/week/52w extremes
// from a raw candle series.
//
// Extracted verbatim from buildSignal() (scanner.mjs) so the exact same logic
// that powers live scoring is also available standalone to the Stage-1 cheap
// filter (stage1_filter.mjs), which needs "today's open" / "today's candles
// so far" from whatever's already cached — WITHOUT pulling in buildSignal's
// full indicator pipeline or requiring a live price. The live-price-dependent
// adjustments (folding the current tick into dayH/dayL, computing chgPct)
// stay in buildSignal, since Stage-1 doesn't have (and doesn't need) that.
// ─────────────────────────────────────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 3600000; // India has no DST, so a fixed offset is exact, not an approximation.
const normalizeTs = ts => ts < 10000000000 ? ts * 1000 : ts;
const istDay = ts => Math.floor((ts + IST_OFFSET_MS) / 86400000);

/**
 * @param {Array<{ts:number, open:number, high:number, low:number, close:number, volume:number}>} candles
 *   Oldest-first chronological order (as fetchCandles/candle_cache return).
 * @param {string} tf
 * @returns {{
 *   todayCandles: Array, dayH: number, dayL: number, weekH: number, weekL: number,
 *   h52w: number, l52w: number, prevClose: number, prevDayH: number|null,
 *   prevDayL: number|null, todayIdx: number, lastTs: number, last: object,
 * }}
 */
export function isolateTodaySession(candles, tf) {
    const n = candles.length;
    const last = candles[n - 1];
    const lastTs = normalizeTs(last.ts);
    const todayIdx = istDay(lastTs);

    // Day High/Low
    let dayH = -Infinity, dayL = Infinity;
    // Weekly High/Low (last 7 days)
    let weekH = -Infinity, weekL = Infinity;
    // 52-Week High/Low (only calculated correctly on 1d TF)
    let h52w = -Infinity, l52w = Infinity;

    let prevClose = null;
    let prevDayIdx = null;
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

        const cIdx = istDay(ts);
        if (cIdx === todayIdx) {
            dayH = Math.max(dayH, c.high);
            dayL = Math.min(dayL, c.low);
            todayCandlesRev.push(c);
        } else if (prevDayIdx === null) {
            // First non-today candle encountered scanning backward from the
            // most recent bar — this is the previous trading day's LAST bar,
            // so its close is the exact previous close.
            prevDayIdx = cIdx;
            prevClose = c.close;
            prevDayH = c.high;
            prevDayL = c.low;
        } else if (cIdx === prevDayIdx) {
            prevDayH = Math.max(prevDayH, c.high);
            prevDayL = Math.min(prevDayL, c.low);
        }
        // else: an earlier day — only relevant to the week/year windows above.
    }

    const todayCandles = todayCandlesRev.slice().reverse(); // chronological order, today's session only
    if (prevDayH === -Infinity) prevDayH = null;
    if (prevDayL === Infinity) prevDayL = null;
    if (prevClose === null && n > 1) prevClose = candles[n - 2].close;
    if (prevClose === null) prevClose = last.open;

    return { todayCandles, dayH, dayL, weekH, weekL, h52w, l52w, prevClose, prevDayH, prevDayL, todayIdx, lastTs, last };
}
