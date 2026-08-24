import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSignal } from "../src/scanner.mjs";
import { historical, freshness, UNAVAILABLE } from "../src/data_quality.mjs";

// buildSignal needs cls.length >= 55 and vol.length >= 15 (its own warmup
// guard) — generate enough synthetic candles to clear that bar.
function genCandles(n, startPrice = 100, startTs = Date.parse("2026-08-20T04:00:00Z")) {
    const out = [];
    let price = startPrice;
    let ts = startTs;
    for (let i = 0; i < n; i++) {
        const open = price;
        const close = open + Math.sin(i * 0.5) * 0.5 + 0.05;
        const high = Math.max(open, close) + 0.3;
        const low = Math.min(open, close) - 0.3;
        out.push({ ts, open, high, low, close, volume: 10000 + i * 10 });
        price = close;
        ts += 5 * 60000;
    }
    return out;
}

test("buildSignal tags priceSource HISTORICAL (never indistinguishable from live) when no live tick is available", () => {
    const candles = genCandles(60);
    const row = buildSignal(candles, "5m", "TESTSTOCK", UNAVAILABLE("no feed"));
    assert.ok(row, "buildSignal should still produce a row");
    assert.equal(row.priceSource, "HISTORICAL");
    // price still numeric (downstream math needs a number) but explicitly
    // sourced from the candle close, not fabricated as if it were live.
    const last = candles[candles.length - 1];
    assert.equal(row.price, +last.close.toFixed(2));
    assert.equal(row.candleTs, last.ts);
});

test("buildSignal uses the live tick and tags priceSource LIVE when a fresh one is supplied", () => {
    const candles = genCandles(60);
    const livePrice = candles[candles.length - 1].close + 5; // deliberately different from the candle close
    const tickTs = Date.now();
    const ltpFresh = freshness(livePrice, tickTs, { sourceOverride: "LIVE" });

    const row = buildSignal(candles, "5m", "TESTSTOCK", ltpFresh);
    assert.equal(row.priceSource, "LIVE");
    assert.equal(row.price, +livePrice.toFixed(2));
    assert.equal(row.priceTs, tickTs);
    // candleTs (the OHLC input age) and priceTs (the live tick age) are
    // independently correct, not collapsed into one timestamp — this is the
    // regression test for the "mixed timestamps under one row" bug class.
    assert.notEqual(row.candleTs, row.priceTs);
});

test("buildSignal never falls back to the candle close when a live value of 0 or exactly at threshold is given (only null/UNAVAILABLE triggers fallback)", () => {
    const candles = genCandles(60);
    // A live tick just outside the market-hours freshness window should
    // still be USED (as DELAYED), not discarded in favor of the candle close.
    const oldTickTs = Date.now() - 60_000;
    const ltpFresh = freshness(candles[candles.length - 1].close + 1, oldTickTs);
    const row = buildSignal(candles, "5m", "TESTSTOCK", ltpFresh);
    assert.equal(row.price, +(candles[candles.length - 1].close + 1).toFixed(2));
    assert.notEqual(row.priceSource, "HISTORICAL");
});

test("buildSignal defaults to UNAVAILABLE-derived HISTORICAL when called with no freshness arg at all", () => {
    const candles = genCandles(60);
    const row = buildSignal(candles, "5m", "TESTSTOCK");
    assert.equal(row.priceSource, "HISTORICAL");
});

test("historical() wrapper passed to buildSignal from a backtest-style caller is tagged HISTORICAL, not LIVE", () => {
    const candles = genCandles(60);
    const last = candles[candles.length - 1];
    const row = buildSignal(candles, "5m", "TESTSTOCK", historical(last.close, last.ts));
    assert.equal(row.priceSource, "HISTORICAL");
});
