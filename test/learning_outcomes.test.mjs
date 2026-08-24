import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { _setMapsForTesting } from "../src/instruments.mjs";
import { getDb } from "../src/learning_db.mjs";
import { finalizeOutcomes, backfillTakenTrades, OUTCOME_THRESHOLDS } from "../src/learning_outcomes.mjs";

afterEach(() => { mock.restoreAll(); cleanup(); });

function cleanup() {
    const db = getDb();
    // outcomes.snapshot_id references snapshots(id) — must delete the
    // referencing table first or the FK constraint rejects the parent delete.
    db.exec("DELETE FROM outcomes WHERE symbol = 'OUTTEST'");
    db.exec("DELETE FROM snapshots WHERE symbol = 'OUTTEST'");
}

// All timestamps below are literal IST wall-clock times ("+05:30" is the
// offset of the literal time written, not a UTC time to be shifted) —
// 10:00 IST is the snapshot capture, 10:35 IST is "shortly after", 15:25 IST
// is "near the close."
const CAPTURE_TS = Date.parse("2026-08-20T10:00:00+05:30");

function insertSnapshot({ tradeDate = "2026-08-20", captureTs = CAPTURE_TS, ltp = 100, open = 98 }) {
    const db = getDb();
    const stmt = db.prepare(`
        INSERT INTO snapshots (trade_date, capture_ts, time_bucket, symbol, ltp, open, breakdown_json, created_at)
        VALUES (?, ?, '09:15-10:00', 'OUTTEST', ?, ?, '{}', ?)
    `);
    const info = stmt.run(tradeDate, captureTs, ltp, open, Date.now());
    return info.lastInsertRowid;
}

function mockCandlesFor(candleSpecs) {
    // candleSpecs: [{ tsIso, high, low, close }] — open is irrelevant to
    // finalizeOutcomes' own math (only high/low/close are used), so reuse
    // close for it.
    mock.method(axios, "get", async () => ({
        data: {
            status: "success",
            data: {
                candles: candleSpecs.map(c => [c.tsIso, c.close, c.high, c.low, c.close, 1000]),
            },
        },
    }));
}

test("finalizeOutcomes computes MFE/MAE/final_close relative to the snapshot's OWN capture price, not the day's open", async () => {
    _setMapsForTesting([{ symbol: "OUTTEST", instrumentKey: "NSE_EQ|OUTTEST" }]);
    insertSnapshot({ ltp: 100 });

    mockCandlesFor([
        { tsIso: "2026-08-20T09:30:00+05:30", high: 99, low: 97, close: 98 },    // before capture — must be excluded from MFE/MAE
        { tsIso: "2026-08-20T10:35:00+05:30", high: 108, low: 100, close: 105 }, // peak high after capture
        { tsIso: "2026-08-20T15:25:00+05:30", high: 106, low: 103, close: 104 }, // final close of the day
    ]);

    const result = await finalizeOutcomes("2026-08-20");
    assert.equal(result.finalized, 1);

    const outcome = getDb().prepare("SELECT * FROM outcomes WHERE symbol = 'OUTTEST'").get();
    assert.equal(outcome.final_close, 104);
    assert.equal(outcome.maximum_high, 108); // NOT 99 from the pre-capture candle
    assert.equal(outcome.mfe_pct, 8); // (108-100)/100*100
    assert.equal(outcome.reached_5pct, 1);
    assert.equal(outcome.reached_2pct, 1);
});

test("finalizeOutcomes derives reached_1/2/2.5/5pct as a monotonic ladder from mfe_pct", async () => {
    _setMapsForTesting([{ symbol: "OUTTEST", instrumentKey: "NSE_EQ|OUTTEST" }]);
    insertSnapshot({ ltp: 100 });
    mockCandlesFor([{ tsIso: "2026-08-20T10:35:00+05:30", high: 102, low: 99, close: 101 }]); // MFE = 2%

    await finalizeOutcomes("2026-08-20");
    const outcome = getDb().prepare("SELECT * FROM outcomes WHERE symbol = 'OUTTEST'").get();
    assert.equal(outcome.reached_1pct, 1);
    assert.equal(outcome.reached_2pct, 1);
    assert.equal(outcome.reached_2_5pct, 0);
    assert.equal(outcome.reached_5pct, 0);
});

