// ─────────────────────────────────────────────────────────────────────────────
// feed.mjs — Bulk REST LTP Poller
// ─────────────────────────────────────────────────────────────────────────────
// Official Groww Rate Limits (confirmed from docs):
//   Live Data (LTP, OHLC, Quote):  10 req/sec  |  300 req/min
//
// Architecture:
//   • 242 stocks ÷ 50 per batch = 5 sequential await LTP calls per poll
//   • 120ms sleep BETWEEN each batch → max burst = 5 / 0.6s ≈ 8.3 req/sec  ✅ under 10
//   • Options feed runs in parallel: 1 req per 1500ms ≈ 0.7 req/sec
//   • Combined peak:  8.3 + 0.7 = ~9 req/sec  ✅  (under 10 req/sec hard cap)
//   • Combined avg:   200 req/min (LTP) + 40 req/min (Options) = 240 req/min  ✅ (80% of 300)
// ─────────────────────────────────────────────────────────────────────────────

import { fetchBulkLtp } from "./groww.mjs";
import { UNIVERSE } from "./universe.mjs";

const BATCH_SIZE        = 50;    // Groww max symbols per LTP call (doc confirmed)
const POLL_INTERVAL_MS  = 3000;  // 3s between full poll rounds -> 100 req/min avg
const BATCH_DELAY_MS    = 150;   // Inter-batch delay

export const livePrices = new Map(); // symbol → last known LTP

let _timer    = null;
let _onBatch  = null;
let _running  = false;

// ── Helpers ───────────────────────────────────────────────────────────────────
function isMarketOpen() {
    const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const h = ist.getHours(), m = ist.getMinutes(), d = ist.getDay();
    return d > 0 && d < 6
        && (h > 9  || (h === 9  && m >= 15))
        && (h < 15 || (h === 15 && m <= 30));
}

function toBatches(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

// ── Poll logic ────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function pollOnce() {
    if (!isMarketOpen()) return;

    const updated = new Map();
    const batches  = toBatches(UNIVERSE, BATCH_SIZE);
    let   ok       = 0;

    for (let i = 0; i < batches.length; i++) {
        // ── Per-second guard: sleep between each batch ────────────────────
        // Groww hard cap = 10 req/sec. With 120ms gap between 5 sequential
        // awaited calls the burst window is ~0.6s → max 8.3 req/sec. Safe.
        if (i > 0) await sleep(BATCH_DELAY_MS);

        try {
            const prices = await fetchBulkLtp(batches[i]);
            for (const [sym, ltp] of Object.entries(prices)) {
                livePrices.set(sym, ltp);
                updated.set(sym, ltp);
            }
            ok++;
        } catch (e) {
            const status = e.response?.status ?? "–";
            const msg    = (e.response?.data?.message || e.message || "").substring(0, 80);
            console.error(`[Feed] LTP batch error (${i + 1}/${batches.length}) HTTP ${status}: ${msg}`);
        }
    }

    if (updated.size > 0) {
        if (_onBatch) _onBatch(updated);
        process.stdout.write(
            `\r[Feed] ⚡ ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} | ` +
            `${updated.size} prices updated (${ok}/${batches.length} calls)  `
        );
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start the bulk LTP polling feed.
 * @param {function(Map<string, number>): void} onBatch
 *   Called after each full poll with a Map of { symbol → ltp } for all stocks
 *   whose price was received this round. Called only during market hours.
 */
export function startFeed(onBatch) {
    if (_running) return;
    _running  = true;
    _onBatch  = onBatch;

    const batches = Math.ceil(UNIVERSE.length / BATCH_SIZE);
    const ratePerMin = (batches / (POLL_INTERVAL_MS / 1000)) * 60;
    console.log(
        `[Feed] Starting Bulk LTP feed: ${UNIVERSE.length} stocks → ` +
        `${batches} call(s)/poll every ${POLL_INTERVAL_MS / 1000}s = ` +
        `${ratePerMin.toFixed(0)} req/min (${((ratePerMin / 300) * 100).toFixed(1)}% of 300/min budget)`
    );

    // Immediate first poll, then every POLL_INTERVAL_MS
    pollOnce().catch(e => console.error("[Feed] Initial poll error:", e.message));
    _timer = setInterval(
        () => pollOnce().catch(e => console.error("[Feed] Poll error:", e.message)),
        POLL_INTERVAL_MS
    );
}

/** Stop the feed */
export function stopFeed() {
    if (_timer) { clearInterval(_timer); _timer = null; }
    _running = false;
    _onBatch = null;
    console.log("\n[Feed] Stopped.");
}

/** Get last known LTP for a symbol, or null if not yet received */
export function getLtp(symbol) {
    return livePrices.get(symbol) ?? null;
}
