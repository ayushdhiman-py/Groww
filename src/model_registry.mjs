// ─────────────────────────────────────────────────────────────────────────────
// model_registry.mjs — weight adaptation for the Opportunity Score's 7
// scoring buckets. PROPOSED vs PRODUCTION, gated, MANUAL promotion only —
// per your explicit call, given real capital, this never auto-flips live
// scoring. A nightly job can compute and even validate a PROPOSED version
// (Phase 6), but only promoteModelVersion() (triggered by a human clicking
// the dashboard button) ever changes what entry_score.mjs actually uses.
//
// Not a neural network: a small hand-rolled logistic regression (one feature
// per scoring bucket, normalized — batch gradient descent,
// L2-regularized, fixed iterations, no external ML dependency) whose
// coefficients are converted into new bucket WEIGHTS, not used as a scoring
// formula themselves. DEFAULT_WEIGHTS mirrors entry_score.mjs's current
// hardcoded bucket max-scores exactly, so a freshly-seeded system (no
// PRODUCTION row yet) is numerically identical to pre-Phase-5 behavior.
// ─────────────────────────────────────────────────────────────────────────────
import { getDb } from "./learning_db.mjs";

export const DEFAULT_WEIGHTS = {
    priceAction: 20, openingStrength: 15, vwap: 15, orb: 15, volume: 15, relativeStrength: 15, confirmation: 10, orderFlow: 8,
};
const FEATURE_KEYS = Object.keys(DEFAULT_WEIGHTS);
const TOTAL_WEIGHT_BUDGET = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0); // 113 — kept constant across proposals so the score stays on a 0-100 scale

const MAX_WEIGHT_CHANGE_FRACTION = 0.25; // stability guard: no bucket can move more than ±25% from current production in one proposal
const IMPORTANCE_FLOOR = 0.05;           // a bucket whose learned coefficient is negative shrinks toward this floor, never toward zero or negative
const L2_LAMBDA = 0.01;
const LEARNING_RATE = 0.1;
const ITERATIONS = 500;
export const MIN_TRAINING_SAMPLES = 50;
export const MIN_VALIDATION_SAMPLES = 30;

// ── Production weight lookup — the ONLY thing entry_score.mjs depends on ──
let getProductionStmt = null;
/**
 * Returns the current PRODUCTION bucket weights, or DEFAULT_WEIGHTS if none
 * has ever been promoted, the row is malformed, or the DB is unavailable
 * for any reason. Must NEVER throw — this is called from computeOpportunityScore
 * on every scan row, and a learning-layer problem must never degrade the
 * live scanner's scoring.
 */
export function getProductionWeights() {
    try {
        if (!getProductionStmt) getProductionStmt = getDb().prepare("SELECT weights_json FROM model_versions WHERE status = 'PRODUCTION' LIMIT 1");
        const row = getProductionStmt.get();
        if (!row) return DEFAULT_WEIGHTS;
        const parsed = JSON.parse(row.weights_json);
        for (const k of FEATURE_KEYS) {
            if (typeof parsed[k] !== "number" || !Number.isFinite(parsed[k])) return DEFAULT_WEIGHTS;
        }
        return parsed;
    } catch (e) {
        console.error("[ModelRegistry] getProductionWeights failed, falling back to DEFAULT_WEIGHTS:", e.message);
        return DEFAULT_WEIGHTS;
    }
}

/**
 * The one piece of math shared between live scoring (entry_score.mjs) and
 * offline validation (validateWeights below) — scales each bucket's raw 0-N
 * sub-score by weight/DEFAULT_WEIGHTS[bucket] and normalizes to 0-100.
 * `bucketRawScores` accepts either `{key: {score, notes}}` (a live
 * computeOpportunityScore buckets object) or `{key: number}` (a breakdown_json
 * parsed from storage) — both shapes appear in this codebase.
 */
