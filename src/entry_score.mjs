// ─────────────────────────────────────────────────────────────────────────────
// entry_score.mjs — Opportunity Score, Entry Attractiveness, Upside Potential.
//
// Runs once per full scan cycle (~30s), after scanAll() has built rows for
// every symbol across every timeframe — it is a cross-sectional pass (needs
// NIFTY's row and sector peers' rows to exist already), which is why it
// can't live inside buildSignal() itself.
//
// Every input here is something scanAll() already computed FOR THE CURRENT
// MOMENT from real Upstox candles/LTP — nothing here fabricates data or
// peeks at future candles, which is what keeps this reusable, unchanged, by
// a future backtester without violating no-look-ahead.
// ─────────────────────────────────────────────────────────────────────────────

import { recordSectorSnapshot, getSectorMomentum } from "./sector_history.mjs";

const INTRADAY_TFS = ["5m", "15m", "30m"];

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function istHourDecimal() {
    const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    return ist.getHours() + ist.getMinutes() / 60;
}

// ── Cross-sectional context: NIFTY's row + per-sector aggregates ──────────────
export function buildMarketContext(dataBuckets, tf) {
    const rows = dataBuckets[`${tf}_ALL`] || [];
    const niftyRow = rows.find(r => r.symbol === "NIFTY") || null;

    const bySector = {};
    for (const r of rows) {
        if (r.sector === "INDEX" || r.pctFromOpen == null) continue;
        const s = bySector[r.sector] || (bySector[r.sector] = { sum: 0, count: 0, positive: 0 });
        s.sum += r.pctFromOpen;
        s.count += 1;
        if (r.pctFromOpen > 0) s.positive += 1;
    }
    const sectorStats = {};
    for (const [sector, s] of Object.entries(bySector)) {
        sectorStats[sector] = {
            avgPctFromOpen: s.count ? +(s.sum / s.count).toFixed(2) : null,
            positiveShare: s.count ? +(s.positive / s.count).toFixed(2) : null,
            count: s.count,
        };
    }

    // Only the 5m context is used to sample sector history — 15m/30m call
    // this too but the 1/min throttle inside recordSectorSnapshot means only
    // the first call in any given minute actually records anything.
    if (tf === "5m") recordSectorSnapshot(sectorStats);
    for (const sector of Object.keys(sectorStats)) {
        sectorStats[sector].momentum = getSectorMomentum(sector, 10);
    }

    return { niftyRow, sectorStats };
}

// ── Opportunity Score buckets (weights sum to 105 raw, normalized to 100) ────
// Deliberately bucketed by underlying phenomenon, not by indicator name, so
// EMA/MACD/RSI — which mostly restate the same trend price action and VWAP
// already scored — contribute only a small "confirmation" allowance instead
// of full independent weight (the "do NOT double-count" requirement).

function scorePriceAction(row) {
    let score = 0; const notes = [];
    const s = row.structure;
    if (s && !s.insufficientData) {
        if (s.bullishStructure) { score += 10; notes.push("Higher highs & higher lows today"); }
        else if (s.higherLows === true && s.higherHighs !== false) { score += 5; notes.push("Higher lows holding"); }
        if (s.brokeStructure) { score -= 6; notes.push("Structure broken — a lower high has formed"); }
    }
    if (row.consolidation?.consolidating) { score += 3; notes.push(`Tight consolidation (${row.consolidation.rangePct}% range)`); }
    if (row.rejection?.rejected) { score -= 4; notes.push("Latest candle shows an upper-wick rejection"); }
    if (row.orb?.brokenAbove && row.orb?.retestFailed) { score -= 5; notes.push("Failed retest of the opening-range high"); }
    else if (row.orb?.brokenAbove && (row.orb?.retested === false || row.orb?.retestHeld)) { score += 4; notes.push("Holding above the opening range"); }
    if (row.prevDayH != null && row.price != null) {
        if (row.price > row.prevDayH) { score += 3; notes.push(`Trading above previous day's high (₹${row.prevDayH})`); }
        else if (row.rejection?.rejected && Math.abs(row.price - row.prevDayH) / row.prevDayH < 0.01) { score -= 3; notes.push("Rejected near previous day's high"); }
    }
    return { score: clamp(score, 0, 20), notes };
}

