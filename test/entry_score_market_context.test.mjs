import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildMarketContext } from "../src/entry_score.mjs";
import { _setLatestSnapshotForTesting } from "../src/stage1_filter.mjs";

afterEach(() => {
    _setLatestSnapshotForTesting(null);
});

function fakeStage1Snapshot(rows) {
    return new Map(rows.map(r => [r.symbol, {
        symbol: r.symbol, sector: r.sector, pctFromOpenCheap: r.pctFromOpenCheap,
        chgPctCheap: null, aboveVwapCheap: null, relVolumeCheap: null,
        priceFreshness: "LIVE", candleAgeMs: 0, lastDeepScanAt: 0,
    }]));
}

test("buildMarketContext falls back to per-tf-bucket sector stats before the first stage1 cycle has ever run", () => {
    _setLatestSnapshotForTesting(null);
    const dataBuckets = {
        "5m_ALL": [
            { symbol: "NIFTY", sector: "INDEX", pctFromOpen: 0.5 },
            { symbol: "A", sector: "IT", pctFromOpen: 2 },
            { symbol: "B", sector: "IT", pctFromOpen: -1 },
        ],
    };
    const ctx = buildMarketContext(dataBuckets, "5m");
    assert.equal(ctx.niftyRow.symbol, "NIFTY");
    assert.equal(ctx.sectorStats.IT.avgPctFromOpen, 0.5); // (2 + -1) / 2
    assert.equal(ctx.sectorStats.IT.positiveShare, 0.5); // 1 of 2 positive
});

test("buildMarketContext prefers the full-universe stage1 snapshot over the persistent (possibly several-cycles-stale) per-tf bucket for sector stats", () => {
    // Deliberately mismatched: the persistent bucket's IT sector rows look
    // strongly negative (as if computed several cycles ago before a sector
    // rally), while the FRESH full-universe snapshot shows the sector has
    // since turned positive. The result must reflect the fresh snapshot,
    // not the stale bucket — proving the freshness fix actually changes
    // which data wins, not just that both are read without error.
    const dataBuckets = {
        "5m_ALL": [
            { symbol: "NIFTY", sector: "INDEX", pctFromOpen: 0.5 },
            { symbol: "A", sector: "IT", pctFromOpen: -5 },
            { symbol: "B", sector: "IT", pctFromOpen: -5 },
        ],
    };
    _setLatestSnapshotForTesting(fakeStage1Snapshot([
        { symbol: "A", sector: "IT", pctFromOpenCheap: 3 },
        { symbol: "B", sector: "IT", pctFromOpenCheap: 3 },
        { symbol: "C", sector: "IT", pctFromOpenCheap: 3 }, // C isn't in the stale bucket at all (never Stage-2'd recently) — must still count
    ]));

    const ctx = buildMarketContext(dataBuckets, "5m");
    assert.equal(ctx.niftyRow.symbol, "NIFTY"); // NIFTY lookup is unaffected — always Stage-2'd every cycle regardless
    assert.equal(ctx.sectorStats.IT.avgPctFromOpen, 3);
    assert.equal(ctx.sectorStats.IT.positiveShare, 1);
    assert.equal(ctx.sectorStats.IT.count, 3);
});

test("buildMarketContext's stage1-snapshot path excludes INDEX symbols and rows with no pctFromOpenCheap, same as the fallback path does", () => {
    _setLatestSnapshotForTesting(fakeStage1Snapshot([
        { symbol: "NIFTY", sector: "INDEX", pctFromOpenCheap: 1 },
        { symbol: "A", sector: "IT", pctFromOpenCheap: null },
        { symbol: "B", sector: "IT", pctFromOpenCheap: 2 },
    ]));
    const ctx = buildMarketContext({ "5m_ALL": [] }, "5m");
    assert.equal(ctx.sectorStats.INDEX, undefined);
    assert.equal(ctx.sectorStats.IT.count, 1); // only B — A's null pctFromOpenCheap excluded
});
