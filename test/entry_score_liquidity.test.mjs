import { test } from "node:test";
import assert from "node:assert/strict";
import { computeOpportunityScore } from "../src/entry_score.mjs";

function baseRow(overrides = {}) {
    return {
        symbol: "TESTSTOCK", sector: "OTHER", price: 100, volume: 200000, // traded value 20M — clears the traded-value gate cleanly
        atrPct: 2, pctFromOpen: 1, aboveSessionVwap: true, sessionVwapSlope: 0.1,
        structure: { insufficientData: true }, consolidation: {}, rejection: {}, orb: {},
        volSpike: false, volumeChange: 0, priceHist: [], emaBullAligned: false, macdBull: false,
        macdAbove: false, macdHistAccel: 0, rsi: 55,
        ...overrides,
    };
}

const ctx = { niftyRow: null, sectorStats: {} };

test("a wide real spread reduces the Opportunity Score via liquidityGate, even with high traded value", () => {
    const tight = computeOpportunityScore(baseRow({ spreadPct: 0.05 }), ctx, "5m");
    const wide = computeOpportunityScore(baseRow({ spreadPct: 0.5 }), ctx, "5m");
    assert.ok(wide.score < tight.score, `wide-spread score (${wide.score}) should be lower than tight-spread score (${tight.score})`);
    assert.ok(wide.gates.liquidity.note.includes("Spread"));
});

test("a missing spreadPct (not yet fetched this cycle) leaves the traded-value-only liquidity gate unchanged — never a hard requirement", () => {
    const withoutSpread = computeOpportunityScore(baseRow({ spreadPct: undefined }), ctx, "5m");
    const withTightSpread = computeOpportunityScore(baseRow({ spreadPct: 0.05 }), ctx, "5m");
    assert.equal(withoutSpread.score, withTightSpread.score, "a tight/normal spread and no spread data at all should score identically");
    assert.equal(withoutSpread.gates.liquidity.multiplier, 1.0);
});

test("a normal spread (<=0.15%) does not trigger any discount", () => {
    const result = computeOpportunityScore(baseRow({ spreadPct: 0.1 }), ctx, "5m");
    assert.equal(result.gates.liquidity.multiplier, 1.0);
    assert.equal(result.gates.liquidity.note, null);
});

test("low traded value still applies its own discount regardless of spread", () => {
    const result = computeOpportunityScore(baseRow({ volume: 100, spreadPct: 0.05 }), ctx, "5m"); // traded value = 10,000
    assert.ok(result.gates.liquidity.multiplier < 1.0);
    assert.ok(result.gates.liquidity.note.includes("Low traded value"));
});
