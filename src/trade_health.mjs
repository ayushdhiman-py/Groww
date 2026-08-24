// ─────────────────────────────────────────────────────────────────────────────
// trade_health.mjs — Trade Health Engine for Critical trades.
//
// "Should I continue holding this?" Deliberately uses a DIFFERENT priority
// order than entry_score.mjs's Opportunity Score, per spec:
//   PRICE ACTION (40%) > VWAP (25%) > VOLUME (20%) > REL. STRENGTH (10%)
//   > EMA/MACD/RSI as confirmation only (5%)
// EMA/MACD/RSI are capped low deliberately — they lag price, so a single
// bearish RSI/MACD/EMA cross must never by itself flip a STRONG HOLD into an
// exit warning here.
//
// Everything here only reads the row snapshot handed to it (this scan
// cycle's already-fetched candles/LTP) plus the trade's own past minute
// history — never anything from "later," so this stays backtest-safe.
// ─────────────────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function scorePriceActionHealth(row5m, row15m, row1m, price) {
    let score = 100; const notes = [];
    const s5 = row5m?.structure, s15 = row15m?.structure;
    if (s5 && !s5.insufficientData) {
        if (s5.brokeStructure) { score -= 30; notes.push("5m: a lower high has formed — structure breaking"); }
        if (s5.higherLows === false) { score -= 15; notes.push("5m: higher-low failed"); }
    }
    if (s15 && !s15.insufficientData && s15.brokeStructure) { score -= 15; notes.push("15m: structure breaking on the higher timeframe"); }
    if (row5m?.rejection?.rejected) { score -= 15; notes.push("Rejection candle at a recent high"); }
    if (row5m?.orb?.retestFailed) { score -= 20; notes.push("Failed retest of the opening range"); }
    if (s5?.lastSwingHigh != null && price != null && price < s5.lastSwingHigh * 0.997) {
        score -= 10; notes.push("Unable to make a new high");
    }
    // 1m = immediate behaviour: a small, early nudge only — deliberately
    // low weight since 1m noise is high; it should never dominate the 5m/
    // 15m structural read above.
    if (row1m?.rejection?.rejected) { score -= 5; notes.push("1m: immediate rejection candle"); }
    if (row1m?.structure?.brokeStructure) { score -= 5; notes.push("1m: immediate structure weakening"); }
    return { score: clamp(score, 0, 100), notes };
}

function scoreVwapHealth(row) {
    if (!row) return { score: 60, notes: ["VWAP data unavailable"] };
    let score = 100; const notes = [];
    if (row.aboveSessionVwap === false) {
        score -= 40; notes.push("Price below session VWAP");
        if (row.vwapReclaimFailed) { score -= 15; notes.push("Failed VWAP reclaim"); }
    }
    if (row.sessionVwapSlope != null && row.sessionVwapSlope < 0) { score -= 20; notes.push("Session VWAP slope weakening"); }
    return { score: clamp(score, 0, 100), notes };
}

function scoreVolumeHealth(row) {
    if (!row) return { score: 70, notes: ["Volume data unavailable"] };
    let score = 100; const notes = [];
    if ((row.volumeChange ?? 0) < 0 && (row.pctFromOpen ?? 0) > 0) {
        score -= 20; notes.push("Volume declining while price is still up — possible distribution");
    }
    if (!row.volSpike && (row.macdHistAccel ?? 0) < 0) { score -= 10; notes.push("Momentum volume fading"); }
    return { score: clamp(score, 0, 100), notes };
}

function scoreRsHealth(row, niftyRow, sectorStats) {
    if (!row || !niftyRow || row.pctFromOpen == null || niftyRow.pctFromOpen == null) {
        return { score: 70, notes: ["Relative strength data unavailable"] };
    }
    let score = 100; const notes = [];
    const rs = row.pctFromOpen - niftyRow.pctFromOpen;
    if (rs < 0) { score -= 25; notes.push("Underperforming NIFTY since open"); }
    const sectorStat = sectorStats?.[row.sector];
    if (sectorStat && sectorStat.positiveShare != null && sectorStat.positiveShare < 0.4) {
        score -= 15; notes.push(`Sector ${row.sector} turning weak`);
    }
    return { score: clamp(score, 0, 100), notes };
}

