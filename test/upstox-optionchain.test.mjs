import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOptionChain } from "../src/upstox.mjs";

// Row shape below matches Upstox's real v2/option/chain response (verified
// against the official docs — see get-pc-option-chain).

test("normalizeOptionChain converts Upstox rows into { strikes: { CE, PE } } and leaves iv untouched (already a percentage)", () => {
    const rows = [
        {
            expiry: "2025-02-13",
            strike_price: 21100,
            underlying_key: "NSE_INDEX|Nifty 50",
            underlying_spot_price: 22976.2,
            call_options: {
                instrument_key: "NSE_FO|51059",
                market_data: { ltp: 2449.9, volume: 0, oi: 750, prev_oi: 700 },
                option_greeks: { iv: 262.31, delta: 0.743, theta: -472.8941, gamma: 0.0001, vega: 4.1731 },
            },
            put_options: {
                instrument_key: "NSE_FO|51060",
                market_data: { ltp: 0.3, volume: 22315725, oi: 5636475, prev_oi: 5797500 },
                option_greeks: { iv: 50.78, delta: -0.0013, theta: -1.2461, gamma: 0, vega: 0.0568 },
            },
        },
    ];

    const result = normalizeOptionChain("NIFTY", rows);

    assert.equal(result.underlying_ltp, 22976.2);
    assert.equal(result.expiryDate, "2025-02-13");

    const strike = result.strikes["21100"];
    assert.ok(strike.CE);
    assert.ok(strike.PE);
    assert.equal(strike.CE.instrument_key, "NSE_FO|51059");
    assert.equal(strike.CE.impliedVolatility, 262.31); // NOT multiplied by 100 — Upstox already reports a percentage
    assert.equal(strike.CE.open_interest, 750);
    assert.equal(strike.CE.changeInOI, 50); // 750 - 700
    assert.equal(strike.PE.lastPrice, 0.3);
    assert.equal(strike.PE.volume, 22315725);
});

test("normalizeOptionChain tolerates a strike with only one side present", () => {
    const rows = [
        {
            expiry: "2025-02-13",
            strike_price: 25000,
            underlying_spot_price: 22976.2,
            call_options: { instrument_key: "NSE_FO|1", market_data: { ltp: 1 }, option_greeks: {} },
        },
    ];
    const result = normalizeOptionChain("NIFTY", rows);
    assert.ok(result.strikes["25000"].CE);
    assert.equal(result.strikes["25000"].PE, undefined);
});

test("normalizeOptionChain reports a field Upstox genuinely omitted as null, never as a look-like-real 0", () => {
    const rows = [
        {
            expiry: "2025-02-13",
            strike_price: 25000,
            underlying_spot_price: 22976.2,
            // oi/volume/prev_oi absent from market_data; option_greeks entirely empty —
            // every one of these must surface as null, not a fabricated 0.
            call_options: { instrument_key: "NSE_FO|1", market_data: { ltp: 1 }, option_greeks: {} },
        },
    ];
    const CE = normalizeOptionChain("NIFTY", rows).strikes["25000"].CE;
    assert.equal(CE.open_interest, null);
    assert.equal(CE.oi, null);
    assert.equal(CE.changeInOI, null); // no prev_oi to diff against — "unknown," not "unchanged"
    assert.equal(CE.volume, null);
    assert.equal(CE.impliedVolatility, null);
    assert.equal(CE.delta, null);
    assert.equal(CE.gamma, null);
    assert.equal(CE.theta, null);
    assert.equal(CE.vega, null);
    assert.equal(CE.lastPrice, 1); // a genuinely-present field is untouched
});

test("normalizeOptionChain preserves a genuine zero value (e.g. delta on a deep OTM option) rather than treating it as missing", () => {
    const rows = [
        {
            expiry: "2025-02-13",
            strike_price: 30000,
            underlying_spot_price: 22976.2,
            call_options: {
                instrument_key: "NSE_FO|2",
                market_data: { ltp: 0.05, oi: 0, volume: 0, prev_oi: 0 },
                option_greeks: { delta: 0, gamma: 0, theta: 0, vega: 0, iv: 0 },
            },
        },
    ];
    const CE = normalizeOptionChain("NIFTY", rows).strikes["30000"].CE;
    assert.equal(CE.open_interest, 0);
    assert.equal(CE.volume, 0);
    assert.equal(CE.changeInOI, 0); // 0 - 0
    assert.equal(CE.delta, 0);
    assert.equal(CE.impliedVolatility, 0);
});
