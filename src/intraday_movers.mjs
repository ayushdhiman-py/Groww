// ─────────────────────────────────────────────────────────────────────────────
// intraday_movers.mjs — "15-min Momentum Ignition" ranking for the Intraday
// tab: every stock scoring 75+ (capped at 30) on how well-aligned its current
// setup is for a ≥0.5% upward move in the next ~15 minutes.
//
// Deliberately INDEPENDENT of scanner.mjs's Stage-2 cycle, entry_score.mjs's
// Opportunity Score, and actionable_score.mjs's Actionable Score — those
// stay exactly as they are (Critical/Quality/Learning/Backtest still depend
// on them), this is a second, separate pipeline with its own scoring logic,
// its own loop, its own output. It touches NOTHING those other systems read
// or write.
//
// REST cost: the 20s scoring loop itself makes zero new Upstox calls — every
// input is a cache read (candle_cache.mjs's peekCandles, the live WebSocket
// LTP feed, options_feed.mjs's own independently-maintained options cache);
// a symbol whose cache isn't warm is just skipped for that cycle. The one
// exception is refreshTradableUniverse() below, which calls upstox.mjs's
// fetchBulkQuotes() for the whole ~500-symbol universe in a single request
// (Upstox allows up to 500 instrument keys per call) to find which symbols
// are actually trading today. This deliberately does NOT rank or cap to a
// "top N" — an earlier version tried to build a "top 100 most liquid" list
// via 500 individual per-symbol candle fetches, which (a) was actually
// biased toward whichever symbols Stage-2's rotation happened to reach
// first (i.e. alphabetical, not liquidity), and (b) even after fixing that,
// took several minutes to complete because it competed with Stage-2 for the
// same shared rate-limit budget. A single bulk-quote call sidesteps both
// problems at once — full universe, seconds not minutes, near-zero REST
// cost — so there's no reason left to pre-filter by rank at all. The
// score >= 75 gate in computeTopMovers() below is the only filter that
// matters; this just excludes symbols with zero traded volume today
// (non-tradable, not "insufficiently liquid").  Runs at most once every 15
// minutes and never blocks the 20s scoring loop.
//
// Scoring — eight factors, each normalized 0-100, weighted sum. All
// grounded in standard intraday technical-analysis concepts, not arbitrary:
//   1. Volatility expansion (20%) — Bollinger Band width expanding vs its
//      own recent average. A stock breaking out of a tight consolidation is
//      statistically more likely to make an outsized move soon than one
//      already mid-move.
//   2. Relative volume (18%) — current 5m volume vs its own recent average.
//      Confirms real participation behind a move, not noise.
//   3. Multi-timeframe alignment (18%) — 1m/5m/15m EMA9 slope direction
//      agreement, plus a bonus when 5m EMA9 is above EMA21 (bullish
//      structure) with extra credit for a crossover in the last few bars.
//   4. Breakout structure (14%) — price vs the last ~1hr's swing high.
//      Actually breaking a real level, not just drifting near one.
//   5. VWAP position + slope (10%) — price above session VWAP, VWAP itself
//      rising. Standard intraday institutional reference.
//   6. F&O confirmation (8%) — PCR level + call-vs-put OI delta, where
//      options data exists. A sentiment/positioning layer on top of price
//      action. Missing (illiquid options, or no F&O) = neutral, never
//      penalized for something outside the stock's control.
//   7. RSI momentum (6%) — 5m RSI(14) in the 50-70 "room to run" zone scores
//      highest; tapers off both toward overbought (>70, less room left) and
//      toward weak/no momentum (<50).
//   8. MACD momentum (6%) — 5m MACD histogram positive and rising confirms
//      trend momentum is building, not fading.
// Any input a symbol doesn't have yet (cold cache) scores neutral (50) for
// that factor rather than zero — a symbol lacking one signal isn't treated
// as "flunking" it, only as "no read yet."
// ─────────────────────────────────────────────────────────────────────────────
import { peekCandles } from "./candle_cache.mjs";
import { isolateTodaySession } from "./session_candles.mjs";
import { ema, bollingerBandWidthPct, vwapSeries, rsi, macd } from "./indicators.mjs";
import { getLtpWithFreshness } from "./feed.mjs";
import { getOptionsCacheWithFreshness } from "./options_feed.mjs";
import { fetchBulkQuotes } from "./upstox.mjs";
import { SCREENER_UNIVERSE } from "./screener_universe.mjs";
import { getSector } from "./universe.mjs";

