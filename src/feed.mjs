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
import { freshness, UNAVAILABLE } from "./data_quality.mjs";

export const livePrices = new Map(); // symbol → last known LTP (backward-compat; bare number)
const tickMeta = new Map();          // symbol → { tickTs, receivedAt } — the real freshness record

let streamer = null;
let _onBatch = null;
let _running = false;
let _restartTimer = null;
let _connected = false;
let _lastTickAt = 0;
const subscribedKeys = new Set();

/**
 * Parse one raw WebSocket message (already protobuf-decoded to JSON by the
 * SDK) into a Map<symbol, {ltp, tickTs}>. Pure function — safe to unit test
 * without a live connection. Returns an empty Map for market-status
 * messages, unresolvable instrument keys, or malformed payloads.
 *
 * `tickTs` is Upstox's own last-trade-time (`ltpc.ltt`, delivered as a
 * string epoch-ms) — the actual moment the exchange generated this price,
 * not when our code happened to receive it. `null` when absent/non-numeric;
 * never fabricated.
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
        const rawTtt = feed?.ltpc?.ltt;
        const tickTs = rawTtt != null && Number.isFinite(+rawTtt) ? +rawTtt : null;
        updated.set(symbol, { ltp, tickTs });
    }
    return updated;
}

function handleMessage(raw) {
    const updated = parseFeedMessage(raw);
    if (updated.size === 0) return;
    const receivedAt = Date.now();
    for (const [symbol, { ltp, tickTs }] of updated) {
        livePrices.set(symbol, ltp);
        // If the exchange didn't send its own trade time, fall back to our
        // receipt time — an honest "we don't know the exchange time, this is
        // when we saw it," never a substitute for a stale candle close.
        tickMeta.set(symbol, { tickTs: tickTs ?? receivedAt, receivedAt });
    }
    _lastTickAt = receivedAt;
    if (_onBatch) _onBatch(updated);
    process.stdout.write(
        `\r[Feed] ⚡ ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} | ` +
        `${updated.size} price(s) updated (WS)  `
    );
}

/**
 * Start the live WebSocket LTP feed for the whole UNIVERSE.
 * @param {function(Map<string, {ltp:number, tickTs:number|null}>): void} onBatch
 *   Called with a Map of { symbol → {ltp, tickTs} } whenever new ticks arrive.
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

    streamer.on("open", () => {
        _connected = true;
        console.log(`[Feed] ✅ WebSocket connected — streaming ${subscribedKeys.size} instruments (ltpc)`);
    });
    streamer.on("message", handleMessage);
    streamer.on("error", (e) => console.error("[Feed] WebSocket error:", e?.message || e));
    streamer.on("close", () => { _connected = false; console.warn("[Feed] WebSocket closed."); });
    streamer.on("reconnecting", (msg) => { _connected = false; console.warn(`[Feed] ${msg}`); });
    streamer.on("autoReconnectStopped", (msg) => scheduleRestart(`Auto-reconnect exhausted (${msg})`));

    _running = true;
    streamer.connect();
}

/**
 * Shared recovery path for "the SDK has given up reconnecting" — normally
 * reached via the "autoReconnectStopped" event above, but also called
 * directly from scanner_testing.mjs's process-level uncaughtException
 * handler: upstox-js-sdk's own retryCount-exhausted cleanup
 * (this.streamer.clearSubscriptions(), in Streamer.js) throws a TypeError
 * because that method doesn't exist on the feeder object it's called on —
 * a real bug in the SDK, not just this app's. That throw happens BEFORE the
 * "autoReconnectStopped" event fires, so if we only swallowed the exception
 * we'd leave the feed permanently dead (streamer never nulled, `_running`
 * never reset, nothing ever schedules a restart) instead of merely delayed.
 */
function scheduleRestart(reason) {
    if (_restartTimer) return; // already scheduled — don't stack duplicate restarts
    _connected = false;
    console.error(`[Feed] ${reason}. Restarting feed in 30s...`);
    _running = false;
    _restartTimer = setTimeout(() => {
        _restartTimer = null;
        if (!_running) startFeed(_onBatch);
    }, 30000);
}

/** Force the recovery path from outside — see scheduleRestart's doc above. */
export function forceFeedRestart(reason) {
    scheduleRestart(reason);
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
    _connected = false;
    _onBatch = null;
    subscribedKeys.clear();
    console.log("[Feed] Stopped.");
}

/** Is the WebSocket currently connected? */
export function isConnected() {
    return _connected;
}

/** Milliseconds since the last tick of ANY kind was received (Infinity if none yet). */
export function msSinceLastTick() {
    return _lastTickAt ? Date.now() - _lastTickAt : Infinity;
}

/**
 * Subscribe additional symbols without duplicating existing subscriptions.
 */
export function subscribeSymbols(symbols) {
    if (!streamer) return;
    const { instrumentKeyBySymbol } = resolveInstrumentKeys(symbols);
    const newKeys = [...instrumentKeyBySymbol.values()].filter(k => !subscribedKeys.has(k));
    if (newKeys.length === 0) return;
    try {
        streamer.subscribe(newKeys, "ltpc");
        newKeys.forEach(k => subscribedKeys.add(k));
    } catch (e) {
        console.error(`[Feed] subscribe failed (socket not open yet): ${e.message}`);
    }
}

/** Unsubscribe symbols currently streamed. */
export function unsubscribeSymbols(symbols) {
    if (!streamer) return;
    const { instrumentKeyBySymbol } = resolveInstrumentKeys(symbols);
    const keys = [...instrumentKeyBySymbol.values()].filter(k => subscribedKeys.has(k));
    if (keys.length === 0) return;
    try {
        streamer.unsubscribe(keys);
        keys.forEach(k => subscribedKeys.delete(k));
    } catch (e) {
        console.error(`[Feed] unsubscribe failed (socket not open yet): ${e.message}`);
    }
}

/**
 * Get last known LTP for a symbol, or null if not yet received.
 * Kept for callers not yet migrated to freshness-aware reads — this alone
 * cannot tell you whether the value is genuinely live or long stale.
 */
export function getLtp(symbol) {
    return livePrices.get(symbol) ?? null;
}

/**
 * Get the last known LTP for a symbol WITH its freshness classification —
 * LIVE / DELAYED / UNAVAILABLE based on the real exchange tick time, never
 * a silent substitution. This is what any consumer that treats the result
 * as "the live price" should use.
 */
export function getLtpWithFreshness(symbol) {
    const meta = tickMeta.get(symbol);
    const ltp = livePrices.get(symbol);
    if (!meta || ltp == null) return UNAVAILABLE("no tick received yet");
    return freshness(ltp, meta.tickTs);
}
