// ─────────────────────────────────────────────────────────────────────────────
// actionable_score.mjs — the Actionable-Quality layer on top of
// entry_score.mjs's Opportunity Score.
//
// Genuinely BUY-only: every signal this reuses (bullish structure, VWAP
// support/reclaim, ORB breakout, "outperforming NIFTY") is inherently
// long-biased — entry_score.mjs has no symmetric bearish-structure/
// breakdown detection to rank a SELL candidate against, so there is no
// honest way to produce one here. SELL is out of scope for this pass, not
// hidden or faked.
//
// Every multiplier below is deterministic and traceable to a real,
// already-computed field. This NEVER reads or writes model_registry.mjs's
// PROPOSED/PRODUCTION weights, and never feeds historical stats back into
// entry_score.mjs's scoring buckets — historical probability only ever
// nudges THIS score by a small, bounded, visible amount (see
// historicalAdjustment below), matching "deterministic historical
// statistics only, never a silent weight change."
// ─────────────────────────────────────────────────────────────────────────────

import { buildTradePlan } from "./trade_plan.mjs";
import { computePositionSizing } from "./position_sizing.mjs";
import { classifyTrapRisk } from "./trade_health.mjs";
import { liquidityGate, atrGate } from "./entry_score.mjs";
import { DEFAULT_WEIGHTS, aggregateScore } from "./model_registry.mjs";
import { MIN_ACTIONABLE_SCORE_FLOOR, MAX_DISPLAYED_OPPORTUNITIES } from "./config.mjs";

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Reconstructs the Opportunity Score using DEFAULT_WEIGHTS explicitly,
 * NEVER getProductionWeights() — the guarantee is that the Intraday
 * Actionable-Quality Score stays deterministic even if a PROPOSED model
 * version is ever manually promoted to PRODUCTION later (entry_score.mjs's
 * shared computeOpportunityScore — used by every other tab/consumer — is
 * deliberately left untouched and still reads getProductionWeights(); this
 * is a parallel, Intraday-only reconstruction, not a change to it).
 * Reuses aggregateScore() (model_registry.mjs) and the same liquidity/ATR
 * gate functions computeOpportunityScore itself uses (now exported from
 * entry_score.mjs) — same math, no duplicated logic, just a fixed weight
 * set. Falls back to the live opportunityScore only if the breakdown isn't
 * available for some reason (never fabricates a number).
 */
function deterministicOpportunityScore(candidate, row5) {
    if (!candidate.opportunityBreakdown) return candidate.opportunityScore ?? 0;
    const normalized = aggregateScore(candidate.opportunityBreakdown, DEFAULT_WEIGHTS);
    const liq = liquidityGate(row5);
    const vol = atrGate(row5);
    return Math.round(clamp(normalized * liq.multiplier * vol.multiplier, 0, 100));
}

// trade_health.mjs's 4-level trap classification, mapped down to the
// LOW/MEDIUM/HIGH scale for display — same underlying evidence-based logic
// (classifyTrapRisk), reused rather than duplicated.
const TRAP_LEVEL_MAP = { "NORMAL": "LOW", "CAUTION": "LOW", "TRAP RISK": "MEDIUM", "STRONG TRAP RISK": "HIGH" };
const TRAP_MULTIPLIER = { "NORMAL": 1.0, "CAUTION": 0.95, "TRAP RISK": 0.8, "STRONG TRAP RISK": 0.55 };

function remainingMoveMultiplier(remainingPct) {
    if (remainingPct == null) return { m: 0.85, note: "Remaining-move estimate unavailable — precautionary discount", warn: true };
    if (remainingPct < 0.3) return { m: 0.5, note: `Only +${remainingPct}% remaining upside estimated — most of the likely move has already happened`, warn: true };
    if (remainingPct < 0.5) return { m: 0.75, note: `+${remainingPct}% remaining upside estimated — below the preferred 0.5%+ zone`, warn: true };
    return { m: 1.0, note: null, warn: false };
}

function rrMultiplier(rr) {
    if (rr < 1.5) return { m: 0.92, note: `R:R ${rr} — modest`, warn: false };
    if (rr < 2) return { m: 1.0, note: null, warn: false };
    return { m: 1.05, note: `R:R ${rr} — strong`, warn: false };
}

