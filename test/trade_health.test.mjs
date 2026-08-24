import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTradeHealth } from "../src/trade_health.mjs";

const trade = { entryPrice: 100, quantity: 10, peakPrice: 100 };

test("computeTradeHealth returns DATA_UNAVAILABLE (never a fabricated flat P&L) when livePrice is null", () => {
    const health = computeTradeHealth(trade, {
        row1m: null, row5m: null, row15m: null, niftyRow5m: null, sectorStats5m: {},
        livePrice: null, // both the live feed and the 5m row were unavailable this cycle
    });
    assert.equal(health.state, "DATA_UNAVAILABLE");
    assert.equal(health.price, null);
    assert.equal(health.pnl, null);
    assert.equal(health.pnlPct, null);
    assert.equal(health.score, null);
});

test("computeTradeHealth never substitutes trade.entryPrice for a missing livePrice — a null stays null, it's never silently equal to entryPrice", () => {
    const health = computeTradeHealth(trade, {
        row1m: null, row5m: null, row15m: null, niftyRow5m: null, sectorStats5m: {},
        livePrice: null,
    });
    // If this ever silently fell back to entryPrice, price would be 100 and
    // pnl would be a fabricated 0 — assert it's genuinely null instead.
    assert.notEqual(health.price, trade.entryPrice);
    assert.equal(health.price, null);
});

test("computeTradeHealth computes real pnl/pnlPct when a genuine livePrice is supplied", () => {
    const health = computeTradeHealth(trade, {
        row1m: null, row5m: null, row15m: null, niftyRow5m: null, sectorStats5m: {},
        livePrice: 110,
    });
    assert.notEqual(health.state, "DATA_UNAVAILABLE");
    assert.equal(health.price, 110);
    assert.equal(health.pnl, 100); // (110-100)*10
    assert.equal(health.pnlPct, 10);
    assert.notEqual(health.score, null);
});

test("computeTradeHealth reports broaderTrendSupportive:null when no 30m row is available (row30m optional)", () => {
    const health = computeTradeHealth(trade, {
        row1m: null, row5m: null, row15m: null, row30m: null, niftyRow5m: null, sectorStats5m: {},
        livePrice: 110,
    });
    assert.equal(health.broaderTrendSupportive, null);
});

test("computeTradeHealth reports broaderTrendSupportive:true when the 30m row is above a rising session VWAP", () => {
    const health = computeTradeHealth(trade, {
        row1m: null, row5m: null, row15m: null,
        row30m: { aboveSessionVwap: true, sessionVwapSlope: 0.2 },
        niftyRow5m: null, sectorStats5m: {}, livePrice: 110,
    });
    assert.equal(health.broaderTrendSupportive, true);
});

test("computeTradeHealth reports broaderTrendSupportive:false and adds an early-warning note when the 30m trend has turned unsupportive while the score still reads HOLD-or-better", () => {
    const health = computeTradeHealth(trade, {
        row1m: null, row5m: null, row15m: null,
        row30m: { aboveSessionVwap: false, sessionVwapSlope: -0.3 },
        niftyRow5m: null, sectorStats5m: {}, livePrice: 110,
    });
    assert.equal(health.broaderTrendSupportive, false);
    // With no row5m/row15m data, every sub-score defaults to its "data
    // unavailable" neutral value (well above 70), so this note should fire.
    assert.ok(health.warnings.some(w => w.includes("30m broader trend has turned unsupportive")));
});

test("computeTradeHealth never lets the 30m broader-trend signal change the weighted score/state — it's informational only", () => {
    const ctxWithout30m = { row1m: null, row5m: null, row15m: null, niftyRow5m: null, sectorStats5m: {}, livePrice: 110 };
    const ctxWithBad30m = { ...ctxWithout30m, row30m: { aboveSessionVwap: false, sessionVwapSlope: -0.5 } };
    const healthWithout = computeTradeHealth(trade, ctxWithout30m);
    const healthWithBad = computeTradeHealth(trade, ctxWithBad30m);
    assert.equal(healthWithout.score, healthWithBad.score);
    assert.equal(healthWithout.state, healthWithBad.state);
});
