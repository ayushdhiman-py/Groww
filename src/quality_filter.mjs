// ─────────────────────────────────────────────────────────────────────────────
// quality_filter.mjs — the "Top 50 Quality" screener.
//
// A SEPARATE pipeline from entry_score.mjs's Intraday Opportunities/Fast
// Movers (which are untouched by this file, and keep working exactly as
// before — Critical trades and capital_rotation.mjs still read from them).
// This is a from-scratch funnel built around one explicit distinction:
// REJECT invalid, PENALIZE imperfect. A stale price, broken structure, or a
// contradictory combination of signals kills a candidate outright; being
// below VWAP or lacking a broader-timeframe confirmation only lowers its
// score.
//
// Pipeline: hard validity gates → weighted evidence score → evidence
// breadth → percentile normalization (against THIS cycle's survivor pool)
// → regime-scaled cutoff → sector/near-duplicate dedup → rank → Top 50 (or
// fewer, if fewer genuinely clear the bar).
//
// Runs once per scan cycle, AFTER entry_score.mjs's enrichOpportunities()
// has already mutated every row in place — this reads those already-computed
// sub-scores (relativeStrength, vwap, orb, priceAction, volume, orderFlow,
// confirmation) rather than recomputing indicators from scratch. Reusing
// them is deliberate, not laziness: recomputing would either duplicate
// entry_score.mjs's logic or silently drift from it.
// ─────────────────────────────────────────────────────────────────────────────

export const FORMULA_VERSION = "quality-v1";

// A candle/price older than this many multiples of its own expected refresh
// interval is treated as stale for THAT factor specifically — never
// silently included as if current. 5m bars refresh every 5 min; anything
// more than 2 cycles (10 min) old didn't just miss one refresh, it missed
// this whole scan pass.
const STALE_MULTIPLE = 2;
const TF_REFRESH_MS = { "5m": 5 * 60_000, "15m": 15 * 60_000, "30m": 30 * 60_000, "1d": 86_400_000 };

const LIQUIDITY_FLOOR_INR = 2_000_000; // same floor as entry_score.mjs's liquidityGate, but a hard reject here, not a soft multiplier
const MIN_ATR_PCT = 0.8; // below this, the stock structurally can't move enough today regardless of setup quality

// Regime-scaled cutoff — expressed as a MINIMUM PERCENTILE within this
// cycle's survivor pool (not a raw score), so the bar self-adjusts to how
// strong the day is overall while still demanding more confluence on a
// weak/uncertain tape. Mirrors the 70/80/95 raw-score philosophy already
// used by entry_score.mjs's regimeMinOpportunityScore, applied post-
// normalization instead of pre.
const MIN_PERCENTILE_BY_REGIME = { BULLISH: 60, SIDEWAYS: 80, BEARISH: 95 };

const TOP_N = 50;
const MAX_PER_SECTOR = 8; // prevents one hot sector from filling the whole list
const NEAR_DUPLICATE_PCT_GAP = 0.3; // same sector + within this many pp of today's move = treated as a duplicate mover

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

/**
 * Is `ts` (epoch ms, possibly null) fresh enough for a bar of size `tf`?
 * Missing entirely counts as stale — there is no "assume it's fine" branch.
 */
function isFresh(ts, tf) {
    if (ts == null) return false;
    const refresh = TF_REFRESH_MS[tf] ?? 5 * 60_000;
    return (Date.now() - ts) <= refresh * STALE_MULTIPLE;
}

/**
 * Hard validity gate — binary, no scoring yet. Returns {ok:true} or
 * {ok:false, reason} so a rejection is always explainable, never a silent
 * disappearance from the list.
 */
export function hardValidityGate(row5, row15, marketRegime) {
    if (!row5 || row5.sector === "INDEX") return { ok: false, reason: "not-a-tradable-equity" };

    if (marketRegime?.noTrade) return { ok: false, reason: "regime-no-trade" };

    if (!isFresh(row5.candleTs, "5m")) return { ok: false, reason: "stale-5m-candle" };
    if (row5.priceTs == null) return { ok: false, reason: "no-honest-price-timestamp" };

    const traded = (row5.volume || 0) * (row5.price || 0);
    if (traded < LIQUIDITY_FLOOR_INR) return { ok: false, reason: "below-liquidity-floor" };

    if (row5.atrPct != null && row5.atrPct < MIN_ATR_PCT) return { ok: false, reason: "insufficient-atr-capacity" };

    // Obvious contradictions — a combination of signals that can't both be
    // true of a genuinely good setup, regardless of how strong anything
    // else about it looks.
    const structureBroken = row5.structure && !row5.structure.insufficientData && row5.structure.brokeStructure;
    const retestFailed = row5.orb?.retestFailed === true;
    if (structureBroken && retestFailed) return { ok: false, reason: "broken-structure-and-failed-retest" };

    const heavySelling = row5.buySellRatio != null && row5.buySellRatio < 0.6;
    const claimsBreakout = row5.orb?.brokenAbove === true;
    if (heavySelling && claimsBreakout) return { ok: false, reason: "sell-side-order-flow-contradicts-breakout" };

    const priceFalling = row5.pctFromOpen != null && row5.pctFromOpen < -0.5;
    const claimsBullishStructure = row5.structure?.bullishStructure === true;
    if (priceFalling && claimsBullishStructure) return { ok: false, reason: "price-falling-contradicts-bullish-structure" };

    return { ok: true, reason: null };
}

