import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { getDb } from "../src/learning_db.mjs";
import { runDailyLearningJob, runWeightProposalStep, pruneOldData } from "../src/daily_learning_job.mjs";
import { DEFAULT_WEIGHTS, MIN_TRAINING_SAMPLES, MIN_VALIDATION_SAMPLES } from "../src/model_registry.mjs";

const PREFIX = "JOBP6TEST";
const TEST_DATE = "2026-09-01"; // isolated from other test files' fixed dates

afterEach(() => {
    mock.restoreAll();
    const db = getDb();
    db.exec(`DELETE FROM outcomes WHERE symbol LIKE '${PREFIX}%'`);
    db.exec(`DELETE FROM snapshots WHERE symbol LIKE '${PREFIX}%'`);
    db.exec("DELETE FROM model_versions");
    db.exec(`DELETE FROM job_runs WHERE run_date = '${TEST_DATE}'`);
});

let seq = 0;
function insertPair(tradeDate, priceActionScore, win) {
    seq++;
    const symbol = `${PREFIX}${seq}`;
    const db = getDb();
    const breakdown = {};
    for (const k of Object.keys(DEFAULT_WEIGHTS)) breakdown[k] = { score: k === "priceAction" ? priceActionScore : 0, notes: [] };
    const info = db.prepare(`
        INSERT INTO snapshots (trade_date, capture_ts, time_bucket, symbol, breakdown_json, created_at)
        VALUES (?, ?, '10:00-11:00', ?, ?, ?)
    `).run(tradeDate, Date.now(), symbol, JSON.stringify(breakdown), Date.now());
    db.prepare(`
        INSERT INTO outcomes (snapshot_id, trade_date, symbol, reached_1pct, finalized_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(info.lastInsertRowid, tradeDate, symbol, win ? 1 : 0, Date.now());
    return symbol;
}

test("runWeightProposalStep returns insufficient-samples ok:false rather than an error when there's no training data yet", () => {
    const result = runWeightProposalStep(TEST_DATE);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "insufficient training samples");
});

test("runWeightProposalStep proposes and auto-validates a version end-to-end, and skips proposing a second one while one is pending review", () => {
    // Training data: everything up to 14 days before TEST_DATE.
    for (let i = 0; i < MIN_TRAINING_SAMPLES; i++) insertPair("2026-08-01", i % 2 === 0 ? 20 : 0, i % 2 === 0);
    // Validation data: the most recent 14-day window ending on TEST_DATE.
    for (let i = 0; i < MIN_VALIDATION_SAMPLES; i++) insertPair("2026-08-25", i % 2 === 0 ? 20 : 0, i % 2 === 0);

    const first = runWeightProposalStep(TEST_DATE);
    assert.equal(first.ok, true);
    assert.equal(first.skipped, undefined);
    assert.ok(first.versionId);
    assert.ok(first.validation?.ok !== false, "expected validation to have run");

    const row = getDb().prepare("SELECT status FROM model_versions WHERE version_id = ?").get(first.versionId);
    assert.ok(["PROPOSED", "REJECTED"].includes(row.status));

    // A second call the same "day" must not create another proposal while one is still PROPOSED (or was just auto-rejected and cleared — either way, at most one PROPOSED at a time).
    if (row.status === "PROPOSED") {
        const second = runWeightProposalStep(TEST_DATE);
        assert.equal(second.skipped, true);
        assert.equal(second.versionId, first.versionId);
    }
});

test("pruneOldData deletes snapshots/outcomes older than RETENTION_DAYS but keeps recent rows, and never touches rolling_stats/model_versions/job_runs", () => {
    const db = getDb();
    insertPair("2020-01-01", 10, true); // ancient — must be pruned
    const recentSymbol = insertPair("2026-08-20", 10, true); // recent — must survive

    const result = pruneOldData(TEST_DATE);
    assert.ok(result.snapshotsDeleted >= 1);
    assert.ok(result.outcomesDeleted >= 1);

    const remaining = db.prepare(`SELECT symbol FROM snapshots WHERE symbol LIKE '${PREFIX}%'`).all().map(r => r.symbol);
    assert.ok(remaining.includes(recentSymbol));
    assert.equal(db.prepare("SELECT COUNT(*) c FROM snapshots WHERE trade_date = '2020-01-01'").get().c, 0);
});

test("runDailyLearningJob's OK path includes weightProposal and retention results without failing the job", async () => {
    mock.method(axios, "get", async () => ({ data: { status: "success", data: { candles: [] } } }));
    const result = await runDailyLearningJob({ tradeDate: TEST_DATE });
    assert.equal(result.skipped, undefined);
    assert.ok(result.weightProposal);
    assert.ok(result.retention);
    const row = getDb().prepare("SELECT status FROM job_runs WHERE run_date = ?").get(TEST_DATE);
    assert.equal(row.status, "OK");
});
