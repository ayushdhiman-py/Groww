// ─────────────────────────────────────────────────────────────────────────────
// index_regime.mjs — short "Trending Up / Trending Down / Sideways / Volatile"
// label per market index (NIFTY/BANKNIFTY/FINNIFTY/SENSEX/MIDCPNIFTY), shown
// on each index capsule. Distinct from market_regime.mjs's BULLISH/BEARISH/
// SIDEWAYS call, which is a single whole-market reading derived from stock
// breadth — this is per-index, and folds in F&O positioning (PCR) alongside
// price-action indicators (ATR%, EMA21 slope), not just price.
//
// Zero extra REST cost: reads whatever 5m candles and options-chain data are
// already cached for these symbols (Stage-2 always includes every INDEX
// symbol every cycle — see stage1_filter.mjs's selectStage2Symbols — and
// options_feed.mjs polls every symbol including indices on its own loop).
// Recomputed on its own 60s loop since a index-level regime call doesn't
// need to track every price tick, unlike the capsule's own LTP.
// ─────────────────────────────────────────────────────────────────────────────
import { peekCandles } from "./candle_cache.mjs";
import { isolateTodaySession } from "./session_candles.mjs";
import { ema, atr, emaSlopePct } from "./indicators.mjs";
import { getOptionsCacheWithFreshness } from "./options_feed.mjs";
import { SECTOR } from "./universe.mjs";

// Tuned for index-level intraday behavior, which moves in a much tighter %
// band than any individual stock (a diversified basket dampens single-name
// swings) — reusing market_regime.mjs's stock-universe ATR% thresholds here
// would call almost everything "Volatile".
const VOLATILE_ATR_PCT = 0.6; // ATR(14, 5m) as % of price >= this -> "Volatile"
const FLAT_SLOPE_PCT = 0.03;  // |EMA21 slope, %/bar| below this -> "Sideways"

// `candleSource`/`optionsSource` are injectable (default = the live caches)
// so src/ai_dataset_builder.mjs can reconstruct this EXACT SAME
// classification against historical as-of-T candles instead of maintaining
// a separate copy of this logic that could silently drift from live. PCR
// has no historical equivalent (options_feed.mjs's cache is live-only, and
// Upstox's historical-candle API doesn't cover option chains) — a
// historical optionsSource honestly returns {data: null, stale: true},
// which this function already treats as "no PCR available," not fabricated.
export function classify(symbol, candleSource = peekCandles, optionsSource = getOptionsCacheWithFreshness) {
    const c5 = candleSource(symbol, "5m");
    if (!c5?.candles?.length) {
        return { regime: "Unknown", atrPct: null, emaSlope: null, pcr: null, updatedAt: Date.now() };
    }

    // Prefer today's session alone (matches what a trader means by "is the
    // market trending today"); fall back to the full cached window early in
    // the session when today alone is too short for a reliable ATR(14)/EMA21.
    const { todayCandles } = isolateTodaySession(c5.candles, "5m");
    const candles = todayCandles.length >= 20 ? todayCandles : c5.candles;

    const closes = candles.map(c => c.close).filter(Number.isFinite);
    const lastClose = closes[closes.length - 1];
    const atrVal = atr(candles, 14);
    const atrPct = (atrVal != null && lastClose) ? (atrVal / lastClose) * 100 : null;
    const emaSlope = closes.length >= 22 ? emaSlopePct(ema(closes, 21), 5) : null;

    const opts = optionsSource(symbol);
    const pcr = (opts.data && !opts.stale) ? opts.data.pcr : null;

    let regime;
    if (atrPct != null && atrPct >= VOLATILE_ATR_PCT) regime = "Volatile";
    else if (emaSlope == null) regime = "Unknown";
    else if (Math.abs(emaSlope) < FLAT_SLOPE_PCT) regime = "Sideways";
    else regime = emaSlope > 0 ? "Trending Up" : "Trending Down";

    return { regime, atrPct, emaSlope, pcr, updatedAt: Date.now() };
}

let latestRegimes = new Map();

export function computeAllIndexRegimes() {
    const next = new Map();
    for (const symbol of SECTOR.INDEX) next.set(symbol, classify(symbol));
    latestRegimes = next;
    return next;
}

export function getLatestIndexRegimes() {
    return latestRegimes;
}

let _running = false;
let _timer = null;
const REGIME_INTERVAL_MS = 60_000;

export function startIndexRegimeLoop() {
    if (_running) return;
    _running = true;
    computeAllIndexRegimes(); // don't make the first capsule paint wait a full minute
    console.log(`[IndexRegime] Starting per-index regime loop (every ${REGIME_INTERVAL_MS / 1000}s, zero REST cost)...`);
    _timer = setInterval(computeAllIndexRegimes, REGIME_INTERVAL_MS);
}

export function stopIndexRegimeLoop() {
    _running = false;
    if (_timer) {
        clearInterval(_timer);
        _timer = null;
    }
}