const TOP_N_MOVERS = 30;
const SCORE_GATE = 75;
const MOVERS_INTERVAL_MS = 20_000;
const UNIVERSE_REFRESH_MS = 15 * 60 * 1000; // which symbols traded today is a slow-moving property, no need to redo it every cycle

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// v==null -> neutral (50), not a penalty; otherwise scale [0, ceiling] -> [0, 100]
const norm = (v, ceiling) => v == null ? 50 : clamp((v / ceiling) * 100, 0, 100);

let tradableSymbols = [];
let lastUniverseRefreshAt = 0;
let universeRefreshInFlight = false;

// Deliberately inclusive: the only thing excluded is a symbol with zero
// traded volume today (can't intraday-trade something with no trades). No
// rank cutoff, no liquidity tier — see the file header for why a "top N"
// pre-filter was dropped. The score >= 75 gate in computeTopMovers() is the
// real filter.
async function refreshTradableUniverse() {
    if (universeRefreshInFlight) return;
    if (Date.now() - lastUniverseRefreshAt < UNIVERSE_REFRESH_MS && tradableSymbols.length) return;

    universeRefreshInFlight = true;
    try {
        const quotes = await fetchBulkQuotes(SCREENER_UNIVERSE);
        const tradable = Object.keys(quotes).filter(symbol => Number.isFinite(quotes[symbol].volume) && quotes[symbol].volume > 0);
        if (tradable.length) {
            tradableSymbols = tradable;
            lastUniverseRefreshAt = Date.now();
        }
    } finally {
        universeRefreshInFlight = false;
    }
}

// EMA9 slope direction on one timeframe: +1 up, -1 down, 0 flat, null = not enough data.
function slopeDirection(candles) {
    if (!candles?.length) return null;
    const closes = candles.map(c => c.close).filter(Number.isFinite);
    if (closes.length < 12) return null;
    const e9 = ema(closes, 9);
    const valid = e9.filter(Number.isFinite);
    if (valid.length < 4) return null;
    const cur = valid[valid.length - 1], prior = valid[valid.length - 4];
    if (cur === prior) return 0;
    return cur > prior ? 1 : -1;
}

