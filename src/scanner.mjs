import { fetchBulkLtp, fetchBulkQuotes } from "./upstox.mjs";
import { getOrFetchCandles } from "./candle_cache.mjs";
import { isolateTodaySession } from "./session_candles.mjs";
import { ema, macd, rsi, vwap, vwapSeries, historicalVolatility, atr, emaSlopePct } from "./indicators.mjs";
import { analyzeStructure, detectBreakout, detectRetest, detectRejection, detectConsolidation } from "./price_action.mjs";
import { TF_MAP } from "./config.mjs";
import { UNIVERSE, getSector } from "./universe.mjs";
import { getLtpWithFreshness } from "./feed.mjs";
import { historical, UNAVAILABLE, isMarketOpen as _isMarketOpen } from "./data_quality.mjs";

import { fetchDividend, formatDividendInfo } from "./dividend.mjs";
import { enrichOpportunities } from "./entry_score.mjs";
import { computeMarketRegime, regimeMinOpportunityScore } from "./market_regime.mjs";
import { listCriticalTrades } from "./critical_trades.mjs";
import { computeFullUniverseSnapshot, selectStage2Symbols, markDeepScanned } from "./stage1_filter.mjs";
import { captureQualifyingSnapshots } from "./learning_capture.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));

export let state = emptyState();
const prevSigs = new Map();
export let scanning = false;
export let isAuthenticated = false;
export let scanProgress = { done: 0, total: UNIVERSE.length };

export function setIsAuthenticated(val) {
    isAuthenticated = val;
}

// Re-exported so existing importers (screener.mjs, scanner_testing.mjs,
// operator scanners) keep working unchanged — the actual logic now lives in
// data_quality.mjs alongside the freshness-threshold policy that depends on it.
export const isMarketOpen = _isMarketOpen;

export function getState() {
    return state;
}

export function emptyState() {
    const data = {};
    for (const tf of Object.keys(TF_MAP)) { data[`${tf}_BUY`] = []; data[`${tf}_SELL`] = []; data[`${tf}_ALL`] = []; data[`${tf}_GOLDEN`] = []; }
    return { lastUpdated: null, dataAsOf: null, data, errors: [], universe: UNIVERSE.length, marketRegime: null, intradayOpportunities: [] };
}

// The oldest priceTs among rows currently in state — an honest "as of"
// distinct from `lastUpdated` (which just says when the scan cycle synced,
// not how fresh the prices it synced actually are).
function computeDataAsOf(data) {
    let min = Infinity;
    for (const tf of Object.keys(TF_MAP)) {
        for (const row of data[`${tf}_ALL`] || []) {
            if (row.priceTs != null && row.priceTs < min) min = row.priceTs;
        }
    }
    return Number.isFinite(min) ? min : null;
}

/** Replace-or-insert by symbol — buckets are persistent, never rebuilt empty. */
function upsertRow(bucketArray, row) {
    const i = bucketArray.findIndex(r => r.symbol === row.symbol);
    if (i >= 0) bucketArray[i] = row;
    else bucketArray.push(row);
}

/**
 * Cheap, zero-fetch price refresh applied to EVERY row in every bucket after
 * each sync — not just the symbols Stage-2 deep-analyzed this cycle. Keeps
 * `price`/`chgPct`/`priceSource`/`priceTs` honestly current even for a
 * symbol whose indicators (VWAP/EMA/structure/etc, tagged via `candleTs`)
 * weren't refreshed this cycle — those two ages are already exposed
 * separately on every row, so this never hides staleness, it only prevents
 * an already-fresh, free (WebSocket) price signal from being ignored.
 */
function applyLivePriceOverlay(data) {
    for (const tf of Object.keys(TF_MAP)) {
        for (const row of data[`${tf}_ALL`] || []) {
            const fresh = getLtpWithFreshness(row.symbol);
            if (fresh.value == null) continue; // no live tick yet — leave the row at its last known price
            row.price = +fresh.value.toFixed(2);
            row.priceSource = fresh.source;
            row.priceTs = fresh.ts;
            if (row.prevClose) {
                row.priceChange = +(row.price - row.prevClose).toFixed(2);
                row.chgPct = +(((row.price - row.prevClose) / row.prevClose) * 100).toFixed(2);
            }
            if (row.vwap != null) row.aboveVwap = row.price > row.vwap;
        }
    }
}

// Local rateLimit removed in favor of global one in upstox.mjs

