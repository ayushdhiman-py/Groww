import { test } from "node:test";
import assert from "node:assert/strict";
import { computeScreenerCategories, screenerState } from "../src/screener.mjs";

function baseRow(overrides = {}) {
    return {
        symbol: "TEST", price: 100, chgPct: 0, volume: 1000, volumeChange: 0, volSpike: false,
        w52H: null, w52L: null, goldenCross: false, macdBull: false, rsi: 50, techScore: 0, priceTs: Date.now(),
        ...overrides,
    };
}

test("bullishCrossover/momentumBurst/rsiOversold are computed from DAILY rows, not 5m — these are conventionally daily-timeframe concepts on every broker app", () => {
    // A stock whose 5m row would qualify for all three categories, but
    // whose DAILY row does NOT — if the daily row wins, none of these
    // categories should include it.
    const rowsByTf = {
        "5m": [baseRow({ symbol: "NOISY5M", goldenCross: true, volSpike: true, macdBull: true, rsi: 10 })],
        "15m": [],
        "1d": [baseRow({ symbol: "NOISY5M", goldenCross: false, volSpike: false, macdBull: false, rsi: 60 })],
    };
    computeScreenerCategories(rowsByTf);
    assert.equal(screenerState.bullishCrossover.length, 0, "5m-only golden cross must not appear — daily row has goldenCross:false");
    assert.equal(screenerState.momentumBurst.length, 0, "5m-only momentum must not appear — daily row has volSpike/macdBull:false");
    assert.equal(screenerState.rsiOversold.length, 0, "5m-only oversold RSI must not appear — daily RSI is 60, not <30");
});

test("bullishCrossover/momentumBurst/rsiOversold DO include a stock whose DAILY row qualifies", () => {
    const rowsByTf = {
        "5m": [baseRow({ symbol: "REALSIGNAL", goldenCross: false, volSpike: false, macdBull: false, rsi: 60 })],
        "15m": [],
        "1d": [baseRow({ symbol: "REALSIGNAL", goldenCross: true, volSpike: true, macdBull: true, rsi: 20, techScore: 5 })],
    };
    computeScreenerCategories(rowsByTf);
    assert.equal(screenerState.bullishCrossover.length, 1);
    assert.equal(screenerState.bullishCrossover[0].symbol, "REALSIGNAL");
    assert.equal(screenerState.momentumBurst.length, 1);
    assert.equal(screenerState.rsiOversold.length, 1);
    assert.equal(screenerState.rsiOversold[0].rsi, 20);
});

test("volumeShockers stays sourced from 5m data (an intraday-relative-volume concept, left unchanged)", () => {
    const rowsByTf = {
        "5m": [baseRow({ symbol: "SPIKY5M", volSpike: true, volumeChange: 5000 })],
        "15m": [],
        "1d": [baseRow({ symbol: "SPIKY5M", volSpike: false, volumeChange: 0 })],
    };
    computeScreenerCategories(rowsByTf);
    assert.equal(screenerState.volumeShockers.length, 1);
    assert.equal(screenerState.volumeShockers[0].symbol, "SPIKY5M");
});

test("gainers/losers/52-week high-low stay sourced from daily data (unchanged, already correct)", () => {
    const rowsByTf = {
        "5m": [],
        "15m": [],
        "1d": [
            baseRow({ symbol: "GAINER", chgPct: 5 }),
            baseRow({ symbol: "LOSER", chgPct: -5 }),
            baseRow({ symbol: "NEARHIGH", price: 100, w52H: 100.5 }), // within 1%
        ],
    };
    computeScreenerCategories(rowsByTf);
    assert.equal(screenerState.gainers[0].symbol, "GAINER");
    assert.equal(screenerState.losers[0].symbol, "LOSER");
    assert.equal(screenerState.high52w.some(r => r.symbol === "NEARHIGH"), true);
});