function scoreSymbol(symbol) {
    const priceFresh = getLtpWithFreshness(symbol);
    const price = priceFresh.value;
    const c1 = peekCandles(symbol, "1m");
    const c5 = peekCandles(symbol, "5m");
    const c15 = peekCandles(symbol, "15m");
    if (price == null || !c5?.candles?.length) return null;

    const today5 = isolateTodaySession(c5.candles, "5m").todayCandles;
    const session5 = today5.length >= 20 ? today5 : c5.candles;
    const closes5 = session5.map(c => c.close).filter(Number.isFinite);
    if (closes5.length < 20) return null; // not enough same-session history for a meaningful read yet

    const reasons = [];

    // 1) Volatility expansion — current BB width vs its own recent average.
    const bbWidths = bollingerBandWidthPct(closes5, 20).filter(Number.isFinite);
    let volExpansionScore = 50;
    if (bbWidths.length >= 6) {
        const current = bbWidths[bbWidths.length - 1];
        const priorAvg = bbWidths.slice(-6, -1).reduce((a, b) => a + b, 0) / 5;
        if (priorAvg > 0) {
            const expansionPct = ((current - priorAvg) / priorAvg) * 100;
            volExpansionScore = norm(expansionPct, 40); // +40% width expansion -> full score
            if (expansionPct > 15) reasons.push("Volatility expanding (squeeze release)");
        }
    }

    // 2) Relative volume — last 5m candle vs its own recent average.
    const vols5 = c5.candles.slice(-15).map(c => c.volume).filter(Number.isFinite);
    let relVolScore = 50, relVolX = null;
    if (vols5.length >= 6) {
        const avgVol = vols5.slice(0, -1).reduce((a, b) => a + b, 0) / (vols5.length - 1);
        const lastVol = vols5[vols5.length - 1];
        if (avgVol > 0) {
            relVolX = lastVol / avgVol;
            relVolScore = norm((relVolX - 1) * 100, 150); // 2.5x+ avg volume -> full score
            if (relVolX >= 1.5) reasons.push(`Volume ${relVolX.toFixed(1)}x average`);
        }
    }

    // 3) Multi-timeframe EMA9 slope alignment, plus an EMA9/EMA21 structure
    //    bonus on 5m (bullish crossover folded in here rather than as its
    //    own weighted factor — it's the same "trend alignment" concept).
    const dirs = [slopeDirection(c1?.candles), slopeDirection(c5?.candles), slopeDirection(c15?.candles)].filter(d => d !== null);
    const upCount = dirs.filter(d => d > 0).length;
    let alignmentScore = dirs.length ? norm((upCount / dirs.length) * 100, 100) : 50;
    if (dirs.length >= 2 && upCount === dirs.length) reasons.push(`${dirs.length}/${dirs.length} timeframes aligned up`);

    const ema9_5 = ema(closes5, 9), ema21_5 = ema(closes5, 21);
    const last9 = ema9_5[ema9_5.length - 1], last21 = ema21_5[ema21_5.length - 1];
    if (last9 != null && last21 != null && last9 > last21) {
        alignmentScore = clamp(alignmentScore + 10, 0, 100);
        for (let k = Math.max(0, ema9_5.length - 6); k < ema9_5.length - 1; k++) {
            if (ema9_5[k] != null && ema21_5[k] != null && ema9_5[k] <= ema21_5[k]) {
                reasons.push("EMA9 crossed above EMA21");
                break;
            }
        }
    }

    // 4) Breakout structure — price vs the last ~1hr's swing high.
    const recentHighs = c5.candles.slice(-13, -1).map(c => c.high).filter(Number.isFinite);
    let breakoutScore = 50;
    if (recentHighs.length >= 6) {
        const swingHigh = Math.max(...recentHighs);
        if (price > swingHigh) {
            breakoutScore = 100;
            reasons.push("Broke last-hour high");
        } else if (swingHigh > 0) {
            breakoutScore = norm(((price - swingHigh) / swingHigh) * 100 + 3, 3); // within 3% below the high scales toward 100 as price approaches it
        }
    }

    // 5) VWAP position + slope.
    let vwapScore = 50;
    const vwapSeriesVals = vwapSeries(session5).filter(Number.isFinite);
    if (vwapSeriesVals.length >= 2) {
        const curVwap = vwapSeriesVals[vwapSeriesVals.length - 1];
        const priorVwap = vwapSeriesVals[Math.max(0, vwapSeriesVals.length - 4)];
        const above = price > curVwap;
        const rising = curVwap > priorVwap;
        vwapScore = (above ? 60 : 20) + (rising ? 40 : 0);
        if (above && rising) reasons.push("Above rising VWAP");
    }

    // 6) F&O confirmation — where options data exists; neutral otherwise.
    let fnoScore = 50;
    const opts = getOptionsCacheWithFreshness(symbol);
    if (opts.data && !opts.stale && Number.isFinite(opts.data.pcr)) {
        const pcr = opts.data.pcr;
        const pcrScore = pcr <= 0.8 ? 100 : pcr >= 1.2 ? 0 : norm((1.2 - pcr) / 0.4 * 100, 100);
        const oiDeltaScore = (Number.isFinite(opts.data.callOIDelta) && Number.isFinite(opts.data.putOIDelta))
            ? norm((opts.data.callOIDelta - opts.data.putOIDelta) + 50, 100)
            : 50;
        fnoScore = (pcrScore + oiDeltaScore) / 2;
        if (fnoScore >= 70) reasons.push("Call-side F&O positioning");
    }

    // 7) RSI momentum — sweet spot is 50-70 (real momentum, not exhausted).
    let rsiScore = 50;
    const rsiVal = rsi(closes5, 14);
    if (Number.isFinite(rsiVal)) {
        if (rsiVal >= 50 && rsiVal <= 70) rsiScore = 100;
        else if (rsiVal > 70) rsiScore = clamp(100 - (rsiVal - 70) * 4, 0, 100); // overbought -> less room left to run
        else rsiScore = clamp((rsiVal / 50) * 100, 0, 100); // below midline -> momentum not established yet
        if (rsiVal >= 55 && rsiVal <= 70) reasons.push(`RSI momentum building (${rsiVal.toFixed(0)})`);
    }

    // 8) MACD momentum — histogram positive and rising confirms trend
    //    momentum is building, not fading.
    let macdScore = 50;
    const { macd: macdLine, signal: signalLine } = macd(closes5);
    const hist = macdLine.map((v, i) => (v != null && signalLine[i] != null) ? v - signalLine[i] : null).filter(Number.isFinite);
    if (hist.length >= 4) {
        const curHist = hist[hist.length - 1];
        const priorHist = hist[hist.length - 4];
        const bullish = curHist > 0, rising = curHist > priorHist;
        macdScore = (bullish ? 60 : 20) + (rising ? 40 : 0);
        if (bullish && rising) reasons.push("MACD bullish & rising");
    }

    const score =
        volExpansionScore * 0.20 +
        relVolScore * 0.18 +
        alignmentScore * 0.18 +
        breakoutScore * 0.14 +
        vwapScore * 0.10 +
        fnoScore * 0.08 +
        rsiScore * 0.06 +
        macdScore * 0.06;

    return {
        symbol,
        sector: getSector(symbol),
        price,
        priceSource: priceFresh.source,
        priceTs: priceFresh.ts,
        score: +score.toFixed(1),
        reasons: reasons.slice(0, 4),
        components: {
            volExpansion: +volExpansionScore.toFixed(1),
            relVolume: +relVolScore.toFixed(1),
            alignment: +alignmentScore.toFixed(1),
            breakout: +breakoutScore.toFixed(1),
            vwap: +vwapScore.toFixed(1),
            fno: +fnoScore.toFixed(1),
            rsi: +rsiScore.toFixed(1),
            macd: +macdScore.toFixed(1),
        },
        relVolX: relVolX != null ? +relVolX.toFixed(2) : null,
    };
}