function scoreOpeningStrength(row) {
    if (row.pctFromOpen == null) return { score: 0, notes: ["Opening data unavailable"] };
    let score = 0; const notes = [];
    if (row.pctFromOpen > 0) { score += 6; notes.push(`+${row.pctFromOpen.toFixed(2)}% from today's open`); }
    if (row.atrPct) {
        const consumed = row.pctFromOpen / row.atrPct;
        if (consumed >= 0 && consumed <= 0.35) { score += 9; notes.push("Early in its typical daily range — sustainable so far"); }
        else if (consumed > 0.35 && consumed <= 0.7) score += 5;
        else if (consumed > 0.7) { score += 1; notes.push("Already used most of its typical daily range"); }
    } else {
        score += 3;
    }
    return { score: clamp(score, 0, 15), notes };
}

function scoreVwap(row) {
    let score = 0; const notes = [];
    if (row.aboveSessionVwap) {
        score += 8; notes.push("Above session VWAP");
        if (row.vwapReclaimed) notes.push("Reclaimed VWAP after dipping below — support holding");
    } else if (row.aboveSessionVwap === false) {
        notes.push("Below session VWAP");
        if (row.vwapReclaimFailed) { score -= 3; notes.push("Failed to hold a VWAP reclaim"); }
    }
    if (row.sessionVwapSlope != null) {
        if (row.sessionVwapSlope > 0) { score += 7; notes.push("Session VWAP rising"); }
        else notes.push("Session VWAP flat or falling");
    }
    return { score: clamp(score, 0, 15), notes };
}

function scoreOrb(row, tf) {
    if (!row.orb || row.orb.high == null) return { score: 0, notes: ["No opening-range data yet"] };
    let score = 0; const notes = [];
    if (row.orb.brokenAbove) {
        score += 6; notes.push(`Broke the ${tf} opening-range high`);
        if (row.orb.volConfirmed) { score += 5; notes.push("Breakout volume confirmed"); }
        if (row.orb.retested && row.orb.retestHeld) { score += 4; notes.push("Retested opening range and held"); }
        else if (row.orb.retestFailed) { score -= 6; notes.push("Retest of opening range failed"); }
    }
    return { score: clamp(score, 0, 15), notes };
}

function scoreVolume(row) {
    let score = 0; const notes = [];
    if (row.volSpike) { score += 7; notes.push("Volume spike vs its own recent average"); }
    if ((row.volumeChange || 0) > 0) { score += 3; notes.push("Volume accelerating bar-on-bar"); }
    // Time-of-day normalization approximation: no per-symbol historical
    // intraday volume profile is fetched (would need many extra API calls
    // per symbol) — instead discount raw volume spikes that land inside the
    // generically thinner midday window rather than treat every spike as
    // equally meaningful regardless of time of day.
    const hour = istHourDecimal();
    const middayLull = hour > 11.5 && hour < 13.5;
    if (row.volSpike && !middayLull) { score += 5; notes.push("Spike outside the typical midday volume lull"); }
    else if (row.volSpike && middayLull) notes.push("Spike during the typical midday lull — weighted down");
    return { score: clamp(score, 0, 15), notes };
}

// Recent return over the last `bars` candles from a priceHist array (both
// stock and NIFTY rows carry the same-length, same-tf priceHist, so indices
// line up closely enough to compare short-term trend, not just the
// since-open snapshot).
function recentReturnPct(priceHist, bars = 5) {
    if (!priceHist || priceHist.length < bars + 1) return null;
    const cur = priceHist[priceHist.length - 1];
    const prior = priceHist[priceHist.length - 1 - bars];
    if (!prior) return null;
    return ((cur - prior) / prior) * 100;
}

