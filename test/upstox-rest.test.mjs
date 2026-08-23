import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { _setMapsForTesting } from "../src/instruments.mjs";
import { fetchCandles, fetchBulkLtp, fetchOptionChain } from "../src/upstox.mjs";

afterEach(() => mock.restoreAll());

test("fetchCandles reverses Upstox's newest-first candles to oldest-first (verified live behavior)", async () => {
    _setMapsForTesting([{ symbol: "NIFTY", instrumentKey: "NSE_INDEX|Nifty 50" }]);
    mock.method(axios, "get", async () => ({
        data: {
            status: "success",
            data: {
                candles: [
                    ["2026-08-21T00:00:00+05:30", 24284.05, 24284.05, 24206.8, 24252, 0, 0],
                    ["2026-08-20T00:00:00+05:30", 24100, 24300, 24000, 24284.05, 0, 0],
                ],
            },
        },
    }));

    const candles = await fetchCandles("NIFTY", "1d");
    assert.equal(candles.length, 2);
    assert.ok(candles[0].ts < candles[1].ts, "oldest candle must come first for downstream EMA/MACD/RSI");
    assert.equal(candles[0].close, 24284.05);
    assert.equal(candles[1].close, 24252);
});

test("fetchCandles surfaces a descriptive error on 401 (invalid/expired token)", async () => {
    _setMapsForTesting([{ symbol: "NIFTY", instrumentKey: "NSE_INDEX|Nifty 50" }]);
    mock.method(axios, "get", async () => {
        const err = new Error("Request failed with status code 401");
        err.response = { status: 401, data: { errors: [{ errorCode: "UDAPI100050", message: "Invalid token used to access API" }] } };
        throw err;
    });

    await assert.rejects(() => fetchCandles("NIFTY", "1d"), /UDAPI100050/);
});

test("fetchCandles rejects with a clear message when the symbol has no instrument_key", async () => {
    _setMapsForTesting([]); // nothing resolvable
    await assert.rejects(() => fetchCandles("NOT_REAL", "1d"), /No Upstox instrument_key/);
});

test("fetchBulkLtp maps Upstox's colon-keyed response back to our symbols via instrument_token", async () => {
    // Verified live: LTP response keys use "SEGMENT:Name" (colon), which does
    // NOT match our pipe-formatted instrument_key — so mapping MUST go through
    // the `instrument_token` field, not the object key itself.
    _setMapsForTesting([
        { symbol: "NIFTY", instrumentKey: "NSE_INDEX|Nifty 50" },
        { symbol: "BANKNIFTY", instrumentKey: "NSE_INDEX|Nifty Bank" },
    ]);
    mock.method(axios, "get", async () => ({
        data: {
            status: "success",
            data: {
                "NSE_INDEX:Nifty Bank": { last_price: 57761.95, instrument_token: "NSE_INDEX|Nifty Bank" },
                "NSE_INDEX:Nifty 50": { last_price: 24252, instrument_token: "NSE_INDEX|Nifty 50" },
            },
        },
    }));

    const prices = await fetchBulkLtp(["NIFTY", "BANKNIFTY"]);
    assert.equal(prices.NIFTY, 24252);
    assert.equal(prices.BANKNIFTY, 57761.95);
});

test("fetchBulkLtp returns {} without calling the API when nothing resolves", async () => {
    _setMapsForTesting([]);
    let called = false;
    mock.method(axios, "get", async () => { called = true; return { data: { data: {} } }; });

    const prices = await fetchBulkLtp(["NOT_REAL"]);
    assert.deepEqual(prices, {});
    assert.equal(called, false);
});

test("fetchOptionChain falls back from current_week to current_month when the near expiry is empty", async () => {
    _setMapsForTesting([{ symbol: "NIFTY", instrumentKey: "NSE_INDEX|Nifty 50" }]);
    const seenExpiries = [];
    mock.method(axios, "get", async (url, opts) => {
        seenExpiries.push(opts.params.expiry_date);
        if (opts.params.expiry_date === "current_week") {
            return { data: { status: "success", data: [] } };
        }
        return {
            data: {
                status: "success",
                data: [{
                    expiry: "2026-08-25",
                    strike_price: 24000,
                    underlying_spot_price: 24252,
                    call_options: { instrument_key: "NSE_FO|1", market_data: { ltp: 100, oi: 10 }, option_greeks: { iv: 12 } },
                }],
            },
        };
    });

    const chain = await fetchOptionChain("NIFTY");
    assert.deepEqual(seenExpiries, ["current_week", "current_month"]);
    assert.ok(chain.strikes["24000"].CE);
});

test("fetchOptionChain returns null when no instrument_key resolves", async () => {
    _setMapsForTesting([]);
    const chain = await fetchOptionChain("NOT_REAL");
    assert.equal(chain, null);
});
