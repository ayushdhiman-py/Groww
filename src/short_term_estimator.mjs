// Short-term estimator: simple DB-backed empirical lookup + lightweight model
// estimate5mByFeatures(features) returns:
// { pReach15, pContinue, pReversal, expectedReturnPct, confidence, insufficient }

import { getDb } from "./learning_db.mjs";

export async function estimate5mByFeatures({ symbol, rsi, macdHist, relativeVolume, price, ts }) {
    // Very conservative: require at least TRIAL_MIN_SAMPLES per symbol in DB
    const db = getDb();
    const MIN_SAMPLES = 30;
    const row = db.prepare("SELECT count(*) c FROM short_term_outcomes WHERE symbol = ?").get(symbol);
    const n = row ? row.c : 0;
    if (n < MIN_SAMPLES) return { insufficient: true };

    // Aggregate simple empirical stats
    const stats = db.prepare("SELECT avg(return5m) avgRet, sum(return5m >= 0.015) winN FROM short_term_outcomes WHERE symbol = ?").get(symbol);
    const avgRet = stats.avgRet || 0;
    const pReach15 = (stats.winN || 0) / Math.max(1, n);

    // Continuation/reversal proxy: simple conditional averages
    const contRow = db.prepare("SELECT avg(return5m) avgNext FROM short_term_outcomes WHERE symbol = ? AND prev1_return > 0 AND prev2_return > 0").get(symbol) || { avgNext: null };
    const revRow = db.prepare("SELECT avg(return5m) avgNext FROM short_term_outcomes WHERE symbol = ? AND prev1_return < 0 AND prev2_return < 0").get(symbol) || { avgNext: null };
    const pContinue = contRow.avgNext != null ? Math.min(1, Math.max(0, contRow.avgNext / 0.02)) : 0.5;
    const pReversal = revRow.avgNext != null ? Math.min(1, Math.max(0, -revRow.avgNext / 0.02)) : 0.5;

    // Confidence scales with sample count
    const confidence = Math.min(0.99, 0.3 + 0.7 * Math.min(1, n / 500));

    return { pReach15: +(pReach15.toFixed(3)), pContinue: +(pContinue.toFixed(3)), pReversal: +(pReversal.toFixed(3)), expectedReturnPct: +(avgRet*100).toFixed(3), confidence };
}