export function buildSignal(candles, tf, symbol, ltpFresh = UNAVAILABLE("no ltp arg")) {
    const cls = candles.map(c => c.close).filter(Number.isFinite);
    const vol = candles.map(c => c.volume).filter(Number.isFinite);
    if (cls.length < 55 || vol.length < 15) return null;

    const e9 = ema(cls, 9), e21 = ema(cls, 21), e50 = ema(cls, 50);
    const { macd: ml, signal: sl } = macd(cls, 12, 26, 9);
    const rsiVal = rsi(cls);
    const vwapVal = vwap(candles);
    const hvResult = historicalVolatility(cls, 20);
    const hv = hvResult.value;
    const n = cls.length;

    const c9 = e9[n - 1];
    const c21 = e21[n - 1], p21 = e21[n - 2];
    const c50 = e50[n - 1], p50 = e50[n - 2];
    const cM = ml[n - 1], pM = ml[n - 2];
    const cS = sl[n - 1], pS = sl[n - 2];
    const macdHist = cM !== null && cS !== null ? cM - cS : null;
    const macdHistPrev = pM !== null && pS !== null ? pM - pS : null;
    const macdHistAccel = macdHist !== null && macdHistPrev !== null ? macdHist - macdHistPrev : null;
    const ema9Slope = emaSlopePct(e9, 5);
    const ema21Slope = emaSlopePct(e21, 5);
    const ema50Slope = emaSlopePct(e50, 5);
    const emaBullAligned = c9 !== null && c21 !== null && c50 !== null ? (c9 > c21 && c21 > c50) : null;

    const goldenCross = p21 !== null && p50 !== null && p21 <= p50 && c21 > c50;
    const deathCross = p21 !== null && p50 !== null && p21 >= p50 && c21 < c50;
    const ema21above = c21 > c50;
    const macdBull = pM !== null && pS !== null && pM <= pS && cM > cS;
    const macdBear = pM !== null && pS !== null && pM >= pS && cM < cS;
    const macdAbove = cM !== null && cS !== null && cM > cS;

    const recentVol = vol.slice(-10);
    const avgVol = recentVol.reduce((a, b) => a + b, 0) / recentVol.length;
    const lastVol = vol[vol.length - 1];
    const prevVol = vol[vol.length - 2] || 0;
    const volSpike = lastVol > avgVol * 1.5;

    const last = candles[candles.length - 1];
    const normalizeTs = ts => ts < 10000000000 ? ts * 1000 : ts;
    const lastTs = normalizeTs(last.ts);
    // Never silently substitute a stale candle close for a live price: if no
    // live tick was supplied (or it's itself UNAVAILABLE), the price falls
    // back to the candle close but is explicitly tagged HISTORICAL — never
    // indistinguishable from a genuine live read.
    const priceSource = ltpFresh && ltpFresh.value != null ? ltpFresh : historical(last.close, lastTs);
    const livePrice = priceSource.value;
    const emaGap = c50 ? +(((c21 - c50) / c50) * 100).toFixed(3) : 0;

    let { todayCandles, dayH, dayL, weekH, weekL, h52w, l52w, prevClose, prevDayH, prevDayL } = isolateTodaySession(candles, tf);

    // Fallbacks and incorporating livePrice
    if (dayH === -Infinity) { dayH = Math.max(last.high, livePrice); dayL = Math.min(last.low, livePrice); }
    else { dayH = Math.max(dayH, livePrice); dayL = Math.min(dayL, livePrice); }

    if (weekH === -Infinity) { weekH = dayH; weekL = dayL; }
    if (h52w === -Infinity && tf === "1d") { h52w = dayH; l52w = dayL; }

    const priceChange = livePrice - prevClose;
    const chgPct = (priceChange / prevClose) * 100;

    // ── Intraday-only derived fields: opening strength, ORB, structure ────────
    // Meaningless for tf === "1d" (there is no "session" within a daily bar),
    // so left null there rather than computed from something that isn't
    // actually today's opening range.
    const isIntradayTf = tf !== "1d";
    let dayOpen = null, pctFromOpen = null;
    let orbHigh = null, orbLow = null, orbBrokenAbove = false, orbVolConfirmed = false, orbRetest = { retested: false, held: null, failed: false };
    let structure = { higherHighs: null, higherLows: null, bullishStructure: null, brokeStructure: null, lastSwingHigh: null, lastSwingLow: null, insufficientData: true };
    let rejection = { rejected: false, upperWickRatio: 0 };
    let consolidation = { consolidating: false, rangePct: null };
    let sessionVwap = null, sessionVwapSlope = null, aboveSessionVwap = null;
    let vwapReclaimed = false, vwapReclaimFailed = false;

    if (isIntradayTf && todayCandles.length > 0) {
        dayOpen = todayCandles[0].open;
        pctFromOpen = dayOpen ? ((livePrice - dayOpen) / dayOpen) * 100 : null;

        orbHigh = todayCandles[0].high;
        orbLow = todayCandles[0].low;
        orbBrokenAbove = orbHigh !== null && livePrice > orbHigh;
        const orbBreakoutInfo = detectBreakout(todayCandles, orbHigh);
        orbVolConfirmed = orbBreakoutInfo.volConfirmed;
        if (orbBreakoutInfo.broke) {
            orbRetest = detectRetest(todayCandles, orbHigh, orbBreakoutInfo.barIndex);
        }

        structure = analyzeStructure(todayCandles);
        rejection = detectRejection(todayCandles[todayCandles.length - 1]);
        consolidation = detectConsolidation(todayCandles, 10, 1.5);

        const sessionVwapArr = vwapSeries(todayCandles);
        sessionVwap = sessionVwapArr.length ? sessionVwapArr[sessionVwapArr.length - 1] : null;
        if (sessionVwapArr.length >= 6) {
            const prior = sessionVwapArr[sessionVwapArr.length - 6];
            sessionVwapSlope = prior ? ((sessionVwap - prior) / prior) * 100 / 5 : null;
        }
        aboveSessionVwap = sessionVwap !== null ? livePrice > sessionVwap : null;

        // VWAP reclaim / failed-reclaim: did price dip below session VWAP in
        // the recent window and then recover above it (reclaim), or recover
        // and then lose it again (failed reclaim)? Distinct from just
        // "currently above/below" — a reclaim is stronger evidence of
        // support than having simply never dipped.
        const reclaimLookback = Math.min(10, sessionVwapArr.length - 1);
        let dippedBelowRecently = false;
        for (let k = Math.max(0, todayCandles.length - 1 - reclaimLookback); k < todayCandles.length - 1; k++) {
            if (sessionVwapArr[k] != null && todayCandles[k].close < sessionVwapArr[k]) dippedBelowRecently = true;
        }
        vwapReclaimed = dippedBelowRecently && aboveSessionVwap === true;
        vwapReclaimFailed = dippedBelowRecently && aboveSessionVwap === false;
    }

    const histLen = 60;
    const priceHist = cls.slice(-histLen);
    const ema21Hist = e21.slice(-histLen);
    const ema50Hist = e50.slice(-histLen);

    const aboveVwap = vwapVal !== null && livePrice > vwapVal;

    const checks = {
        "Golden Cross (EMA 21>50)": goldenCross,
        "EMA 21 above 50": ema21above,
        "MACD Bull cross": macdBull,
        "MACD above signal": macdAbove,
        "Vol spike + price up": volSpike && chgPct > 0,
        "RSI healthy (45-75)": rsiVal !== null && rsiVal >= 45 && rsiVal <= 75,
        "Price > VWAP": aboveVwap,
    };

    const redFlags = {
        "Death Cross": deathCross,
        "MACD Bear cross": macdBear,
        "RSI overbought >80": rsiVal !== null && rsiVal > 80,
        "RSI oversold <25": rsiVal !== null && rsiVal < 25,
        "Volume collapsing": lastVol < avgVol * 0.4,
    };

    const techScore = Object.values(checks).filter(Boolean).length;
    const redCount = Object.values(redFlags).filter(Boolean).length;

    let signal = "NONE";
    if (goldenCross) signal = "BUY";
    else if (deathCross) signal = "SELL";
    else if (ema21above && macdBull) signal = "BUY";
    else if (!ema21above && macdBear) signal = "SELL";

    const rating = techScore >= 5 ? "STRONG BUY" : techScore >= 3 ? "MODERATE" : "SKIP";

    return {
        symbol, sector: getSector(symbol), tf, signal,
        goldenCross, deathCross,
        price: Number.isFinite(livePrice) ? +livePrice.toFixed(2) : livePrice,
        open: Number.isFinite(last.open) ? +last.open.toFixed(2) : last.open,
        prevClose: Number.isFinite(prevClose) ? +prevClose.toFixed(2) : prevClose,
        high: Number.isFinite(last.high) ? +last.high.toFixed(2) : last.high,
        low: Number.isFinite(last.low) ? +last.low.toFixed(2) : last.low,
        dayH, dayL, weekH, weekL, h52w, l52w,
        prevDayH: prevDayH !== null ? +prevDayH.toFixed(2) : null,
        prevDayL: prevDayL !== null ? +prevDayL.toFixed(2) : null,
        chgPct: Number.isFinite(chgPct) ? +chgPct.toFixed(2) : chgPct,
        volume: lastVol, volumeChange: lastVol - prevVol, volSpike,
        relativeVolume: avgVol ? +(lastVol / avgVol).toFixed(2) : null,
        ema9: c9 !== null && Number.isFinite(c9) ? +c9.toFixed(2) : null,
        ema21: c21 !== null && Number.isFinite(c21) ? +c21.toFixed(2) : null,
        ema50: c50 !== null && Number.isFinite(c50) ? +c50.toFixed(2) : null,
        ema9Slope, ema21Slope, ema50Slope, emaBullAligned,
        emaGap, ema21above,
        ema21Hist, ema50Hist, priceHist,
        macdBull, macdBear, macdAbove,
        macdVal: cM !== null && Number.isFinite(cM) ? +cM.toFixed(4) : null,
        macdHist: macdHist !== null && Number.isFinite(macdHist) ? +macdHist.toFixed(4) : null,
        macdHistAccel: macdHistAccel !== null && Number.isFinite(macdHistAccel) ? +macdHistAccel.toFixed(4) : null,
        vwap: vwapVal, aboveVwap,
        sessionVwap, sessionVwapSlope, aboveSessionVwap, vwapReclaimed, vwapReclaimFailed,
        rsi: rsiVal,
        checks, redFlags,
        techScore, redCount,
        rating,
        ts: last.ts,
        hv, hvEstimated: hvResult.estimated,
        atr: null, atrPct: null, // filled in by scanSymbol() from the 1d-pass cache
        dayOpen: dayOpen !== null ? +dayOpen.toFixed(2) : null,
        pctFromOpen: pctFromOpen !== null && Number.isFinite(pctFromOpen) ? +pctFromOpen.toFixed(2) : null,
        orb: {
            high: orbHigh !== null ? +orbHigh.toFixed(2) : null,
            low: orbLow !== null ? +orbLow.toFixed(2) : null,
            brokenAbove: orbBrokenAbove,
            volConfirmed: orbVolConfirmed,
            retested: orbRetest.retested, retestHeld: orbRetest.held, retestFailed: orbRetest.failed,
        },
        structure,
        rejection,
        consolidation,
        isNew: false, isNewGolden: false,
        // No `options` field here — the raw optionsCache Map has no
        // freshness guarantee (see OPTIONS_STALE_AFTER_MS). Consumers must
        // call getOptionsCacheWithFreshness(symbol) themselves rather than
        // read a copy stashed on this row, which could go stale between
        // when this row was built and when it's actually read.
        w52H: h52w, w52L: l52w,
        priceChange: +priceChange.toFixed(2),
        dividend: null,
        // Freshness provenance — `ts` stays the candle timestamp (unchanged,
        // for backward compat), but `price`/`chgPct`/dayH/dayL etc. may have
        // come from a separately-sourced live tick of a DIFFERENT age. Expose
        // both real ages explicitly instead of collapsing them into one
        // timestamp that would otherwise silently imply they match.
        priceSource: priceSource.source, priceTs: priceSource.ts, candleTs: lastTs,
    };
}

