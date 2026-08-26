import { test } from "node:test";
import assert from "node:assert/strict";
import { selectStage2Symbols, selectIntradayCandidates } from "../src/stage1_filter.mjs";

function fakeSnapshot(rows) {
    return new Map(rows.map(r => [r.symbol, {
        symbol: r.symbol, sector: r.sector ?? "OTHER", cheapScore: r.cheapScore ?? 0,
        chgPctCheap: null, aboveVwapCheap: null, pctFromOpenCheap: null, relVolumeCheap: null,
        priceFreshness: r.priceFreshness ?? "LIVE", candleAgeMs: 0, lastDeepScanAt: r.lastDeepScanAt ?? 0,
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

// ── selectIntradayCandidates — the Intraday-only cheap pre-filter, deliberately
// independent of selectStage2Symbols() over the same full-universe snapshot. ──

test("selectIntradayCandidates excludes INDEX-sector symbols", () => {
    const snapshot = fakeSnapshot([
        { symbol: "NIFTY", sector: "INDEX", cheapScore: 999 },
        { symbol: "GOODCO", sector: "OTHER", cheapScore: 10 },
    ]);
    const selected = selectIntradayCandidates(snapshot, { topN: 10 });
    assert.ok(!selected.includes("NIFTY"));
    assert.ok(selected.includes("GOODCO"));
});

test("selectIntradayCandidates excludes non-positive cheap scores (BUY-only pre-filter)", () => {
    const snapshot = fakeSnapshot([
        { symbol: "FLAT", cheapScore: 0 },
        { symbol: "DOWN", cheapScore: -5 },
        { symbol: "UP", cheapScore: 5 },
    ]);
    const selected = selectIntradayCandidates(snapshot, { topN: 10 });
    assert.deepEqual(selected, ["UP"]);
});

test("selectIntradayCandidates excludes symbols with no live price yet", () => {
    const snapshot = fakeSnapshot([
        { symbol: "NOPRICE", cheapScore: 50, priceFreshness: "UNAVAILABLE" },
        { symbol: "HASPRICE", cheapScore: 5 },
    ]);
    const selected = selectIntradayCandidates(snapshot, { topN: 10 });
    assert.deepEqual(selected, ["HASPRICE"]);
});

test("selectIntradayCandidates ranks by cheapScore descending and respects topN", () => {
    const rows = [];
    for (let i = 0; i < 20; i++) rows.push({ symbol: `S${i}`, cheapScore: i + 1 });
    const snapshot = fakeSnapshot(rows);
    const selected = selectIntradayCandidates(snapshot, { topN: 5 });
    assert.deepEqual(selected, ["S19", "S18", "S17", "S16", "S15"]);
});

// ── The actual architectural fix being tested: a stock Stage-2 doesn't pick
// (its own topN/rotation/cap policy is unrelated to current cheap signal
// strength) must still be reachable through the Intraday-specific pool. ──
test("a symbol excluded from a small Stage-2 shortlist is still reachable via selectIntradayCandidates", () => {
    const rows = [];
    for (let i = 0; i < 200; i++) rows.push({ symbol: `S${i}`, cheapScore: i }); // S199 has the best cheap score
    const snapshot = fakeSnapshot(rows);

    // A small Stage-2 shortlist (as this cycle's actual selectStage2Symbols
    // call might produce, e.g. narrow topN + small cap) excludes most of them.
    const stage2 = selectStage2Symbols(snapshot, { topN: 2, rotationSize: 0, cap: 2 });
    assert.equal(stage2.length, 2);
    assert.ok(!stage2.includes("S150")); // a genuinely strong candidate Stage-2's own cap left out

    // The Intraday-specific pool, ranked purely by current cheap signal, can
    // still surface it regardless of what Stage-2 selected.
    const intradayPool = selectIntradayCandidates(snapshot, { topN: 100 });
    assert.ok(intradayPool.includes("S150"));
});
