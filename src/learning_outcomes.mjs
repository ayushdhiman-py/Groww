// ─────────────────────────────────────────────────────────────────────────────
// learning_outcomes.mjs — fills in what actually happened after market close.
//
// Reads candles ONLY for the trade_date being finalized (never "today" if
// today is still in progress) — same "recording what already happened, not
// predicting" discipline backtest.mjs already documents for its own EOD
// close usage. Run this well after 15:30 IST close (the daily job schedules
// it at 15:45 by default) so Upstox's EOD candles for that day are reliable.
// ─────────────────────────────────────────────────────────────────────────────
import { fetchCandles } from "./upstox.mjs";
import { getDb } from "./learning_db.mjs";
import { listCriticalTrades } from "./critical_trades.mjs";
import { istTradeDate, istTimeBucket } from "./learning_capture.mjs";

// Centralized, tunable — not spec-mandated numbers, a starting point to
// revisit once real outcome data exists to check against.
export const OUTCOME_THRESHOLDS = {
    MAJOR_REVERSAL_MFE_MIN_PCT: 1.5,     // ran up at least this much intraday...
    MAJOR_REVERSAL_CLOSE_MAX_PCT: -1.0,  // ...but closed at least this much below the snapshot price
    THESIS_FAILURE_CLOSE_MAX_PCT: -1.0,  // closed meaningfully below the snapshot price...
    THESIS_FAILURE_MFE_MAX_PCT: 1.0,     // ...and never even ran up meaningfully first
    PROFIT_GIVEBACK_MIN_PEAK_PCT: 1.0,   // needs a real peak move to have something to give back
    PROFIT_GIVEBACK_MIN_GIVEBACK_PCT: 30, // % of that peak move given back by close
};

function bool01(cond) {
    return cond == null ? null : (cond ? 1 : 0);
}

