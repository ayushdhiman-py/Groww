import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMarketRegime } from "../src/market_regime.mjs";

function niftyRow(overrides = {}) {
    return {
        symbol: "NIFTY", sector: "INDEX", aboveSessionVwap: true, sessionVwapSlope: 0.1, pctFromOpen: 0.5,
        ...overrides,
    };
}

function cheapRow(symbol, { chgPctCheap = 0, aboveVwapCheap = null, candleAgeMs = 1000 } = {}) {
    return { symbol, sector: "OTHER", cheapScore: 0, chgPctCheap, aboveVwapCheap, pctFromOpenCheap: null, relVolumeCheap: null, priceFreshness: "LIVE", candleAgeMs, lastDeepScanAt: 0 };
}

test("breadth is computed from the FULL stage1Snapshot, not from dataBuckets — a Stage-2-only-subset dataBuckets must not change breadth", () => {
    const dataBuckets = { "15m_ALL": [niftyRow()] }; // simulate a cycle where ONLY NIFTY was Stage-2'd this pass
    const snapshot = new Map();
    // 10 symbols in the full universe snapshot, 8 advancing — breadth should be 80%, using ALL 10, not the 1-row dataBuckets.
    for (let i = 0; i < 10; i++) snapshot.set(`SYM${i}`, cheapRow(`SYM${i}`, { chgPctCheap: i < 8 ? 1 : -1 }));

    const regime = computeMarketRegime(dataBuckets, snapshot, {});
    assert.equal(regime.breadthPct, 80);
});

test("a regime computed only from Stage-2 'looks strong' survivors would be biased bullish — this must NOT happen: passing a snapshot where the visible bucket is bullish but the full universe is bearish must report bearish breadth", () => {
    const dataBuckets = { "15m_ALL": [niftyRow({ aboveSessionVwap: false, sessionVwapSlope: -0.1, pctFromOpen: -0.5 })] };
    const snapshot = new Map();
    // Full universe: only 2/10 advancing (bearish breadth) even though NIFTY itself sits in a DOWN trend row.
    for (let i = 0; i < 10; i++) snapshot.set(`SYM${i}`, cheapRow(`SYM${i}`, { chgPctCheap: i < 2 ? 1 : -1 }));

    const regime = computeMarketRegime(dataBuckets, snapshot, {});
    assert.equal(regime.breadthPct, 20);
    assert.equal(regime.regime, "BEARISH");
});

test("avgAtrPct comes from the full-universe atrPctBySymbol map, not from any per-row atrPct field", () => {
    const dataBuckets = { "15m_ALL": [niftyRow()] };
    const snapshot = new Map([["A", cheapRow("A")], ["B", cheapRow("B")]]);
    const regime = computeMarketRegime(dataBuckets, snapshot, { A: 2, B: 4 });
    assert.equal(regime.avgAtrPct, 3);
});

test("computeMarketRegime degrades gracefully (no throw) when stage1Snapshot is omitted", () => {
    assert.doesNotThrow(() => computeMarketRegime({ "15m_ALL": [] }));
});
