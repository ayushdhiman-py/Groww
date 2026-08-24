import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { _setMapsForTesting } from "../src/instruments.mjs";
import { getOrFetchCandles, peekCandles, clearCandleCache, cacheStats } from "../src/candle_cache.mjs";

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

test("getOrFetchCandles fetches on a cold cache, then serves from cache within TTL without another request", async () => {
    _setMapsForTesting([{ symbol: "TESTSYM", instrumentKey: "NSE_EQ|TEST" }]);
    let calls = 0;
    mock.method(axios, "get", async () => { calls++; return mockCandleResponse([100, 101, 102]); });

    const first = await getOrFetchCandles("TESTSYM", "5m");
    assert.equal(calls, 1);
    assert.equal(first.length, 3);

    const second = await getOrFetchCandles("TESTSYM", "5m");
    assert.equal(calls, 1, "a cache hit within TTL must not trigger another network request");
    assert.deepEqual(second, first);

    const stats = cacheStats();
    assert.equal(stats.hits, 1);
    assert.equal(stats.misses, 1);
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
