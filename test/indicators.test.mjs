import { test } from "node:test";
import assert from "node:assert/strict";
import { historicalVolatility, theoreticalOptionChain } from "../src/indicators.mjs";

test("historicalVolatility always returns {value, estimated} — never a bare number that hides which case fired", () => {
    const closes = Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i * 0.2) * 3);
    const real = historicalVolatility(closes, 20);
    assert.equal(typeof real.value, "number");
    assert.equal(real.estimated, false);

    const insufficient = historicalVolatility(closes.slice(0, 5), 20);
    assert.equal(insufficient.value, 0.25);
    assert.equal(insufficient.estimated, true);
});

test("theoreticalOptionChain tags OI fields null, never a fabricated confirmed-zero", () => {
    const chain = theoreticalOptionChain(24000, 0.15, 7, "NIFTY");
    for (const opt of [...chain.calls, ...chain.puts]) {
        assert.equal(opt.openInterest, null);
        assert.equal(opt.oiChange, null);
    }
});
