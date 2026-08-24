// ─────────────────────────────────────────────────────────────────────────────
// price_action.mjs — Shared, pure price-structure primitives.
//
// Used by BOTH entry_score.mjs (ranking new opportunities) and
// trade_health.mjs (monitoring open Critical trades) so "price action" means
// the same thing on the way in and on the way out. Every function here only
// looks at the candles it's handed — callers are responsible for never
// passing candles beyond "now" (see scanner.mjs / backtest.mjs), which is
// what keeps the whole system free of look-ahead bias.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simple 3-bar fractal pivot detection. Returns chronologically-ordered
 * swing highs/lows. Sparse on short candle sets (e.g. early in the session)
 * — callers must treat "not enough pivots yet" as unknown, not bearish.
 */
export function findPivots(candles) {
    const highs = [], lows = [];
    for (let i = 1; i < candles.length - 1; i++) {
        const c = candles[i];
        if (c.high >= candles[i - 1].high && c.high >= candles[i + 1].high) {
            highs.push({ idx: i, price: c.high, ts: c.ts });
        }
        if (c.low <= candles[i - 1].low && c.low <= candles[i + 1].low) {
            lows.push({ idx: i, price: c.low, ts: c.ts });
        }
    }
    return { highs, lows };
}

/**
 * Higher-highs / higher-lows structure from swing pivots.
 * Returns nulls (not false) when there isn't yet enough data to judge —
 * "no evidence of bullish structure" is a different claim from "structure
 * is bearish," and collapsing them would overstate confidence early in the
 * session.
 */
export function analyzeStructure(candles) {
    if (!candles || candles.length < 5) {
        return { higherHighs: null, higherLows: null, bullishStructure: null, brokeStructure: null, lastSwingHigh: null, lastSwingLow: null, insufficientData: true };
    }
    const { highs, lows } = findPivots(candles);
    const higherHighs = highs.length >= 2 ? highs[highs.length - 1].price > highs[highs.length - 2].price : null;
    const higherLows = lows.length >= 2 ? lows[lows.length - 1].price > lows[lows.length - 2].price : null;
    const brokeStructure = highs.length >= 2 ? highs[highs.length - 1].price < highs[highs.length - 2].price : null;
    const lowerLow = lows.length >= 2 ? lows[lows.length - 1].price < lows[lows.length - 2].price : null;

    return {
        higherHighs, higherLows,
        bullishStructure: higherHighs === true && higherLows === true,
        brokeStructure: brokeStructure === true || lowerLow === true,
        lastSwingHigh: highs.length ? highs[highs.length - 1].price : null,
        lastSwingLow: lows.length ? lows[lows.length - 1].price : null,
        pivotHighCount: highs.length,
        pivotLowCount: lows.length,
        insufficientData: false,
    };
}

/**
 * First bar (chronologically) whose CLOSE breaks above `level`, plus whether
 * that bar's volume confirms the break vs. the average of the bars before it.
 */
export function detectBreakout(candles, level) {
    if (!candles || candles.length < 2 || !Number.isFinite(level) || level <= 0) {
        return { broke: false, barIndex: -1, volConfirmed: false };
    }
    for (let i = 1; i < candles.length; i++) {
        if (candles[i].close > level) {
            const prior = candles.slice(0, i);
            const avgVol = prior.length ? prior.reduce((s, c) => s + (c.volume || 0), 0) / prior.length : 0;
            const volConfirmed = avgVol > 0 && (candles[i].volume || 0) > avgVol * 1.3;
            return { broke: true, barIndex: i, barVolume: candles[i].volume || 0, priorAvgVolume: avgVol, volConfirmed };
        }
    }
    return { broke: false, barIndex: -1, volConfirmed: false };
}

/**
 * After a breakout of `level` at `breakoutBarIndex`, did price pull back
 * close to that level (a "retest") and hold above it, or fail back below?
 */
export function detectRetest(candles, level, breakoutBarIndex, tolerancePct = 0.35) {
    if (breakoutBarIndex < 0 || breakoutBarIndex >= candles.length - 1) {
        return { retested: false, held: null, failed: false };
    }
    let retested = false, failed = false, heldAfterRetest = null;
    for (let i = breakoutBarIndex + 1; i < candles.length; i++) {
        const c = candles[i];
        const nearLevel = Math.abs(c.low - level) / level * 100 <= tolerancePct;
        if (nearLevel) {
            retested = true;
            heldAfterRetest = c.close >= level;
        }
        if (c.close < level * (1 - tolerancePct / 100)) {
            failed = true;
        }
    }
    return { retested, held: retested ? heldAfterRetest : null, failed };
}

/**
 * Rejection candle: large upper wick relative to range, small body —
 * evidence sellers stepped in near the high, not proof of intent.
 */
export function detectRejection(candle) {
    if (!candle) return { rejected: false, upperWickRatio: 0 };
    const range = candle.high - candle.low;
    if (range <= 0) return { rejected: false, upperWickRatio: 0 };
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const body = Math.abs(candle.close - candle.open);
    const upperWickRatio = upperWick / range;
    const bodyRatio = body / range;
    return { rejected: upperWickRatio > 0.55 && bodyRatio < 0.4, upperWickRatio: +upperWickRatio.toFixed(2) };
}

/** Tight-range consolidation over the most recent `lookback` bars. */
export function detectConsolidation(candles, lookback = 10, maxRangePct = 1.5) {
    if (!candles || candles.length < lookback) return { consolidating: false, rangePct: null };
    const slice = candles.slice(-lookback);
    const hi = Math.max(...slice.map(c => c.high));
    const lo = Math.min(...slice.map(c => c.low));
    if (lo <= 0) return { consolidating: false, rangePct: null };
    const rangePct = ((hi - lo) / lo) * 100;
    return { consolidating: rangePct <= maxRangePct, rangePct: +rangePct.toFixed(2) };
}

/**
 * Exhaustion risk: how much of today's typical (ATR-based) daily movement
 * capacity has already been consumed by the current move from open? The
 * same `pctFromOpen / atrPct` ratio computeUpsidePotential() (entry_score.mjs)
 * already computes internally to discount its own zone estimate — surfaced
 * here as a standalone, reusable classification (used by the learning
 * layer's snapshot capture, not just the live Upside Potential estimate).
 * A starting point (thresholds are not battle-tested), easy to retune once
 * real outcome data exists to check against.
 */
export function classifyExhaustionRisk(row) {
    if (row?.pctFromOpen == null || !row?.atrPct) return { level: "LOW", consumedFraction: null };
    const consumedFraction = row.pctFromOpen / row.atrPct;
    const level = consumedFraction > 0.7 ? "HIGH" : consumedFraction > 0.4 ? "MEDIUM" : "LOW";
    return { level, consumedFraction: +consumedFraction.toFixed(2) };
}