function scoreRelativeStrength(row, ctx) {
    let score = 0; const notes = [];
    const nifty = ctx.niftyRow;
    if (nifty && row.pctFromOpen != null && nifty.pctFromOpen != null) {
        const rsVsNifty = row.pctFromOpen - nifty.pctFromOpen;
        if (rsVsNifty > 0.3) { score += 8; notes.push(`Outperforming NIFTY by ${rsVsNifty.toFixed(2)}pp since open`); }
        else if (rsVsNifty > 0) score += 4;
        else notes.push("Underperforming NIFTY since open");
    }
    // Improving relative strength: is the stock pulling ahead of NIFTY over
    // the last few bars, not just cumulatively since open? A distinct signal
    // from the since-open snapshot above (a stock can be behind since open
    // but currently pulling ahead, or vice versa).
    if (nifty) {
        const stockRet = recentReturnPct(row.priceHist, 5);
        const niftyRet = recentReturnPct(nifty.priceHist, 5);
        if (stockRet != null && niftyRet != null && stockRet - niftyRet > 0.1) {
            score += 2; notes.push("Relative strength improving vs NIFTY over the last few bars");
        }
    }
    const sectorStat = ctx.sectorStats?.[row.sector];
    if (sectorStat && sectorStat.avgPctFromOpen != null) {
        if (row.pctFromOpen != null && row.pctFromOpen > sectorStat.avgPctFromOpen && sectorStat.positiveShare >= 0.5) {
            score += 5; notes.push(`Leading its sector (${row.sector})`);
        } else if (sectorStat.positiveShare >= 0.5) {
            score += 2; notes.push(`Sector ${row.sector} broadly positive`);
        } else {
            notes.push(`Sector ${row.sector} weak today`);
        }
        // Momentum = change in the sector's own average move-from-open over
        // the last ~10 minutes — a trend, distinct from the snapshot above.
        if (sectorStat.momentum != null && sectorStat.momentum > 0.2) {
            score += 1; notes.push(`Sector ${row.sector} momentum improving (+${sectorStat.momentum}pp/10min)`);
        }
    }
    return { score: clamp(score, 0, 15), notes };
}

function scoreConfirmation(row) {
    // Capped low and clearly separate from priceAction/VWAP above — EMA/MACD/
    // RSI mostly restate the same underlying trend, so they only get to add a
    // small confirmation allowance, not independent full weight.
    let score = 0; const notes = [];
    if (row.emaBullAligned) {
        score += 3; notes.push("EMA 9 > 21 > 50 aligned");
        if ((row.ema21Slope ?? 0) > 0) { score += 1; notes.push("EMA21 slope rising"); }
    }
    if (row.macdBull || (row.macdAbove && (row.macdHistAccel ?? 0) > 0)) { score += 3; notes.push("MACD histogram accelerating bullish"); }
    if (row.rsi != null && row.rsi >= 50 && row.rsi <= 72) { score += 3; notes.push(`RSI ${row.rsi} — healthy momentum`); }
    else if (row.rsi != null && row.rsi > 80) notes.push(`RSI ${row.rsi} — extended, watch for deterioration`);
    return { score: clamp(score, 0, 10), notes };
}

// ── Gates (multiplicative, not additive) ──────────────────────────────────────
function liquidityGate(row) {
    const traded = (row.volume || 0) * (row.price || 0);
    if (traded < 2_000_000) return { multiplier: 0.5, note: "Low traded value today — execution/spread risk at size" };
    if (traded < 8_000_000) return { multiplier: 0.85, note: "Moderate traded value" };
    return { multiplier: 1.0, note: null };
}

function atrGate(row) {
    if (row.atrPct == null) return { multiplier: 0.9, note: "ATR unavailable — precautionary discount" };
    if (row.atrPct < 1.2) return { multiplier: 0.6, note: `ATR ${row.atrPct}% — limited intraday movement capacity` };
    return { multiplier: 1.0, note: null };
}