/**
 * One weighted-evidence factor. Reuses an already-computed sub-score from
 * entry_score.mjs's opportunityBreakdown (normalized to 0-1) when that
 * sub-score's own inputs are fresh; returns {available:false} otherwise —
 * NEVER a default/neutral guess. `label` is what shows up in evidence-breadth
 * reporting.
 */
function factor(label, rawScore, maxScore, fresh) {
    if (!fresh || rawScore == null) return { label, available: false, value: null };
    return { label, available: true, value: clamp01(rawScore / maxScore) };
}

/**
 * Weighted evidence score for one candidate (already past the hard gate).
 * Every factor here is read from row5's opportunityBreakdown — computed
 * once by entry_score.mjs, not recomputed — plus row15/row30/row1d used
 * only as SUPPORTING bonus evidence, never a required gate (per the "5m/
 * 15m/1h/1D as supporting evidence, not mandatory agreement" rule).
 */
export function computeWeightedEvidence(row5, row15, row30, row1d) {
    const bd = row5.opportunityBreakdown || {};
    const fresh5 = isFresh(row5.candleTs, "5m");

    const factors = [
        factor("relativeStrength", bd.relativeStrength?.score, 15, fresh5),
        factor("vwap", bd.vwap?.score, 15, fresh5),
        factor("momentum", bd.confirmation?.score, 10, fresh5),
        factor("breakoutStructure", (bd.orb?.score ?? 0) + (bd.priceAction?.score ?? 0), 35, fresh5),
        factor("volatilityEfficiency", bd.openingStrength?.score, 15, fresh5),
        factor("relativeVolume", bd.volume?.score, 15, fresh5),
        factor("orderFlow", bd.orderFlow?.score, 8, fresh5),
    ];

    // Supporting-timeframe evidence — bonus only, capped so it can never by
    // itself carry a candidate that the core factors don't support.
    const supporting = [];
    if (row15 && isFresh(row15.candleTs, "15m") && (row15.opportunityScore ?? 0) >= 50) {
        supporting.push({ label: "15mConfirms", available: true, value: 1 });
    }
    if (row30 && isFresh(row30.candleTs, "30m") && (row30.opportunityScore ?? 0) >= 50) {
        supporting.push({ label: "30mConfirms", available: true, value: 1 });
    }
    if (row1d && isFresh(row1d.candleTs, "1d") && (row1d.opportunityScore ?? 0) >= 50) {
        supporting.push({ label: "1dConfirms", available: true, value: 1 });
    }

    const availableCore = factors.filter(f => f.available);
    const coreRaw = availableCore.length
        ? (availableCore.reduce((s, f) => s + f.value, 0) / availableCore.length) * 100
        : 0;
    const supportingBonus = supporting.reduce((s, f) => s + f.value, 0) * (5 / 3); // up to +5 total across the 3 supporting flags
    const compositeScore = Math.min(100, Math.round(coreRaw + supportingBonus));

    const allEvidence = [...factors, ...supporting];
    const breadthAvailable = allEvidence.filter(f => f.available);
    const breadthPositive = breadthAvailable.filter(f => f.value > 0.3);

    return {
        compositeScore,
        coreRaw: +coreRaw.toFixed(2),
        supportingBonus: +supportingBonus.toFixed(2),
        factors: Object.fromEntries(allEvidence.map(f => [f.label, f.available ? +f.value.toFixed(3) : null])),
        breadth: { positive: breadthPositive.length, available: breadthAvailable.length, total: allEvidence.length },
    };
}

/** Percentile rank of each candidate's compositeScore within `candidates` (0-100, higher = stronger relative to the rest of THIS cycle's pool). */
export function percentileNormalize(candidates) {
    const sorted = [...candidates].sort((a, b) => a._evidence.compositeScore - b._evidence.compositeScore);
    const n = sorted.length;
    sorted.forEach((c, i) => {
        c._percentile = n > 1 ? Math.round((i / (n - 1)) * 100) : 100;
    });
    return candidates;
}

