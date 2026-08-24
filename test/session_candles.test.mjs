import { test } from "node:test";
import assert from "node:assert/strict";
import { isolateTodaySession } from "../src/session_candles.mjs";

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
        ts += 5 * 60000; // 5m bars
    }
    return out;
}

test("isolateTodaySession isolates only today's bars and derives prevClose from the last bar of the prior day", () => {
    const candles = genCandles(400); // 400 * 5m = ~33h — guaranteed to span into a 2nd IST calendar day
    const session = isolateTodaySession(candles, "5m");
    assert.ok(session.todayCandles.length > 0);
    assert.ok(session.todayCandles.length < candles.length, "must exclude prior-day bars");
    assert.ok(Number.isFinite(session.prevClose));
    assert.ok(session.dayH >= session.dayL);
});

test("isolateTodaySession falls back to the second-to-last candle's close as prevClose when there's only one day of data", () => {
    const oneDayCandles = genCandles(10); // well within a single IST day, no prior-day bar exists
    const session = isolateTodaySession(oneDayCandles, "5m");
    assert.equal(session.prevClose, oneDayCandles[oneDayCandles.length - 2].close);
    assert.equal(session.prevDayH, null);
    assert.equal(session.prevDayL, null);
});

test("isolateTodaySession only computes 52-week high/low for the 1d timeframe", () => {
    const candles = genCandles(400, 100, Date.parse("2025-01-01T04:00:00Z"));
    candles.forEach((c, i) => { c.ts += i * 86400000; }); // spread across many days
    const daily = isolateTodaySession(candles, "1d");
    const fiveMin = isolateTodaySession(candles, "5m");
    assert.ok(Number.isFinite(daily.h52w) && daily.h52w > -Infinity);
    assert.equal(fiveMin.h52w, -Infinity); // untouched for non-1d timeframes — buildSignal's own fallback handles this
});
