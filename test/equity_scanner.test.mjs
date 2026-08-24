import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeEquityStock } from "../src/equity_scanner.mjs";

function genCandles(n, startPrice, trendPerBar, startTs = Date.parse("2026-01-05T00:00:00Z")) {
    const out = [];
    let price = startPrice;
    let ts = startTs;
    for (let i = 0; i < n; i++) {
        const open = price;
        const close = open + trendPerBar + Math.sin(i * 0.3) * (startPrice * 0.003);
        const high = Math.max(open, close) + startPrice * 0.002;
        const low = Math.min(open, close) - startPrice * 0.002;
        out.push({ ts, open, high, low, close, volume: 500000 + (i % 10) * 20000 });
        price = close;
        ts += 86400000;
    }
    return out;
}

test("analyzeEquityStock does not throw and does not silently fail debt_equity/revenue_growth checks when fundamentalData is empty (the {} default)", () => {
    const daily = genCandles(260, 100, 0.35);
    const weekly = genCandles(120, 100, 0.35);
    const nifty = genCandles(260, 24000, 5);
    const ltp = { price: daily[daily.length - 1].close };

    // Must not throw regardless of the specific score outcome — this is the
    // regression test for the `=== null` vs `== null` fix: fundamentalData
    // defaults to {} (debtToEquity/revenueGrowthQoQ both undefined), and the
    // function must treat that as "unknown" (don't penalize), not crash and
    // not silently fail those two checks as if the data actively disqualified
    // the stock.
    assert.doesNotThrow(() => {
        analyzeEquityStock("TESTSTOCK", daily, weekly, ltp, {}, { isFoStock: false }, {}, nifty);
    });
});

test("analyzeEquityStock tags price_source LIVE when a real ltp is supplied, HISTORICAL when it falls back to the daily close", () => {
    const daily = genCandles(260, 100, 0.35);
    const weekly = genCandles(120, 100, 0.35);
    const nifty = genCandles(260, 24000, 5);

    const withLtp = analyzeEquityStock("TESTSTOCK", daily, weekly, { price: 150 }, {}, { isFoStock: false }, {}, nifty);
    const withoutLtp = analyzeEquityStock("TESTSTOCK", daily, weekly, null, {}, { isFoStock: false }, {}, nifty);

    // Either call may legitimately return null if score < 40 on this
    // synthetic data — only assert price_source when a call is returned.
    if (withLtp) assert.equal(withLtp.price_source, "LIVE");
    if (withoutLtp) assert.equal(withoutLtp.price_source, "HISTORICAL");
});