/** Sector cap + near-duplicate-mover dedup, applied to an already-ranked (best-first) list. */
function dedupeSectorAndCorrelation(rankedCandidates) {
    const sectorCounts = {};
    const kept = [];
    for (const c of rankedCandidates) {
        const sector = c.sector || "OTHER";
        sectorCounts[sector] = sectorCounts[sector] || 0;
        if (sectorCounts[sector] >= MAX_PER_SECTOR) continue;

        const isDuplicateMover = kept.some(k =>
            k.sector === sector &&
            Math.abs((k.pctFromOpen ?? 0) - (c.pctFromOpen ?? 0)) < NEAR_DUPLICATE_PCT_GAP
        );
        if (isDuplicateMover) continue;

        sectorCounts[sector]++;
        kept.push(c);
    }
    return kept;
}

/**
 * Orchestrator — call once per scan cycle. `dataBuckets` is scanner.mjs's
 * `next.data` (already mutated by entry_score.mjs's enrichOpportunities()).
 * Returns {list, meta} — meta carries the provenance every result is
 * stamped with, so a Top-50 list is reproducible/auditable later.
 */
export function buildQualityList(dataBuckets, marketRegime) {
    const rows5 = dataBuckets["5m_ALL"] || [];
    const rows15ByS = new Map((dataBuckets["15m_ALL"] || []).map(r => [r.symbol, r]));
    const rows30ByS = new Map((dataBuckets["30m_ALL"] || []).map(r => [r.symbol, r]));
    const rows1dByS = new Map((dataBuckets["1d_ALL"] || []).map(r => [r.symbol, r]));

    const rejections = {};
    const survivors = [];

    for (const row5 of rows5) {
        const row15 = rows15ByS.get(row5.symbol);
        const gate = hardValidityGate(row5, row15, marketRegime);
        if (!gate.ok) {
            rejections[gate.reason] = (rejections[gate.reason] || 0) + 1;
            continue;
        }

        const row30 = rows30ByS.get(row5.symbol);
        const row1d = rows1dByS.get(row5.symbol);
        const evidence = computeWeightedEvidence(row5, row15, row30, row1d);

        survivors.push({
            symbol: row5.symbol, sector: row5.sector,
            price: row5.price, priceSource: row5.priceSource, priceTs: row5.priceTs,
            pctFromOpen: row5.pctFromOpen, chgPct: row5.chgPct, volSpike: row5.volSpike,
            priceHist: row5.priceHist, ema21Hist: row5.ema21Hist, ema50Hist: row5.ema50Hist,
            _evidence: evidence,
        });
    }

    percentileNormalize(survivors);

    const minPercentile = MIN_PERCENTILE_BY_REGIME[marketRegime?.regime] ?? MIN_PERCENTILE_BY_REGIME.SIDEWAYS;
    const qualifying = survivors.filter(c => c._percentile >= minPercentile);
    qualifying.sort((a, b) => b._percentile - a._percentile || b._evidence.compositeScore - a._evidence.compositeScore);

    const deduped = dedupeSectorAndCorrelation(qualifying);
    const top = deduped.slice(0, TOP_N);

    const snapshotTimestamp = Date.now();
    const dataAsOfCandidates = rows5.map(r => r.candleTs).filter(ts => ts != null);
    const dataAsOf = dataAsOfCandidates.length ? Math.min(...dataAsOfCandidates) : null;

    const list = top.map(c => ({
        symbol: c.symbol, sector: c.sector, price: c.price, priceSource: c.priceSource, priceTs: c.priceTs,
        pctFromOpen: c.pctFromOpen, chgPct: c.chgPct, volSpike: c.volSpike,
        priceHist: c.priceHist, ema21Hist: c.ema21Hist, ema50Hist: c.ema50Hist,
        compositeScore: c._evidence.compositeScore,
        percentile: c._percentile,
        evidenceBreadth: c._evidence.breadth,
        provenance: {
            formulaVersion: FORMULA_VERSION,
            regime: marketRegime?.regime ?? "UNKNOWN",
            snapshotTimestamp,
            dataAsOf,
            factorScores: c._evidence.factors,
        },
    }));

    return {
        list,
        meta: {
            formulaVersion: FORMULA_VERSION,
            regime: marketRegime?.regime ?? "UNKNOWN",
            minPercentile,
            snapshotTimestamp,
            dataAsOf,
            universeSize: rows5.length,
            survivorCount: survivors.length,
            qualifyingCount: qualifying.length,
            returnedCount: list.length,
            rejectionReasons: rejections,
        },
    };
}