const w52Cache = new Map();  // symbol -> { w52H, w52L, wroteAt }
const atrCache = new Map();  // symbol -> { atr, atrPct, wroteAt } — computed once on the 1d pass, applied to every tf
const CACHE_MAX_AGE_MS = 26 * 3600 * 1000; // one missed daily refresh — beyond this, stop serving it as current
const symbolErrorCount = new Map(); // Track consecutive errors per symbol
const MAX_CONSECUTIVE_ERRORS = 3; // Skip symbol after this many consecutive errors

/**
 * Full-universe ATR% snapshot for Market Regime's volatility input — reads
 * atrCache directly rather than the (possibly Stage-2-partial) `_ALL`
 * buckets, so regime volatility isn't subject to the same selection-bias
 * risk breadth/VWAP-participation are (see market_regime.mjs).
 */
export function getAtrPctSnapshot() {
    const out = {};
    for (const [symbol, c] of atrCache) {
        if (Date.now() - c.wroteAt < CACHE_MAX_AGE_MS) out[symbol] = c.atrPct;
    }
    return out;
}

async function scanSymbol(symbol, buckets, errors, progressInfo, ltpFresh, { forceRefresh = false } = {}) {
    // Skip symbols with too many consecutive errors (likely invalid symbols)
    const consecutiveErrors = symbolErrorCount.get(symbol) || 0;
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        process.stdout.write(`\r\x1b[K⏭️ Skipping ${symbol} (${consecutiveErrors} consecutive errors)\n`);
        return;
    }

    // Process 1d first to cache the 52-week high/low
    const tfs = Object.keys(TF_MAP).sort((a, b) => a === "1d" ? -1 : (b === "1d" ? 1 : 0));
    let okCount = 0;
    let symbolHadError = false;

    for (const tf of tfs) {
        try {
            // getOrFetchCandles rate-limits internally (upstox.mjs) ONLY on an
            // actual cache miss — an explicit rateLimit() call here would
            // needlessly gate even cache HITS, wasting rate-limit budget for
            // no request at all.
            process.stdout.write(`\r\x1b[K⏳ ${progressInfo} ${symbol}: [${okCount}/${tfs.length}] Scanning ${tf}...`);
            const candles = await getOrFetchCandles(symbol, tf, { forceRefresh });

            // Reset error count on successful fetch
            symbolErrorCount.set(symbol, 0);

            const row = buildSignal(candles, tf, symbol, ltpFresh);
            if (!row) continue;

            if (tf === "1d") {
                w52Cache.set(symbol, { w52H: row.w52H, w52L: row.w52L, wroteAt: Date.now() });
                const dailyAtr = atr(candles, 14);
                const atrPct = dailyAtr !== null && row.price ? (dailyAtr / row.price) * 100 : null;
                atrCache.set(symbol, { atr: dailyAtr !== null ? +dailyAtr.toFixed(2) : null, atrPct: atrPct !== null ? +atrPct.toFixed(2) : null, wroteAt: Date.now() });
                row.atr = atrCache.get(symbol).atr;
                row.atrPct = atrCache.get(symbol).atrPct;
            } else {
                // If a later 1d fetch fails, don't keep perpetuating an
                // arbitrarily old 52W/ATR value forever — past one missed
                // daily refresh, surface it as unavailable instead.
                const cached = w52Cache.get(symbol);
                if (cached && Date.now() - cached.wroteAt < CACHE_MAX_AGE_MS) {
                    row.w52H = cached.w52H;
                    row.w52L = cached.w52L;
                } else {
                    row.w52H = null;
                    row.w52L = null;
                }
                const cachedAtr = atrCache.get(symbol);
                if (cachedAtr && Date.now() - cachedAtr.wroteAt < CACHE_MAX_AGE_MS) {
                    row.atr = cachedAtr.atr;
                    row.atrPct = cachedAtr.atrPct;
                } else {
                    row.atr = null;
                    row.atrPct = null;
                }
            }

            const key = `${symbol}|${tf}`;
            const prev = prevSigs.get(key);
            row.isNew = prev && prev !== row.signal;
            row.isNewGolden = row.goldenCross && row.isNew;
            prevSigs.set(key, row.signal);

            // Buckets are now PERSISTENT (carried forward across cycles, not
            // rebuilt from empty each time — see scanAll()), so this must
            // upsert-by-symbol rather than push, or a symbol scanned in a
            // prior cycle would end up duplicated once re-scanned. `_BUY`/
            // `_SELL`/`_GOLDEN` are derived from `_ALL` in scanAll()'s sync
            // step instead of being pushed to directly here, so a symbol
            // whose signal changed (or dropped out of BUY/SELL) never lingers
            // stale in a derived bucket.
            upsertRow(buckets[`${tf}_ALL`], row);
            okCount++;
        } catch (e) {
            let errMsg = e.response?.data?.message || e.response?.data?.error || e.message;
            if (typeof errMsg === 'object') errMsg = JSON.stringify(errMsg);
            errors.push(`${symbol}/${tf}: ${errMsg}`);
            symbolHadError = true;

            // Check if it's a GA001 error (invalid symbol)
            if (errMsg.includes("GA001") || errMsg.includes("trading symbol")) {
                // Mark as invalid immediately
                symbolErrorCount.set(symbol, MAX_CONSECUTIVE_ERRORS);
                process.stdout.write(`\n\x1b[33m⚠️ Invalid symbol: ${symbol} - will skip in future scans\x1b[0m\n`);
                break; // Stop processing this symbol entirely
            }

            // Force a new line for actual errors so they don't get overwritten
            process.stdout.write(`\n\x1b[31m❌ Error: ${symbol}/${tf} → ${errMsg}\x1b[0m\n`);
        }
    }

    // Update error count for this symbol
    if (symbolHadError) {
        const currentErrors = symbolErrorCount.get(symbol) || 0;
        symbolErrorCount.set(symbol, currentErrors + 1);
    }
}

