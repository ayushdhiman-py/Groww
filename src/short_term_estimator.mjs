import { getDb } from "./learning_db.mjs";
import { TRIAL_MIN_SAMPLES } from "./config.mjs";

/**
 * Short-term estimator for 5-minute outcomes
 * Uses historical snapshots + outcomes to compute empirical probabilities
 * for continuation/reversal/target reach and expected 5-minute return.
 */
export async function estimate5mByFeatures(features) {
    // features: { symbol, rsi, macdHist, relativeVolume, price, ts }
    const db = getDb();
    const rsi = features.rsi;
    const macdSign = features.macdHist != null ? (features.macdHist > 0 ? 1 : (features.macdHist < 0 ? -1 : 0)) : null;
    const rvol = features.relativeVolume;
    const price = features.price;

    // Buckets
    const rsiLow = Math.max(0, Math.floor(rsi / 10) * 10);
    const rsiHigh = rsiLow + 9;
    const rvolLow = rvol != null ? Math.max(0, Math.floor(rvol)) : null; // integer bucket

    // Build WHERE clause to find similar historical snapshots across symbols
    // Matching by: time_bucket='1m' (we want 1m snapshots), rsi between rsiLow..rsiHigh,
    // macd sign equal (if available), relative_volume bucket equal (if available)
    const where = [`s.time_bucket = '1m'`];
    const params = [];
    if (rsi != null) {
        where.push("s.rsi BETWEEN ? AND ?");
        params.push(rsiLow, rsiHigh);
    }
    if (macdSign != null) {
        where.push("(CASE WHEN s.macd IS NULL THEN 0 WHEN s.macd>0 THEN 1 WHEN s.macd<0 THEN -1 ELSE 0 END) = ?");
        params.push(macdSign);
    }
    if (rvolLow != null) {
        where.push("(CASE WHEN s.relative_volume IS NULL THEN -1 ELSE CAST(s.relative_volume AS INTEGER) END) = ?");
        params.push(rvolLow);
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : "";

    // Join snapshots (s) with outcomes (o). Compute:
    // - sample count n
    // - reached target count (maximum_high >= ltp*1.015)
    // - continuation proxy: fraction where close_vs_snapshot_pct > 0 (price higher at 5m close vs snapshot)
    // - reversal proxy: fraction where close_vs_snapshot_pct < 0 and mfe_pct < 0 (or mae_pct large)
    // - expectedReturn: AVG(close_vs_snapshot_pct)

    const sql = `SELECT COUNT(*) as n,
        SUM(CASE WHEN o.maximum_high >= s.ltp * 1.015 THEN 1 ELSE 0 END) as reached_target,
        SUM(CASE WHEN o.close_vs_snapshot_pct >= 0 THEN 1 ELSE 0 END) as continued_up_count,
        SUM(CASE WHEN o.close_vs_snapshot_pct < 0 THEN 1 ELSE 0 END) as reversal_count,
        AVG(o.close_vs_snapshot_pct) as avg_return_pct,
        AVG(o.mfe_pct) as avg_mfe_pct,
        AVG(o.mae_pct) as avg_mae_pct,
        AVG(o.maximum_high) as avg_max_high
    FROM snapshots s JOIN outcomes o ON o.snapshot_id = s.id
    ${whereClause}`;

    const row = db.prepare(sql).get(...params);
    const n = row?.n || 0;
    if (!n || n < TRIAL_MIN_SAMPLES) return { insufficient: true, sampleCount: n };

    const reached = row.reached_target || 0;
    const continued = row.continued_up_count || 0;
    const reversal = row.reversal_count || 0;
    const avgReturn = row.avg_return_pct != null ? row.avg_return_pct : null;

    const pReach15 = reached / n;
    const pContinue = continued / n;
    const pReversal = reversal / n;

    // Simple confidence heuristic: based on sample size and dispersion of returns
    // compute variance of close_vs_snapshot_pct for matching rows
    const varSql = `SELECT AVG((o.close_vs_snapshot_pct - ?) * (o.close_vs_snapshot_pct - ?)) as var_return
        FROM snapshots s JOIN outcomes o ON o.snapshot_id = s.id
        ${whereClause}`;
    const varRow = db.prepare(varSql).get(avgReturn, avgReturn, ...params);
    const varReturn = varRow?.var_return != null ? varRow.var_return : 0;

    // Confidence: logistic-like function of sample size, penalised by variance
    const sizeScore = Math.min(1, Math.log10(n) / Math.log10(1000)); // ~1 at 1000 samples
    const varPenalty = 1 / (1 + Math.sqrt(varReturn));
    const confidence = Math.max(0, Math.min(1, sizeScore * varPenalty));

    return {
        insufficient: false,
        sampleCount: n,
        pReach15, // 0..1
        pContinue: pContinue,
        pReversal: pReversal,
        expectedReturnPct: avgReturn, // percent as stored in DB
        confidence,
    };
}
