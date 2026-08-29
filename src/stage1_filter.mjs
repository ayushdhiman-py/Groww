// ─────────────────────────────────────────────────────────────────────────────
// stage1_filter.mjs — cheap, full-universe pre-filter that runs every cycle
// with near-zero REST cost (cache reads + free WebSocket LTP only), used to
// narrow the curated UNIVERSE (src/universe.mjs — now the full Nifty 500 plus
// a handful of indices/legacy names) down to a Stage-2 deep-analysis
// shortlist. This is what makes a real ~5-minute cycle possible: Stage-2
// (buildSignal across all 7 timeframes) only runs on the symbols this module
// selects, not the whole universe every time.
//
// IMPORTANT: computeFullUniverseSnapshot() must stay full-universe every
// cycle — Market Regime's breadth calculation depends on it covering the
// whole UNIVERSE, not just symbols that already look strong. If this were computed
// only from Stage-2 survivors, breadth would be permanently biased bullish
// (a "regime computed only from stocks that already look strong" selection-
// bias trap).
// ─────────────────────────────────────────────────────────────────────────────
import { peekCandles, getOrFetchCandles } from "./candle_cache.mjs";
import { isolateTodaySession } from "./session_candles.mjs";
import { vwap, ema, vwapSeries, bollingerBandWidthPct, rsi, macd } from "./indicators.mjs";
import { getLtpWithFreshness } from "./feed.mjs";
import { getOptionsCacheWithFreshness } from "./options_feed.mjs";
import { UNIVERSE, getSector } from "./universe.mjs";

// symbol -> last time it got a real Stage-2 deep refresh. Lives here (not
// scanner.mjs) so stage1_filter.mjs and scanner.mjs can both read/write it
// without a circular import.
const lastDeepScanAt = new Map();

export function markDeepScanned(symbol) {
    lastDeepScanAt.set(symbol, Date.now());
}