// Real bid/ask spread (via Upstox's v2 full-quote endpoint — the v3 LTP
// path used everywhere else doesn't carry it), throttled independently of
// how often the periodic sync tick fires — spread doesn't need refreshing
// every ~2s. Previously fetched ONLY for the already-shortlisted Intraday
// Opportunities (~40 symbols), so real spread never reached liquidityGate()'s
// full-universe Opportunity Score — every OTHER scored row only had traded
// value to go on. Now fetched for every Stage-2-scanned symbol this cycle
// (a superset of the opportunities shortlist, since opportunities are
// derived FROM Stage-2 rows) and attached directly to the underlying rows
// BEFORE enrichOpportunities() runs, so entry_score.mjs's liquidityGate()
// can use real spread across the whole deeply-scanned universe, not just
// the shortlist.
let lastQuoteAttemptTs = 0;  // throttles how often we RETRY the fetch
let lastQuoteSuccessTs = 0;  // when lastQuoteMap was actually last refreshed
let lastQuoteMap = {};
const QUOTE_FETCH_INTERVAL_MS = 20000;
const QUOTE_STALE_AFTER_MS = QUOTE_FETCH_INTERVAL_MS * 3; // 3 missed refresh cycles — stop trusting it

async function refreshQuoteMap(symbols) {
    if (!symbols.length) return;
    const now = Date.now();
    if (now - lastQuoteAttemptTs < QUOTE_FETCH_INTERVAL_MS) return;
    lastQuoteAttemptTs = now;
    try {
        lastQuoteMap = await fetchBulkQuotes(symbols);
        lastQuoteSuccessTs = now;
    } catch (e) {
        console.error("[Scanner] Spread fetch failed:", e.message);
        // lastQuoteSuccessTs is intentionally left where it was — a failed
        // fetch must not reset the staleness clock, or a permanently-failing
        // fetch would keep looking "just refreshed."
    }
}