function scoreConfirmHealth(row) {
    if (!row) return { score: 80, notes: [] };
    let score = 100; const notes = [];
    let bearishCount = 0;
    if (row.macdBear) bearishCount++;
    if (row.ema21above === false) bearishCount++;
    if (row.rsi != null && row.rsi < 45) bearishCount++;
    // Deliberately mild — this bucket carries only 5% of total weight, so
    // even all three turning bearish at once can't override healthy price
    // action / VWAP / volume on its own.
    if (bearishCount >= 3) { score -= 20; notes.push("EMA/MACD/RSI all turned bearish (confirmation only — lagging)"); }
    else if (bearishCount >= 1) score -= 5;
    return { score: clamp(score, 0, 100), notes };
}

/**
 * Trap classification — OBSERVABLE market behaviour only (breakout without
 * volume, failed retests, rejections, deteriorating volume/RS while price
 * rises, abnormal range). This is not a claim about who is behind it.
 */
export function classifyTrapRisk(row, trade) {
    if (!row) return { level: "NORMAL", flags: [] };
    const flags = [];
    if (row.orb?.brokenAbove && !row.orb?.volConfirmed) flags.push("Breakout without volume confirmation");
    if (row.orb?.retestFailed) flags.push("Opening-range breakout failed on retest");
    if (row.rejection?.rejected && row.volSpike) flags.push("Volume spike followed by a rejection candle");
    if (row.aboveSessionVwap === false && (row.sessionVwapSlope ?? 0) < 0) flags.push("VWAP breakdown");
    if (row.structure?.brokeStructure && (row.pctFromOpen ?? 0) > 0) flags.push("Price still elevated while structure breaks down");
    if ((row.volumeChange ?? 0) < 0 && (row.pctFromOpen ?? 0) > 0) flags.push("Price rising while volume deteriorates");
    if ((row.rejection?.upperWickRatio ?? 0) > 0.6) flags.push("Large upper wick");
    if (row.atrPct != null && row.dayH != null && row.dayL != null && row.price) {
        const todayRangePct = ((row.dayH - row.dayL) / row.price) * 100;
        if (todayRangePct > row.atrPct * 1.8) flags.push("Abnormal intraday range vs typical ATR");
    }
    if (trade?.minuteHistory?.length >= 4 && trade.peakPrice) {
        const recent = trade.minuteHistory.slice(-4);
        const nearPeakCount = recent.filter(m => Math.abs(m.price - trade.peakPrice) / trade.peakPrice < 0.003).length;
        if (nearPeakCount >= 3 && recent[recent.length - 1].price < trade.peakPrice) flags.push("Repeated rejection near the same high");
    }

    const level = flags.length >= 3 ? "STRONG TRAP RISK" : flags.length === 2 ? "TRAP RISK" : flags.length === 1 ? "CAUTION" : "NORMAL";
    return { level, flags };
}

/**
 * Classify the shape of recent health-score movement so a single bad tick
 * doesn't read the same as a genuine accelerating decline.
 */
export function classifyDeteriorationPattern(minuteHistory) {
    if (!minuteHistory || minuteHistory.length < 3) return { pattern: "INSUFFICIENT_DATA", notes: [] };
    const recent = minuteHistory.slice(-6).map(m => m.health);
    const deltas = [];
    for (let i = 1; i < recent.length; i++) deltas.push(recent[i] - recent[i - 1]);
    const lastDelta = deltas[deltas.length - 1];
    const avgDelta = deltas.reduce((s, d) => s + d, 0) / deltas.length;

    if (lastDelta <= -15) return { pattern: "SUDDEN_DETERIORATION", notes: [`Health dropped ${Math.abs(lastDelta)} pts in one update`] };
    if (deltas.length >= 3 && deltas.slice(-3).every(d => d < 0) && deltas[deltas.length - 1] < deltas[deltas.length - 3]) {
        return { pattern: "ACCELERATING_DETERIORATION", notes: ["Decline is accelerating across recent updates"] };
    }
    if (avgDelta < -2 && deltas.every(d => d <= 2)) {
        return { pattern: "GRADUAL_DETERIORATION", notes: [`Health drifting down, avg ${avgDelta.toFixed(1)} pts/update`] };
    }
    if (lastDelta > 5 && avgDelta > 0) return { pattern: "RECOVERY", notes: ["Health improving over recent updates"] };
    return { pattern: "STABLE", notes: [] };
}