let insertStmt = null;
function getInsertStmt() {
    if (insertStmt) return insertStmt;
    insertStmt = getDb().prepare(`
        INSERT OR IGNORE INTO outcomes (
            snapshot_id, trade_date, symbol, final_close, maximum_high, maximum_low,
            mfe_pct, mae_pct, close_vs_open_pct, close_vs_snapshot_pct,
            reached_1pct, reached_2pct, reached_2_5pct, reached_5pct,
            close_above_open, major_reversal, profit_giveback, thesis_failure, finalized_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return insertStmt;
}

/**
 * Finalize every un-finalized snapshot for `tradeDate`: fetch that day's
 * candles (one fetch per symbol, covering every snapshot for that symbol
 * that day), compute MFE/MAE/final close relative to each snapshot's own
 * capture price, and derive the boolean outcome labels.
 */
export async function finalizeOutcomes(tradeDate) {
    const db = getDb();
    const pending = db.prepare(`
        SELECT s.* FROM snapshots s
        LEFT JOIN outcomes o ON o.snapshot_id = s.id
        WHERE s.trade_date = ? AND o.snapshot_id IS NULL
    `).all(tradeDate);
    if (!pending.length) return { finalized: 0, skipped: 0, symbols: 0 };

    const bySymbol = new Map();
    for (const snap of pending) {
        if (!bySymbol.has(snap.symbol)) bySymbol.set(snap.symbol, []);
        bySymbol.get(snap.symbol).push(snap);
    }

    const stmt = getInsertStmt();
    let finalized = 0, skipped = 0;
    const dayStart = new Date(`${tradeDate}T00:00:00+05:30`);
    const dayEnd = new Date(`${tradeDate}T23:59:59+05:30`);

    for (const [symbol, snaps] of bySymbol) {
        let dayCandles;
        try {
            const candles = await fetchCandles(symbol, "5m", { from: dayStart, to: dayEnd });
            dayCandles = candles.filter(c => {
                const ts = c.ts < 10000000000 ? c.ts * 1000 : c.ts;
                return ts >= dayStart.getTime() && ts <= dayEnd.getTime();
            });
        } catch (e) {
            console.error(`[LearningOutcomes] ${symbol}: candle fetch failed — ${e.message}`);
            skipped += snaps.length;
            continue;
        }
        if (!dayCandles.length) { skipped += snaps.length; continue; }

        const finalClose = dayCandles[dayCandles.length - 1].close;

        for (const snap of snaps) {
            try {
                const relevant = dayCandles.filter(c => {
                    const ts = c.ts < 10000000000 ? c.ts * 1000 : c.ts;
                    return ts >= snap.capture_ts;
                });
                if (!relevant.length || snap.ltp == null) { skipped++; continue; }

                const maxHigh = Math.max(...relevant.map(c => c.high));
                const minLow = Math.min(...relevant.map(c => c.low));
                const mfePct = +(((maxHigh - snap.ltp) / snap.ltp) * 100).toFixed(2);
                const maePct = +(((minLow - snap.ltp) / snap.ltp) * 100).toFixed(2);
                const closeVsOpenPct = snap.open ? +(((finalClose - snap.open) / snap.open) * 100).toFixed(2) : null;
                const closeVsSnapshotPct = +(((finalClose - snap.ltp) / snap.ltp) * 100).toFixed(2);

                const closeAboveOpen = bool01(closeVsOpenPct != null ? closeVsOpenPct > 0 : null);
                const majorReversal = bool01(mfePct >= OUTCOME_THRESHOLDS.MAJOR_REVERSAL_MFE_MIN_PCT
                    && closeVsSnapshotPct <= OUTCOME_THRESHOLDS.MAJOR_REVERSAL_CLOSE_MAX_PCT);
                const thesisFailure = bool01(closeVsSnapshotPct <= OUTCOME_THRESHOLDS.THESIS_FAILURE_CLOSE_MAX_PCT
                    && mfePct <= OUTCOME_THRESHOLDS.THESIS_FAILURE_MFE_MAX_PCT);
                // General "gave back most of its peak intraday move by close" —
                // computed from candle data alone, so it applies to every
                // candidate, not only ones actually held (backfillTakenTrades
                // separately links which snapshots correspond to real trades).
                let profitGiveback = 0;
                if (mfePct >= OUTCOME_THRESHOLDS.PROFIT_GIVEBACK_MIN_PEAK_PCT) {
                    const givebackPct = ((maxHigh - finalClose) / (maxHigh - snap.ltp)) * 100;
                    profitGiveback = bool01(givebackPct >= OUTCOME_THRESHOLDS.PROFIT_GIVEBACK_MIN_GIVEBACK_PCT);
                }

                stmt.run(
                    snap.id, tradeDate, symbol, finalClose, maxHigh, minLow,
                    mfePct, maePct, closeVsOpenPct, closeVsSnapshotPct,
                    bool01(mfePct >= 1), bool01(mfePct >= 2), bool01(mfePct >= 2.5), bool01(mfePct >= 5),
                    closeAboveOpen, majorReversal, profitGiveback, thesisFailure, Date.now()
                );
                finalized++;
            } catch (e) {
                console.error(`[LearningOutcomes] ${symbol} snapshot ${snap.id}: ${e.message}`);
                skipped++;
            }
        }
    }
    return { finalized, skipped, symbols: bySymbol.size };
}

/**
 * Cross-reference actually-taken Critical trades against that day's
 * snapshots so `was_taken`/`linked_critical_trade_id` reflect reality —
 * doesn't change any outcome numbers, just marks which candidates you acted
 * on (needed so the learning layer can eventually distinguish "signal
 * quality" from "your actual selection/execution," though this phase
 * doesn't yet compute that distinction).
 */
export function backfillTakenTrades(tradeDate) {
    const db = getDb();
    const trades = listCriticalTrades({ includeClosed: true });
    const updateStmt = db.prepare(`
        UPDATE snapshots SET was_taken = 1, linked_critical_trade_id = ?
        WHERE symbol = ? AND trade_date = ? AND time_bucket = ?
    `);
    let updated = 0;
    for (const trade of trades) {
        const entryTs = Date.parse(trade.entryTime);
        if (!Number.isFinite(entryTs)) continue;
        if (istTradeDate(entryTs) !== tradeDate) continue;
        const result = updateStmt.run(trade.id, trade.symbol, tradeDate, istTimeBucket(entryTs));
        updated += result.changes;
    }
    return { updated };
}