test("finalizeOutcomes flags major_reversal only when it ran up meaningfully AND still closed meaningfully below the snapshot price", async () => {
    _setMapsForTesting([{ symbol: "OUTTEST", instrumentKey: "NSE_EQ|OUTTEST" }]);
    insertSnapshot({ ltp: 100 });
    // Ran up to 103 (MFE 3%, clears the 1.5% min) then collapsed to close at 98 (-2%, clears the -1% max).
    mockCandlesFor([
        { tsIso: "2026-08-20T10:35:00+05:30", high: 103, low: 100, close: 102 },
        { tsIso: "2026-08-20T15:25:00+05:30", high: 99, low: 97, close: 98 },
    ]);

    await finalizeOutcomes("2026-08-20");
    const outcome = getDb().prepare("SELECT * FROM outcomes WHERE symbol = 'OUTTEST'").get();
    assert.equal(outcome.mfe_pct, 3);
    assert.equal(outcome.close_vs_snapshot_pct, -2);
    assert.equal(outcome.major_reversal, 1);
    assert.equal(outcome.thesis_failure, 0); // it DID run up meaningfully, so thesis_failure's "never ran up" condition fails
});

test("finalizeOutcomes flags thesis_failure when it never ran up AND closed meaningfully below the snapshot price", async () => {
    _setMapsForTesting([{ symbol: "OUTTEST", instrumentKey: "NSE_EQ|OUTTEST" }]);
    insertSnapshot({ ltp: 100 });
    mockCandlesFor([{ tsIso: "2026-08-20T15:25:00+05:30", high: 100.2, low: 96, close: 97 }]); // MFE only 0.2%, close -3%

    await finalizeOutcomes("2026-08-20");
    const outcome = getDb().prepare("SELECT * FROM outcomes WHERE symbol = 'OUTTEST'").get();
    assert.equal(outcome.thesis_failure, 1);
    assert.equal(outcome.major_reversal, 0); // never ran up enough to be a "reversal from strength"
});

test("finalizeOutcomes flags profit_giveback when a real peak move gave back most of its gain by close", async () => {
    _setMapsForTesting([{ symbol: "OUTTEST", instrumentKey: "NSE_EQ|OUTTEST" }]);
    insertSnapshot({ ltp: 100 });
    // Peak at 105 (+5%, well above the 1% min-peak threshold), closes at 100.5
    // — gave back (105-100.5)/(105-100) = 90% of the peak move.
    mockCandlesFor([
        { tsIso: "2026-08-20T10:35:00+05:30", high: 105, low: 100, close: 103 },
        { tsIso: "2026-08-20T15:25:00+05:30", high: 101, low: 100, close: 100.5 },
    ]);

    await finalizeOutcomes("2026-08-20");
    const outcome = getDb().prepare("SELECT * FROM outcomes WHERE symbol = 'OUTTEST'").get();
    assert.equal(outcome.profit_giveback, 1);
});

test("finalizeOutcomes is idempotent — re-running does not duplicate or change outcome rows", async () => {
    _setMapsForTesting([{ symbol: "OUTTEST", instrumentKey: "NSE_EQ|OUTTEST" }]);
    insertSnapshot({ ltp: 100 });
    mockCandlesFor([{ tsIso: "2026-08-20T15:25:00+05:30", high: 102, low: 99, close: 101 }]);

    const first = await finalizeOutcomes("2026-08-20");
    const second = await finalizeOutcomes("2026-08-20"); // nothing left pending this time
    assert.equal(first.finalized, 1);
    assert.equal(second.finalized, 0);
    const rows = getDb().prepare("SELECT * FROM outcomes WHERE symbol = 'OUTTEST'").all();
    assert.equal(rows.length, 1);
});

test("finalizeOutcomes skips (does not fabricate) a snapshot when no candles exist for that symbol/day", async () => {
    _setMapsForTesting([{ symbol: "OUTTEST", instrumentKey: "NSE_EQ|OUTTEST" }]);
    insertSnapshot({ ltp: 100 });
    mock.method(axios, "get", async () => ({ data: { status: "success", data: { candles: [] } } }));

    const result = await finalizeOutcomes("2026-08-20");
    assert.equal(result.finalized, 0);
    assert.equal(result.skipped, 1);
    assert.equal(getDb().prepare("SELECT COUNT(*) c FROM outcomes WHERE symbol = 'OUTTEST'").get().c, 0);
});
