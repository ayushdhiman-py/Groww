import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { getDb } from "../src/learning_db.mjs";
import { runDailyLearningJob } from "../src/daily_learning_job.mjs";
import { istTimeBucket } from "../src/learning_capture.mjs";
import { markCritical, deleteCriticalTrade } from "../src/critical_trades.mjs";

const TEST_DATE = "2026-08-19"; // isolated from other test files' fixed dates

afterEach(() => {
    mock.restoreAll();
    getDb().exec(`DELETE FROM job_runs WHERE run_date = '${TEST_DATE}'`);
});

test("runDailyLearningJob records a job_runs row and marks it OK when nothing is pending", async () => {
    mock.method(axios, "get", async () => ({ data: { status: "success", data: { candles: [] } } }));
    const result = await runDailyLearningJob({ tradeDate: TEST_DATE });
    assert.equal(result.skipped, undefined);
    assert.equal(result.tradeDate, TEST_DATE);

    const row = getDb().prepare("SELECT * FROM job_runs WHERE run_date = ?").get(TEST_DATE);
    assert.equal(row.status, "OK");
    assert.ok(row.finished_at >= row.started_at);
});

test("runDailyLearningJob skips an already-OK day unless force:true", async () => {
    mock.method(axios, "get", async () => ({ data: { status: "success", data: { candles: [] } } }));
    await runDailyLearningJob({ tradeDate: TEST_DATE }); // first run -> OK

    const second = await runDailyLearningJob({ tradeDate: TEST_DATE });
    assert.equal(second.skipped, true);
    assert.equal(second.reason, "already ran");

    const third = await runDailyLearningJob({ tradeDate: TEST_DATE, force: true });
    assert.notEqual(third.skipped, true); // force bypasses the "already ran" guard
});

test("runDailyLearningJob completes OK on a day with nothing pending even if the network is completely down", () => {
    // finalizeOutcomes only calls fetchCandles for symbols with pending
    // snapshots — with none pending, a total network outage can't affect
    // this run at all. Confirms the job doesn't spuriously fail on a quiet day.
    mock.method(axios, "get", async () => { throw new Error("simulated network failure"); });
    return runDailyLearningJob({ tradeDate: TEST_DATE }).then(result => {
        assert.equal(result.tradeDate, TEST_DATE);
        const row = getDb().prepare("SELECT * FROM job_runs WHERE run_date = ?").get(TEST_DATE);
        assert.equal(row.status, "OK");
    });
});

test("runDailyLearningJob marks job_runs FAILED (never silently swallowed) when a step genuinely throws", async () => {
    const db = getDb();
    // finalizeOutcomes' own per-symbol AND per-snapshot try/catch swallows
    // candle-fetch and insert failures by design (one bad symbol shouldn't
    // abort the whole day — already covered by the "network down" test
    // above), so a trigger on `outcomes` INSERT can never surface here.
    // backfillTakenTrades has no such internal try/catch, so a genuine
    // failure there IS what should take down the whole job — use a
    // session-local TEMP TRIGGER on its `snapshots` UPDATE instead. Temp
    // triggers are connection-scoped and auto-drop on close, so this can't
    // leak into the persistent schema even if cleanup below is skipped.
    let trade;
    try {
        trade = markCritical({
            symbol: "JOBFAILTEST", entryPrice: 100, quantity: 1,
            entryTime: `${TEST_DATE}T10:00:00+05:30`,
        });
        const bucket = istTimeBucket(Date.parse(trade.entryTime));
        db.prepare(`INSERT INTO snapshots (trade_date, capture_ts, time_bucket, symbol, ltp, open, breakdown_json, created_at)
                    VALUES (?, ?, ?, 'JOBFAILTEST', 100, 98, '{}', ?)`)
          .run(TEST_DATE, Date.parse(trade.entryTime), bucket, Date.now());
        db.exec(`
            CREATE TEMP TRIGGER IF NOT EXISTS block_jobfailtest_update
            BEFORE UPDATE ON snapshots
            WHEN NEW.symbol = 'JOBFAILTEST'
            BEGIN SELECT RAISE(ABORT, 'simulated backfill update failure'); END;
        `);
        mock.method(axios, "get", async () => ({ data: { status: "success", data: { candles: [] } } }));

        await assert.rejects(() => runDailyLearningJob({ tradeDate: TEST_DATE }));
        const row = db.prepare("SELECT * FROM job_runs WHERE run_date = ?").get(TEST_DATE);
        assert.equal(row.status, "FAILED");
        assert.ok(row.error);
    } finally {
        db.exec("DROP TRIGGER IF EXISTS block_jobfailtest_update");
        db.exec("DELETE FROM snapshots WHERE symbol = 'JOBFAILTEST'");
        if (trade) deleteCriticalTrade(trade.id);
    }
});