let latestMovers = [];
let latestUpdatedAt = null;

export function computeTopMovers() {
    // Fire-and-forget — this is a single bulk-quote call so it normally
    // finishes in a second or two, but scoring below must never block on
    // it regardless, and always uses whatever universe list is currently
    // available.
    refreshTradableUniverse().catch(e => console.error("[IntradayMovers] Universe refresh error:", e.message));

    // scoreSymbol runs synchronously for the whole universe every 20s
    // inside a bare setInterval(computeTopMovers, ...) — nothing upstream
    // catches a throw. One symbol with an edge-case candle shape throwing
    // here (uncaught inside a setInterval callback) hits scanner_testing.mjs's
    // process.on('uncaughtException') handler, which exits the whole server
    // for anything it doesn't recognize as a known SDK quirk. Isolating
    // per-symbol keeps one bad symbol from taking the entire process down.
    const scored = tradableSymbols.map(symbol => {
        try {
            return scoreSymbol(symbol);
        } catch (e) {
            console.error(`[IntradayMovers] scoreSymbol failed for ${symbol}:`, e.message);
            return null;
        }
    }).filter(Boolean);
    scored.sort((a, b) => b.score - a.score);
    // The score >= 75 gate is the real filter — a stock either shows
    // genuine multi-factor alignment for a 15-min move or it doesn't.
    // TOP_N_MOVERS only caps the list length; it never pads it out with
    // weaker names to hit 30.
    latestMovers = scored.filter(s => s.score >= SCORE_GATE).slice(0, TOP_N_MOVERS);
    latestUpdatedAt = Date.now();
    return latestMovers;
}

export function getLatestMovers() {
    return { movers: latestMovers, updatedAt: latestUpdatedAt, universeSize: tradableSymbols.length };
}

let _running = false;
let _timer = null;

export function startIntradayMoversLoop() {
    if (_running) return;
    _running = true;
    computeTopMovers(); // don't make the first tab open wait a full cycle
    console.log(`[IntradayMovers] Starting 15-min momentum ranking loop (every ${MOVERS_INTERVAL_MS / 1000}s, zero REST cost)...`);
    _timer = setInterval(computeTopMovers, MOVERS_INTERVAL_MS);
}

export function stopIntradayMoversLoop() {
    _running = false;
    if (_timer) {
        clearInterval(_timer);
        _timer = null;
    }
}
