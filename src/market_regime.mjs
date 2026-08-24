// ─────────────────────────────────────────────────────────────────────────────
// market_regime.mjs — BULLISH / BEARISH / SIDEWAYS classification.
//
// Breadth/VWAP-participation/volatility MUST be computed from the full
// curated universe every cycle, never from just the symbols the (now
// two-stage) scanner happened to deep-analyze this cycle — a "regime"
// computed only from stocks that already look strong would be permanently
// biased bullish. `stage1Snapshot` (stage1_filter.mjs's
// computeFullUniverseSnapshot output) and `atrPctBySymbol`
// (scanner.mjs's getAtrPctSnapshot output) both cover all 241 symbols
// regardless of which subset Stage-2 refreshed this cycle. NIFTY's own row
// still comes from the 15m_ALL bucket — NIFTY is always Stage-2'd every
// cycle (it's in the always-include set), so it's always fresh.
// ─────────────────────────────────────────────────────────────────────────────

export function computeMarketRegime(dataBuckets, stage1Snapshot, atrPctBySymbol = {}) {
    const rows = dataBuckets["15m_ALL"] || [];
    const nifty = rows.find(r => r.symbol === "NIFTY") || null;

    const cheapRows = stage1Snapshot ? [...stage1Snapshot.values()].filter(r => r.sector !== "INDEX") : [];
    const total = cheapRows.length;

    const advancing = cheapRows.filter(r => (r.chgPctCheap ?? 0) > 0).length;
    const breadthPct = total ? +((advancing / total) * 100).toFixed(1) : null;

    const aboveVwapCount = cheapRows.filter(r => r.aboveVwapCheap === true).length;
    const aboveVwapPct = total ? +((aboveVwapCount / total) * 100).toFixed(1) : null;

    // Volatility proxy: average ATR% across the full universe, computed from
    // real Upstox daily candles (no dependency on India VIX, which NSE
    // routinely blocks server-side fetches for).
    const atrValues = Object.values(atrPctBySymbol).filter(v => v != null && Number.isFinite(v));
    const avgAtrPct = atrValues.length ? +(atrValues.reduce((s, v) => s + v, 0) / atrValues.length).toFixed(2) : null;

    let niftyTrend = "UNKNOWN";
    if (nifty) {
        if (nifty.aboveSessionVwap === true && (nifty.sessionVwapSlope ?? 0) > 0 && (nifty.pctFromOpen ?? 0) > 0) niftyTrend = "UP";
        else if (nifty.aboveSessionVwap === false && (nifty.sessionVwapSlope ?? 0) < 0 && (nifty.pctFromOpen ?? 0) < 0) niftyTrend = "DOWN";
        else niftyTrend = "MIXED";
    }

    let regime = "SIDEWAYS";
    if (niftyTrend === "UP" && breadthPct != null && breadthPct >= 55) regime = "BULLISH";
    else if (niftyTrend === "DOWN" && breadthPct != null && breadthPct <= 45) regime = "BEARISH";

    const highVol = avgAtrPct != null && avgAtrPct >= 3.5;
    const noTrade = regime === "BEARISH" || (highVol && regime !== "BULLISH");

    const notes = [`NIFTY trend vs its own session VWAP: ${niftyTrend}`];
    if (breadthPct != null) notes.push(`Breadth: ${breadthPct}% of the scanned universe advancing`);
    if (aboveVwapPct != null) notes.push(`${aboveVwapPct}% of the scanned universe above its own session VWAP`);
    if (avgAtrPct != null) notes.push(`Avg ATR ${avgAtrPct}% across the universe${highVol ? " — elevated volatility" : ""}`);
    if (noTrade) notes.push("NO TRADE — conditions unfavorable for fresh intraday longs");

    // `dataAsOf` reflects the actual data behind THIS regime call — the
    // oldest cached-candle age feeding the full-universe breadth/VWAP-
    // participation calc above, not wall-clock "now". Since breadth now
    // covers the whole universe every cycle (not just Stage-2 survivors),
    // some of that data may be cache-aged rather than this-cycle-fresh —
    // this must show that honestly instead of claiming freshness it doesn't
    // have.
    const candleAges = cheapRows.map(r => r.candleAgeMs).filter(ms => ms != null);
    const dataAsOf = candleAges.length ? Date.now() - Math.max(...candleAges) : null;

    return { regime, niftyTrend, breadthPct, aboveVwapPct, avgAtrPct, noTrade, notes, dataAsOf, updatedAt: new Date().toISOString() };
}

/**
 * Dynamic entry bar: demand more confluence when the tape isn't clearly
 * bullish, rather than a fixed 70 cutoff regardless of regime.
 */
export function regimeMinOpportunityScore(regimeResult) {
    if (!regimeResult) return 70;
    if (regimeResult.regime === "BULLISH") return 70;
    if (regimeResult.regime === "SIDEWAYS") return 80;
    return 95; // BEARISH — effectively closed via the score gate as well as noTrade
}
