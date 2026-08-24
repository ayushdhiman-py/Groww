// ─────────────────────────────────────────────────────────────────────────────
// capital_rotation.mjs — "Is there a better fresh opportunity than this
// weakening Critical trade?" Purely informational: never places, closes, or
// resizes any trade. The caller (UI) decides what to do with the suggestion.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} trade — Critical trade record
 * @param {object} health — this cycle's computeTradeHealth() result
 * @param {Array} opportunities — state.intradayOpportunities from the same scan
 */
export function findBetterOpportunity(trade, health, opportunities) {
    if (!opportunities?.length) return null;
    // Only worth surfacing once the current trade is actually showing
    // weakness — a STRONG HOLD trade doesn't need a replacement suggestion.
    if (!health || health.score >= 80) return null;

    const candidate = opportunities.find(o =>
        o.symbol !== trade.symbol &&
        o.opportunityScore > health.score + 10 &&
        o.entryAttractiveness >= 70 &&
        (o.pctFromOpen ?? 99) <= 2.5
    );
    if (!candidate) return null;

    return {
        symbol: candidate.symbol,
        opportunityScore: candidate.opportunityScore,
        entryAttractiveness: candidate.entryAttractiveness,
        pctFromOpen: candidate.pctFromOpen,
        upside: candidate.upside,
        reason: `${candidate.symbol}: Opportunity ${candidate.opportunityScore}, Entry Attractiveness ${candidate.entryAttractiveness}, only +${(candidate.pctFromOpen ?? 0).toFixed(2)}% from open — vs ${trade.symbol} at health ${health.score} (${health.state}).`,
    };
}
