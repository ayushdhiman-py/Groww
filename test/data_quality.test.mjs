import { test } from "node:test";
import assert from "node:assert/strict";
import { freshness, historical, estimated, UNAVAILABLE, isMarketOpen, maxLiveAgeMs, SOURCE } from "../src/data_quality.mjs";

// A Tuesday 11:00 IST and a Tuesday 20:00 IST, as epoch ms, for deterministic
// market-open/closed fixtures independent of when the test actually runs.
const DURING_MARKET_HOURS = Date.parse("2026-08-25T11:00:00+05:30");
const AFTER_MARKET_CLOSE = Date.parse("2026-08-25T20:00:00+05:30");

test("freshness() never fabricates a value for null/NaN/missing input", () => {
    assert.equal(freshness(null, Date.now()).source, "UNAVAILABLE");
    assert.equal(freshness(NaN, Date.now()).source, "UNAVAILABLE");
    assert.equal(freshness(100, null).source, "UNAVAILABLE");
    assert.equal(freshness(undefined, undefined).value, null);
});

test("freshness() classifies a fresh tick as LIVE during market hours", () => {
    const tickTs = DURING_MARKET_HOURS - 1000; // 1s old
    const result = freshness(100, tickTs, { now: DURING_MARKET_HOURS });
    assert.equal(result.source, "LIVE");
    assert.equal(result.value, 100);
    assert.equal(result.ageMs, 1000);
});

test("freshness() classifies an old tick as DELAYED during market hours", () => {
    const tickTs = DURING_MARKET_HOURS - 60_000; // 60s old — beyond the live threshold
    const result = freshness(100, tickTs, { now: DURING_MARKET_HOURS });
    assert.equal(result.source, "DELAYED");
});

test("freshness() never reports LIVE outside market hours, even for a fresh tick", () => {
    const tickTs = AFTER_MARKET_CLOSE - 1000;
    const result = freshness(100, tickTs, { now: AFTER_MARKET_CLOSE });
    assert.equal(result.source, "DELAYED");
});

test("isMarketOpen()/maxLiveAgeMs() agree: closed market has an infinite live-age budget (nothing can be LIVE)", () => {
    assert.equal(isMarketOpen(new Date(AFTER_MARKET_CLOSE)), false);
    assert.equal(maxLiveAgeMs(new Date(AFTER_MARKET_CLOSE)), Infinity);
    assert.equal(isMarketOpen(new Date(DURING_MARKET_HOURS)), true);
    assert.ok(Number.isFinite(maxLiveAgeMs(new Date(DURING_MARKET_HOURS))));
});

test("historical() wraps a value as explicitly non-live, UNAVAILABLE for missing input", () => {
    const r = historical(100, DURING_MARKET_HOURS - 1000);
    assert.equal(r.source, "HISTORICAL");
    assert.equal(r.value, 100);
    assert.equal(historical(null, Date.now()).source, "UNAVAILABLE");
});

test("estimated() carries a reason and is UNAVAILABLE for missing input", () => {
    const r = estimated(0.25, null, "insufficient history for IV");
    assert.equal(r.source, "ESTIMATED");
    assert.equal(r.reason, "insufficient history for IV");
    assert.equal(estimated(null).source, "UNAVAILABLE");
});

test("UNAVAILABLE() always has a null value regardless of reason", () => {
    const r = UNAVAILABLE("feed disconnected");
    assert.equal(r.value, null);
    assert.equal(r.source, SOURCE.UNAVAILABLE);
    assert.equal(r.reason, "feed disconnected");
});
