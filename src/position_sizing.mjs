// ─────────────────────────────────────────────────────────────────────────────
// position_sizing.mjs — capital-aware quantity/exposure for a validated
// trade_plan.mjs plan.
//
// Deterministic arithmetic only. `capital` is a CONFIGURED ASSUMPTION
// (src/config.mjs's DEFAULT_CAPITAL_INR, tunable via env var), never a live
// read of the user's actual broker balance — this system has no portfolio-
// state engine and does not know what the user is really holding elsewhere.
// ─────────────────────────────────────────────────────────────────────────────

import { DEFAULT_CAPITAL_INR, MAX_RISK_PCT_PER_TRADE, MAX_CAPITAL_ALLOCATION_PCT_PER_TRADE } from "./config.mjs";

export function computePositionSizing(plan, capital = DEFAULT_CAPITAL_INR) {
    if (!plan?.valid) return null;

    const riskPerShare = plan.entryLow - plan.stopLoss;
    if (riskPerShare <= 0) return null;

    const maxRiskAmount = capital * (MAX_RISK_PCT_PER_TRADE / 100);
    const maxCapitalForTrade = capital * (MAX_CAPITAL_ALLOCATION_PCT_PER_TRADE / 100);

    const qtyByRisk = Math.floor(maxRiskAmount / riskPerShare);
    const qtyByCapital = Math.floor(maxCapitalForTrade / plan.entryLow);
    const quantity = Math.max(0, Math.min(qtyByRisk, qtyByCapital));

    if (quantity <= 0) {
        return {
            quantity: 0, capitalDeployed: 0, maxLoss: 0, expectedProfit: 0, expectedProfitT2: 0,
            assumedCapital: capital,
            note: "Position size rounds to 0 at the configured capital/risk limits for this stock's price/risk-per-share",
        };
    }

    const capitalDeployed = +(quantity * plan.entryLow).toFixed(2);
    const maxLoss = +(quantity * riskPerShare).toFixed(2);
    const expectedProfit = +(quantity * (plan.target1 - plan.entryLow)).toFixed(2);
    const expectedProfitT2 = +(quantity * (plan.target2 - plan.entryLow)).toFixed(2);

    return {
        quantity, capitalDeployed, maxLoss, expectedProfit, expectedProfitT2,
        capitalUsedPct: +((capitalDeployed / capital) * 100).toFixed(1),
        assumedCapital: capital,
    };
}
