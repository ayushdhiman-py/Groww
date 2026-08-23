// ─────────────────────────────────────────────────────────────────────────────
// feed.mjs — Live LTP Feed via Upstox Market Data Feed V3 (WebSocket)
// ─────────────────────────────────────────────────────────────────────────────
// Replaces the old Groww REST-polling loop. Verified live against Upstox:
//   - message shape:  {"feeds":{"<instrument_key>":{"ltpc":{"ltp":..,"ltt":..,"cp":..}}},"currentTs":".."}
//   - market-status:  {"type":"market_info","marketInfo":{"segmentStatus":{...}}}
//   - reconnection is handled by upstox-js-sdk's Streamer base class; we add an
//     outer restart as a last-resort safety net if it exhausts its own retries.
// ─────────────────────────────────────────────────────────────────────────────
import UpstoxClient from "upstox-js-sdk";
import { CREDS } from "./config.mjs";
import { loadInstrumentMaster, isInstrumentMasterLoaded, resolveInstrumentKeys, symbolForInstrumentKey } from "./instruments.mjs";
import { UNIVERSE } from "./universe.mjs";

export const livePrices = new Map(); // symbol → last known LTP

let streamer = null;
let _onBatch = null;
let _running = false;
let _restartTimer = null;
const subscribedKeys = new Set();

/**
 * Parse one raw WebSocket message (already protobuf-decoded to JSON by the
 * SDK) into a Map<symbol, ltp>. Pure function — safe to unit test without a
 * live connection. Returns an empty Map for market-status messages,
 * unresolvable instrument keys, or malformed payloads.
 */
export function parseFeedMessage(raw) {
    const updated = new Map();
    let payload;
    try {
        const text = Buffer.isBuffer(raw) ? raw.toString("utf-8") : String(raw);
        payload = JSON.parse(text);
    } catch (e) {
        console.error("[Feed] Malformed message, skipping:", e.message);
        return updated;
    }

    if (!payload || typeof payload !== "object" || !payload.feeds) return updated;

    for (const [instrumentKey, feed] of Object.entries(payload.feeds)) {
        const ltp = feed?.ltpc?.ltp;
        if (!Number.isFinite(ltp)) continue;
        const symbol = symbolForInstrumentKey(instrumentKey);
        if (!symbol) continue;
        updated.set(symbol, ltp);
    }
    return updated;
}

function handleMessage(raw) {
    const updated = parseFeedMessage(raw);
    if (updated.size === 0) return;
    for (const [symbol, ltp] of updated) livePrices.set(symbol, ltp);
    if (_onBatch) _onBatch(updated);
    process.stdout.write(
        `\r[Feed] ⚡ ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} | ` +
        `${updated.size} price(s) updated (WS)  `
    );
}

/**
 * Start the live WebSocket LTP feed for the whole UNIVERSE.
 * @param {function(Map<string, number>): void} onBatch
 *   Called with a Map of { symbol → ltp } whenever new ticks arrive.
 */
export async function startFeed(onBatch) {
    if (_running) return;
    if (!CREDS.accessToken) {
        console.warn("[Feed] UPSTOX_ACCESS_TOKEN not configured — live feed disabled.");
        return;
    }
    _onBatch = onBatch;

    if (!isInstrumentMasterLoaded()) await loadInstrumentMaster();
    const { instrumentKeyBySymbol, unresolved } = resolveInstrumentKeys(UNIVERSE);
    if (unresolved.length > 0) {
        console.warn(`[Feed] ${unresolved.length} symbol(s) skipped (no Upstox instrument_key): ${unresolved.join(", ")}`);
    }
    for (const key of instrumentKeyBySymbol.values()) subscribedKeys.add(key);

    if (subscribedKeys.size === 0) {
        console.error("[Feed] No instruments resolved — live feed cannot start.");
        return;
    }

    UpstoxClient.ApiClient.instance.authentications["OAUTH2"].accessToken = CREDS.accessToken;

    streamer = new UpstoxClient.MarketDataStreamerV3([...subscribedKeys], "ltpc");
    streamer.autoReconnect(true, 5, 1000); // retry every 5s, generous attempt budget

    streamer.on("open", () => console.log(`[Feed] ✅ WebSocket connected — streaming ${subscribedKeys.size} instruments (ltpc)`));
    streamer.on("message", handleMessage);
    streamer.on("error", (e) => console.error("[Feed] WebSocket error:", e?.message || e));
    streamer.on("close", () => console.warn("[Feed] WebSocket closed."));
    streamer.on("reconnecting", (msg) => console.warn(`[Feed] ${msg}`));
    streamer.on("autoReconnectStopped", (msg) => {
        console.error(`[Feed] Auto-reconnect exhausted (${msg}). Restarting feed in 30s...`);
        _running = false;
        _restartTimer = setTimeout(() => { if (!_running) startFeed(_onBatch); }, 30000);
    });

    _running = true;
    streamer.connect();
}

/** Stop the feed and close the WebSocket connection. */
export function stopFeed() {
    if (_restartTimer) { clearTimeout(_restartTimer); _restartTimer = null; }
    if (streamer) {
        try { streamer.autoReconnect(false); } catch (_) { /* noop */ }
        try { streamer.disconnect(); } catch (_) { /* noop */ }
    }
    streamer = null;
    _running = false;
    _onBatch = null;
    subscribedKeys.clear();
    console.log("[Feed] Stopped.");
}

/**
 * Subscribe additional symbols without duplicating existing subscriptions.
 */
export function subscribeSymbols(symbols) {
    if (!streamer) return;
    const { instrumentKeyBySymbol } = resolveInstrumentKeys(symbols);
    const newKeys = [...instrumentKeyBySymbol.values()].filter(k => !subscribedKeys.has(k));
    if (newKeys.length === 0) return;
    streamer.subscribe(newKeys, "ltpc");
    newKeys.forEach(k => subscribedKeys.add(k));
}

/** Unsubscribe symbols currently streamed. */
export function unsubscribeSymbols(symbols) {
    if (!streamer) return;
    const { instrumentKeyBySymbol } = resolveInstrumentKeys(symbols);
    const keys = [...instrumentKeyBySymbol.values()].filter(k => subscribedKeys.has(k));
    if (keys.length === 0) return;
    streamer.unsubscribe(keys);
    keys.forEach(k => subscribedKeys.delete(k));
}

/** Get last known LTP for a symbol, or null if not yet received */
export function getLtp(symbol) {
    return livePrices.get(symbol) ?? null;
}
