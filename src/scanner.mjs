import { fetchBulkLtp, fetchBulkQuotes } from "./upstox.mjs";
import { getOrFetchCandles, appendTickTo1m, getRecentCandles } from "./candle_cache.mjs";
import { isolateTodaySession } from "./session_candles.mjs";
import { ema, macd, rsi, vwap, vwapSeries, historicalVolatility, atr, emaSlopePct, supertrend } from "./indicators.mjs";
import { analyzeStructure, detectBreakout, detectRetest, detectRejection, detectConsolidation } from "./price_action.mjs";
import { TF_MAP, INTRADAY_PREFILTER_TOP_N, TRIAL_ENABLED, TRIAL_MINUTE_CADENCE_MS, TRIAL_MIN_P_S
REACH_15_PCT, TRIAL_MIN_CONTINUATION, TRIAL_MAX_REVERSAL, TRIAL_MIN_EXPECTED_RETURN_PCT, TRIAL_MIN_RVOL, TRIAL_MIN_CONFIDENCE, TRIAL_MAX_DISPLAY, TRIAL_MIN_SAMPLES } from "./config.mjs";
import { UNIVERSE, getSector } from "./universe.mjs";
import { getLtpWithFreshness } from "./feed.mjs";
import { historical, UNAVAILABLE, isMarketOpen as _isMarketOpen } from "./data_quality.mjs";

import { fetchDividend, formatDividendInfo } from "./dividend.mjs";
import { enrichOpportunities } from "./entry_score.mjs";
import { computeMarketRegime, regimeMinOpportunityScore } from "./market_regime.mjs";
import { listCriticalTrades } from "./critical_trades.mjs";
import { computeFullUniverseSnapshot, selectStage2Symbols, selectIntradayCandidates, markDeepScanned } from "./stage1_filter.mjs";
import { captureQualifyingSnapshots, LEARNING_CAPTURE_MIN_SCORE } from "./learning_capture.mjs";
import { buildQualityList } from "./quality_filter.mjs";
import { attachCalibratedProbabilities } from "./learning_stats.mjs";
import { buildActionableIntraday } from "./actionable_score.mjs";
import { estimate5mByFeatures } from "./short_term_estimator.mjs";

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
    // intradayActionable: null (not [])  distinguishes "not computed yet"
    // (first boot, or before any heartbeat has arrived) from a real "zero
    // candidates cleared the 75+ bar this cycle" result — the frontend
    // treats these differently (see public/ui-renders.mjs's
    // computeIntradayCandidates).
    return { lastUpdated: null, dataAsOf: null, data, errors: [], universe: UNIVERSE.length, marketRegime: null, intradayOpportunities: [], intradayNearMiss: [], intradayMinScore: null, fastMovers: { "5m": [], "10m": [], "15m": [] }, qualityList: { list: [], meta: null }, intradayActionable: null, trialFeed: { generatedAt: null, items: [] } };
}

// ── Intraday tab active-heartbeat ──────────────────────────────────────────
// The Actionable Intraday layer (trade plan + capital-aware position sizing
// + Actionable Quality Score, src/actionable_score.mjs) is the one
// genuinely new, non-trivial per-cycle computation this feature adds —
// everything else it reuses (Opportunity Score, Upside Potential, candle
// cache, Stage-1/Stage-2 scan) already runs every cycle regardless, for
// other tabs. scanner_testing.mjs's POST /api/intraday/heartbeat calls
// markIntradayActive() while the frontend's Intraday tab is visible and
// active; a stale heartbeat means nobody is currently looking at it, so
// this cycle skips recomputing it instead of running it in the background.
let lastIntradayActiveAt = 0;
const INTRADAY_HEARTBEAT_TIMEOUT_MS = 20_000; // a few missed 3s frontend ticks tolerated before treating the tab as inactive
export function markIntradayActive() { lastIntradayActiveAt = Date.now(); }
function isIntradayHeartbeatFresh() { return Date.now() - lastIntradayActiveAt < INTRADAY_HEARTBEAT_TIMEOUT_MS; }

