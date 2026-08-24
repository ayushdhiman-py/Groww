import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../src/learning_db.mjs";
import {
    runDailyStatsRollup, detectDrift, getCalibratedProbability, attachCalibratedProbabilities,
    MIN_SAMPLE_SIZE, MIN_SAMPLE_SIZE_DRIFT, DRIFT_THRESHOLD_PP,
} from "../src/learning_stats.mjs";

const PREFIX = "STATTEST"; // isolates this file's synthetic symbols from other test files' data

afterEach(() => {
    const db = getDb();
    db.exec(`DELETE FROM outcomes WHERE symbol LIKE '${PREFIX}%'`);
    db.exec(`DELETE FROM snapshots WHERE symbol LIKE '${PREFIX}%'`);
    db.exec(`DELETE FROM rolling_stats WHERE segment_key LIKE 'regime:${PREFIX}%'`);
    db.exec(`DELETE FROM drift_log WHERE segment_key LIKE 'regime:${PREFIX}%'`);
});

let seq = 0;
let fillerSeq = 0;
/**
 * The RECENT window is "the last RECENT_WINDOW_TRADING_DAYS distinct trade
 * dates that have ANY snapshot row, <= as-of date" — not a calendar-day
 * cutoff. To genuinely push an older batch out of RECENT in a test, there
 * must be at least that many distinct intervening dates with data, so this
 * inserts throwaway filler rows (irrelevant regime, cleaned up in afterEach
 * like everything else) on each given date.
 */
function insertFillerDates(dates) {
    for (const d of dates) insertPair({ tradeDate: d, regime: `${PREFIX}_FILLER` });
}