/** Opportunity Score — "how strong is the stock?" */
export function computeOpportunityScore(row, ctx, tf) {
    const buckets = {
        priceAction: scorePriceAction(row),
        openingStrength: scoreOpeningStrength(row),
        vwap: scoreVwap(row),
        orb: scoreOrb(row, tf),
        volume: scoreVolume(row),
        relativeStrength: scoreRelativeStrength(row, ctx),
        confirmation: scoreConfirmation(row),
    };
    const MAX_RAW = 20 + 15 + 15 + 15 + 15 + 15 + 10; // 105
    const raw = Object.values(buckets).reduce((s, b) => s + b.score, 0);
    const normalized = clamp((raw / MAX_RAW) * 100, 0, 100);

    const liq = liquidityGate(row);
    const volGate = atrGate(row);
    const score = Math.round(clamp(normalized * liq.multiplier * volGate.multiplier, 0, 100));
    const band = score >= 90 ? "VERY STRONG" : score >= 80 ? "STRONG" : score >= 70 ? "WATCH" : "IGNORE";

    const notes = Object.values(buckets).flatMap(b => b.notes);
    if (liq.note) notes.push(liq.note);
    if (volGate.note) notes.push(volGate.note);

    return { score, band, breakdown: buckets, gates: { liquidity: liq, atr: volGate }, notes };
}

/** Entry Attractiveness — "is NOW a good entry?" (independent of Opportunity Score) */
export function computeEntryAttractiveness(row) {
    if (row.pctFromOpen == null) return { score: 50, label: "UNKNOWN", notes: ["Opening data unavailable"] };

    const notes = [];
    let score = 100;
    const move = row.pctFromOpen;

    if (move < 0) {
        score -= 25; notes.push("Price is below today's open");
    } else if (move <= 2.5) {
        notes.push(`+${move.toFixed(2)}% from open — within the preferred entry zone`);
    } else if (move <= 4) {
        score -= (move - 2.5) * 14;
        notes.push(`+${move.toFixed(2)}% from open — moderately extended`);
    } else {
        score -= 22 + (move - 4) * 12;
        notes.push(`+${move.toFixed(2)}% from open — already extended, chase risk`);
    }

    if (row.atrPct) {
        const consumed = clamp(move / row.atrPct, -1, 2);
        if (consumed > 0.6) {
            score -= (consumed - 0.6) * 40;
            notes.push(`~${Math.round(consumed * 100)}% of its typical daily range already used`);
        }
    }

    const vwapRef = row.sessionVwap ?? row.vwap;
    if (vwapRef && row.price) {
        const vwapExtPct = ((row.price - vwapRef) / vwapRef) * 100;
        if (vwapExtPct > 2) {
            score -= (vwapExtPct - 2) * 6;
            notes.push(`${vwapExtPct.toFixed(2)}% above VWAP — extended from fair value`);
        }
    }

    const hour = istHourDecimal();
    if (hour <= 11) { score += 5; notes.push("Early session — preferred timing to find strength early"); }
    else if (hour >= 14) { score -= 5; notes.push("Late session — less runway left today"); }

    score = Math.round(clamp(score, 0, 100));
    const label = score >= 80 ? "EXCELLENT" : score >= 60 ? "GOOD" : score >= 40 ? "FAIR" : "POOR — CHASE RISK";
    return { score, label, notes };
}

