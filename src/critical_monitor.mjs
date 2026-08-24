// ─────────────────────────────────────────────────────────────────────────────
// critical_monitor.mjs — dedicated ~1-minute Critical-trade refresh loop.
//
// Decoupled entirely from the general 5-minute Stage-1/Stage-2 scan cycle:
// this force-refreshes (bypasses the candle cache's TTL) 1m/5m/15m/30m
// candles for JUST the active Critical-trade symbols — typically a handful, trivial
// request volume — and feeds fresh rows into critical_trades.mjs's
// onCriticalTick(). Uses `priority: true` on every fetch, which reserves
// rate-limit headroom (see upstox.mjs's rateLimit()) so this is never queued
// behind a general-scan burst: a Critical trade's own structural freshness
// must never depend on where the general scan's Stage-2 pass currently is.
// ─────────────────────────────────────────────────────────────────────────────
import { getOrFetchCandles } from "./candle_cache.mjs";
import { buildSignal } from "./scanner.mjs";
import { getLtpWithFreshness } from "./feed.mjs";
import { listCriticalTrades, onCriticalTick } from "./critical_trades.mjs";

const MONITOR_TFS = ["1m", "5m", "15m", "30m"];
const MONITOR_INTERVAL_MS = 60_000;

let timer = null;
let running = false; // re-entrancy guard — a slow tick must not overlap the next one

export async function runCriticalMonitorTick() {
    if (running) return;
    running = true;
    try {
        const active = listCriticalTrades();
        if (!active.length) return;

        const symbols = [...new Set(active.map(t => t.symbol))];
        const rowsBySymbol = {};
        for (const symbol of symbols) {
            rowsBySymbol[symbol] = {};
            for (const tf of MONITOR_TFS) {
                try {
                    const candles = await getOrFetchCandles(symbol, tf, { forceRefresh: true, priority: true });
                    const row = buildSignal(candles, tf, symbol, getLtpWithFreshness(symbol));
                    if (row) rowsBySymbol[symbol][tf] = row;
                } catch (e) {
                    console.error(`[CriticalMonitor] ${symbol}/${tf} refresh failed:`, e.message);
                }
            }
        }
        await onCriticalTick(rowsBySymbol);
    } finally {
        running = false;
    }
}

/** Idempotent — safe to call multiple times (e.g. on re-login). */
export function startCriticalMonitor() {
    if (timer) return;
    timer = setInterval(() => {
        runCriticalMonitorTick().catch(e => console.error("[CriticalMonitor] tick error:", e.message));
    }, MONITOR_INTERVAL_MS);
    console.log(`[CriticalMonitor] Started — refreshing active Critical trades every ${MONITOR_INTERVAL_MS / 1000}s.`);
}

export function stopCriticalMonitor() {
    if (timer) { clearInterval(timer); timer = null; }
}