/**
 * Main entry point — one Trade Health computation for one Critical trade.
 * @param {object} trade — the persisted Critical trade record
 * @param {object} ctx — { row1m, row5m, row15m, niftyRow5m, sectorStats5m, livePrice }
 *   row1m is optional (immediate-behaviour nudge only); everything else is required.
 */
export function computeTradeHealth(trade, ctx) {
    const { row1m, row5m, row15m, niftyRow5m, sectorStats5m, livePrice } = ctx;
    const price = livePrice ?? row5m?.price ?? trade.entryPrice;
    const pnl = (price - trade.entryPrice) * trade.quantity;
    const pnlPct = ((price - trade.entryPrice) / trade.entryPrice) * 100;

    const priceActionHealth = scorePriceActionHealth(row5m, row15m, row1m, price);
    const vwapHealth = scoreVwapHealth(row5m);
    const volumeHealth = scoreVolumeHealth(row5m);
    const rsHealth = scoreRsHealth(row5m, niftyRow5m, sectorStats5m);
    const confirmHealth = scoreConfirmHealth(row5m);

    const WEIGHTS = { priceAction: 0.40, vwap: 0.25, volume: 0.20, rs: 0.10, confirm: 0.05 };
    const score = Math.round(
        priceActionHealth.score * WEIGHTS.priceAction +
        vwapHealth.score * WEIGHTS.vwap +
        volumeHealth.score * WEIGHTS.volume +
        rsHealth.score * WEIGHTS.rs +
        confirmHealth.score * WEIGHTS.confirm
    );

    const state = score >= 90 ? "STRONG HOLD"
        : score >= 80 ? "HOLD"
        : score >= 70 ? "MOMENTUM WEAKENING"
        : score >= 60 ? "PROFIT PROTECTION"
        : score >= 50 ? "STRONG EXIT WARNING"
        : "THESIS INVALIDATED";

    const warnings = [...priceActionHealth.notes, ...vwapHealth.notes, ...volumeHealth.notes, ...rsHealth.notes, ...confirmHealth.notes];

    // Fires independent of the score threshold above and even while still in
    // profit — "do not wait until price falls below entry."
    const deteriorationSignals = [priceActionHealth.score < 70, vwapHealth.score < 70, volumeHealth.score < 70, rsHealth.score < 70].filter(Boolean).length;
    const profitProtectionWarning = pnlPct > 0 && deteriorationSignals >= 2;

    // Multi-timeframe reference points named explicitly per spec: price vs
    // entry (pnlPct above), vs today's open, and vs the estimated upside
    // zone computed at/after entry — three different reference frames that
    // are easy to conflate otherwise.
    const vsOpenPct = row5m?.pctFromOpen ?? null;
    const upside = row5m?.upside ?? null;
    const vsUpsideZonePct = upside?.zoneHigh ? +(((price - upside.zoneHigh) / upside.zoneHigh) * 100).toFixed(2) : null;

    return {
        price: +price.toFixed(2), pnl: +pnl.toFixed(2), pnlPct: +pnlPct.toFixed(2),
        vsOpenPct, vsUpsideZonePct,
        score, state, warnings,
        breakdown: { priceActionHealth, vwapHealth, volumeHealth, rsHealth, confirmHealth },
        profitProtectionWarning,
        remainingUpside: upside,
        ts: new Date().toISOString(),
    };
}