export function aggregateScore(bucketRawScores, weights = DEFAULT_WEIGHTS) {
    const maxRaw = FEATURE_KEYS.reduce((s, k) => s + (weights[k] ?? DEFAULT_WEIGHTS[k]), 0);
    if (!maxRaw) return 0;
    const raw = FEATURE_KEYS.reduce((s, k) => {
        const entry = bucketRawScores?.[k];
        const rawScore = typeof entry === "number" ? entry : (entry?.score ?? 0);
        const w = weights[k] ?? DEFAULT_WEIGHTS[k];
        return s + rawScore * (w / DEFAULT_WEIGHTS[k]);
    }, 0);
    return (raw / maxRaw) * 100;
}

function sigmoid(z) {
    return 1 / (1 + Math.exp(-z));
}

/** Batch gradient descent, L2-regularized, fixed iterations — deliberately simple, no convergence-detection complexity. */
function trainLogisticRegression(X, y, { iterations = ITERATIONS, learningRate = LEARNING_RATE, l2 = L2_LAMBDA } = {}) {
    const n = X.length;
    const d = X[0].length;
    const weights = new Array(d).fill(0);
    let bias = 0;
    for (let iter = 0; iter < iterations; iter++) {
        const gradW = new Array(d).fill(0);
        let gradB = 0;
        for (let i = 0; i < n; i++) {
            const z = bias + X[i].reduce((s, x, j) => s + x * weights[j], 0);
            const err = sigmoid(z) - y[i];
            for (let j = 0; j < d; j++) gradW[j] += err * X[i][j];
            gradB += err;
        }
        for (let j = 0; j < d; j++) weights[j] -= learningRate * (gradW[j] / n + l2 * weights[j]);
        bias -= learningRate * (gradB / n);
    }
    return { weights, bias };
}

function accuracyOf(X, y, weights, bias) {
    let correct = 0;
    for (let i = 0; i < X.length; i++) {
        const z = bias + X[i].reduce((s, x, j) => s + x * weights[j], 0);
        if ((sigmoid(z) >= 0.5 ? 1 : 0) === y[i]) correct++;
    }
    return +(correct / X.length).toFixed(4);
}

function pearsonCorrelation(xs, ys) {
    const n = xs.length;
    if (n < 2) return null;
    const meanX = xs.reduce((a, b) => a + b, 0) / n;
    const meanY = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, denX = 0, denY = 0;
    for (let i = 0; i < n; i++) {
        const dx = xs[i] - meanX, dy = ys[i] - meanY;
        num += dx * dy; denX += dx * dx; denY += dy * dy;
    }
    if (denX === 0 || denY === 0) return null;
    return +(num / Math.sqrt(denX * denY)).toFixed(4);
}

function clampToStabilityBand(proposed, currentProd) {
    const lo = currentProd * (1 - MAX_WEIGHT_CHANGE_FRACTION);
    const hi = currentProd * (1 + MAX_WEIGHT_CHANGE_FRACTION);
    return Math.min(Math.max(proposed, lo), hi);
}

function getVersionRow(versionId) {
    return getDb().prepare("SELECT * FROM model_versions WHERE version_id = ?").get(versionId);
}

function loadTrainingRows(from, to) {
    return getDb().prepare(`
        SELECT s.breakdown_json, o.reached_1pct
        FROM snapshots s JOIN outcomes o ON o.snapshot_id = s.id
        WHERE s.trade_date BETWEEN ? AND ? AND o.reached_1pct IS NOT NULL
    `).all(from, to);
}

/**
 * Trains on stored breakdown_json feature vectors (bucket sub-scores,
 * normalized to their own 0-1 scale) against reached_1pct labels for
 * [from, to], and inserts a new PROPOSED model_versions row. Never touches
 * PRODUCTION. Returns {ok:false, reason} rather than proposing anything off
 * too few samples to mean anything.
 */
