// ─────────────────────────────────────────────────────────────────────────────
// trade_plan.mjs — Entry zone / Stop Loss / Target 1 / Target 2 / R:R
// derivation for the Intraday Actionable-Quality layer.
//
// Every level here comes from data scanAll() already computed this cycle:
// swing pivots (price_action.mjs's analyzeStructure, via buildSignal's
// `structure`), the opening range (`orb`), ATR, session VWAP, and the
// Upside Potential zone (entry_score.mjs's computeUpsidePotential — itself
// already ATR/structure/resistance-bounded). Nothing here fetches new data
// or invents a level; a candidate with insufficient real structure to
// derive a defensible stop/target, or whose R:R doesn't clear the
// configured minimum, is marked invalid rather than filled in with a guess.
// ─────────────────────────────────────────────────────────────────────────────

import { MIN_RR_RATIO } from "./config.mjs";

/**
 * @param {object} row - the full buildSignal() row for this symbol on the
 *   5m timeframe (has price, atr, structure.lastSwingLow, orb.low/high,
 *   sessionVwap, aboveSessionVwap — fields entry_score.mjs's trimmed
 *   opportunity object doesn't carry).
 * @param {object} opportunity - the entry_score.mjs opportunity summary
 *   (has upside.zoneLow/zoneHigh/remainingPct, already ATR+resistance-
 *   bounded — reused directly as Target 1/Target 2, never recomputed here).
 */
export function buildTradePlan(row, opportunity) {
    const price = row?.price;
    const atr = row?.atr;
    const upside = opportunity?.upside;

    if (!price || !atr || upside?.zoneLow == null || upside?.zoneHigh == null) {
        return { valid: false, reason: "Insufficient data (missing price/ATR/upside zone) to derive a defensible trade plan" };
    }

    // Entry zone — a tight band around the current price. This is a "room
    // still available right now" candidate, not a pending order far away.
    const entryLow = +price.toFixed(2);
    const entryHigh = +(price + atr * 0.2).toFixed(2);

    // Stop Loss — the tightest REAL support below price: last swing low,
    // the opening-range low (only if price already broke above it — an
    // unbroken ORB low isn't support, it's just today's start), or session
    // VWAP (only if currently held above it). Take whichever of those is
    // closest to price (least risk) while still being real; fall back to a
    // pure-ATR distance only if none apply. A noise floor and a max-risk
    // ceiling (both ATR-relative) keep the stop from being either
    // noise-tight or unreasonably wide.
    const candidates = [
        row.structure?.lastSwingLow,
        row.orb?.brokenAbove ? row.orb?.low : null,
        row.aboveSessionVwap ? row.sessionVwap : null,
    ].filter(v => v != null && v < price);

    let stopLoss = candidates.length ? Math.max(...candidates) : (price - atr);
    const minRisk = atr * 0.3, maxRisk = atr * 1.5;
    if (price - stopLoss < minRisk) stopLoss = price - minRisk;
    if (price - stopLoss > maxRisk) stopLoss = price - maxRisk;
    stopLoss = +stopLoss.toFixed(2);

    if (stopLoss >= entryLow) {
        return { valid: false, reason: "No valid stop-loss level below current price" };
    }

    // Targets — the Upside Potential zone's own price levels, reused as-is.
    const target1 = upside.zoneLow;
    const target2 = upside.zoneHigh;

    const risk = entryLow - stopLoss;
    const reward1 = target1 - entryLow;
    const reward2 = target2 - entryLow;

    if (risk <= 0 || reward1 <= 0) {
        return { valid: false, reason: "Degenerate entry/stop/target geometry — no real room between them" };
    }

    const riskReward = +(reward1 / risk).toFixed(2);
    const riskReward2 = +(reward2 / risk).toFixed(2);

    if (riskReward < MIN_RR_RATIO) {
        return { valid: false, reason: `Risk/Reward ${riskReward} below the configured minimum ${MIN_RR_RATIO}`, riskReward };
    }

    return {
        valid: true,
        entryLow, entryHigh,
        stopLoss, target1, target2,
        riskPct: +((risk / entryLow) * 100).toFixed(2),
        rewardPct: +((reward1 / entryLow) * 100).toFixed(2),
        riskReward, riskReward2,
        expectedMovePct: upside.remainingPct,
    };
}
