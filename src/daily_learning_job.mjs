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

export const DAILY_JOB_IST_HOUR = 15;
export const DAILY_JOB_IST_MINUTE = 45;
const CHECK_INTERVAL_MS = 60_000;

function todayIST() {
    const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    return `${ist.getFullYear()}-${String(ist.getMonth() + 1).padStart(2, "0")}-${String(ist.getDate()).padStart(2, "0")}`;
}

let jobInFlight = false; // re-entrancy guard — a slow run must not overlap a second scheduler tick

/**
 * Runs the full nightly sequence for one trade_date. Idempotent: re-running
 * an already-OK day is a no-op unless `force`. Phase 5/6 steps (weight
 * proposal/validation, retention pruning) are appended here as later phases
 * land — this phase does outcome finalization + the statistical rollup/
 * drift check.
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

        db.prepare("UPDATE job_runs SET finished_at = ?, status = 'OK' WHERE run_date = ?").run(Date.now(), tradeDate);
        return { tradeDate, outcomes, backfill, statsRollup, drift, durationMs: Date.now() - startedAt };
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
