import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../src/learning_db.mjs";
import {
    DEFAULT_WEIGHTS, getProductionWeights, aggregateScore,
    proposeNewWeights, validateWeights, meetsPromotionCriteria,
    promoteModelVersion, rollbackToVersion,
    MIN_TRAINING_SAMPLES, MIN_VALIDATION_SAMPLES,
} from "../src/model_registry.mjs";

const PREFIX = "MODELTEST";

afterEach(() => {
    const db = getDb();
    db.exec(`DELETE FROM outcomes WHERE symbol LIKE '${PREFIX}%'`);
    db.exec(`DELETE FROM snapshots WHERE symbol LIKE '${PREFIX}%'`);
    db.exec("DELETE FROM model_versions"); // this test file owns model_versions exclusively during its run
});

let seq = 0;
/** breakdownOverrides: {bucketKey: rawScore} — any bucket not specified defaults to 0. */
function insertPair({ tradeDate = "2026-06-01", breakdownOverrides = {}, reached1 = 0 }) {
    seq++;
    const symbol = `${PREFIX}${seq}`;
    const db = getDb();
    const breakdown = {};
    for (const k of Object.keys(DEFAULT_WEIGHTS)) breakdown[k] = { score: breakdownOverrides[k] ?? 0, notes: [] };
    const info = db.prepare(`
        INSERT INTO snapshots (trade_date, capture_ts, time_bucket, symbol, breakdown_json, created_at)
        VALUES (?, ?, '10:00-11:00', ?, ?, ?)
    `).run(tradeDate, Date.now(), symbol, JSON.stringify(breakdown), Date.now());
    db.prepare(`
        INSERT INTO outcomes (snapshot_id, trade_date, symbol, reached_1pct, finalized_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(info.lastInsertRowid, tradeDate, symbol, reached1, Date.now());
    return symbol;
}

test("getProductionWeights returns DEFAULT_WEIGHTS when no PRODUCTION version exists", () => {
    getDb().exec("DELETE FROM model_versions");
    assert.deepEqual(getProductionWeights(), DEFAULT_WEIGHTS);
});

test("getProductionWeights returns a promoted version's weights, and falls back to DEFAULT_WEIGHTS for a malformed row", () => {
    const db = getDb();
    db.exec("DELETE FROM model_versions");
    const custom = { ...DEFAULT_WEIGHTS, priceAction: 22, confirmation: 8 };
    db.prepare("INSERT INTO model_versions (created_at, status, weights_json) VALUES (?, 'PRODUCTION', ?)").run(Date.now(), JSON.stringify(custom));
    assert.deepEqual(getProductionWeights(), custom);

    db.exec("DELETE FROM model_versions");
    db.prepare("INSERT INTO model_versions (created_at, status, weights_json) VALUES (?, 'PRODUCTION', ?)").run(Date.now(), JSON.stringify({ priceAction: 22 })); // missing keys
    assert.deepEqual(getProductionWeights(), DEFAULT_WEIGHTS);
});

test("aggregateScore with DEFAULT_WEIGHTS reproduces the plain raw/105*100 formula exactly (inertness)", () => {
    const buckets = { priceAction: { score: 10 }, openingStrength: { score: 8 }, vwap: { score: 5 }, orb: { score: 15 }, volume: { score: 0 }, relativeStrength: { score: 15 }, confirmation: { score: 5 } };
    const rawSum = 10 + 8 + 5 + 15 + 0 + 15 + 5;
    const expected = (rawSum / 105) * 100;
    assert.equal(aggregateScore(buckets, DEFAULT_WEIGHTS), expected);
});

test("aggregateScore accepts a plain-number breakdown (as parsed from storage) the same as a {score,notes} object", () => {
    const asObjects = { priceAction: { score: 10 }, openingStrength: { score: 0 }, vwap: { score: 0 }, orb: { score: 0 }, volume: { score: 0 }, relativeStrength: { score: 0 }, confirmation: { score: 0 } };
    const asNumbers = { priceAction: 10, openingStrength: 0, vwap: 0, orb: 0, volume: 0, relativeStrength: 0, confirmation: 0 };
    assert.equal(aggregateScore(asObjects, DEFAULT_WEIGHTS), aggregateScore(asNumbers, DEFAULT_WEIGHTS));
});

test("proposeNewWeights refuses to propose off fewer than MIN_TRAINING_SAMPLES", () => {
    for (let i = 0; i < 5; i++) insertPair({ breakdownOverrides: { priceAction: 20 }, reached1: 1 });
    const result = proposeNewWeights({ from: "2026-06-01", to: "2026-06-01" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "insufficient training samples");
});

test("proposeNewWeights converges toward weighting a clearly predictive bucket more than a noise bucket, on a synthetic separable dataset", () => {
    // priceAction is a PERFECT predictor of reached_1pct (high score -> win, low score -> loss).
    // confirmation is pure noise, uncorrelated with the label.
    for (let i = 0; i < MIN_TRAINING_SAMPLES; i++) {
        const win = i % 2 === 0;
        insertPair({
            breakdownOverrides: { priceAction: win ? 20 : 0, confirmation: i % 3 === 0 ? 10 : 0 },
            reached1: win ? 1 : 0,
        });
    }
    const result = proposeNewWeights({ from: "2026-06-01", to: "2026-06-01" });
    assert.equal(result.ok, true);
    assert.equal(result.sampleCount, MIN_TRAINING_SAMPLES);
    assert.ok(result.weights.priceAction > result.weights.confirmation,
        `expected priceAction (${result.weights.priceAction}) to outweigh confirmation (${result.weights.confirmation}) given it perfectly predicts the label`);
});

test("proposeNewWeights never moves a bucket's weight more than the ±25% stability cap from current PRODUCTION", () => {
    const db = getDb();
    db.exec("DELETE FROM model_versions");
    // Seed a PRODUCTION version with a below-default priceAction weight, so the cap is the binding constraint even for a strongly predictive bucket.
    const prodWeights = { ...DEFAULT_WEIGHTS, priceAction: 10 };
    db.prepare("INSERT INTO model_versions (created_at, status, weights_json) VALUES (?, 'PRODUCTION', ?)").run(Date.now(), JSON.stringify(prodWeights));

    for (let i = 0; i < MIN_TRAINING_SAMPLES; i++) {
        const win = i % 2 === 0;
        insertPair({ breakdownOverrides: { priceAction: win ? 20 : 0 }, reached1: win ? 1 : 0 });
    }
    const result = proposeNewWeights({ from: "2026-06-01", to: "2026-06-01" });
    assert.equal(result.ok, true);
    assert.ok(result.weights.priceAction <= 10 * 1.25 + 1e-6, `priceAction weight ${result.weights.priceAction} exceeds the +25% cap from production (10)`);
});

test("validateWeights refuses off fewer than MIN_VALIDATION_SAMPLES, and requires the version to be PROPOSED", () => {
    const db = getDb();
    db.exec("DELETE FROM model_versions");
    const info = db.prepare("INSERT INTO model_versions (created_at, status, weights_json) VALUES (?, 'PROPOSED', ?)").run(Date.now(), JSON.stringify(DEFAULT_WEIGHTS));
    for (let i = 0; i < 5; i++) insertPair({ tradeDate: "2026-06-15", reached1: 1 });
    const tooFew = validateWeights(info.lastInsertRowid, { from: "2026-06-15", to: "2026-06-15" });
    assert.equal(tooFew.ok, false);
    assert.equal(tooFew.reason, "insufficient validation samples");

    const nonexistent = validateWeights(999999, { from: "2026-06-15", to: "2026-06-15" });
    assert.equal(nonexistent.ok, false);
});

test("validateWeights reports a higher correlation for weights that actually track the label better on the validation set", () => {
    const db = getDb();
    db.exec("DELETE FROM model_versions");
    // Proposed weights emphasize priceAction (the truly predictive bucket); production weights are the flat default.
    const proposed = { ...DEFAULT_WEIGHTS, priceAction: 60, openingStrength: 5, vwap: 5, orb: 5, volume: 5, relativeStrength: 5, confirmation: 5 };
    const info = db.prepare("INSERT INTO model_versions (created_at, status, weights_json) VALUES (?, 'PROPOSED', ?)").run(Date.now(), JSON.stringify(proposed));

    for (let i = 0; i < MIN_VALIDATION_SAMPLES; i++) {
        const win = i % 2 === 0;
        // priceAction perfectly predicts the label; every other bucket is randomized noise uncorrelated with it.
        insertPair({
            tradeDate: "2026-06-20",
            breakdownOverrides: { priceAction: win ? 20 : 0, vwap: (i * 7) % 15, volume: (i * 3) % 15 },
            reached1: win ? 1 : 0,
        });
    }
    const result = validateWeights(info.lastInsertRowid, { from: "2026-06-20", to: "2026-06-20" });
    assert.equal(result.ok, true);
    assert.ok(result.metrics.proposedCorrelation > result.metrics.productionCorrelation,
        `expected proposed (${result.metrics.proposedCorrelation}) to beat production (${result.metrics.productionCorrelation})`);
});

test("meetsPromotionCriteria is false before validation, and reflects the validation outcome afterward", () => {
    const db = getDb();
    db.exec("DELETE FROM model_versions");
    const proposed = { ...DEFAULT_WEIGHTS, priceAction: 60, openingStrength: 5, vwap: 5, orb: 5, volume: 5, relativeStrength: 5, confirmation: 5 };
    const info = db.prepare("INSERT INTO model_versions (created_at, status, weights_json) VALUES (?, 'PROPOSED', ?)").run(Date.now(), JSON.stringify(proposed));
    const versionId = info.lastInsertRowid;

    const beforeValidation = meetsPromotionCriteria(versionId);
    assert.equal(beforeValidation.meets, false);
    assert.ok(beforeValidation.reasons.includes("not yet validated"));

    for (let i = 0; i < MIN_VALIDATION_SAMPLES; i++) {
        const win = i % 2 === 0;
        // Noise in the other buckets dilutes production's equal-weighted
        // correlation but barely touches proposed's (which nearly ignores
        // them) — without this, every unspecified bucket defaults to a
        // constant 0 and both weight sets end up perfectly (and equally)
        // correlated with the label, since only priceAction varies at all.
        insertPair({
            tradeDate: "2026-06-25",
            breakdownOverrides: { priceAction: win ? 20 : 0, vwap: (i * 7) % 15, volume: (i * 3) % 15 },
            reached1: win ? 1 : 0,
        });
    }
    validateWeights(versionId, { from: "2026-06-25", to: "2026-06-25" });
    const afterValidation = meetsPromotionCriteria(versionId);
    assert.equal(afterValidation.meets, true, JSON.stringify(afterValidation.reasons));
});

test("promoteModelVersion flips PROPOSED to PRODUCTION and demotes the prior PRODUCTION to SUPERSEDED; refuses a non-PROPOSED version", () => {
    const db = getDb();
    db.exec("DELETE FROM model_versions");
    const oldProd = db.prepare("INSERT INTO model_versions (created_at, status, weights_json) VALUES (?, 'PRODUCTION', ?)").run(Date.now(), JSON.stringify(DEFAULT_WEIGHTS));
    const proposal = db.prepare("INSERT INTO model_versions (created_at, status, weights_json) VALUES (?, 'PROPOSED', ?)").run(Date.now(), JSON.stringify(DEFAULT_WEIGHTS));

    const promoted = promoteModelVersion(proposal.lastInsertRowid);
    assert.equal(promoted.status, "PRODUCTION");
    assert.ok(promoted.promoted_at);

    const demoted = db.prepare("SELECT * FROM model_versions WHERE version_id = ?").get(oldProd.lastInsertRowid);
    assert.equal(demoted.status, "SUPERSEDED");

    assert.throws(() => promoteModelVersion(oldProd.lastInsertRowid), /only a PROPOSED version can be promoted/);
    assert.throws(() => promoteModelVersion(999999), /not found/);
});

test("rollbackToVersion re-promotes an older SUPERSEDED version and demotes the current PRODUCTION", () => {
    const db = getDb();
    db.exec("DELETE FROM model_versions");
    const v1 = db.prepare("INSERT INTO model_versions (created_at, status, weights_json) VALUES (?, 'SUPERSEDED', ?)").run(Date.now(), JSON.stringify(DEFAULT_WEIGHTS));
    const v2 = db.prepare("INSERT INTO model_versions (created_at, status, weights_json) VALUES (?, 'PRODUCTION', ?)").run(Date.now(), JSON.stringify({ ...DEFAULT_WEIGHTS, priceAction: 25 }));

    const rolledBack = rollbackToVersion(v1.lastInsertRowid);
    assert.equal(rolledBack.status, "PRODUCTION");
    assert.match(rolledBack.notes || "", /rolled back to/);

    const nowSuperseded = db.prepare("SELECT * FROM model_versions WHERE version_id = ?").get(v2.lastInsertRowid);
    assert.equal(nowSuperseded.status, "SUPERSEDED");

    assert.throws(() => rollbackToVersion(v1.lastInsertRowid), /already PRODUCTION/);
});
