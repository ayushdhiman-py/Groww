import { test } from "node:test";
import assert from "node:assert/strict";
import { selectStage2Symbols } from "../src/stage1_filter.mjs";

function fakeSnapshot(rows) {
    return new Map(rows.map(r => [r.symbol, {
        symbol: r.symbol, sector: r.sector ?? "OTHER", cheapScore: r.cheapScore ?? 0,
        chgPctCheap: null, aboveVwapCheap: null, pctFromOpenCheap: null, relVolumeCheap: null,
        priceFreshness: "LIVE", candleAgeMs: 0, lastDeepScanAt: r.lastDeepScanAt ?? 0,
    }]));
}

test("selectStage2Symbols always includes INDEX-sector symbols regardless of cheap score", () => {
    const snapshot = fakeSnapshot([
        { symbol: "NIFTY", sector: "INDEX", cheapScore: -999 },
        { symbol: "RANDOMSTOCK", sector: "OTHER", cheapScore: -999 },
    ]);
    const selected = selectStage2Symbols(snapshot, { topN: 0, rotationSize: 0 });
    assert.ok(selected.includes("NIFTY"));
});

test("selectStage2Symbols always includes active Critical-trade symbols even with a terrible cheap score", () => {
    const snapshot = fakeSnapshot([
        { symbol: "MYCRITICALTRADE", sector: "OTHER", cheapScore: -999 },
        { symbol: "OTHERSTOCK", sector: "OTHER", cheapScore: 100 },
    ]);
    const selected = selectStage2Symbols(snapshot, { activeCriticalSymbols: ["MYCRITICALTRADE"], topN: 1, rotationSize: 0 });
    assert.ok(selected.includes("MYCRITICALTRADE"));
});

test("selectStage2Symbols selects top-N by cheap score", () => {
    const snapshot = fakeSnapshot([
        { symbol: "A", cheapScore: 10 }, { symbol: "B", cheapScore: 50 },
        { symbol: "C", cheapScore: 30 }, { symbol: "D", cheapScore: 5 },
    ]);
    const selected = selectStage2Symbols(snapshot, { topN: 2, rotationSize: 0 });
    assert.deepEqual(new Set(selected), new Set(["B", "C"]));
});

test("selectStage2Symbols' fairness rotation picks the oldest/never-deep-scanned symbols first — a symbol that never top-ranks is never permanently excluded", () => {
    const rows = [];
    for (let i = 0; i < 10; i++) rows.push({ symbol: `LOW${i}`, cheapScore: 0, lastDeepScanAt: i * 1000 }); // never top-ranks
    rows.push({ symbol: "WINNER", cheapScore: 999, lastDeepScanAt: Date.now() });
    const snapshot = fakeSnapshot(rows);

    const selected = selectStage2Symbols(snapshot, { topN: 1, rotationSize: 3, cap: 100 });
    assert.ok(selected.includes("WINNER"));
    // The 3 with the OLDEST lastDeepScanAt (LOW0, LOW1, LOW2) must be rotated in.
    assert.ok(selected.includes("LOW0"));
    assert.ok(selected.includes("LOW1"));
    assert.ok(selected.includes("LOW2"));
    assert.equal(selected.length, 4); // WINNER (top) + 3 rotation
});

test("selectStage2Symbols never exceeds `cap` even if always-include + top + rotation would overflow it", () => {
    const rows = [];
    for (let i = 0; i < 20; i++) rows.push({ symbol: `S${i}`, cheapScore: i });
    const snapshot = fakeSnapshot(rows);
    const selected = selectStage2Symbols(snapshot, { topN: 15, rotationSize: 15, cap: 10 });
    assert.ok(selected.length <= 10);
});
