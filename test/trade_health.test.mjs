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