export function proposeNewWeights({ from, to } = {}) {
    const rawRows = loadTrainingRows(from, to);
    const X = [], y = [];
    for (const r of rawRows) {
        let breakdown;
        try { breakdown = JSON.parse(r.breakdown_json); } catch { continue; }
        X.push(FEATURE_KEYS.map(k => {
            const raw = breakdown[k]?.score;
            return typeof raw === "number" ? raw / DEFAULT_WEIGHTS[k] : 0;
        }));
        y.push(r.reached_1pct);
    }

    if (X.length < MIN_TRAINING_SAMPLES) {
        return { ok: false, reason: "insufficient training samples", sampleCount: X.length, minRequired: MIN_TRAINING_SAMPLES };
    }

    const { weights: coefficients, bias } = trainLogisticRegression(X, y);
    const productionWeights = getProductionWeights();

    // Non-negative importances — a bucket the data says is anti-predictive
    // shrinks toward the floor; it's never amplified by taking abs().
    const importances = coefficients.map(c => Math.max(c, IMPORTANCE_FLOOR));
    const importanceSum = importances.reduce((a, b) => a + b, 0);

    const proposedWeights = {};
    FEATURE_KEYS.forEach((k, i) => {
        const rawProposed = TOTAL_WEIGHT_BUDGET * (importances[i] / importanceSum);
        const currentProd = productionWeights[k] ?? DEFAULT_WEIGHTS[k];
        proposedWeights[k] = +clampToStabilityBand(rawProposed, currentProd).toFixed(2);
    });

    const trainAccuracy = accuracyOf(X, y, coefficients, bias);
    const db = getDb();
    const info = db.prepare(`
        INSERT INTO model_versions (created_at, status, training_period_from, training_period_to, training_sample_count, weights_json, metrics_json)
        VALUES (?, 'PROPOSED', ?, ?, ?, ?, ?)
    `).run(Date.now(), from, to, X.length, JSON.stringify(proposedWeights), JSON.stringify({
        training: { accuracy: trainAccuracy, coefficients, bias, sampleCount: X.length },
    }));

    return { ok: true, versionId: info.lastInsertRowid, weights: proposedWeights, sampleCount: X.length, trainAccuracy };
}

/**
 * Re-scores stored (not re-fetched) validation-period snapshots under both
 * the proposed version's weights and current PRODUCTION weights, and
 * records the comparison on that model_versions row. No look-ahead risk and
 * no extra API calls — same discipline as backtest.mjs and learning_outcomes.mjs.
 */
export function validateWeights(versionId, { from, to } = {}) {
    const version = getVersionRow(versionId);
    if (!version) return { ok: false, reason: "version not found" };
    if (version.status !== "PROPOSED") return { ok: false, reason: `version status is ${version.status}, not PROPOSED` };

    const rawRows = loadTrainingRows(from, to);
    const proposedWeights = JSON.parse(version.weights_json);
    const productionWeights = getProductionWeights();

    const scoresProposed = [], scoresProduction = [], labels = [];
    for (const r of rawRows) {
        let breakdown;
        try { breakdown = JSON.parse(r.breakdown_json); } catch { continue; }
        scoresProposed.push(aggregateScore(breakdown, proposedWeights));
        scoresProduction.push(aggregateScore(breakdown, productionWeights));
        labels.push(r.reached_1pct);
    }

    if (scoresProposed.length < MIN_VALIDATION_SAMPLES) {
        return { ok: false, reason: "insufficient validation samples", sampleCount: scoresProposed.length, minRequired: MIN_VALIDATION_SAMPLES };
    }

    const winRateAt = (scores, thresh) => {
        const qualifying = labels.filter((_, i) => scores[i] >= thresh);
        if (!qualifying.length) return null;
        return +(qualifying.filter(l => l === 1).length / qualifying.length).toFixed(4);
    };

    const validation = {
        sampleCount: scoresProposed.length,
        proposedCorrelation: pearsonCorrelation(scoresProposed, labels),
        productionCorrelation: pearsonCorrelation(scoresProduction, labels),
        proposedWinRateAt70: winRateAt(scoresProposed, 70),
        productionWinRateAt70: winRateAt(scoresProduction, 70),
    };

    const existingMetrics = JSON.parse(version.metrics_json || "{}");
    getDb().prepare(`
        UPDATE model_versions SET validation_period_from = ?, validation_period_to = ?, validation_sample_count = ?, metrics_json = ?
        WHERE version_id = ?
    `).run(from, to, scoresProposed.length, JSON.stringify({ ...existingMetrics, validation }), versionId);

    return { ok: true, versionId, metrics: validation };
}

