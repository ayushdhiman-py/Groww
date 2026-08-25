import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { _setMapsForTesting } from "../src/instruments.mjs";
import { getOrFetchCandles, peekCandles, clearCandleCache, cacheStats, resampleFrom1m } from "../src/candle_cache.mjs";

afterEach(() => { mock.restoreAll(); clearCandleCache(); });

function mockCandleResponse(closes) {
    return {
        data: {
            status: "success",
            data: {
                candles: closes.map((c, i) => [
                    new Date(Date.now() - (closes.length - i) * 60000).toISOString(),
                    c, c, c, c, 1000,
                ]),
            },
        },
    };
}

// Fixed session-aligned timestamps (9:15 IST = 03:45 UTC) instead of
// Date.now()-relative ones, so resampling-bucket assertions are
// deterministic regardless of what wall-clock second the suite runs at.
const SESSION_OPEN_UTC = new Date("2026-01-05T03:45:00.000Z").getTime();
function mockOneMinResponse(bars) {
    return {
        data: {
            status: "success",
            data: {
                candles: bars.map((b, i) => [
                    new Date(SESSION_OPEN_UTC + i * 60_000).toISOString(),
                    b.o, b.h, b.l, b.c, b.v,
                ]),
            },
        },
    };
}

test("requesting a consolidated timeframe (5m) fetches the shared 1m base once, then serves the resampled result from cache within TTL", async () => {
    _setMapsForTesting([{ symbol: "TESTSYM", instrumentKey: "NSE_EQ|TEST" }]);
    let calls = 0;
    const bars = Array.from({ length: 10 }, (_, i) => ({ o: 100 + i, h: 100 + i + 0.5, l: 100 + i - 0.5, c: 100 + i, v: 1000 }));
    mock.method(axios, "get", async () => { calls++; return mockOneMinResponse(bars); });

    const first = await getOrFetchCandles("TESTSYM", "5m");
    assert.equal(calls, 1, "cold cache must fetch exactly once (the shared 1m base), not once per timeframe");
    assert.equal(first.length, 2, "10 one-minute bars from session open bucket into exactly two 5-minute bars");

    const second = await getOrFetchCandles("TESTSYM", "5m");
    assert.equal(calls, 1, "a cache hit within TTL must not trigger another network request");
    assert.deepEqual(second, first);

    const stats = cacheStats();
    assert.equal(stats.hits, 1);
    assert.equal(stats.misses, 1);
});

test("1m/5m/10m/15m share ONE underlying fetch — the whole point of base consolidation", async () => {
    _setMapsForTesting([{ symbol: "TESTSYM", instrumentKey: "NSE_EQ|TEST" }]);
    let calls = 0;
    const bars = Array.from({ length: 20 }, (_, i) => ({ o: 100 + i, h: 100 + i + 0.5, l: 100 + i - 0.5, c: 100 + i, v: 1000 }));
    mock.method(axios, "get", async () => { calls++; return mockOneMinResponse(bars); });

    await getOrFetchCandles("TESTSYM", "1m");
    await getOrFetchCandles("TESTSYM", "5m");
    await getOrFetchCandles("TESTSYM", "10m");
    await getOrFetchCandles("TESTSYM", "15m");
    assert.equal(calls, 1, "four consolidated timeframes for the same symbol must cost exactly one network call total");
});

test("resampleFrom1m aggregates OHLCV correctly into session-aligned 5-minute buckets", () => {
    const bars = [
        { ts: SESSION_OPEN_UTC + 0 * 60_000, open: 100, high: 101, low: 99, close: 100.5, volume: 10 },
        { ts: SESSION_OPEN_UTC + 1 * 60_000, open: 100.5, high: 102, low: 100, close: 101, volume: 20 },
        { ts: SESSION_OPEN_UTC + 2 * 60_000, open: 101, high: 101.5, low: 98, close: 99, volume: 30 },
        { ts: SESSION_OPEN_UTC + 3 * 60_000, open: 99, high: 100, low: 97, close: 98, volume: 40 },
        { ts: SESSION_OPEN_UTC + 4 * 60_000, open: 98, high: 99, low: 96, close: 97, volume: 50 },
        // second 5-minute bucket
        { ts: SESSION_OPEN_UTC + 5 * 60_000, open: 97, high: 98, low: 95, close: 96, volume: 5 },
    ];
    const resampled = resampleFrom1m(bars, 5 * 60_000);
    assert.equal(resampled.length, 2);
    assert.equal(resampled[0].ts, SESSION_OPEN_UTC);
    assert.equal(resampled[0].open, 100, "open = first bar's open");
    assert.equal(resampled[0].high, 102, "high = max across the bucket");
    assert.equal(resampled[0].low, 96, "low = min across the bucket");
    assert.equal(resampled[0].close, 97, "close = last bar's close");
    assert.equal(resampled[0].volume, 150, "volume = sum across the bucket");
    assert.equal(resampled[1].open, 97);
    assert.equal(resampled[1].volume, 5);
});

test("forceRefresh bypasses the cache even within TTL", async () => {
    _setMapsForTesting([{ symbol: "TESTSYM", instrumentKey: "NSE_EQ|TEST" }]);
    let calls = 0;
    mock.method(axios, "get", async () => { calls++; return mockCandleResponse([100 + calls]); });

    await getOrFetchCandles("TESTSYM", "1d");
    assert.equal(calls, 1);
    await getOrFetchCandles("TESTSYM", "1d", { forceRefresh: true });
    assert.equal(calls, 2, "forceRefresh must trigger a real fetch even though the TTL hasn't expired");
});

test("peekCandles never triggers a network request, even for an uncached symbol", async () => {
    let calls = 0;
    mock.method(axios, "get", async () => { calls++; return mockCandleResponse([100]); });
    const result = peekCandles("NEVER_FETCHED", "5m");
    assert.equal(result, null);
    assert.equal(calls, 0);
});

test("an explicit range always bypasses the cache (backtest-style historical window)", async () => {
    _setMapsForTesting([{ symbol: "TESTSYM", instrumentKey: "NSE_EQ|TEST" }]);
    let calls = 0;
    mock.method(axios, "get", async () => { calls++; return mockCandleResponse([100]); });

    const range = { from: new Date(Date.now() - 86400000), to: new Date() };
    await getOrFetchCandles("TESTSYM", "1d", { range });
    await getOrFetchCandles("TESTSYM", "1d", { range });
    assert.equal(calls, 2, "a range-bound fetch is a specific historical window, not 'the current series' — never cached");
});
