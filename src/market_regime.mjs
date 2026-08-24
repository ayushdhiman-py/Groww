// ─────────────────────────────────────────────────────────────────────────────
// market_regime.mjs — BULLISH / BEARISH / SIDEWAYS classification from data
// already computed by the main scan (NIFTY's own row + breadth across the
// scanned universe). No separate API calls — reuses the 15m_ALL bucket.
// ─────────────────────────────────────────────────────────────────────────────

export function computeMarketRegime(dataBuckets) {
    const rows = dataBuckets["15m_ALL"] || [];
    const nifty = rows.find(r => r.symbol === "NIFTY") || null;
    const stockRows = rows.filter(r => r.sector !== "INDEX");
    const total = stockRows.length;

    const advancing = stockRows.filter(r => (r.chgPct ?? 0) > 0).length;
    const breadthPct = total ? +((advancing / total) * 100).toFixed(1) : null;

    const aboveVwapCount = stockRows.filter(r => r.aboveSessionVwap === true).length;
    const aboveVwapPct = total ? +((aboveVwapCount / total) * 100).toFixed(1) : null;

    // Volatility proxy: average ATR% across the scanned universe, computed
    // from real Upstox daily candles (no dependency on India VIX, which NSE
    // routinely blocks server-side fetches for).
    const atrValues = stockRows.map(r => r.atrPct).filter(v => v != null && Number.isFinite(v));
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

    return { regime, niftyTrend, breadthPct, aboveVwapPct, avgAtrPct, noTrade, notes, updatedAt: new Date().toISOString() };
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
