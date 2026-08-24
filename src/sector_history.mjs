// ─────────────────────────────────────────────────────────────────────────────
// sector_history.mjs — Rolling per-sector snapshot history, so "sector
// momentum" can mean an actual trend over time instead of a single-moment
// reading. In-memory only (resets on restart, same as everything else in
// this app — there is no DB).
// ─────────────────────────────────────────────────────────────────────────────

const HISTORY_MAX = 40;
const SAMPLE_MIN_GAP_MS = 60 * 1000; // at most one sample/minute per sector — a
// snapshot every ~2s scan-sync tick would just be noise, not a trend.

let history = []; // [{ ts, stats: { [sector]: avgPctFromOpen } }]
let lastSampleTs = 0;

/** Record one snapshot of per-sector avgPctFromOpen, throttled to 1/minute. */
export function recordSectorSnapshot(sectorStats) {
    const now = Date.now();
    if (now - lastSampleTs < SAMPLE_MIN_GAP_MS) return;
    lastSampleTs = now;

    const snapshot = {};
    for (const [sector, s] of Object.entries(sectorStats || {})) {
        if (s?.avgPctFromOpen != null) snapshot[sector] = s.avgPctFromOpen;
    }
    history.push({ ts: now, stats: snapshot });
    if (history.length > HISTORY_MAX) history.shift();
}

/**
 * Change in a sector's avgPctFromOpen over the last `lookbackMinutes`
 * (approx, since sampling is throttled to ~1/min). Returns null if there
 * isn't enough history yet — genuinely "unknown," not zero.
 */
export function getSectorMomentum(sector, lookbackMinutes = 10) {
    if (history.length < 2) return null;
    const cutoff = Date.now() - lookbackMinutes * 60 * 1000;
    let pastSnapshot = null;
    for (const h of history) {
        if (h.ts <= cutoff) pastSnapshot = h;
        else break;
    }
    if (!pastSnapshot) pastSnapshot = history[0]; // not enough history for the full window — use the oldest we have
    const past = pastSnapshot.stats?.[sector];
    const current = history[history.length - 1].stats?.[sector];
    if (past == null || current == null) return null;
    return +(current - past).toFixed(2);
}

/** Test-only seam. */
export function _resetForTesting() {
    history = [];
    lastSampleTs = 0;
}
