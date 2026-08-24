import { test } from "node:test";
import assert from "node:assert/strict";
import { getDb, closeDb } from "../src/learning_db.mjs";

test("getDb() creates all 6 learning-layer tables idempotently", () => {
    const db = getDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    for (const expected of ["snapshots", "outcomes", "model_versions", "rolling_stats", "drift_log", "job_runs"]) {
        assert.ok(tables.includes(expected), `missing table: ${expected}`);
    }
});

test("getDb() returns the same singleton instance on repeated calls", () => {
    const a = getDb();
    const b = getDb();
    assert.equal(a, b);
});

test("re-opening after closeDb() works and schema is still intact (idempotent CREATE TABLE IF NOT EXISTS)", () => {
    closeDb();
    const db = getDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    assert.ok(tables.includes("snapshots"));
});

test("only one model_versions row can have status='PRODUCTION' at a time (partial unique index)", () => {
    const db = getDb();
    db.exec("DELETE FROM model_versions"); // isolate this test from any real data
    const insert = db.prepare("INSERT INTO model_versions (created_at, status, weights_json) VALUES (?, ?, ?)");
    insert.run(Date.now(), "PRODUCTION", "{}");
    assert.throws(() => insert.run(Date.now(), "PRODUCTION", "{}"), /UNIQUE constraint failed/);
    // A second PROPOSED row is fine — the constraint only applies to PRODUCTION.
    assert.doesNotThrow(() => insert.run(Date.now(), "PROPOSED", "{}"));
    db.exec("DELETE FROM model_versions");
});

test("snapshots table rejects a duplicate (trade_date, symbol, time_bucket) via its unique index", () => {
    const db = getDb();
    db.exec("DELETE FROM snapshots WHERE symbol = 'TESTDEDUP'");
    const insert = db.prepare(`INSERT INTO snapshots (trade_date, capture_ts, time_bucket, symbol, breakdown_json, created_at)
                                VALUES (?, ?, ?, ?, ?, ?)`);
    insert.run("2026-08-24", Date.now(), "09:15-10:00", "TESTDEDUP", "{}", Date.now());
    assert.throws(() => insert.run("2026-08-24", Date.now(), "09:15-10:00", "TESTDEDUP", "{}", Date.now()), /UNIQUE constraint failed/);
    db.exec("DELETE FROM snapshots WHERE symbol = 'TESTDEDUP'");
});
