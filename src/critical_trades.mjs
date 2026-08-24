// ─────────────────────────────────────────────────────────────────────────────
// critical_trades.mjs — MARK CRITICAL persistence + the per-scan orchestrator
// that updates Trade Health, minute history, and notifications for every
// active Critical trade.
//
// Persistence note: this writes to a JSON file (data/critical_trades.json),
// the same pattern already used for the Upstox instrument-master cache.
// On Render's free plan this survives process restarts but is NOT
// guaranteed to survive a redeploy (ephemeral disk) — acceptable for a
// personal tool, but don't rely on it surviving a deploy mid-trade.
// ─────────────────────────────────────────────────────────────────────────────
import fs from "fs";
import path from "path";
import { __dirname } from "./config.mjs";
import { getLtp } from "./feed.mjs";
import { computeTradeHealth, classifyDeteriorationPattern, classifyTrapRisk } from "./trade_health.mjs";
import { buildMarketContext } from "./entry_score.mjs";
import { maybeNotify } from "./notifications.mjs";
import { findBetterOpportunity } from "./capital_rotation.mjs";

const DATA_DIR = path.join(__dirname, "..", "data");
const STORE_FILE = path.join(DATA_DIR, "critical_trades.json");
const MAX_MINUTE_HISTORY = 240; // ~4 hours at 1 entry/minute — covers a full trading session

let trades = [];

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function persist() {
    try {
        ensureDataDir();
        fs.writeFileSync(STORE_FILE, JSON.stringify(trades, null, 2));
    } catch (e) {
        console.error("[CriticalTrades] Persist failed:", e.message);
    }
}

function load() {
    try {
        if (fs.existsSync(STORE_FILE)) {
            trades = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
            console.log(`[CriticalTrades] Loaded ${trades.length} trade(s) from disk`);
        }
    } catch (e) {
        console.error("[CriticalTrades] Load failed, starting empty:", e.message);
        trades = [];
    }
}
load();

let seq = 0;
function nextId(symbol) {
    seq++;
    return `${symbol}-${Date.now()}-${seq}`;
}

export function markCritical({ symbol, entryPrice, quantity, entryTime, stopLoss = null, target = null }) {
    if (!symbol || !Number.isFinite(+entryPrice) || !Number.isFinite(+quantity)) {
        throw new Error("symbol, entryPrice and quantity are required");
    }
    const trade = {
        id: nextId(symbol),
        symbol: String(symbol).toUpperCase(),
        entryPrice: +entryPrice,
        quantity: +quantity,
        entryTime: entryTime || new Date().toISOString(),
        stopLoss: stopLoss != null && stopLoss !== "" ? +stopLoss : null,
        target: target != null && target !== "" ? +target : null,
        status: "ACTIVE",
        createdAt: new Date().toISOString(),
        closedAt: null,
        closeReason: null,
        peakPrice: +entryPrice,
        minuteHistory: [],
        lastMinuteKey: null,
        lastHealth: null,
        lastDeteriorationPattern: "INSUFFICIENT_DATA",
        trap: { level: "NORMAL", flags: [] },
        betterOpportunity: null,
        notifications: [],
        lastNotifiedAt: {},
    };
    trades.push(trade);
    persist();
    return trade;
}

export function listCriticalTrades({ includeClosed = false } = {}) {
    return includeClosed ? trades : trades.filter(t => t.status === "ACTIVE");
}

export function getCriticalTrade(id) {
    return trades.find(t => t.id === id) || null;
}

export function updateCriticalTrade(id, patch) {
    const trade = getCriticalTrade(id);
    if (!trade) return null;
    if (patch.stopLoss !== undefined) trade.stopLoss = patch.stopLoss != null && patch.stopLoss !== "" ? +patch.stopLoss : null;
    if (patch.target !== undefined) trade.target = patch.target != null && patch.target !== "" ? +patch.target : null;
    persist();
    return trade;
}

export function closeCriticalTrade(id, reason = "manual") {
    const trade = getCriticalTrade(id);
    if (!trade) return null;
    trade.status = "CLOSED";
    trade.closedAt = new Date().toISOString();
    trade.closeReason = reason;
    persist();
    return trade;
}

export function deleteCriticalTrade(id) {
    const before = trades.length;
    trades = trades.filter(t => t.id !== id);
    if (trades.length !== before) persist();
    return trades.length !== before;
}

function findRow(dataBuckets, symbol, tf) {
    return (dataBuckets[`${tf}_ALL`] || []).find(r => r.symbol === symbol) || null;
}

/**
 * Called once per full scan cycle (~30s) from scanner.mjs's scanAll(), right
 * after enrichOpportunities() has run. Uses only data that scan just fetched
 * from Upstox — no extra API calls.
 * @param {object} scanResult — the freshly-built `next` state object: { data, intradayOpportunities, marketRegime }
 */
