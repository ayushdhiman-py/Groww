// ─────────────────────────────────────────────────────────────────────────────
// daily_learning_job.mjs — the ONCE-DAILY (never continuous) learning loop.
//
// Runs at a fixed IST wall-clock time (15:45 by default — 15 min after
// market close, buffering for EOD candle availability), guarded by the
// job_runs table so a process restart can't double-run or silently skip a
// day. Mirrors critical_monitor.mjs's setInterval-loop shape.
// ─────────────────────────────────────────────────────────────────────────────
import { getDb } from "./learning_db.mjs";
import { finalizeOutcomes, backfillTakenTrades } from "./learning_outcomes.mjs";
import { runDailyStatsRollup, detectDrift } from "./learning_stats.mjs";
import { proposeNewWeights, validateWeights, meetsPromotionCriteria } from "./model_registry.mjs";

export const DAILY_JOB_IST_HOUR = 15;
export const DAILY_JOB_IST_MINUTE = 45;
const CHECK_INTERVAL_MS = 60_000;

// Walk-forward split for the automatic (still non-promoting) weight
// proposal/validation step: train on all history up to (tradeDate - this
// many days), then validate on that most-recent holdout window.
const WEIGHT_VALIDATION_WINDOW_DAYS = 14;
// Raw per-candidate rows (snapshots/outcomes) older than this are pruned;
// aggregate/audit tables (rolling_stats, drift_log, model_versions,
// job_runs) are kept indefinitely — they're small and the whole point of
// model_versions/drift_log is a permanent history.
const RETENTION_DAYS = 180;

function todayIST() {
    const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    return `${ist.getFullYear()}-${String(ist.getMonth() + 1).padStart(2, "0")}-${String(ist.getDate()).padStart(2, "0")}`;
}

function daysBeforeIST(tradeDate, days) {
    const d = new Date(`${tradeDate}T00:00:00+05:30`);
    d.setDate(d.getDate() - days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * The nightly job's weight-adaptation step — proposes and immediately
 * validates a new PROPOSED model_versions row, but NEVER promotes it
 * (promotion is always a deliberate manual dashboard action). Skips quietly
 * whenever a PROPOSED version is already awaiting review, so this can't
 * pile up an ever-growing backlog of unreviewed proposals; a proposal that
 * demonstrably fails to beat production on validation is auto-marked
 * REJECTED so only genuinely promising candidates linger as PROPOSED.
 */
export function runWeightProposalStep(tradeDate) {
    const db = getDb();
    const pending = db.prepare("SELECT version_id FROM model_versions WHERE status = 'PROPOSED' LIMIT 1").get();
    if (pending) {
        return { ok: true, skipped: true, reason: "a PROPOSED version is already awaiting manual review", versionId: pending.version_id };
    }

    const validationFrom = daysBeforeIST(tradeDate, WEIGHT_VALIDATION_WINDOW_DAYS - 1);
    const trainingTo = daysBeforeIST(tradeDate, WEIGHT_VALIDATION_WINDOW_DAYS);
    const proposal = proposeNewWeights({ from: "2000-01-01", to: trainingTo }); // all available history up to the training cutoff
    if (!proposal.ok) return proposal; // typically "insufficient training samples" during ramp-up — expected, not an error

    const validation = validateWeights(proposal.versionId, { from: validationFrom, to: tradeDate });
    if (!validation.ok) return { ...proposal, validation };

    const criteria = meetsPromotionCriteria(proposal.versionId);
    if (!criteria.meets) {
        db.prepare("UPDATE model_versions SET status = 'REJECTED' WHERE version_id = ?").run(proposal.versionId);
    }
    return { ...proposal, validation, criteria };
}

/** Deletes raw snapshots/outcomes older than RETENTION_DAYS. outcomes first — its FK references snapshots(id). */
export function pruneOldData(tradeDate) {
    const db = getDb();
    const cutoff = daysBeforeIST(tradeDate, RETENTION_DAYS);
    const outcomesDeleted = db.prepare("DELETE FROM outcomes WHERE trade_date < ?").run(cutoff).changes;
    const snapshotsDeleted = db.prepare("DELETE FROM snapshots WHERE trade_date < ?").run(cutoff).changes;
    return { cutoff, outcomesDeleted, snapshotsDeleted };
}

let jobInFlight = false; // re-entrancy guard — a slow run must not overlap a second scheduler tick

/**
 * Runs the full nightly sequence for one trade_date. Idempotent: re-running
 * an already-OK day is a no-op unless `force`. Outcome finalization and the
 * statistical rollup/drift check are load-bearing (a failure there fails
 * the whole day); the weight-proposal and retention-pruning steps are each
 * wrapped in their own try/catch below — genuinely additive/optional, so a
 * bug in either can never mask the outcome-finalization work that already
 * succeeded.
 */
export async function runDailyLearningJob({ force = false, tradeDate = todayIST() } = {}) {
    if (jobInFlight) return { skipped: true, reason: "already running" };
    const db = getDb();

    if (!force) {
        const existing = db.prepare("SELECT status FROM job_runs WHERE run_date = ?").get(tradeDate);
        if (existing?.status === "OK") return { skipped: true, reason: "already ran", tradeDate };
    }

    jobInFlight = true;
    const startedAt = Date.now();
    db.prepare(`
        INSERT INTO job_runs (run_date, started_at, status) VALUES (?, ?, 'RUNNING')
        ON CONFLICT(run_date) DO UPDATE SET started_at = excluded.started_at, status = 'RUNNING', error = NULL
    `).run(tradeDate, startedAt);

    try {
        const outcomes = await finalizeOutcomes(tradeDate);
        const backfill = backfillTakenTrades(tradeDate);
        const statsRollup = runDailyStatsRollup(tradeDate);
        const drift = detectDrift(tradeDate);

        let weightProposal;
        try {
            weightProposal = runWeightProposalStep(tradeDate);
        } catch (e) {
            console.error("[DailyLearningJob] weight proposal step failed (non-fatal):", e.message);
            weightProposal = { ok: false, error: e.message };
        }

        let retention;
        try {
            retention = pruneOldData(tradeDate);
        } catch (e) {
            console.error("[DailyLearningJob] retention pruning failed (non-fatal):", e.message);
            retention = { ok: false, error: e.message };
        }

        db.prepare("UPDATE job_runs SET finished_at = ?, status = 'OK' WHERE run_date = ?").run(Date.now(), tradeDate);
        return { tradeDate, outcomes, backfill, statsRollup, drift, weightProposal, retention, durationMs: Date.now() - startedAt };
    } catch (e) {
        db.prepare("UPDATE job_runs SET finished_at = ?, status = 'FAILED', error = ? WHERE run_date = ?")
            .run(Date.now(), e.message, tradeDate);
        throw e;
    } finally {
        jobInFlight = false;
    }
}

let timer = null;

/** Idempotent — safe to call multiple times (e.g. on re-login). */
export function startDailyLearningScheduler() {
    if (timer) return;
    timer = setInterval(() => {
        const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
        if (ist.getHours() === DAILY_JOB_IST_HOUR && ist.getMinutes() >= DAILY_JOB_IST_MINUTE) {
            runDailyLearningJob().catch(e => console.error("[DailyLearningJob] run failed:", e.message));
        }
    }, CHECK_INTERVAL_MS);
    console.log(`[DailyLearningJob] Scheduler started — runs daily at ${DAILY_JOB_IST_HOUR}:${String(DAILY_JOB_IST_MINUTE).padStart(2, "0")} IST.`);
}

export function stopDailyLearningScheduler() {
    if (timer) { clearInterval(timer); timer = null; }
}
