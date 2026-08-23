import { test } from "node:test";
import assert from "node:assert/strict";
import {
    _setMapsForTesting,
    resolveInstrumentKey,
    resolveInstrumentKeys,
    symbolForInstrumentKey,
} from "../src/instruments.mjs";

test("resolves plain equity/index symbols to Upstox instrument keys", () => {
    _setMapsForTesting([
        { symbol: "RELIANCE", instrumentKey: "NSE_EQ|INE002A01018" },
        { symbol: "NIFTY", instrumentKey: "NSE_INDEX|Nifty 50" },
        { symbol: "SENSEX", instrumentKey: "BSE_INDEX|SENSEX" },
    ]);

    assert.equal(resolveInstrumentKey("RELIANCE"), "NSE_EQ|INE002A01018");
    assert.equal(resolveInstrumentKey("NIFTY"), "NSE_INDEX|Nifty 50");
    assert.equal(resolveInstrumentKey("SENSEX"), "BSE_INDEX|SENSEX");
});

test("applies the PRISMJOHN -> PRSMJOHNSN alias (verified against live instrument master)", () => {
    _setMapsForTesting([{ symbol: "PRSMJOHNSN", instrumentKey: "NSE_EQ|INE010A01011" }]);
    assert.equal(resolveInstrumentKey("PRISMJOHN"), "NSE_EQ|INE010A01011");
});

test("returns null for unresolvable symbols instead of guessing a key", () => {
    _setMapsForTesting([{ symbol: "RELIANCE", instrumentKey: "NSE_EQ|INE002A01018" }]);
    assert.equal(resolveInstrumentKey("NOT_A_REAL_SYMBOL"), null);
});

test("resolveInstrumentKeys partitions resolved vs unresolved symbols", () => {
    _setMapsForTesting([{ symbol: "RELIANCE", instrumentKey: "NSE_EQ|INE002A01018" }]);
    const { instrumentKeyBySymbol, unresolved } = resolveInstrumentKeys(["RELIANCE", "FAKESYM"]);
    assert.equal(instrumentKeyBySymbol.get("RELIANCE"), "NSE_EQ|INE002A01018");
    assert.deepEqual(unresolved, ["FAKESYM"]);
});

test("symbolForInstrumentKey performs the reverse lookup used by LTP/feed parsing", () => {
    _setMapsForTesting([{ symbol: "NIFTY", instrumentKey: "NSE_INDEX|Nifty 50" }]);
    assert.equal(symbolForInstrumentKey("NSE_INDEX|Nifty 50"), "NIFTY");
    assert.equal(symbolForInstrumentKey("NSE_INDEX|Unknown"), null);
});