/** Upside Potential — never "price + 5%"; ATR/structure/resistance-bounded and explicitly uncertain. */
export function computeUpsidePotential(row, ctx) {
    if (!row.price || !row.atrPct) {
        return { zoneLowPct: null, zoneHighPct: null, zoneLow: null, zoneHigh: null, remainingPct: null, confidence: "LOW", notes: ["Insufficient data for an upside estimate"] };
    }
    const notes = [];
    let capacityFraction = 0.55; // fraction of today's ATR% assumed achievable under typical conditions
    let confidenceScore = 0;

    if (row.orb?.brokenAbove && row.orb?.volConfirmed) { capacityFraction += 0.15; confidenceScore += 2; notes.push("Confirmed opening-range breakout supports continuation"); }
    if (row.structure?.bullishStructure) { capacityFraction += 0.10; confidenceScore += 2; notes.push("Bullish higher-high/higher-low structure"); }
    if ((row.macdHistAccel ?? 0) > 0) { capacityFraction += 0.05; confidenceScore += 1; }
    const nifty = ctx.niftyRow;
    if (nifty && row.pctFromOpen != null && nifty.pctFromOpen != null && row.pctFromOpen > nifty.pctFromOpen) { capacityFraction += 0.05; confidenceScore += 1; notes.push("Outperforming NIFTY"); }
    const sectorStat = ctx.sectorStats?.[row.sector];
    if (sectorStat?.positiveShare >= 0.6) { capacityFraction += 0.05; confidenceScore += 1; notes.push("Sector participation broadly positive"); }
    if (sectorStat?.momentum != null && sectorStat.momentum > 0.2) { capacityFraction += 0.05; confidenceScore += 1; notes.push("Sector momentum improving"); }

    const consumedFraction = row.pctFromOpen != null ? clamp(row.pctFromOpen / row.atrPct, 0, 3) : 0;
    if (consumedFraction > 0.5) {
        capacityFraction *= Math.max(0.3, 1 - (consumedFraction - 0.5));
        notes.push("Discounted for distance already travelled today (exhaustion risk)");
    }
    capacityFraction = clamp(capacityFraction, 0.15, 0.9);

    let zoneHighPct = row.atrPct * capacityFraction;

    const resistances = [row.prevDayH, row.w52H, row.weekH].filter(r => r != null && r > row.price);
    if (resistances.length) {
        const nearestResistancePct = ((Math.min(...resistances) - row.price) / row.price) * 100;
        if (nearestResistancePct < zoneHighPct) {
            zoneHighPct = nearestResistancePct * 0.9;
            notes.push(`Capped by resistance near +${nearestResistancePct.toFixed(2)}%`);
        }
    }
    // Derived from the FINAL (post-resistance-cap) high so a nearby
    // resistance level always produces a proportionally narrower zone
    // instead of the low end colliding with — or exceeding — the capped high.
    const zoneLowPct = zoneHighPct * 0.45;

    const zoneLow = +(row.price * (1 + zoneLowPct / 100)).toFixed(2);
    const zoneHigh = +(row.price * (1 + zoneHighPct / 100)).toFixed(2);
    const confidence = confidenceScore >= 4 ? "HIGH" : confidenceScore >= 2 ? "MEDIUM" : "LOW";
    notes.push("Estimate only — not a target or a guarantee");

    return {
        zoneLowPct: +zoneLowPct.toFixed(2), zoneHighPct: +zoneHighPct.toFixed(2),
        zoneLow, zoneHigh, remainingPct: +zoneHighPct.toFixed(2), confidence, notes,
    };
}

/**
 * Orchestrator — called once per full scan cycle. Mutates every intraday row
 * in place (so ALL/BUY/GOLDEN tabs can also see the scores) and returns the
 * ranked, deduped "Intraday Opportunities" list.
 */
