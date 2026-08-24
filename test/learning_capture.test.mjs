import { test } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../src/learning_db.mjs";
import { captureQualifyingSnapshots, istTimeBucket } from "../src/learning_capture.mjs";
import { classifyExhaustionRisk } from "../src/price_action.mjs";

function qualifyingRow(symbol, overrides = {}) {
    return {
        symbol, sector: "OTHER", tf: "5m",
        price: 105, priceTs: Date.parse("2026-08-24T04:30:00Z"), // ~10:00 IST
        dayOpen: 100, pctFromOpen: 5, vwap: 103, sessionVwap: 103, relativeVolume: 2,
        rsi: 60, macdVal: 1.2, macdHist: 0.3, ema9: 104, ema21: 102, ema50: 100, atrPct: 2,
        orb: { high: 101, brokenAbove: true, volConfirmed: true, retested: false },
        structure: { insufficientData: false, bullishStructure: true },
        opportunityScore: 85, opportunityBand: "STRONG", entryAttractiveness: 80,
        upside: { zoneHighPct: 4, remainingPct: 4, confidence: "MEDIUM" },
        opportunityBreakdown: { priceAction: 15, vwap: 10 },
        ...overrides,
    };
}

function fixture({ score5 = 85, score15 = 85 } = {}) {
    return {
        "5m_ALL": [qualifyingRow("TESTA", { opportunityScore: score5 }), { symbol: "NIFTY", sector: "INDEX" }],
        "15m_ALL": [qualifyingRow("TESTA", { opportunityScore: score15 }), { symbol: "NIFTY", sector: "INDEX", pctFromOpen: 0.5 }],
    };
}

function cleanup() {
    getDb().exec("DELETE FROM snapshots WHERE symbol = 'TESTA'");
}

test("classifyExhaustionRisk thresholds match the documented breakpoints", () => {
    assert.equal(classifyExhaustionRisk({ pctFromOpen: 1, atrPct: 2 }).level, "MEDIUM"); // 0.5
    assert.equal(classifyExhaustionRisk({ pctFromOpen: 3, atrPct: 2 }).level, "HIGH");   // 1.5
    assert.equal(classifyExhaustionRisk({ pctFromOpen: 0.5, atrPct: 2 }).level, "LOW");  // 0.25
    assert.equal(classifyExhaustionRisk({ pctFromOpen: null, atrPct: 2 }).level, "LOW");
    assert.equal(classifyExhaustionRisk({ pctFromOpen: 1, atrPct: null }).level, "LOW");
});

test("istTimeBucket maps to one of the 5 spec-defined windows", () => {
    assert.equal(istTimeBucket(Date.parse("2026-08-24T03:45:00Z")), "09:15-10:00"); // 9:15 IST
    assert.equal(istTimeBucket(Date.parse("2026-08-24T05:30:00Z")), "11:00-12:00"); // 11:00 IST
    assert.equal(istTimeBucket(Date.parse("2026-08-24T08:00:00Z")), "13:30-15:00"); // 13:30 IST
});

test("captureQualifyingSnapshots stores a candidate that clears the 5m+15m confluence gate", () => {
    cleanup();
    captureQualifyingSnapshots(fixture(), { regime: "BULLISH" }, 70);
    const rows = getDb().prepare("SELECT * FROM snapshots WHERE symbol = 'TESTA'").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].opportunity_score, 85);
    assert.equal(rows[0].market_regime, "BULLISH");
    assert.ok(JSON.parse(rows[0].breakdown_json).priceAction === 15);
    cleanup();
});

test("captureQualifyingSnapshots does NOT store a candidate that fails the confluence gate on either timeframe", () => {
    cleanup();
    captureQualifyingSnapshots(fixture({ score15: 40 }), { regime: "BULLISH" }, 70);
    const rows = getDb().prepare("SELECT * FROM snapshots WHERE symbol = 'TESTA'").all();
    assert.equal(rows.length, 0);
    cleanup();
});

test("captureQualifyingSnapshots deduplicates within the same (trade_date, symbol, time_bucket) — repeated calls don't create duplicate rows", () => {
    cleanup();
    const data = fixture();
    captureQualifyingSnapshots(data, { regime: "BULLISH" }, 70);
    captureQualifyingSnapshots(data, { regime: "BULLISH" }, 70); // same cycle data, called again
    const rows = getDb().prepare("SELECT * FROM snapshots WHERE symbol = 'TESTA'").all();
    assert.equal(rows.length, 1);
    cleanup();
});

test("captureQualifyingSnapshots never throws, even when given malformed input — it's optional instrumentation, not a hard dependency", () => {
    assert.doesNotThrow(() => captureQualifyingSnapshots(null, null, 70));
    assert.doesNotThrow(() => captureQualifyingSnapshots({ "5m_ALL": [{ symbol: "BROKEN" }] }, {}, 70));
});

test("captureQualifyingSnapshots skips a row with no priceTs rather than fabricating a capture timestamp", () => {
    cleanup();
    const data = fixture();
    data["5m_ALL"][0].priceTs = null;
    captureQualifyingSnapshots(data, { regime: "BULLISH" }, 70);
    const rows = getDb().prepare("SELECT * FROM snapshots WHERE symbol = 'TESTA'").all();
    assert.equal(rows.length, 0);
    cleanup();
});