function isQuoteMapStale() {
    return Date.now() - lastQuoteSuccessTs > QUOTE_STALE_AFTER_MS;
}

/** Attach real spreadPct onto every intraday row (5m/15m/30m) for `symbols` — feeds entry_score.mjs's liquidityGate() ahead of enrichOpportunities(). */
function applyRowSpread(dataBuckets, symbols) {
    if (isQuoteMapStale()) return;
    const symbolSet = new Set(symbols);
    for (const tf of ["5m", "15m", "30m"]) {
        for (const row of dataBuckets[`${tf}_ALL`] || []) {
            if (!symbolSet.has(row.symbol)) continue;
            const q = lastQuoteMap[row.symbol];
            if (q?.spreadPct != null) row.spreadPct = q.spreadPct;
        }
    }
}

/** Discount for the already-shortlisted Intraday Opportunities — spread makes a setup less attractive to act on NOW, doesn't invalidate the underlying technical picture. */
function annotateSpread(opportunities) {
    if (!opportunities.length || isQuoteMapStale()) return;
    for (const o of opportunities) {
        const q = lastQuoteMap[o.symbol];
        if (!q || q.spreadPct == null) continue;
        o.spreadPct = q.spreadPct;
        if (q.spreadPct > 0.15) {
            const penalty = Math.min(20, (q.spreadPct - 0.15) * 40);
            o.entryAttractiveness = Math.max(0, Math.round(o.entryAttractiveness - penalty));
            o.notes = [...(o.notes || []), `Spread ${q.spreadPct}% — wider than typical, mind slippage at size`].slice(0, 7);
        }
    }
}