export async function onScanComplete(scanResult) {
    const active = trades.filter(t => t.status === "ACTIVE");
    if (active.length === 0) return;

    const dataBuckets = scanResult.data;
    const ctx5m = buildMarketContext(dataBuckets, "5m");
    const nowMinuteKey = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false });

    for (const trade of active) {
        const row5m = findRow(dataBuckets, trade.symbol, "5m");
        const row15m = findRow(dataBuckets, trade.symbol, "15m");
        const livePrice = getLtp(trade.symbol) ?? row5m?.price ?? trade.entryPrice;

        if (livePrice > trade.peakPrice) trade.peakPrice = livePrice;

        const health = computeTradeHealth(trade, {
            row5m, row15m, niftyRow5m: ctx5m.niftyRow, sectorStats5m: ctx5m.sectorStats, livePrice,
        });
        trade.lastHealth = health;
        trade.trap = classifyTrapRisk(row5m, trade);

        // Profit giveback: fraction of PEAK unrealized profit given back —
        // not a fixed price %, and only meaningful once there was real peak
        // profit to give back in the first place.
        const peakProfitPct = ((trade.peakPrice - trade.entryPrice) / trade.entryPrice) * 100;
        let givebackPct = null;
        if (peakProfitPct > 0.5 && trade.peakPrice > trade.entryPrice) {
            givebackPct = ((trade.peakPrice - livePrice) / (trade.peakPrice - trade.entryPrice)) * 100;
        }
        trade.givebackPct = givebackPct != null ? +givebackPct.toFixed(1) : null;

        // One entry per calendar minute — matches the spec's minute-history example.
        if (trade.lastMinuteKey !== nowMinuteKey) {
            trade.lastMinuteKey = nowMinuteKey;
            trade.minuteHistory.push({
                ts: new Date().toISOString(), minuteKey: nowMinuteKey,
                health: health.score, state: health.state, price: livePrice, pnlPct: health.pnlPct,
            });
            if (trade.minuteHistory.length > MAX_MINUTE_HISTORY) trade.minuteHistory.shift();
        }

        const deterioration = classifyDeteriorationPattern(trade.minuteHistory);
        trade.lastDeteriorationPattern = deterioration.pattern;

        // ── Notifications — debounced, and strong warnings require the last
        // TWO recorded minute-ticks to agree ("one bad minute should not
        // automatically trigger an exit"). ─────────────────────────────────
        const lastTwo = trade.minuteHistory.slice(-2);
        const confirmedLow = lastTwo.length === 2 && lastTwo.every(m => m.health < 60);
        const confirmedVeryLow = lastTwo.length === 2 && lastTwo.every(m => m.health < 50);

        if (health.score >= 70 && health.score < 80) {
            maybeNotify(trade, "MOMENTUM WEAKENING", `${trade.symbol}: health ${health.score} (${health.state}).`, "warning");
        }
        if (health.profitProtectionWarning) {
            maybeNotify(trade, "PROFIT PROTECTION",
                `${trade.symbol}: still in profit (+${health.pnlPct.toFixed(2)}%) but ${health.warnings.slice(0, 2).join("; ") || "momentum is deteriorating"}.`,
                "warning");
        }
        if (givebackPct != null && givebackPct > 30 && (health.breakdown.priceActionHealth.score < 80 || health.breakdown.vwapHealth.score < 80)) {
            maybeNotify(trade, "PROFIT GIVEBACK",
                `${trade.symbol}: given back ${givebackPct.toFixed(0)}% of peak unrealized profit (peak ₹${trade.peakPrice}, now ₹${livePrice.toFixed?.(2) ?? livePrice}).`,
                "warning");
        }
        if (deterioration.pattern === "ACCELERATING_DETERIORATION" || (health.score < 60 && confirmedLow)) {
            maybeNotify(trade, "EXHAUSTION", `${trade.symbol}: deterioration accelerating — health ${health.score}.`, "warning");
        }
        if (confirmedLow && health.score >= 50 && health.score < 60) {
            maybeNotify(trade, "STRONG EXIT WARNING",
                `${trade.symbol}: health ${health.score}, confirmed over 2 consecutive checks — ${health.warnings.slice(0, 3).join("; ")}.`,
                "danger");
        }
        if (confirmedVeryLow) {
            maybeNotify(trade, "THESIS INVALIDATED",
                `${trade.symbol}: health ${health.score}, confirmed over 2 consecutive checks — bullish thesis no longer supported (${health.warnings.slice(0, 3).join("; ")}).`,
                "danger");
        }
        if (deterioration.pattern === "RECOVERY" && health.score >= 70) {
            maybeNotify(trade, "MOMENTUM RECOVERED", `${trade.symbol}: health recovering, now ${health.score}.`, "info");
        }

        const better = findBetterOpportunity(trade, health, scanResult.intradayOpportunities);
        trade.betterOpportunity = better;
        if (better) {
            maybeNotify(trade, "BETTER OPPORTUNITY", `${better.symbol} looks stronger right now than ${trade.symbol} — ${better.reason}`, "info");
        }
    }

    persist();
}