// ... rest of file unchanged (omitted for brevity) ...

// Trial minute worker — lightweight, incremental 1m scanner for NIFTY 500
export async function startTrialMinuteWorker() {
    if (!TRIAL_ENABLED) { console.log('[Trial] Disabled via config'); return; }
    console.log('[Trial] Minute worker starting...');

    while (true) {
        const start = Date.now();
        try {
            if (!isAuthenticated || !isMarketOpen()) {
                // sleep full cadence when not authenticated or market closed
                await sleep(TRIAL_MINUTE_CADENCE_MS);
                continue;
            }

            // 1) Fetch bulk LTP for universe
            let ltpMap = {};
            try {
                ltpMap = await fetchBulkLtp(UNIVERSE);
            } catch (e) {
                console.error('[Trial] fetchBulkLtp failed:', e.message);
                await sleep(TRIAL_MINUTE_CADENCE_MS);
                continue;
            }

            // 2) Fetch bulk quotes (volume/spread) — best-effort, may throw 429 and be rate-limited internally
            let quoteMap = {};
            try {
                quoteMap = await fetchBulkQuotes(UNIVERSE);
            } catch (e) {
                console.warn('[Trial] fetchBulkQuotes failed (continuing without quotes):', e.message);
            }

            const nowTs = Date.now();
            const items = [];

            for (const symbol of UNIVERSE) {
                const price = ltpMap?.[symbol] ?? null;
                const q = quoteMap?.[symbol] ?? {};
                const vol = q?.volume ?? null;
                if (price == null) continue;

                // Append tick to 1m store
                appendTickTo1m(symbol, price, vol, nowTs, TRIAL_1M_HISTORY_BARS);

                // Get recent candles
                const c1 = getRecentCandles(symbol, '1m', 16); // last 16 1m bars
                const c5 = getRecentCandles(symbol, '5m', 6);
                const c15 = getRecentCandles(symbol, '15m', 4);
                if (!c1.length) continue;

                // Basic indicators
                const closes1 = c1.map(c => c.close).filter(Number.isFinite);
                const closes5 = c5.map(c => c.close).filter(Number.isFinite);
                const closes15 = c15.map(c => c.close).filter(Number.isFinite);

                const rsi1 = closes1.length ? rsi(closes1) : null;
                const mac1 = closes1.length ? macd(closes1, 12, 26, 9) : { macd: [], signal: [] };
                const mac5 = closes5.length ? macd(closes5, 12, 26, 9) : { macd: [], signal: [] };
                const mac15 = closes15.length ? macd(closes15, 12, 26, 9) : { macd: [], signal: [] };

                const macdHist1 = (mac1.macd.length && mac1.signal.length) ? (mac1.macd[mac1.macd.length - 1] - mac1.signal[mac1.signal.length - 1]) : null;
                const macdHist5 = (mac5.macd.length && mac5.signal.length) ? (mac5.macd[mac5.macd.length - 1] - mac5.signal[mac5.signal.length - 1]) : null;

                const st1 = c1.length ? supertrend(c1, 10, 3) : { direction: [] };
                const st5 = c5.length ? supertrend(c5, 10, 3) : { direction: [] };
                const st15 = c15.length ? supertrend(c15, 10, 3) : { direction: [] };
                const dir1 = st1.direction[st1.direction.length - 1] ?? null;
                const dir5 = st5.direction[st5.direction.length - 1] ?? null;
                const dir15 = st15.direction[st15.direction.length - 1] ?? null;

                // RVOL: ratio of last 1m vol to avg of prior 10
                const vols1 = c1.map(c => c.volume).filter(v => v != null && Number.isFinite(v));
                const lastVol = vols1.length ? vols1[vols1.length - 1] : null;
                const avgVol = vols1.length > 1 ? (vols1.slice(0, -1).reduce((a,b)=>a+b,0) / Math.max(1, vols1.length - 1)) : null;
                const rvol = lastVol != null && avgVol != null ? +(lastVol / avgVol).toFixed(2) : null;

                // Estimator features
                const features = { symbol, rsi: rsi1, macdHist: macdHist1, relativeVolume: rvol, price, ts: nowTs };
                let est = null;
                try { est = await estimate5mByFeatures(features); } catch (e) { est = { insufficient: true }; }

                const item = {
                    symbol,
                    price: +price.toFixed(2),
                    chg1m: c1.length >= 2 ? +(((c1[c1.length-1].close - c1[c1.length-2].close)/c1[c1.length-2].close)*100).toFixed(2) : null,
                    chg5m: c5.length >= 2 ? +(((c5[c5.length-1].close - c5[Math.max(0,c5.length-2)].close)/ (c5[Math.max(0,c5.length-2)].close || 1))*100).toFixed(2) : null,
                    chg15m: c15.length >= 2 ? +(((c15[c15.length-1].close - c15[Math.max(0,c15.length-2)].close)/ (c15[Math.max(0,c15.length-2)].close || 1))*100).toFixed(2) : null,
                    indicators: {
                        rsi: rsi1 != null ? Math.round(rsi1) : null,
                        macd1: macdHist1 != null ? +macdHist1.toFixed(4) : null,
                        macd5: macdHist5 != null ? +macdHist5.toFixed(4) : null,
                        supertrend1: dir1,
                        supertrend5: dir5,
                        supertrend15: dir15,
                        rvol,
                        lastVol,
                    },
                    estimator: est,
                    sourceTs: nowTs,
                    quote: q,
                };

                // Decide signal (strict rules)
                let signal = 'NO_SIGNAL';
                if (!est || est.insufficient) {
                    signal = 'INSUFFICIENT_DATA';
                } else {
                    const okProb = est.pReach15 >= TRIAL_MIN_P_REACH_15_PCT && est.pContinue >= TRIAL_MIN_CONTINUATION && est.pReversal <= TRIAL_MAX_REVERSAL && (est.expectedReturnPct == null || est.expectedReturnPct >= TRIAL_MIN_EXPECTED_RETURN_PCT) && est.confidence >= TRIAL_MIN_CONFIDENCE && (rvol == null ? false : rvol >= TRIAL_MIN_RVOL);
                    const tfConfirm = dir1 === 'UP' && dir5 === 'UP';
                    const macConfirm = macdHist1 != null && macdHist1 > 0 && macdHist5 != null && macdHist5 > 0;
                    if (okProb && tfConfirm && macConfirm) signal = 'CONTINUE';
                }

                item.signal = signal;
                items.push(item);
            }

            // Ranking: primary pReach15 desc, then pContinue, expectedReturnPct, confidence
            const ranked = items.filter(i => i.estimator && !i.estimator.insufficient).sort((a,b) => {
                const ea = a.estimator, eb = b.estimator;
                if (eb.pReach15 !== ea.pReach15) return eb.pReach15 - ea.pReach15;
                if (eb.pContinue !== ea.pContinue) return eb.pContinue - ea.pContinue;
                const ra = (ea.expectedReturnPct || 0), rb = (eb.expectedReturnPct || 0);
                if (rb !== ra) return rb - ra;
                return eb.confidence - ea.confidence;
            }).slice(0, TRIAL_MAX_DISPLAY);

            state.trialFeed = { generatedAt: new Date().toISOString(), items: ranked };

        } catch (e) {
            console.error('[Trial] Minute worker error:', e.message);
        } finally {
            const elapsed = Date.now() - start;
            const wait = Math.max(0, TRIAL_MINUTE_CADENCE_MS - elapsed);
            await sleep(wait);
        }
    }
}

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
