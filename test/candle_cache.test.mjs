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

test("each timeframe is fetched and cached independently — no shared base", async () => {
    _setMapsForTesting([{ symbol: "TESTSYM", instrumentKey: "NSE_EQ|TEST" }]);
    let calls = 0;
    mock.method(axios, "get", async () => { calls++; return mockCandleResponse([100 + calls]); });

    await getOrFetchCandles("TESTSYM", "1m");
    await getOrFetchCandles("TESTSYM", "5m");
    await getOrFetchCandles("TESTSYM", "10m");
    await getOrFetchCandles("TESTSYM", "15m");
    assert.equal(calls, 4, "four distinct timeframes for the same symbol must cost four separate network calls");

    const cached = await getOrFetchCandles("TESTSYM", "5m");
    assert.equal(calls, 4, "a cache hit within TTL must not trigger another network request");
    assert.ok(cached.length);
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