/**
 * Advisory only — never auto-promotes. A PROPOSED version meets promotion
 * criteria once it's been validated on enough samples and its validation-
 * period correlation with reached_1pct beats current PRODUCTION's.
 */
export function meetsPromotionCriteria(versionId) {
    const row = getVersionRow(versionId);
    if (!row) return { meets: false, reasons: ["version not found"] };
    if (row.status !== "PROPOSED") return { meets: false, reasons: [`status is ${row.status}, not PROPOSED`] };

    const metrics = JSON.parse(row.metrics_json || "{}");
    const reasons = [];
    if (!metrics.validation) {
        reasons.push("not yet validated");
    } else {
        if ((row.validation_sample_count ?? 0) < MIN_VALIDATION_SAMPLES) {
            reasons.push(`validation sample count ${row.validation_sample_count} below minimum ${MIN_VALIDATION_SAMPLES}`);
        }
        if (metrics.validation.proposedCorrelation == null || metrics.validation.productionCorrelation == null) {
            reasons.push("correlation could not be computed (degenerate sample)");
        } else if (!(metrics.validation.proposedCorrelation > metrics.validation.productionCorrelation)) {
            reasons.push("proposed weights did not outperform production on validation correlation");
        }
    }
    return { meets: reasons.length === 0, reasons, metrics: metrics.validation ?? null };
}

/** Flips PROPOSED -> PRODUCTION and demotes the prior PRODUCTION -> SUPERSEDED. The only thing that ever changes live scoring — always a manual, explicit call. */
export function promoteModelVersion(versionId, { promotedBy = "manual" } = {}) {
    const row = getVersionRow(versionId);
    if (!row) throw new Error(`model version ${versionId} not found`);
    if (row.status !== "PROPOSED") throw new Error(`only a PROPOSED version can be promoted (current status: ${row.status})`);

    const db = getDb();
    const now = Date.now();
    db.exec("BEGIN");
    try {
        db.prepare("UPDATE model_versions SET status = 'SUPERSEDED' WHERE status = 'PRODUCTION'").run();
        db.prepare("UPDATE model_versions SET status = 'PRODUCTION', promoted_at = ?, promoted_by = ? WHERE version_id = ?").run(now, promotedBy, versionId);
        db.exec("COMMIT");
    } catch (e) {
        db.exec("ROLLBACK");
        throw e;
    }
    return getVersionRow(versionId);
}

/** Re-promotes an older (SUPERSEDED/REJECTED) version — same operation as promote, in reverse, explicitly logged as a rollback. */
export function rollbackToVersion(versionId, { promotedBy = "manual-rollback" } = {}) {
    const row = getVersionRow(versionId);
    if (!row) throw new Error(`model version ${versionId} not found`);
    if (row.status === "PRODUCTION") throw new Error("version is already PRODUCTION");

    const db = getDb();
    const now = Date.now();
    db.exec("BEGIN");
    try {
        db.prepare("UPDATE model_versions SET status = 'SUPERSEDED' WHERE status = 'PRODUCTION'").run();
        db.prepare(`
            UPDATE model_versions SET status = 'PRODUCTION', promoted_at = ?, promoted_by = ?,
                notes = TRIM(COALESCE(notes, '') || ' [rolled back to]')
            WHERE version_id = ?
        `).run(now, promotedBy, versionId);
        db.exec("COMMIT");
    } catch (e) {
        db.exec("ROLLBACK");
        throw e;
    }
    return getVersionRow(versionId);
}
