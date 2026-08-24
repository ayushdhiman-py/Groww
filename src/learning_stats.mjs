// ─────────────────────────────────────────────────────────────────────────────
// learning_stats.mjs — the statistical layer: rolling win rates + calibrated
// probabilities per (market_regime, time_bucket, signal_combo) segment, plus
// drift detection between a RECENT and HISTORICAL window.
//
// Deliberately NOT a trained model (that's model_registry.mjs, a later
// phase) — this is descriptive statistics over stored outcomes, grouped from
// coarse to fine, with a hard minimum-sample-size gate at every level so a
// thin segment can never masquerade as a confident number.
// ─────────────────────────────────────────────────────────────────────────────
import { getDb } from "./learning_db.mjs";
import { istTimeBucket, orbStateOf, priceActionStateOf } from "./learning_capture.mjs";

export const MIN_SAMPLE_SIZE = 30;          // gate for trusting a rolling_stats row, and for unlocking the signal-combo level
export const MIN_SAMPLE_SIZE_DRIFT = 15;    // lower bar for even comparing a segment's drift (comparison, not a standalone probability)
export const RECENT_WINDOW_TRADING_DAYS = 10;
export const DRIFT_THRESHOLD_PP = 15;       // percentage-point win-rate delta, RECENT vs HISTORICAL, to flag as drift

function groupBy(rows, keyFn) {
    const m = new Map();
    for (const r of rows) {
        const k = keyFn(r);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(r);
    }
    return m;
}

// Best available proxy for "signal interaction" learning without inventing
// a new taxonomy: the two categorical fields entry_score.mjs already treats
// as structurally distinct (breakout state vs. price-structure state).
function signalComboOf(row) {
    return `${row.orb_state ?? "NA"}+${row.price_action_state ?? "NA"}`;
}

function rateOf(rows, field) {
    const valid = rows.filter(r => r[field] != null);
    if (!valid.length) return null;
    return +(valid.filter(r => r[field] === 1).length / valid.length).toFixed(4);
}

function computeStats(rows) {
    // "Win" is defined as reaching at least +1% MFE from the snapshot price —
    // the loosest rung of the reached_Xpct ladder, i.e. "moved favorably at
    // all." A judgment call, easy to redefine later once real data exists.
    return {
        sampleCount: rows.length,
        winRate: rateOf(rows, "reached_1pct"),
        probReach1pct: rateOf(rows, "reached_1pct"),
        probReach2pct: rateOf(rows, "reached_2pct"),
        probReach2_5pct: rateOf(rows, "reached_2_5pct"),
        probReach5pct: rateOf(rows, "reached_5pct"),
        probMajorAdverse: rateOf(rows, "major_reversal"),
        // No dedicated "momentum deterioration" outcome label exists yet —
        // thesis_failure (never ran up, closed meaningfully below snapshot)
        // is the closest available proxy.
        probMomentumDeterioration: rateOf(rows, "thesis_failure"),
        probProfitGiveback: rateOf(rows, "profit_giveback"),
    };
}

let upsertStmt = null;
function getUpsertStmt() {
    if (upsertStmt) return upsertStmt;
    upsertStmt = getDb().prepare(`
        INSERT INTO rolling_stats (
            as_of_date, segment_key, segment_json, window, sample_count, win_rate,
            prob_reach_1pct, prob_reach_2pct, prob_reach_2_5pct, prob_reach_5pct,
            prob_major_adverse, prob_momentum_deterioration, prob_profit_giveback,
            sufficient_sample, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(as_of_date, segment_key, window) DO UPDATE SET
            segment_json = excluded.segment_json, sample_count = excluded.sample_count,
            win_rate = excluded.win_rate, prob_reach_1pct = excluded.prob_reach_1pct,
            prob_reach_2pct = excluded.prob_reach_2pct, prob_reach_2_5pct = excluded.prob_reach_2_5pct,
            prob_reach_5pct = excluded.prob_reach_5pct, prob_major_adverse = excluded.prob_major_adverse,
            prob_momentum_deterioration = excluded.prob_momentum_deterioration,
            prob_profit_giveback = excluded.prob_profit_giveback,
            sufficient_sample = excluded.sufficient_sample, created_at = excluded.created_at
    `);
    return upsertStmt;
}

/**
 * Recomputes every rolling_stats row as of `tradeDate`, for both the RECENT
 * (last RECENT_WINDOW_TRADING_DAYS distinct trade dates with data, <=
 * tradeDate) and HISTORICAL (all-time, <= tradeDate) windows. Segments
 * nest coarse-to-fine: regime alone -> regime+time_bucket -> +signal_combo
 * (only computed once the regime+time_bucket group itself already clears
 * MIN_SAMPLE_SIZE, so a signal-combo split of an already-thin bucket can't
 * produce a spuriously "sufficient" sub-segment).
 */