/**
 * Two-stage scan cycle:
 *  Stage 1 — computeFullUniverseSnapshot() (stage1_filter.mjs): ALL 241
 *    symbols, near-zero REST cost (cache reads + free WebSocket LTP).
 *  Stage 2 — deep buildSignal() analysis, but ONLY on selectStage2Symbols()'s
 *    output (indices + active Critical trades + top cheap-score + a fairness
 *    rotation slice) instead of the whole universe — this is what brings a
 *    cycle down from ~20-25 minutes to roughly ~5 minutes.
 * `state.data` buckets are PERSISTENT across cycles (this cycle's `next`
 * starts as a clone of the current `state`, not an empty shell) — a symbol
 * not Stage-2'd this cycle simply keeps its last-known row, already tagged
 * with its real age via `priceTs`/`candleTs`.
 */
export async function scanAll() {
    if (!isAuthenticated || scanning) return;
    scanning = true;
    console.log("Scan started:", new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }));

    const cycleStartedAt = Date.now();
    const stage1StartedAt = Date.now();

    // Stage 1 breadth/participation is deliberately computed from ALL 241
    // symbols here, never from the Stage-2 shortlist below — otherwise Market
    // Regime would be biased toward stocks that already look strong (a
    // regime "confirmed" only by cherry-picked survivors is not a regime
    // reading at all).
    const snapshot = computeFullUniverseSnapshot(UNIVERSE);
    const activeCriticalSymbols = listCriticalTrades().map(t => t.symbol);
    const stage2Symbols = selectStage2Symbols(snapshot, { activeCriticalSymbols });
    const stage1DurationMs = Date.now() - stage1StartedAt;

    scanProgress = {
        done: 0, total: stage2Symbols.length, stage: "stage2", cycleStartedAt,
        stage1DurationMs, stage2DurationMs: null,
        lastCycleDurationMs: scanProgress?.lastCycleDurationMs ?? null,
    };

    const next = { ...emptyState(), data: JSON.parse(JSON.stringify(state.data)) };

    try {
        const sortFn = (a, b) => {
            if (a.goldenCross !== b.goldenCross) return a.goldenCross ? -1 : 1;
            if (b.techScore !== a.techScore) return b.techScore - a.techScore;
            return Math.abs(b.volumeChange) - Math.abs(a.volumeChange);
        };

        // Cloning + sorting the full accumulated state is O(size-so-far) work.
        // Doing it after every single symbol made the whole scan O(n^2) and,
        // since JSON.stringify/parse run synchronously, blocked Node's event
        // loop for longer stretches as the scan progressed — starving HTTP
        // responses and WebSocket handling, which is what made prices/rows
        // appear to "freeze". Throttle the sync to roughly once every 2s
        // (still frequent enough for the UI to see progress), plus always
        // once more on the final symbol.
        const SYNC_INTERVAL_MS = 2000;
        let lastSyncTs = 0;
        const stage2StartedAt = Date.now();

        for (let scanIdx = 0; scanIdx < stage2Symbols.length; scanIdx++) {
            const sym = stage2Symbols[scanIdx];
            const pInfo = `[${scanProgress.done + 1}/${stage2Symbols.length}]`;
            try {
                await scanSymbol(sym, next.data, next.errors, pInfo, getLtpWithFreshness(sym));
                markDeepScanned(sym);
            } catch (e) {
                console.error(`\n❌ Critical error scanning ${sym}:`, e.message);
            }
            scanProgress.done++;

            const now = Date.now();
            const isLast = scanIdx === stage2Symbols.length - 1;
            if (!isLast && now - lastSyncTs < SYNC_INTERVAL_MS) continue;
            lastSyncTs = now;

            // BUY/SELL/GOLDEN are derived fresh from ALL every sync (ALL is
            // the only bucket scanSymbol writes to now, via upsertRow) — a
            // symbol whose signal changed, or that dropped out of BUY/SELL
            // entirely, is never left stale in a derived bucket.
            for (const tf of Object.keys(TF_MAP)) {
                const all = next.data[`${tf}_ALL`];
                next.data[`${tf}_BUY`] = all.filter(r => r.signal === "BUY").sort(sortFn);
                next.data[`${tf}_SELL`] = all.filter(r => r.signal === "SELL").sort(sortFn);
                next.data[`${tf}_GOLDEN`] = all.filter(r => r.goldenCross).sort(sortFn);
                all.sort((a, b) => b.techScore - a.techScore);
            }

            // Free (WebSocket-only) price refresh across EVERY row, not just
            // this cycle's Stage-2 subset — see applyLivePriceOverlay's doc.
            applyLivePriceOverlay(next.data);

            // Real spread for every Stage-2-scanned symbol — BEFORE
            // enrichOpportunities() runs, so liquidityGate() sees real
            // spread across the whole deeply-scanned universe this cycle,
            // not just the ~40-symbol opportunities shortlist (see the
            // comment above refreshQuoteMap's definition).
            await refreshQuoteMap(stage2Symbols);
            applyRowSpread(next.data, stage2Symbols);

            // Cross-sectional passes (need every symbol scanned SO FAR, not
            // the whole universe) run on every periodic sync, not just once
            // at the very end — both the Intraday tab and Critical-trade
            // monitoring should update progressively.
            next.marketRegime = computeMarketRegime(next.data, snapshot, getAtrPctSnapshot());
            const minOppScore = regimeMinOpportunityScore(next.marketRegime);
            next.intradayOpportunities = enrichOpportunities(next.data, minOppScore);
            annotateSpread(next.intradayOpportunities);

            // Learning-layer snapshot capture — stores EVERY qualifying
            // candidate (not just ones you act on), so the statistical
            // layer can learn from what was passed on too, not only from a
            // self-selected subset. Purely additive/optional: never allowed
            // to affect the live scan (see captureQualifyingSnapshots' own
            // try/catch).
            captureQualifyingSnapshots(next.data, next.marketRegime, minOppScore);

            next.lastUpdated = new Date().toISOString();  // when this scan cycle synced — NOT a data-freshness claim
            next.dataAsOf = computeDataAsOf(next.data);    // the actual oldest price timestamp behind what synced
            state = JSON.parse(JSON.stringify(next));

            scanProgress = { ...scanProgress, stage2DurationMs: Date.now() - stage2StartedAt };

            // Critical trades' structural health no longer updates here —
            // critical_monitor.mjs's dedicated ~60s loop is now sole
            // authority for that (see critical_trades.mjs's onCriticalTick).
            // Stage-2 still includes active-critical symbols in its
            // always-include set (stage1_filter.mjs) so their full 7-
            // timeframe `_ALL`-bucket rows stay populated for entry_score/
            // screener — additive, not a second source of truth for health.
        }
        const lastCycleDurationMs = Date.now() - cycleStartedAt;
        scanProgress = { ...scanProgress, stage: "idle", lastCycleDurationMs };
        process.stdout.write(`\r\x1b[K✅ Scan complete | Time: ${new Date().toLocaleTimeString()} | Total Errors: ${state.errors.length} | Regime: ${next.marketRegime?.regime} | Cycle: ${(lastCycleDurationMs / 1000).toFixed(1)}s | Stage-2: ${stage2Symbols.length} symbols\n`);

        // Fetch dividend data in background after scan completes
        fetchDividendsInBackground(next.data);
    } finally { scanning = false; }
}