export function getLastDeepScanAt(symbol) {
    return lastDeepScanAt.get(symbol) ?? 0;
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

/**
 * Full-universe cheap read, every cycle. Reads ONLY the live WebSocket LTP
 * (free) and whatever candles are already cached (peekCandles — never
 * triggers a fetch) — zero new REST requests. A symbol whose cache hasn't
 * warmed up yet (e.g. right after boot) simply gets a lower-confidence
 * cheapScore of 0, not an error — it'll get picked up by the fairness
 * rotation in selectStage2Symbols() and warm up naturally.
 */
let latestSnapshot = null;

/**
 * The most recent computeFullUniverseSnapshot() result — full-universe,
 * every cycle. Lets other modules (entry_score.mjs's sector/RS context) use
 * this SAME cheap-but-genuinely-full-universe-fresh source instead of
 * whatever subset the persistent Stage-2 buckets happen to carry forward
 * from previous cycles, without needing every caller to thread the
 * snapshot through as a parameter. Null only before the very first cycle
 * completes.
 */
export function getLatestFullUniverseSnapshot() {
    return latestSnapshot;
}

/** Test-only hook — lets tests inject a deterministic snapshot without depending on live feed/candle-cache state. */
export function _setLatestSnapshotForTesting(snapshot) {
    latestSnapshot = snapshot;
}

export function computeFullUniverseSnapshot(universe = UNIVERSE) {
    const snapshot = new Map();
    for (const symbol of universe) {
        const priceFresh = getLtpWithFreshness(symbol);
        const livePrice = priceFresh.value;

        const d1 = peekCandles(symbol, "1d");
        const c5 = peekCandles(symbol, "5m");
        const prevClose = d1?.candles?.length ? d1.candles[d1.candles.length - 1].close : null;

        let dayOpen = null, pctFromOpenCheap = null, aboveVwapCheap = null, relVolumeCheap = null;
        let volumeCheap = null;
        if (c5?.candles?.length) {
            const { todayCandles } = isolateTodaySession(c5.candles, "5m");
            if (todayCandles.length) {
                dayOpen = todayCandles[0].open;
                if (dayOpen && livePrice != null) pctFromOpenCheap = ((livePrice - dayOpen) / dayOpen) * 100;
                const v = vwap(todayCandles);
                if (v != null && livePrice != null) aboveVwapCheap = livePrice > v;
                const todayVols = todayCandles.map(c => c.volume).filter(Number.isFinite);
                if (todayVols.length) volumeCheap = todayVols.reduce((a, b) => a + b, 0);
            }
            const vols = c5.candles.slice(-10).map(c => c.volume).filter(Number.isFinite);
            const avgVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : null;
            const lastVol = vols[vols.length - 1];
            if (avgVol) relVolumeCheap = lastVol / avgVol;
        }

        const chgPctCheap = prevClose && livePrice != null ? ((livePrice - prevClose) / prevClose) * 100 : null;

        // Simple, transparent composite — this is a CHEAP pre-filter, not the
        // real Opportunity Score (that's entry_score.mjs, run only on the
        // Stage-2 shortlist against fresh data). Rewards a moderate move off
        // the open, elevated relative volume, and positive change vs prior
        // close — the same directional signals the real score uses, just
        // computed from whatever's already cached instead of a fresh fetch.
        const cheapScore =
            (pctFromOpenCheap != null ? clamp(pctFromOpenCheap, -5, 5) * 4 : 0) +
            (relVolumeCheap != null ? clamp(relVolumeCheap - 1, 0, 3) * 8 : 0) +
            (chgPctCheap != null ? clamp(chgPctCheap, -5, 5) * 3 : 0);

        snapshot.set(symbol, {
            symbol,
            sector: getSector(symbol),
            price: livePrice,
            cheapScore,
            chgPctCheap,
            aboveVwapCheap,
            pctFromOpenCheap,
            relVolumeCheap,
            volumeCheap,
            priceFreshness: priceFresh.source,
            candleAgeMs: c5 ? Date.now() - c5.fetchedAt : null,
            lastDeepScanAt: getLastDeepScanAt(symbol),
        });
    }
    latestSnapshot = snapshot;
    return snapshot; // Map<symbol, cheapRow> — ALL universe.length symbols, always
}

// Independent fast refresh loop, decoupled from the slow Stage-2 cycle this
// snapshot also feeds into. Every tick here is pure cache/WebSocket reads —
// zero Upstox REST calls — so it isn't subject to Upstox's rate limits at
// all; the only reason it isn't even faster is there's no point refreshing
// quicker than the underlying WebSocket ticks/candle cache actually change.
let _fastLoopRunning = false;
let _fastLoopTimer = null;
const FAST_SNAPSHOT_INTERVAL_MS = 2000;

export function startFastSnapshotLoop() {
    if (_fastLoopRunning) return;
    _fastLoopRunning = true;
    console.log(`[Stage1] Starting fast full-universe snapshot loop (every ${FAST_SNAPSHOT_INTERVAL_MS / 1000}s, zero REST cost)...`);
    _fastLoopTimer = setInterval(() => {
        computeFullUniverseSnapshot();
        computeAllChartFields(UNIVERSE, activeChartTf);
        ensureChartCandlesWarm().catch(e => console.error("[Stage1] Chart candle warm-up error:", e.message));
    }, FAST_SNAPSHOT_INTERVAL_MS);
}

export function stopFastSnapshotLoop() {
    _fastLoopRunning = false;
    if (_fastLoopTimer) {
        clearInterval(_fastLoopTimer);
        _fastLoopTimer = null;
    }
}

// ── Per-timeframe chart fields + per-indicator Score for the "All Stocks"
// view ───────────────────────────────────────────────────────────────────
// Deliberately SEPARATE from computeFullUniverseSnapshot() above: that
// snapshot's pctFromOpenCheap/aboveVwapCheap/relVolumeCheap feed cheapScore,
// which selectStage2Symbols() and entry_score.mjs's sector/RS context both
// depend on — those must stay on a fixed, canonical basis regardless of
// whatever candle timeframe the user happens to have the "All Stocks" chart
// set to. The chart/EMA/Score/Volume fields below are timeframe-selectable
// (see computeChartFields()'s volumeCheap override below for why Volume
// specifically had to move here too — a day-cumulative number looks
// identical no matter which tf you bucket it by, so it can't be the thing
// that visibly changes when you switch timeframes); price and change% stay
// day-level (tf-agnostic) — those are meant to answer "where is it today
// vs. yesterday's close," a question a chart timeframe doesn't change.
const INTRADAY_TFS = new Set(["1m", "5m", "10m", "15m", "30m", "1h"]);
const ALL_REAL_TFS = ["1m", "5m", "10m", "15m", "30m", "1h", "1d"];
let activeChartTf = "5m";
let latestChartFields = new Map();

function computeChartFieldsForTf(symbol, tf) {
    const c = peekCandles(symbol, tf);
    if (!c?.candles?.length) return { priceHist: [], ema21Hist: [], ema50Hist: [], emaGap: null, ema21above: null, candles: [], lastVolume: null };

    // Daily candles are already one bar per session — there's no "today"
    // sub-window to isolate the way there is for an intraday timeframe.
    //
    // The threshold below has to be tied to EMA50's actual 50-bar
    // requirement, not an arbitrary "looks like enough" number — a flat 20
    // was a real bug: a full trading day produces ~25 15m-candles and ~37
    // 10m-candles, both comfortably over 20, so "today only" always won for
    // those two tfs even though today alone can never reach the 50 bars
    // EMA50 needs — ema21aboveCheap/emaGapCheap/Score stayed permanently
    // null all day for 15m/10m specifically, never "warming up" no matter
    // how long the server ran, while every other tf (where a day's candle
    // count naturally lands under 20, e.g. 30m/1h/1d, or comfortably over
    // 50, e.g. 1m/5m) worked fine. Requiring 55 (50 plus a handful of real
    // plotted points, not just the bare minimum) means "today only" is used
    // exactly when it's actually sufficient, and every tf otherwise falls
    // back to the fuller multi-day cache the same way 30m/1h/1d already did.
    const source = INTRADAY_TFS.has(tf) ? isolateTodaySession(c.candles, tf).todayCandles : c.candles;
    const rawCandles = source.length >= 55 ? source : c.candles;

    // 150, not 60 — EMA50 needs 50 bars just to produce its first real
    // value, so a short window leaves almost nothing real to plot
    // (generateSparkline skips the null warm-up rather than drawing it as
    // garbage, but a wider window means an actually informative amount of
    // the EMA50 line shows at all).
    const candles = rawCandles.slice(-150);
    const closes = candles.map(x => x.close).filter(Number.isFinite);
    if (closes.length < 2) return { priceHist: [], ema21Hist: [], ema50Hist: [], emaGap: null, ema21above: null, candles: [], lastVolume: null };

    const ema21Hist = ema(closes, 21);
    const ema50Hist = ema(closes, 50);
    const e21 = ema21Hist[ema21Hist.length - 1], e50 = ema50Hist[ema50Hist.length - 1];
    let ema21above = null, emaGap = null;
    if (Number.isFinite(e21) && Number.isFinite(e50) && e50 !== 0) {
        ema21above = e21 > e50;
        emaGap = ((e21 - e50) / e50) * 100;
    }
    // Most recent candle's volume AT THIS TIMEFRAME — genuinely different
    // per tf (a 1h candle's volume is naturally ~12x a 5m candle's), unlike
    // "today's total volume so far" which sums to roughly the same number
    // no matter how it's bucketed. This is what actually makes the All
    // Stocks Volume column change when the timeframe selection changes.
    const lastCandle = candles[candles.length - 1];
    const lastVolume = Number.isFinite(lastCandle?.volume) ? lastCandle.volume : null;
    return { priceHist: closes, ema21Hist, ema50Hist, emaGap, ema21above, candles, lastVolume };
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

// v==null -> neutral (50), not a penalty; otherwise scale [0, ceiling] -> [0, 100]
function norm(v, ceiling) { return v == null ? 50 : clamp((v / ceiling) * 100, 0, 100); }

/**
 * Same 8-factor composite as the Intraday tab's engine (see
 * intraday_movers.mjs), reused here as a plain per-row "how strong does
 * this setup look" score rather than a 75+ gate — deliberately a separate,
 * self-contained implementation (not a shared import) so this tab and
 * Intraday stay fully independent, matching how the rest of the codebase
 * keeps each tab's scoring untangled from the others.
 *
 * tf-aware: every factor reads the given tf's candles.
 *
 * `primary` is the caller's already-computed computeChartFieldsForTf() result
 * for this symbol/tf — passed in rather than recomputed here since
 * computeChartFields() below needs that same result anyway; computing it
 * twice per symbol on every 2s tick was pure wasted CPU across the whole
 * universe.
 */
function computeMoverScore(symbol, tf, primary) {
    const priceFresh = getLtpWithFreshness(symbol);
    const price = priceFresh.value;
    if (price == null || primary.candles.length < 20) return { score: null, reasons: [] };

    const closes = primary.candles.map(c => c.close).filter(Number.isFinite);
    const reasons = [];

    // 1) Volatility expansion — current BB width vs its own recent average.
    const bbWidths = bollingerBandWidthPct(closes, 20).filter(Number.isFinite);
    let volExpansionScore = 50;
    if (bbWidths.length >= 6) {
        const current = bbWidths[bbWidths.length - 1];
        const priorAvg = bbWidths.slice(-6, -1).reduce((a, b) => a + b, 0) / 5;
        if (priorAvg > 0) {
            const expansionPct = ((current - priorAvg) / priorAvg) * 100;
            volExpansionScore = norm(expansionPct, 40);
            if (expansionPct > 15) reasons.push("Volatility expanding");
        }
    }

    // 2) Relative volume — last candle vs its own recent average.
    const vols = primary.candles.slice(-15).map(c => c.volume).filter(Number.isFinite);
    let relVolScore = 50;
    if (vols.length >= 6) {
        const avgVol = vols.slice(0, -1).reduce((a, b) => a + b, 0) / (vols.length - 1);
        const lastVol = vols[vols.length - 1];
        if (avgVol > 0) {
            const relVolX = lastVol / avgVol;
            relVolScore = norm((relVolX - 1) * 100, 150);
            if (relVolX >= 1.5) reasons.push(`Volume ${relVolX.toFixed(1)}x average`);
        }
    }

    // 3) EMA alignment — single-tf EMA9 slope direction, plus a bonus when
    //    EMA21 sits above EMA50 on this tf.
    let alignmentScore = 50;
    const dir = slopeDirection(primary.candles);
    if (dir != null) {
        alignmentScore = dir > 0 ? 100 : dir < 0 ? 0 : 50;
        if (dir > 0) reasons.push("EMA9 trending up");
    }
    if (primary.ema21above) {
        alignmentScore = clamp(alignmentScore + 10, 0, 100);
        reasons.push("EMA21 above EMA50");
    }

    // 4) Breakout structure — price vs the recent swing high on this tf.
    const recentHighs = primary.candles.slice(-13, -1).map(c => c.high).filter(Number.isFinite);
    let breakoutScore = 50;
    if (recentHighs.length >= 6) {
        const swingHigh = Math.max(...recentHighs);
        if (price > swingHigh) {
            breakoutScore = 100;
            reasons.push("Broke recent high");
        } else if (swingHigh > 0) {
            breakoutScore = norm(((price - swingHigh) / swingHigh) * 100 + 3, 3);
        }
    }

    // 5) VWAP position + slope.
    let vwapScore = 50;
    const todaySession = INTRADAY_TFS.has(tf) ? isolateTodaySession(primary.candles, tf).todayCandles : primary.candles;
    const vwapSeriesVals = vwapSeries(todaySession.length >= 5 ? todaySession : primary.candles).filter(Number.isFinite);
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

    // 7) RSI momentum — 50-70 "room to run" sweet spot.
    let rsiScore = 50;
    const rsiVal = rsi(closes, 14);
    if (Number.isFinite(rsiVal)) {
        if (rsiVal >= 50 && rsiVal <= 70) rsiScore = 100;
        else if (rsiVal > 70) rsiScore = clamp(100 - (rsiVal - 70) * 4, 0, 100);
        else rsiScore = clamp((rsiVal / 50) * 100, 0, 100);
        if (rsiVal >= 55 && rsiVal <= 70) reasons.push(`RSI momentum (${rsiVal.toFixed(0)})`);
    }

    // 8) MACD momentum — histogram positive and rising.
    let macdScore = 50;
    const { macd: macdLine, signal: signalLine } = macd(closes);
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

    return { score: +score.toFixed(1), reasons: reasons.slice(0, 3) };
}

function computeChartFields(symbol, tf) {
    const f = computeChartFieldsForTf(symbol, tf);
    const { score, reasons } = computeMoverScore(symbol, tf, f);
    // volumeCheap here is the selected tf's most recent candle's volume —
    // deliberately overrides computeFullUniverseSnapshot()'s day-cumulative
    // volumeCheap in the merged /api/universe-snapshot response (route spreads
    // chart fields after the canonical row) for DISPLAY purposes only. That
    // canonical value still exists and still feeds cheapScore internally
    // (already computed, unaffected) — this override is what actually makes
    // the All Stocks Volume column change when the timeframe changes, same as
    // the EMA fields already did.
    return { priceHist: f.priceHist, ema21Hist: f.ema21Hist, ema50Hist: f.ema50Hist, emaGapCheap: f.emaGap, ema21aboveCheap: f.ema21above, volumeCheap: f.lastVolume, score, reasons };
}

// On-demand only — never part of the universe-wide 2s loop. Used when the
// frontend has narrowed search to exactly one stock and the user picks
// "ALL" timeframe for it specifically: 1 symbol × 7 real timeframes, not
// the whole universe × 7, so actively fetching whichever of those aren't
// cached yet (sequential, awaited) is cheap and fast — worst case 7 fetches
// for one symbol, nothing like the multi-minute full-universe warm-up.
export async function computeSymbolAllTimeframes(symbol) {
    // The 7 fetches are for different timeframes of the same symbol — fully
    // independent of each other, so run them concurrently rather than
    // waiting on each one's full round trip before starting the next. They
    // still funnel through the same shared rate limiter (upstox.mjs's
    // rateLimit()), so this doesn't add REST volume, it just stops paying
    // for 7 sequential round-trip latencies back-to-back — a real difference
    // for a cold symbol (every one a genuine cache miss), which otherwise
    // took ~35s end to end for something meant to feel like a quick lookup.
    await Promise.all(ALL_REAL_TFS.map(async tf => {
        if (peekCandles(symbol, tf)?.candles?.length) return;
        try {
            await getOrFetchCandles(symbol, tf, { priority: false });
        } catch (e) {
            // no data for this tf — computeChartFields below just returns nulls for it
        }
    }));

    return ALL_REAL_TFS.map(tf => {
        try {
            return { tf, ...computeChartFields(symbol, tf) };
        } catch (e) {
            console.error(`[Stage1] computeChartFields failed for ${symbol}/${tf}:`, e.message);
            return { tf, ...EMPTY_CHART_FIELDS };
        }
    });
}

const EMPTY_CHART_FIELDS = { priceHist: [], ema21Hist: [], ema50Hist: [], emaGapCheap: null, ema21aboveCheap: null, score: null, reasons: [] };

export function computeAllChartFields(universe = UNIVERSE, tf = activeChartTf) {
    const next = new Map();
    for (const symbol of universe) {
        // computeChartFields runs synchronously, every 2s, for the whole
        // universe, inside startFastSnapshotLoop's setInterval — nothing
        // upstream of this catches a throw. One symbol with an edge-case
        // candle shape throwing here (uncaught inside a bare setInterval
        // callback) hits scanner_testing.mjs's process.on('uncaughtException')
        // handler, which exits the whole server for anything it doesn't
        // recognize as a known SDK quirk. Isolating per-symbol keeps one bad
        // symbol from taking the entire process down.
        try {
            next.set(symbol, computeChartFields(symbol, tf));
        } catch (e) {
            console.error(`[Stage1] computeChartFields failed for ${symbol}:`, e.message);
            next.set(symbol, EMPTY_CHART_FIELDS);
        }
    }
    latestChartFields = next;
    return next;
}

export function getLatestChartFields() {
    return latestChartFields;
}

// Which candle timeframe(s) need to be kept warm in the cache for whatever
// the frontend currently has selected — read fresh on every call (not
// captured in a closure) so a mid-pass tf switch takes effect on the very
// next symbol instead of waiting for the whole pass to finish.
function tfsCurrentlyNeeded() {
    return [activeChartTf];
}

// computeChartFields()/computeMoverScore() above are pure cache reads
// (peekCandles, never fetches) — by design, zero extra REST cost. But nothing
// else actively fetches candles for the FULL universe on a timely basis; the
// only thing that does is Stage-2's own slow, 7-timeframe-per-symbol
// rotation, which can take many minutes to reach a given symbol. Without
// this, "All Stocks" chart/EMA/Score data would only be as complete as
// whatever Stage-2 happens to have scanned so far — most of the table blank
// most of the time. This actively (and separately from Stage-2) fetches
// whichever tf(s) tfsCurrentlyNeeded() says are missing, self-throttled to
// keep its own footprint on the shared rate limiter small (this doesn't need
// to be fast, just needs to keep making progress) — the same lesson learned
// building intraday_movers.mjs's universe refresh.
//
// chartFetchGeneration guards against a real bug: this loop walks UNIVERSE
// in a fixed order start-to-finish. Without the generation check, switching
// timeframe mid-pass wouldn't restart it from symbol 0 — the symbols already
// passed this pass would just never get checked for the newly-selected tf
// until the current (possibly near-complete, possibly barely-started) pass
// finishes on its own and wraps back around. For someone testing timeframe
// after timeframe, that meant most of them never actually caught up, not
// just "slow." Bumping the generation on every tf switch makes the loop
// abandon its current position and start a fresh pass from symbol 0 for
// whatever's newly selected, so every tf switch gets the same "a few
// minutes, from scratch" convergence instead of an unpredictable one that
// depends on where the previous pass happened to be.
const CHART_FETCH_SELF_THROTTLE_MS = 300;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let chartFetchInFlight = false;
let chartFetchGeneration = 0;

async function ensureChartCandlesWarm() {
    if (chartFetchInFlight) return;
    chartFetchInFlight = true;
    const myGeneration = chartFetchGeneration;
    try {
        for (const symbol of UNIVERSE) {
            if (chartFetchGeneration !== myGeneration) return; // tf changed mid-pass — abandon; the next tick starts fresh from symbol 0
            for (const tf of tfsCurrentlyNeeded()) {
                if (peekCandles(symbol, tf)?.candles?.length) continue;
                try {
                    await getOrFetchCandles(symbol, tf, { priority: false });
                    await sleep(CHART_FETCH_SELF_THROTTLE_MS); // only after a REAL fetch — a cache hit costs nothing
                } catch (e) {
                    continue; // one unresolvable/delisted symbol shouldn't abort the whole pass
                }
            }
        }
    } finally {
        chartFetchInFlight = false;
    }
}

// Called from the /api/universe-snapshot route whenever the frontend's
// timeframe selector changes — the NEXT fast-loop tick (within 2s) picks up
// the new tf on its own, but the route also recomputes synchronously so the
// response answering the tf switch itself is already correct, not stale by
// up to one tick.
export function setActiveChartTf(tf) {
    if (tf === activeChartTf) return;
    activeChartTf = tf;
    chartFetchGeneration++;
    computeAllChartFields(UNIVERSE, tf);
}

/**
 * Selection policy for the Stage-2 deep-analysis pass.
 * Always includes: INDEX-sector symbols (NIFTY/BANKNIFTY/etc — needed for
 * market context/RS calculations everywhere) and any symbol with an active
 * Critical trade (their full 7-timeframe row data still needs to stay
 * populated for entry_score/screener even though their minute-to-minute
 * health now comes from the dedicated Critical monitor, not this pass).
 * Then: top-N by cheap score, plus a fairness-rotation slice (oldest/never
 * deep-scanned first) so a symbol that never top-ranks still gets refreshed
 * periodically — without this, a currently-out-of-favor stock could never
 * be rediscovered once its cache goes stale, and its 52W/ATR would go
 * permanently null past the existing 26h staleness cap.
 */
export function selectStage2Symbols(snapshot, { activeCriticalSymbols = [], topN = 55, rotationSize = 20, cap = 100 } = {}) {
    const always = new Set([...snapshot.values()].filter(r => r.sector === "INDEX").map(r => r.symbol));
    for (const s of activeCriticalSymbols) always.add(s);

    const rest = [...snapshot.values()].filter(r => !always.has(r.symbol));
    const top = rest.slice().sort((a, b) => b.cheapScore - a.cheapScore).slice(0, topN).map(r => r.symbol);

    const chosenSoFar = new Set([...always, ...top]);
    const rotation = rest
        .filter(r => !chosenSoFar.has(r.symbol))
        .sort((a, b) => a.lastDeepScanAt - b.lastDeepScanAt) // oldest / never-scanned first
        .slice(0, rotationSize)
        .map(r => r.symbol);

    return [...new Set([...always, ...top, ...rotation])].slice(0, cap);
}

/**
 * Selection policy for the Intraday Actionable-Quality layer's candidate
 * pool (src/actionable_score.mjs) — DELIBERATELY INDEPENDENT of
 * selectStage2Symbols() above, over the SAME full-universe snapshot.
 *
 * Why a separate function instead of reusing selectStage2Symbols(): that
 * function's top-N slot budget is diluted by always-include (INDEX symbols
 * + active Critical trades) and a fairness-rotation slice that picks
 * oldest-scanned-first rather than by current cheap signal — both correct
 * for Stage-2's own general-scan purpose, but they mean a stock with a
 * genuinely strong CURRENT cheapScore can still miss Stage-2's shortlist on
 * a given cycle for reasons that have nothing to do with its current
 * intraday potential. This function ranks purely by cheapScore (already
 * computed by computeFullUniverseSnapshot for the ENTIRE universe, zero
 * extra fetches — SOURCE = EXISTING LOCAL CODE) so a stock's presence in
 * the Intraday candidate pool depends only on its own current signal, never
 * on whether Stage-2 happened to pick it.
 *
 * This is a CHEAP PRE-FILTER, not a final ranking — callers still run the
 * full deep-analysis pipeline (buildSignal, trade_plan, actionable_score)
 * on whatever this returns; a symbol surviving this filter is not yet an
 * "opportunity," only a candidate worth the expensive analysis.
 */
export function selectIntradayCandidates(snapshot, { topN = 80 } = {}) {
    const eligible = [...snapshot.values()].filter(r =>
        r.sector !== "INDEX" &&           // Intraday ranks individual stocks, not the indices themselves (entry_score.mjs already excludes INDEX rows the same way)
        r.priceFreshness !== "UNAVAILABLE" && // no live price at all yet — nothing to act on
        r.cheapScore > 0                  // BUY-only engine: only genuinely positive current momentum/volume/change signal is worth a deep scan
    );
    return eligible
        .sort((a, b) => b.cheapScore - a.cheapScore)
        .slice(0, topN)
        .map(r => r.symbol);
}