// Bounded (+3/-5) and only ever a tie-breaker on top of the already-computed
// score — deliberately small so historical stats can never dominate the
// rule-based read, matching "historical probability must not silently
// modify scoring rules or weights."
function historicalAdjustment(calibratedProbability) {
    if (!calibratedProbability?.available) return { delta: 0, note: null };
    const { probReach1pct, sampleCount } = calibratedProbability;
    if (probReach1pct == null || sampleCount == null) return { delta: 0, note: null };
    if (probReach1pct >= 0.65 && sampleCount >= 20) {
        return { delta: 3, note: `Historically reached +1% in ${Math.round(probReach1pct * 100)}% of similar setups (n=${sampleCount})`, warn: false };
    }
    if (probReach1pct <= 0.35 && sampleCount >= 20) {
        return { delta: -5, note: `Historically reached +1% in only ${Math.round(probReach1pct * 100)}% of similar setups (n=${sampleCount}) — caution`, warn: true };
    }
    return { delta: 0, note: null, warn: false };
}

/**
 * @param {object} candidate - one entry from entry_score.mjs's `allRanked`
 *   (same shape as `opportunities`, just not truncated to 40).
 * @param {object} row5 - the matching full 5m buildSignal() row this cycle.
 */
export function scoreActionableCandidate(candidate, row5) {
    const plan = buildTradePlan(row5, candidate);
    if (!plan.valid) return { qualifies: false, reason: plan.reason };

    const sizing = computePositionSizing(plan);
    const trap = classifyTrapRisk(row5, null);
    const notes = [], warnings = [...trap.flags];

    const rm = remainingMoveMultiplier(candidate.upside?.remainingPct);
    if (rm.note) (rm.warn ? warnings : notes).push(rm.note);

    const rr = rrMultiplier(plan.riskReward);
    if (rr.note) notes.push(rr.note);

    const trapMult = TRAP_MULTIPLIER[trap.level] ?? 1.0;

    const tfConflict = candidate.broaderTrendSupportive === false;
    const tfMult = tfConflict ? 0.9 : 1.0;
    if (tfConflict) warnings.push("30m broader trend not confirming — 5m/15m momentum may be running against the higher timeframe");

    // Reuses Entry Attractiveness (entry_score.mjs — "is NOW a good entry?",
    // already penalizes distance-from-open/ATR-consumed/VWAP-extension) as
    // the overextension factor here instead of recomputing an equivalent
    // metric.
    const entryMult = clamp(0.7 + (candidate.entryAttractiveness ?? 50) / 100 * 0.3, 0.7, 1.0);

    const hist = historicalAdjustment(candidate.calibratedProbability);
    if (hist.note) (hist.warn ? warnings : notes).push(hist.note);

    const base = deterministicOpportunityScore(candidate, row5);
    const score = Math.round(clamp(base * rm.m * rr.m * trapMult * tfMult * entryMult + hist.delta, 0, 100));

    if (score < MIN_ACTIONABLE_SCORE_FLOOR) {
        return { qualifies: false, reason: `Actionable score ${score} below the ${MIN_ACTIONABLE_SCORE_FLOOR} floor` };
    }

    return {
        qualifies: true,
        actionableScore: score,
        direction: "BUY",
        tradePlan: plan,
        positionSizing: sizing,
        operatorTrapRisk: TRAP_LEVEL_MAP[trap.level] ?? "LOW",
        trapFlags: trap.flags,
        timeframeConflict: tfConflict,
        actionableNotes: notes,
        actionableWarnings: warnings,
    };
}

/**
 * Orchestrator — called once per scan cycle (scanner.mjs), only while the
 * Intraday tab's active-heartbeat is fresh. `candidates` is
 * entry_score.mjs's full `allRanked` list (every dual-timeframe-confirmed
 * candidate, not just the top-40 `opportunities` slice — remaining-move/R:R
 * down-ranking needs real headroom); `row5BySymbol` is a Map of this
 * cycle's full 5m rows (structure/orb/ATR/VWAP fields the trimmed
 * opportunity object doesn't carry).
 */
export function buildActionableIntraday(candidates, row5BySymbol) {
    const out = [];
    for (const c of candidates || []) {
        const row5 = row5BySymbol.get(c.symbol);
        if (!row5) continue;
        const result = scoreActionableCandidate(c, row5);
        if (!result.qualifies) continue;
        out.push({ ...c, ...result });
    }
    out.sort((a, b) => b.actionableScore - a.actionableScore);
    return out.slice(0, MAX_DISPLAYED_OPPORTUNITIES);
}