/**
 * On-demand single-symbol refresh — force-bypasses the candle cache so the
 * result is genuinely current, not whatever happened to be cached. Mutates
 * the live `state.data` buckets directly (a single symbol × 7 timeframes is
 * fast enough that the atomic-snapshot concern the main cycle's clone-and-
 * swap pattern exists for doesn't meaningfully apply here). Meets the
 * "<60s manual refresh" target: 7 sequential force-refreshed fetches with no
 * rate-limit contention from the general scan.
 */
export async function refreshSymbolNow(symbol) {
    const errors = [];
    await scanSymbol(symbol, state.data, errors, `[manual/${symbol}]`, getLtpWithFreshness(symbol), { forceRefresh: true });
    markDeepScanned(symbol);
    return { symbol, errors };
}

// Fetch dividend data for all stocks in background
async function fetchDividendsInBackground(data) {
    try {
        const allStocks = data["1d_ALL"] || [];
        console.log(`\n💰 Fetching dividend data for ${allStocks.length} stocks...`);

        // Fetch dividends in batches of 10 to avoid overwhelming the API
        const batchSize = 10;
        for (let i = 0; i < allStocks.length; i += batchSize) {
            const batch = allStocks.slice(i, i + batchSize);
            const promises = batch.map(async (stock) => {
                try {
                    const dividendData = await fetchDividend(stock.symbol);
                    if (dividendData) {
                        stock.dividend = formatDividendInfo(dividendData, stock.price);
                    }
                } catch (e) {
                    // Silent fail for individual stocks
                }
            });
            await Promise.all(promises);
            console.log(`  💰 Dividend progress: ${Math.min(i + batchSize, allStocks.length)}/${allStocks.length}`);
        }

        // `data` was mutated in place, but `state` was already deep-cloned
        // via JSON.parse(JSON.stringify(next)) back in scanAll() — a value
        // copy, not a reference — so without this, every dividend enrichment
        // above is silently discarded and never reaches served state.
        state = { ...state, data: JSON.parse(JSON.stringify(data)) };
        console.log(`✅ Dividend fetch complete.`);
    } catch (e) {
        console.error("❌ Error fetching dividends:", e.message);
    }
}

// Real ~5-minute general-scan cadence (was "back-to-back forever" — with the
// pre-two-stage full-241-symbol deep scan taking ~20-25 minutes on its own,
// a fixed 30s post-cycle sleep never produced anything close to a 5-minute
// refresh; now that a cycle is ~3-6 minutes, this actually holds).
const CYCLE_INTERVAL_MS = 5 * 60 * 1000;

export async function startScan() {
    while (true) {
        const cycleStart = Date.now();
        try {
            if (isMarketOpen() || state.lastUpdated === null) {
                await scanAll();
            }
        } catch (e) {
            console.error("Critical error in startScan background loop:", e.message);
        }

        const elapsed = Date.now() - cycleStart;
        await sleep(Math.max(5000, CYCLE_INTERVAL_MS - elapsed));
    }
}
