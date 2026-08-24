import { test } from "node:test";
import assert from "node:assert/strict";
import { computeUpsideCalibration } from "../src/backtest.mjs";
import { applyUpsideCalibration } from "../src/entry_score.mjs";

function trade({ upsideConfidence, upsideZoneHighPct, mfePct }) {
    return { upsideConfidence, upsideZoneHighPct, mfePct };
}

test("computeUpsideCalibration buckets trades by confidence label and computes hit rate (mfePct >= upsideZoneHighPct)", () => {
    const trades = [
        trade({ upsideConfidence: "HIGH", upsideZoneHighPct: 3, mfePct: 4 }),   // hit
        trade({ upsideConfidence: "HIGH", upsideZoneHighPct: 3, mfePct: 1 }),   // miss
        trade({ upsideConfidence: "LOW", upsideZoneHighPct: 2, mfePct: 2.5 }),  // hit
    ];
    const cal = computeUpsideCalibration(trades);
    assert.equal(cal.HIGH.count, 2);
    assert.equal(cal.HIGH.hitRate, 0.5);
    assert.equal(cal.LOW.count, 1);
    assert.equal(cal.LOW.hitRate, 1);
    assert.equal(cal.MEDIUM.count, 0);
    assert.equal(cal.MEDIUM.hitRate, null);
});

test("computeUpsideCalibration marks a bucket sufficientSample:false below the minimum sample size, true at/above it", () => {
    const trades = Array.from({ length: 19 }, () => trade({ upsideConfidence: "HIGH", upsideZoneHighPct: 3, mfePct: 4 }));
    let cal = computeUpsideCalibration(trades);
    assert.equal(cal.HIGH.sufficientSample, false);

    trades.push(trade({ upsideConfidence: "HIGH", upsideZoneHighPct: 3, mfePct: 4 })); // 20th
    cal = computeUpsideCalibration(trades);
    assert.equal(cal.HIGH.sufficientSample, true);
});

test("applyUpsideCalibration never adjusts anything when the bucket has an insufficient sample (model safety fallback)", () => {
    const calibration = { byConfidence: { HIGH: { count: 5, hitRate: 0.1, sufficientSample: false } } };
    const result = applyUpsideCalibration("HIGH", calibration);
    assert.equal(result.confidence, "HIGH");
    assert.equal(result.note, null);
});

test("applyUpsideCalibration never adjusts anything when there's no calibration file at all", () => {
    assert.deepEqual(applyUpsideCalibration("HIGH", null), { confidence: "HIGH", note: null });
    assert.deepEqual(applyUpsideCalibration("MEDIUM", undefined), { confidence: "MEDIUM", note: null });
});

test("applyUpsideCalibration downgrades HIGH to MEDIUM when the historical hit rate is poor with a sufficient sample", () => {
    const calibration = { byConfidence: { HIGH: { count: 40, hitRate: 0.25, sufficientSample: true } } };
    const result = applyUpsideCalibration("HIGH", calibration);
    assert.equal(result.confidence, "MEDIUM");
    assert.ok(result.note.includes("downgraded to MEDIUM"));
});

test("applyUpsideCalibration downgrades MEDIUM to LOW (never skips a level or goes below LOW)", () => {
    const calibration = { byConfidence: { MEDIUM: { count: 30, hitRate: 0.2, sufficientSample: true } } };
    const result = applyUpsideCalibration("MEDIUM", calibration);
    assert.equal(result.confidence, "LOW");
});

test("applyUpsideCalibration never upgrades a label even with a strong historical hit rate — only confirms it", () => {
    const calibration = { byConfidence: { LOW: { count: 50, hitRate: 0.9, sufficientSample: true } } };
    const result = applyUpsideCalibration("LOW", calibration);
    assert.equal(result.confidence, "LOW", "LOW must never be upgraded to MEDIUM/HIGH by calibration");
    assert.ok(result.note.includes("historically reached this zone"));
});

test("applyUpsideCalibration leaves a mid-range hit rate (neither poor nor strong) unadjusted with no note", () => {
    const calibration = { byConfidence: { HIGH: { count: 40, hitRate: 0.55, sufficientSample: true } } };
    const result = applyUpsideCalibration("HIGH", calibration);
    assert.equal(result.confidence, "HIGH");
    assert.equal(result.note, null);
});