export function enrichOpportunities(dataBuckets, minScore = 70) {
    for (const tf of INTRADAY_TFS) {
        const rows = dataBuckets[`${tf}_ALL`] || [];
        const ctx = buildMarketContext(dataBuckets, tf);
        for (const row of rows) {
            if (row.sector === "INDEX") continue;
            const opp = computeOpportunityScore(row, ctx, tf);
            const attract = computeEntryAttractiveness(row);
            const upside = computeUpsidePotential(row, ctx);
            row.opportunityScore = opp.score;
            row.opportunityBand = opp.band;
            row.opportunityBreakdown = opp.breakdown;
            row.opportunityNotes = opp.notes;
            row.entryAttractiveness = attract.score;
            row.entryAttractivenessLabel = attract.label;
            row.entryAttractivenessNotes = attract.notes;
            row.upside = upside;
        }
    }

    // Require independent WATCH+ (>=70) confirmation on BOTH 5m and 15m so a
    // single-timeframe blip can't qualify alone; rank Opportunity first,
    // Entry Attractiveness second, so the single highest score doesn't win
    // just because it already ran — avoids chasing.
    const rows5 = dataBuckets["5m_ALL"] || [];
    const rows15ByS = new Map((dataBuckets["15m_ALL"] || []).map(r => [r.symbol, r]));
    const rows30ByS = new Map((dataBuckets["30m_ALL"] || []).map(r => [r.symbol, r]));

    const opportunities = [];
    for (const r5 of rows5) {
        if (r5.sector === "INDEX") continue;
        const r15 = rows15ByS.get(r5.symbol);
        if (!r15) continue;
        if ((r5.opportunityScore ?? 0) < minScore || (r15.opportunityScore ?? 0) < minScore) continue;

        const combinedOpportunity = Math.round((r5.opportunityScore + r15.opportunityScore) / 2);
        const combinedAttractiveness = Math.round((r5.entryAttractiveness + r15.entryAttractiveness) / 2);
        // 30m ("broader trend") is informational context here, not a hard
        // gate — requiring three independent timeframes to agree would make
        // an already-rare signal even rarer without a stated basis for the
        // stricter bar.
        const r30 = rows30ByS.get(r5.symbol);

        opportunities.push({
            symbol: r5.symbol, sector: r5.sector, tf: r5.tf,
            price: r5.price, priceSource: r5.priceSource, priceTs: r5.priceTs,
            dayOpen: r5.dayOpen, pctFromOpen: r5.pctFromOpen,
            opportunityScore: combinedOpportunity,
            opportunityBand: combinedOpportunity >= 90 ? "VERY STRONG" : combinedOpportunity >= 80 ? "STRONG" : "WATCH",
            entryAttractiveness: combinedAttractiveness,
            entryAttractivenessLabel: r5.entryAttractivenessLabel,
            upside: r5.upside,
            score5m: r5.opportunityScore, score15m: r15.opportunityScore, score30m: r30?.opportunityScore ?? null,
            broaderTrendSupportive: r30 ? r30.opportunityScore >= 50 : null,
            notes: [...new Set([...(r5.opportunityNotes || []), ...(r15.opportunityNotes || [])])].slice(0, 6),
            priceHist: r5.priceHist, ema21Hist: r5.ema21Hist, ema50Hist: r5.ema50Hist,
            dayH: r5.dayH, dayL: r5.dayL, vwap: r5.sessionVwap ?? r5.vwap, chgPct: r5.chgPct,
            volSpike: r5.volSpike || r15.volSpike,
        });
    }

    // Among otherwise-tied opportunities: prefer more remaining upside (the
    // spec's "prefer evidence of unusually high upside potential" applied
    // as a tiebreaker, not a primary rank — Opportunity/Entry Attractiveness
    // stay primary since a mediocre setup with a big theoretical zone still
    // isn't a good trade), then prefer 30m trend agreement.
    opportunities.sort((a, b) => {
        if (b.opportunityScore !== a.opportunityScore) return b.opportunityScore - a.opportunityScore;
        if (b.entryAttractiveness !== a.entryAttractiveness) return b.entryAttractiveness - a.entryAttractiveness;
        const upsideA = a.upside?.remainingPct ?? 0, upsideB = b.upside?.remainingPct ?? 0;
        if (upsideB !== upsideA) return upsideB - upsideA;
        return (b.broaderTrendSupportive === true ? 1 : 0) - (a.broaderTrendSupportive === true ? 1 : 0);
    });

    return opportunities.slice(0, 40);
}
