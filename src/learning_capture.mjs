// ─────────────────────────────────────────────────────────────────────────────
// learning_capture.mjs — store every QUALIFYING candidate, taken or not.
//
// This is the fix for the selection-bias trap the spec explicitly warns
// about: if only actually-entered Critical trades were stored, the learning
// layer could only ever learn from a biased subset (whatever you happened to
// pick), never "what happened to the setups I passed on." So this captures
// anything that clears the SAME 5m+15m confluence gate entry_score.mjs's
// enrichOpportunities() uses for the Intraday Opportunities list — computed
// BEFORE that list's top-40 truncation, so a candidate ranked #41 still gets
// stored even though it never appears in the UI list.
//
// Must NEVER throw into scanAll() — this is optional/additive instrumentation,
// not a hard dependency of the live scanner.
// ─────────────────────────────────────────────────────────────────────────────
import { getDb } from "./learning_db.mjs";
import { buildMarketContext } from "./entry_score.mjs";
import { classifyTrapRisk } from "./trade_health.mjs";
import { classifyExhaustionRisk } from "./price_action.mjs";
import { getMarketCapCategory } from "./market_cap.mjs";

const MIN_OPP_SCORE_FALLBACK = 70;

function istParts(ts) {
    const ist = new Date(new Date(ts).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    return { ist, hourDecimal: ist.getHours() + ist.getMinutes() / 60 };
}

export function istTradeDate(ts) {
    const { ist } = istParts(ts);
    return `${ist.getFullYear()}-${String(ist.getMonth() + 1).padStart(2, "0")}-${String(ist.getDate()).padStart(2, "0")}`;
}

/** One of the spec's 5 fixed intraday windows. */
export function istTimeBucket(ts) {
    const { hourDecimal } = istParts(ts);
    if (hourDecimal < 10) return "09:15-10:00";
    if (hourDecimal < 11) return "10:00-11:00";
    if (hourDecimal < 12) return "11:00-12:00";
    if (hourDecimal < 13.5) return "12:00-13:30";
    return "13:30-15:00";
}

function orbStateOf(orb) {
    if (!orb || orb.high == null) return "NO_DATA";
    if (orb.retestFailed) return "RETEST_FAILED";
    if (orb.retested && orb.retestHeld) return "RETEST_HELD";
    if (orb.brokenAbove && orb.volConfirmed) return "BROKEN_CONFIRMED";
    if (orb.brokenAbove) return "BROKEN_UNCONFIRMED";
    return "INSIDE_RANGE";
}

function priceActionStateOf(structure) {
    if (!structure || structure.insufficientData) return "INSUFFICIENT_DATA";
    if (structure.brokeStructure) return "BROKEN";
    if (structure.bullishStructure) return "BULLISH";
    if (structure.higherLows === true) return "HIGHER_LOWS_HOLDING";
    return "NEUTRAL";
}

let insertStmt = null;
function getInsertStmt() {
    if (insertStmt) return insertStmt;
    const db = getDb();
    insertStmt = db.prepare(`
        INSERT OR IGNORE INTO snapshots (
            trade_date, capture_ts, time_bucket, symbol, sector, market_cap_category, market_regime,
            open, ltp, move_from_open_pct, vwap, relative_volume, rsi, macd, macd_histogram,
            ema9, ema21, ema50, atr_pct, orb_state, relative_strength_pp, sector_strength,
            price_action_state, trap_risk, exhaustion_risk, opportunity_score, opportunity_band,
            entry_attractiveness, estimated_upside_pct, remaining_upside_pct, upside_confidence,
            breakdown_json, was_taken, linked_critical_trade_id, created_at
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, 0, NULL, ?
        )
    `);
    return insertStmt;
}

/**
 * Called once per synced scan cycle, right after enrichOpportunities() has
 * mutated every 5m_ALL/15m_ALL row in place. Stores a compact snapshot for
 * every symbol that clears the SAME confluence gate the Intraday
 * Opportunities list uses, regardless of whether it ends up in that list's
 * top-40 slice or whether you ever act on it.
 */
export function captureQualifyingSnapshots(dataBuckets, marketRegime, minScore = MIN_OPP_SCORE_FALLBACK) {
    try {
        const rows5 = dataBuckets["5m_ALL"] || [];
        const rows15ByS = new Map((dataBuckets["15m_ALL"] || []).map(r => [r.symbol, r]));
        const ctx = buildMarketContext(dataBuckets, "5m");
        const stmt = getInsertStmt();
        const now = Date.now();
        const regime = marketRegime?.regime ?? null;

        for (const r5 of rows5) {
            if (r5.sector === "INDEX") continue;
            const r15 = rows15ByS.get(r5.symbol);
            if (!r15) continue;
            if ((r5.opportunityScore ?? 0) < minScore || (r15.opportunityScore ?? 0) < minScore) continue;
            if (r5.priceTs == null) continue; // no honest capture timestamp — skip rather than fabricate one

            const trap = classifyTrapRisk(r5, null);
            const exhaustion = classifyExhaustionRisk(r5);
            const vwapRef = r5.sessionVwap ?? r5.vwap ?? null;
            const relStrengthPp = ctx.niftyRow && r5.pctFromOpen != null && ctx.niftyRow.pctFromOpen != null
                ? +(r5.pctFromOpen - ctx.niftyRow.pctFromOpen).toFixed(2) : null;
            const sectorStrength = ctx.sectorStats?.[r5.sector]?.positiveShare ?? null;

            try {
                stmt.run(
                    istTradeDate(r5.priceTs), r5.priceTs, istTimeBucket(r5.priceTs), r5.symbol, r5.sector ?? null,
                    getMarketCapCategory(r5.symbol), regime,
                    r5.dayOpen ?? null, r5.price ?? null, r5.pctFromOpen ?? null, vwapRef, r5.relativeVolume ?? null,
                    r5.rsi ?? null, r5.macdVal ?? null, r5.macdHist ?? null,
                    r5.ema9 ?? null, r5.ema21 ?? null, r5.ema50 ?? null, r5.atrPct ?? null,
                    orbStateOf(r5.orb), relStrengthPp, sectorStrength,
                    priceActionStateOf(r5.structure), trap?.level ?? null, exhaustion?.level ?? null,
                    r5.opportunityScore ?? null, r5.opportunityBand ?? null,
                    r5.entryAttractiveness ?? null, r5.upside?.zoneHighPct ?? null, r5.upside?.remainingPct ?? null,
                    r5.upside?.confidence ?? null,
                    JSON.stringify(r5.opportunityBreakdown ?? {}), now
                );
            } catch (e) {
                console.error(`[LearningCapture] Failed to store snapshot for ${r5.symbol}:`, e.message);
            }
        }
    } catch (e) {
        // Never let a capture failure interrupt the live scan — this is
        // optional instrumentation, not a hard dependency.
        console.error("[LearningCapture] captureQualifyingSnapshots failed:", e.message);
    }
}