export function runDailyStatsRollup(tradeDate) {
    const db = getDb();
    const stmt = getUpsertStmt();

    const distinctDates = db.prepare(`
        SELECT DISTINCT trade_date FROM snapshots WHERE trade_date <= ?
        ORDER BY trade_date DESC LIMIT ?
    `).all(tradeDate, RECENT_WINDOW_TRADING_DAYS).map(r => r.trade_date);
    const recentCutoff = distinctDates.length ? distinctDates[distinctDates.length - 1] : tradeDate;

    const allRows = db.prepare(`
        SELECT s.market_regime, s.time_bucket, s.orb_state, s.price_action_state, s.trade_date,
               o.reached_1pct, o.reached_2pct, o.reached_2_5pct, o.reached_5pct,
               o.major_reversal, o.thesis_failure, o.profit_giveback
        FROM snapshots s JOIN outcomes o ON o.snapshot_id = s.id
        WHERE s.trade_date <= ?
    `).all(tradeDate);
    const recentRows = allRows.filter(r => r.trade_date >= recentCutoff);

    function writeSegment(segmentKey, segmentObj, windowName, rows) {
        if (!rows.length) return;
        const stats = computeStats(rows);
        stmt.run(
            tradeDate, segmentKey, JSON.stringify(segmentObj), windowName, stats.sampleCount, stats.winRate,
            stats.probReach1pct, stats.probReach2pct, stats.probReach2_5pct, stats.probReach5pct,
            stats.probMajorAdverse, stats.probMomentumDeterioration, stats.probProfitGiveback,
            stats.sampleCount >= MIN_SAMPLE_SIZE ? 1 : 0, Date.now()
        );
    }

    function rollupWindow(rows, windowName) {
        const byRegime = groupBy(rows, r => r.market_regime ?? "UNKNOWN");
        for (const [regime, regimeRows] of byRegime) {
            writeSegment(`regime:${regime}`, { regime }, windowName, regimeRows);

            const byBucket = groupBy(regimeRows, r => r.time_bucket ?? "UNKNOWN");
            for (const [bucket, bucketRows] of byBucket) {
                const bucketKey = `regime:${regime}|bucket:${bucket}`;
                writeSegment(bucketKey, { regime, timeBucket: bucket }, windowName, bucketRows);

                if (bucketRows.length >= MIN_SAMPLE_SIZE) {
                    const byCombo = groupBy(bucketRows, signalComboOf);
                    for (const [combo, comboRows] of byCombo) {
                        writeSegment(`${bucketKey}|combo:${combo}`, { regime, timeBucket: bucket, signalCombo: combo }, windowName, comboRows);
                    }
                }
            }
        }
    }

    rollupWindow(recentRows, "RECENT");
    rollupWindow(allRows, "HISTORICAL");

    return { asOfDate: tradeDate, recentSampleTotal: recentRows.length, historicalSampleTotal: allRows.length, recentCutoff };
}