/** Inserts one snapshot + its outcome directly, bypassing capture/finalize so segment membership is exact. */
function insertPair({ tradeDate, regime, timeBucket = "10:00-11:00", orbState = "INSIDE_RANGE", priceActionState = "NEUTRAL", reached1 = 0, reached2 = 0, reached2_5 = 0, reached5 = 0, majorReversal = 0, thesisFailure = 0, profitGiveback = 0 }) {
    seq++;
    const symbol = `${PREFIX}${seq}`;
    const db = getDb();
    const info = db.prepare(`
        INSERT INTO snapshots (trade_date, capture_ts, time_bucket, symbol, market_regime, orb_state, price_action_state, breakdown_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?)
    `).run(tradeDate, Date.now(), timeBucket, symbol, regime, orbState, priceActionState, Date.now());
    db.prepare(`
        INSERT INTO outcomes (snapshot_id, trade_date, symbol, reached_1pct, reached_2pct, reached_2_5pct, reached_5pct, major_reversal, thesis_failure, profit_giveback, finalized_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(info.lastInsertRowid, tradeDate, symbol, reached1, reached2, reached2_5, reached5, majorReversal, thesisFailure, profitGiveback, Date.now());
    return symbol;
}

test("runDailyStatsRollup marks a thin segment (below MIN_SAMPLE_SIZE) as insufficient, and a segment at/above it as sufficient", () => {
    const regime = `${PREFIX}_THIN`;
    for (let i = 0; i < 5; i++) insertPair({ tradeDate: "2026-01-10", regime, reached1: i < 4 ? 1 : 0 }); // 5 samples, 4 wins

    runDailyStatsRollup("2026-01-10");
    const row = getDb().prepare(`SELECT * FROM rolling_stats WHERE segment_key = ? AND window = 'HISTORICAL' AND as_of_date = '2026-01-10'`).get(`regime:${regime}`);
    assert.equal(row.sample_count, 5);
    assert.equal(row.win_rate, 0.8);
    assert.equal(row.sufficient_sample, 0); // below MIN_SAMPLE_SIZE despite a clean 80% win rate

    getDb().exec(`DELETE FROM outcomes WHERE symbol LIKE '${PREFIX}%'`);
    getDb().exec(`DELETE FROM snapshots WHERE symbol LIKE '${PREFIX}%'`);
    const regime2 = `${PREFIX}_ENOUGH`;
    for (let i = 0; i < MIN_SAMPLE_SIZE; i++) insertPair({ tradeDate: "2026-01-10", regime: regime2, reached1: i < 24 ? 1 : 0 }); // 30 samples, 24 wins

    runDailyStatsRollup("2026-01-10");
    const row2 = getDb().prepare(`SELECT * FROM rolling_stats WHERE segment_key = ? AND window = 'HISTORICAL' AND as_of_date = '2026-01-10'`).get(`regime:${regime2}`);
    assert.equal(row2.sample_count, MIN_SAMPLE_SIZE);
    assert.equal(row2.sufficient_sample, 1);
});

test("runDailyStatsRollup only computes the signal-combo level once its parent regime+bucket group clears MIN_SAMPLE_SIZE", () => {
    const regime = `${PREFIX}_COMBO`;
    // Only 10 samples in this regime+bucket — below MIN_SAMPLE_SIZE, so no combo-level row should exist.
    for (let i = 0; i < 10; i++) insertPair({ tradeDate: "2026-01-11", regime, orbState: "BROKEN_CONFIRMED", priceActionState: "BULLISH" });

    runDailyStatsRollup("2026-01-11");
    const comboRows = getDb().prepare(`SELECT * FROM rolling_stats WHERE segment_key LIKE ? AND as_of_date = '2026-01-11'`).all(`regime:${regime}|bucket:%|combo:%`);
    assert.equal(comboRows.length, 0);

    // Top it up past MIN_SAMPLE_SIZE — now the combo level should appear.
    for (let i = 0; i < MIN_SAMPLE_SIZE; i++) insertPair({ tradeDate: "2026-01-11", regime, orbState: "BROKEN_CONFIRMED", priceActionState: "BULLISH" });
    runDailyStatsRollup("2026-01-11");
    const comboRows2 = getDb().prepare(`SELECT * FROM rolling_stats WHERE segment_key LIKE ? AND as_of_date = '2026-01-11'`).all(`regime:${regime}|bucket:%|combo:%`);
    assert.ok(comboRows2.length >= 1);
    assert.equal(comboRows2[0].segment_key, `regime:${regime}|bucket:10:00-11:00|combo:BROKEN_CONFIRMED+BULLISH`);
});

test("runDailyStatsRollup's RECENT window excludes trade dates older than RECENT_WINDOW_TRADING_DAYS", () => {
    const regime = `${PREFIX}_WINDOW`;
    insertPair({ tradeDate: "2020-01-01", regime, reached1: 0 }); // ancient — must be excluded from RECENT
    insertFillerDates(["2026-01-20", "2026-01-21", "2026-01-22", "2026-01-23", "2026-01-24", "2026-01-25", "2026-01-26", "2026-01-27", "2026-01-28", "2026-01-29", "2026-01-30"]); // 11 intervening distinct dates pushes 2020-01-01 out of the last 10
    for (let i = 0; i < MIN_SAMPLE_SIZE; i++) insertPair({ tradeDate: "2026-02-01", regime, reached1: 1 }); // all on the as-of date itself

    runDailyStatsRollup("2026-02-01");
    const recent = getDb().prepare(`SELECT * FROM rolling_stats WHERE segment_key = ? AND window = 'RECENT' AND as_of_date = '2026-02-01'`).get(`regime:${regime}`);
    const historical = getDb().prepare(`SELECT * FROM rolling_stats WHERE segment_key = ? AND window = 'HISTORICAL' AND as_of_date = '2026-02-01'`).get(`regime:${regime}`);
    assert.equal(recent.sample_count, MIN_SAMPLE_SIZE); // the 2020 row excluded
    assert.equal(historical.sample_count, MIN_SAMPLE_SIZE + 1); // HISTORICAL includes it
});

test("detectDrift flags a segment whose RECENT win rate diverges from HISTORICAL by at least DRIFT_THRESHOLD_PP, given enough recent samples", () => {
    const regime = `${PREFIX}_DRIFT`;
    // Historical baseline: mostly on an old date, low win rate.
    for (let i = 0; i < MIN_SAMPLE_SIZE; i++) insertPair({ tradeDate: "2026-03-01", regime, reached1: i < 6 ? 1 : 0 }); // 20% win rate
    insertFillerDates(["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12"]); // pushes the 03-01 baseline out of RECENT
    // Recent: a fresh batch of much higher win rate, all on the as-of date, clearing MIN_SAMPLE_SIZE_DRIFT.
    for (let i = 0; i < MIN_SAMPLE_SIZE_DRIFT; i++) insertPair({ tradeDate: "2026-03-15", regime, reached1: i < 12 ? 1 : 0 }); // 80% win rate

    runDailyStatsRollup("2026-03-15");
    const result = detectDrift("2026-03-15");
    const flaggedSeg = result.flagged.find(f => f.segmentKey === `regime:${regime}`);
    assert.ok(flaggedSeg, "expected the regime segment to be flagged for drift");
    assert.ok(Math.abs(flaggedSeg.deltaPp) >= DRIFT_THRESHOLD_PP);
});

test("detectDrift does not compare a segment whose RECENT sample count is below MIN_SAMPLE_SIZE_DRIFT", () => {
    const regime = `${PREFIX}_NODRIFT`;
    for (let i = 0; i < MIN_SAMPLE_SIZE; i++) insertPair({ tradeDate: "2026-04-01", regime, reached1: 0 }); // historical, 0% win rate
    for (let i = 0; i < MIN_SAMPLE_SIZE_DRIFT - 1; i++) insertPair({ tradeDate: "2026-04-20", regime, reached1: 1 }); // recent, too few samples

    runDailyStatsRollup("2026-04-20");
    const result = detectDrift("2026-04-20");
    assert.equal(result.flagged.some(f => f.segmentKey === `regime:${regime}`), false);
});

test("getCalibratedProbability falls back from combo to bucket to regime, and reports unavailable when nothing is sufficient", () => {
    const regime = `${PREFIX}_CALIB`;
    for (let i = 0; i < MIN_SAMPLE_SIZE; i++) insertPair({ tradeDate: "2026-05-01", regime, timeBucket: "11:00-12:00", reached1: i < 15 ? 1 : 0 }); // regime+bucket sufficient, no combo-level split reaches MIN_SAMPLE_SIZE on its own within one orb/price-action combo
    runDailyStatsRollup("2026-05-01");

    const specific = getCalibratedProbability({ regime, timeBucket: "11:00-12:00", signalCombo: "BROKEN_CONFIRMED+BULLISH", asOfDate: "2026-05-01" });
    assert.equal(specific.available, true);
    assert.equal(specific.level, "regime+bucket"); // falls back past the nonexistent combo segment

    const noRegime = getCalibratedProbability({ regime: `${PREFIX}_NOTHING`, timeBucket: "11:00-12:00", asOfDate: "2026-05-01" });
    assert.equal(noRegime.available, false);
});

test("attachCalibratedProbabilities attaches a real win rate to a live row whose regime+bucket+signal-combo segment has enough history", () => {
    const regime = `${PREFIX}_LIVE`;
    const asOfDate = "2026-12-01"; // ahead of every other test's date in this file — guaranteed to be MAX(as_of_date)
    for (let i = 0; i < MIN_SAMPLE_SIZE; i++) {
        insertPair({
            tradeDate: asOfDate, regime, timeBucket: "10:00-11:00",
            orbState: "BROKEN_CONFIRMED", priceActionState: "BULLISH",
            reached1: i < 20 ? 1 : 0,
        });
    }
    runDailyStatsRollup(asOfDate);

    const priceTs = Date.parse(`${asOfDate}T10:15:00+05:30`); // falls in the 10:00-11:00 IST bucket
    const opportunities = [{
        symbol: "LIVEROW", priceTs,
        orb: { high: 100, brokenAbove: true, volConfirmed: true },     // -> orbStateOf: BROKEN_CONFIRMED
        structure: { bullishStructure: true },                          // -> priceActionStateOf: BULLISH
    }];
    attachCalibratedProbabilities(opportunities, { regime });

    const prob = opportunities[0].calibratedProbability;
    assert.equal(prob.available, true);
    assert.equal(prob.sampleCount, MIN_SAMPLE_SIZE);
    assert.equal(prob.probReach1pct, 0.6667); // 20/30
});

test("attachCalibratedProbabilities never fabricates a probability — unavailable for a row with no priceTs, and for a regime with no history", () => {
    const noTsRow = { symbol: "NOTS", priceTs: null, orb: {}, structure: {} };
    attachCalibratedProbabilities([noTsRow], { regime: `${PREFIX}_LIVE` });
    assert.equal(noTsRow.calibratedProbability.available, false);
    assert.equal(noTsRow.calibratedProbability.reason, "no capture timestamp");

    const unknownRegimeRow = { symbol: "NOHIST", priceTs: Date.now(), orb: {}, structure: {} };
    attachCalibratedProbabilities([unknownRegimeRow], { regime: `${PREFIX}_NEVERSEEN` });
    assert.equal(unknownRegimeRow.calibratedProbability.available, false);
});