let insertDriftStmt = null;
function getInsertDriftStmt() {
    if (insertDriftStmt) return insertDriftStmt;
    insertDriftStmt = getDb().prepare(`
        INSERT INTO drift_log (checked_at, segment_key, recent_win_rate, historical_win_rate, delta,
            recent_sample_count, historical_sample_count, flagged, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return insertDriftStmt;
}

/**
 * Compares each segment's RECENT vs HISTORICAL win rate as of `tradeDate`
 * (must be called after runDailyStatsRollup has written that date's rows).
 * A segment is only even compared once its RECENT sample size clears
 * MIN_SAMPLE_SIZE_DRIFT (a lower bar than trusting the number standalone —
 * this is a relative comparison, not a fresh probability estimate), and is
 * flagged only when the divergence is large enough to matter.
 */
export function detectDrift(tradeDate) {
    const db = getDb();
    const recent = db.prepare(`SELECT * FROM rolling_stats WHERE as_of_date = ? AND window = 'RECENT'`).all(tradeDate);
    const historicalBySegment = new Map(
        db.prepare(`SELECT * FROM rolling_stats WHERE as_of_date = ? AND window = 'HISTORICAL'`).all(tradeDate)
            .map(r => [r.segment_key, r])
    );
    const stmt = getInsertDriftStmt();
    const flagged = [];
    let checked = 0;

    for (const r of recent) {
        if (r.win_rate == null || r.sample_count < MIN_SAMPLE_SIZE_DRIFT) continue;
        const hist = historicalBySegment.get(r.segment_key);
        if (!hist || hist.win_rate == null) continue;

        checked++;
        const deltaPp = +((r.win_rate - hist.win_rate) * 100).toFixed(1);
        const isFlagged = Math.abs(deltaPp) >= DRIFT_THRESHOLD_PP;
        const notes = isFlagged
            ? `Recent win rate diverges ${deltaPp}pp from historical (n=${r.sample_count} recent, n=${hist.sample_count} historical)`
            : null;
        stmt.run(Date.now(), r.segment_key, r.win_rate, hist.win_rate, deltaPp, r.sample_count, hist.sample_count, isFlagged ? 1 : 0, notes);
        if (isFlagged) flagged.push({ segmentKey: r.segment_key, deltaPp, recentSampleCount: r.sample_count, historicalSampleCount: hist.sample_count });
    }
    return { checked, flagged };
}

/**
 * Looks up the calibrated probability for a candidate's segment, falling
 * back from the most specific match (regime+bucket+signalCombo) to
 * successively coarser ones, and within each specificity level preferring
 * RECENT over HISTORICAL — but only ever returning a segment whose
 * `sufficient_sample` flag is set. Returns `{available:false}` rather than
 * a number when nothing at any level clears the bar, exactly like
 * entry_score.mjs's applyUpsideCalibration pattern: never fabricate
 * confidence a thin sample doesn't support.
 */
export function getCalibratedProbability({ regime, timeBucket, signalCombo, asOfDate } = {}) {
    const db = getDb();
    const latestDate = asOfDate ?? db.prepare(`SELECT MAX(as_of_date) d FROM rolling_stats`).get()?.d;
    if (!latestDate) return { available: false, reason: "no rolling stats computed yet" };

    const candidates = [];
    if (regime && timeBucket && signalCombo) {
        candidates.push({ segmentKey: `regime:${regime}|bucket:${timeBucket}|combo:${signalCombo}`, level: "regime+bucket+combo" });
    }
    if (regime && timeBucket) {
        candidates.push({ segmentKey: `regime:${regime}|bucket:${timeBucket}`, level: "regime+bucket" });
    }
    if (regime) {
        candidates.push({ segmentKey: `regime:${regime}`, level: "regime" });
    }

    const getStmt = db.prepare(`SELECT * FROM rolling_stats WHERE as_of_date = ? AND segment_key = ? AND window = ?`);
    for (const { segmentKey, level } of candidates) {
        for (const windowName of ["RECENT", "HISTORICAL"]) {
            const row = getStmt.get(latestDate, segmentKey, windowName);
            if (row && row.sufficient_sample) {
                return {
                    available: true, level, window: windowName, segmentKey, asOfDate: latestDate,
                    sampleCount: row.sample_count, winRate: row.win_rate,
                    probReach1pct: row.prob_reach_1pct, probReach2pct: row.prob_reach_2pct,
                    probReach2_5pct: row.prob_reach_2_5pct, probReach5pct: row.prob_reach_5pct,
                    probMajorAdverse: row.prob_major_adverse, probMomentumDeterioration: row.prob_momentum_deterioration,
                    probProfitGiveback: row.prob_profit_giveback,
                };
            }
        }
    }
    return { available: false, reason: "no segment at any specificity level has sufficient sample size", asOfDate: latestDate };
}

/**
 * Attaches a `calibratedProbability` field to each live Intraday Opportunity
 * row, looked up from the SAME segment classification learning_capture.mjs
 * uses when storing snapshots (regime + time-of-day bucket + orb/price-
 * action signal combo) — so a live row's lookup lands on exactly the
 * segment its own eventual snapshot would be filed under. This is what
 * turns "Opportunity Score 83" into an honest "historically reached +1% in
 * 62% of 45 similar past cases" — or, before enough history exists,
 * `{available:false}` rather than a fabricated number.
 *
 * Mutates each row in place. Never throws — a DB problem here must
 * degrade to `{available:false}` for that row, never break the live scan.
 */
export function attachCalibratedProbabilities(opportunities, marketRegime) {
    const regime = marketRegime?.regime ?? null;
    for (const p of opportunities || []) {
        try {
            if (p.priceTs == null) {
                p.calibratedProbability = { available: false, reason: "no capture timestamp" };
                continue;
            }
            const timeBucket = istTimeBucket(p.priceTs);
            const signalCombo = `${orbStateOf(p.orb)}+${priceActionStateOf(p.structure)}`;
            p.calibratedProbability = getCalibratedProbability({ regime, timeBucket, signalCombo });
        } catch (e) {
            p.calibratedProbability = { available: false, reason: "lookup failed" };
        }
    }
    return opportunities;
}

export { signalComboOf };
