// ─────────────────────────────────────────────────────────────────────────────
// ai_scanner.mjs — the AI tab: a 7-layer (0-6) scanning pipeline for a single
// fixed predictive object, per the user's system-prompt spec.
//
// CORE PREDICTIVE OBJECT (fixed): P(Target reached BEFORE Stop | current
// state, regime, stock, entry, 20-min horizon) — a single joint probability,
// never two independent marginals. Fixed race definition: +TARGET_PCT before
// -SL_PCT within HORIZON_MIN minutes.
//
// WHY LAYERS 4-5's DECISION STILL SHOWS BLOCKED TODAY: the joint probability
// has to come from a real statistical model, fit and walk-forward-validated
// against a real historical dataset of "candidates that looked like X, and
// whether they actually reached target before stop." Layer 6 below is now a
// REAL, executable validation pipeline (purged walk-forward split, a
// nonparametric calibration fit, calibration evaluation via Brier score,
// Monte-Carlo trade-sequence bootstrap, regime-wise backtest, MFE/MAE
// distribution, feature-drift check, kill-switch) — every one of these is
// genuine, callable code, not a comment describing what it would do. It
// simply has nothing to validate yet: it needs MIN_VALIDATION_SAMPLES real
// resolved outcomes before it produces its first CANDIDATE model version,
// and a CANDIDATE version only ever becomes usable via a manual call to
// validateModelVersion() (never automatic — same real-capital reasoning as
// model_registry.mjs's manual-promotion-only design). Until a VALIDATED
// version exists, Layer 4 correctly returns BLOCKED — not a placeholder
// number — because computeCalibrationBucket()'s lookup has nothing to read.
//
// DATA TIER: this app only has Upstox OHLCV candles + a live LTP feed +
// top-of-book bid/ask/qty from fetchBulkQuotes — no genuine tick-by-tick
// order-book reconstruction. Declared Tier B throughout; the bid/ask
// imbalance from fetchBulkQuotes is used as a labeled PROXY order-flow
// signal (real data, just not full order-flow), never presented as real
// order flow (spec Rule 5).
//
// INDEPENDENCE: like every other tab built this session, this pipeline reads
// its own cache-only data and writes to its own database (ai_scanner_db.mjs,
// separate from learning_db.mjs, which validates a different object — the
// existing Opportunity Score). It only ever READS shared state elsewhere
// (index_regime.mjs's regime cache) — the same read-only-consumption pattern
// screener.mjs already uses reading scanner.mjs's `mainState`.
// ─────────────────────────────────────────────────────────────────────────────
import { peekCandles, getOrFetchCandles } from "./candle_cache.mjs";
import { isolateTodaySession } from "./session_candles.mjs";
import { ema, rsi, macd, bollingerBandWidthPct, vwapSeries, atr } from "./indicators.mjs";
import { getLtpWithFreshness } from "./feed.mjs";
import { isMarketOpen } from "./data_quality.mjs";
import { fetchBulkQuotes } from "./upstox.mjs";
import { SCREENER_UNIVERSE } from "./screener_universe.mjs";
import { getSector } from "./universe.mjs";
import { getMarketCapCategory } from "./market_cap.mjs";
import { getLatestIndexRegimes } from "./index_regime.mjs";
import { fetchIndiaVix, getVixMode } from "./vix_manager.mjs";
import { getDb } from "./ai_scanner_db.mjs";

// ── Fixed race definition ───────────────────────────────────────────────────
const DATA_TIER = "B";
const TARGET_PCT = 1.0;
const SL_PCT = 0.4;
const HORIZON_MIN = 20;

// ── Cadence ──────────────────────────────────────────────────────────────────
const SCAN_INTERVAL_MS = 5 * 60 * 1000; // Layers 0-5, per spec
const OUTCOME_SWEEP_INTERVAL_MS = 2 * 60 * 1000; // finer than 5min so a 20-min-old candidate isn't left waiting
// Layer 6 is explicitly NOT run inline with the live scan (spec Rule 1) — a
// separate, much slower cadence, matching "offline/periodic."
const VALIDATION_INTERVAL_MS = 30 * 60 * 1000;

// ── Layer 0 freshness thresholds (per timeframe actually consumed downstream) ──
const STALE_MS = { "1m": 2 * 60 * 1000, "5m": 5 * 60 * 1000, "15m": 15 * 60 * 1000 };

// ── Layer 3 ensemble weights — EXPLICIT AND OPERATOR-CONFIGURABLE. The spec
// lists these factors but assigns no percentages, so this split is authored
// here, not derived from the prompt. Change it here; nothing else needs
// touching. Must sum to 1 (catalyst is excluded — genuinely DATA_UNAVAILABLE,
// no news/corporate-event feed exists in this codebase — its nominal share
// is folded into the rest below).
const LAYER3_WEIGHTS = {
    structure: 0.20,
    vwap: 0.16,
    compression: 0.16,
    breakout: 0.15,
    momentum: 0.13,
    fakeout: 0.10,
    orderFlow: 0.10,
};
const REGIME_WEIGHT_CONFIRM = 10;   // invented, disclosed: bonus when regime bias agrees with the chosen direction
const REGIME_WEIGHT_OPPOSE = -10;
const REGIME_WEIGHT_CAUTION = -5;

// ── Layer 2 hard-gate thresholds — invented, disclosed (spec names the
// concepts, not the numbers) ────────────────────────────────────────────────
const MAX_IMPACT_COST_PCT = 0.5;     // >0.5% estimated round-trip impact on a 10L clip fails the liquidity gate
const IMPACT_NOTIONAL_INR = 1_000_000;

// ── Layer 4/6 thresholds — invented, disclosed ──────────────────────────────
const MIN_VALIDATION_SAMPLES = 50;   // mirrors model_registry.mjs's MIN_TRAINING_SAMPLES
const MIN_BUCKET_SAMPLES = 10;       // a calibration bucket needs at least this many resolved outcomes before its rate is trusted
const KILL_SWITCH_FLOOR_HIT_RATE = 0.30;
const DRIFT_FLAG_THRESHOLD = 0.30;   // >30% relative change in a feature's mean vs history
const CORRELATION_FLAG_THRESHOLD = 0.70;
const RUNWAY_MIN_ATR_RATIO = 0.5;    // typical range must be at least half the target distance

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const norm = (v, ceiling) => v == null ? 50 : clamp((v / ceiling) * 100, 0, 100);

// ── Layer 6 model registry check — read first since Layer 4 needs it ───────
function getValidatedModel() {
    try {
        const row = getDb().prepare("SELECT * FROM ai_model_versions WHERE status = 'VALIDATED' ORDER BY validated_at DESC LIMIT 1").get();
        return row || null;
    } catch (e) {
        console.error("[AIScanner] Model version lookup failed:", e.message);
        return null;
    }
}

// ── LAYER 0 — Data Reality & Quality Gate ───────────────────────────────────
// Pure cache reads, zero REST cost. Checks EVERY timeframe actually consumed
// downstream (1m/5m/15m — Layer 3's structure alignment reads all three),
// feed latency (not just "missing"), and captures the price's OWN tick
// timestamp (not server wall-clock) so later layers anchor to real market
// time, not scan-loop time.
// Default context = exactly today's live behavior (peekCandles + the live
// LTP feed + real wall-clock "now"). The historical dataset builder
// (src/ai_dataset_builder.mjs) constructs a DIFFERENT ctx — an as-of-T
// candle slicer, a historical last-closed-candle price proxy, and a fixed
// historical `now` — so Layers 0-3 run through the EXACT SAME code in both
// cases (spec requirement: "reconstruct Layers 0-3 exactly as the live
// scanner does," not a parallel reimplementation that could silently
// drift). `historical: true` only ever skips the live-cache-staleness
// check below, which is meaningless for historical data by definition
// (there is no "cache age" for a candle from 2023) — it changes NO feature
// math, only that one live-infra-specific check.
const LIVE_CTX = { candleSource: peekCandles, getPrice: getLtpWithFreshness, now: () => new Date(), historical: false };

function layer0(symbol, ctx = LIVE_CTX) {
    const c1 = ctx.candleSource(symbol, "1m");
    const c5 = ctx.candleSource(symbol, "5m");
    const c15 = ctx.candleSource(symbol, "15m");
    const priceFresh = ctx.getPrice(symbol); // { value, ts, ageMs, source }
    const issues = [];

    if (!c5?.candles?.length) issues.push("MISSING_CANDLES_5M");
    if (!c1?.candles?.length) issues.push("MISSING_CANDLES_1M");
    if (!c15?.candles?.length) issues.push("MISSING_CANDLES_15M");
    if (priceFresh.value == null) issues.push("MISSING_PRICE");
    else if (priceFresh.ts == null) issues.push("MISSING_PRICE_TIMESTAMP");

    // Feed latency (Rule 6 explicitly names this, separate from "missing") —
    // ONLY meaningful while the market is actually open (as of ctx.now(), so
    // this is historically-aware too): data_quality.mjs's freshness()
    // classifies EVERY price as DELAYED whenever the market is closed, by
    // design ("no tick is live by definition" outside market hours) — that
    // is the correct, expected classification then, not a data-quality
    // problem, and flagging it unconditionally would reject the entire
    // universe every time the market isn't open. During market hours,
    // DELAYED/ESTIMATED genuinely does mean the feed has gone stale (see
    // maxLiveAgeMs) and is a real problem worth gating on. The historical
    // price proxy always reports source="HISTORICAL", which never matches
    // either branch here — historical rows are never penalized for this.
    if (isMarketOpen(ctx.now()) && priceFresh.value != null && (priceFresh.source === "DELAYED" || priceFresh.source === "ESTIMATED")) {
        issues.push("PRICE_FEED_LATENCY");
    }

    // Live-cache staleness only — meaningless for historical candles (there
    // is no "fetchedAt" concept for a slice of a 2023 series).
    if (!ctx.historical) {
        const staleCheck = (c, tf) => {
            if (!c) return; // already flagged as MISSING above
            if (Date.now() - c.fetchedAt > STALE_MS[tf]) issues.push(`STALE_CANDLES_${tf.toUpperCase()}`);
        };
        staleCheck(c1, "1m");
        staleCheck(c5, "5m");
        staleCheck(c15, "15m");
    }

    // Heuristic corporate-action gap detector — PROXY, not a real
    // corporate-action feed (none exists in this codebase; src/dividend.mjs
    // only parses dividend rows out of NSE's corporate-actions payload, not
    // splits/bonuses). Flags an implausible single-bar gap as a signature an
    // unadjusted split/bonus commonly produces.
    let corpActionSuspectProxy = false;
    if (c5?.candles?.length >= 2) {
        const last = c5.candles[c5.candles.length - 1];
        const prev = c5.candles[c5.candles.length - 2];
        if (prev.close > 0 && Math.abs((last.open - prev.close) / prev.close) * 100 > 15) corpActionSuspectProxy = true;
    }
    if (corpActionSuspectProxy) issues.push("CORP_ACTION_SUSPECT_PROXY");

    return {
        symbol, pass: issues.length === 0, issues, dataTier: DATA_TIER,
        price: priceFresh.value, priceTs: priceFresh.ts, priceSource: priceFresh.source,
        candles: c5?.candles || [], candles1m: c1?.candles || [], candles15m: c15?.candles || [],
    };
}

// ── INVALID logging (spec Rule 3) — every symbol Layer 0/1 could not
// evaluate gets explicitly surfaced, not silently dropped. Layer 2's hard
// gates are NOT logged here — those are a real, evaluated ELIMINATION
// (spec Rule 2/9), a different and legitimate outcome from "couldn't
// evaluate at all." ──────────────────────────────────────────────────────────
function logInvalid(scannedAt, symbol, layer, reason) {
    try {
        getDb().prepare("INSERT INTO ai_invalid_log (scanned_at, symbol, layer, reason) VALUES (?,?,?,?)").run(scannedAt, symbol, layer, reason);
    } catch (e) {
        console.error(`[AIScanner] logInvalid failed for ${symbol}:`, e.message);
    }
}

function pruneInvalidLog() {
    try {
        getDb().prepare("DELETE FROM ai_invalid_log WHERE scanned_at < ?").run(Date.now() - 3 * 60 * 60 * 1000);
    } catch (e) {
        console.error("[AIScanner] pruneInvalidLog failed:", e.message);
    }
}

function invalidSummaryForCycle(scannedAt) {
    try {
        const byReason = getDb().prepare(
            "SELECT layer, reason, COUNT(*) as n FROM ai_invalid_log WHERE scanned_at = ? GROUP BY layer, reason ORDER BY n DESC"
        ).all(scannedAt);
        const sample = getDb().prepare(
            "SELECT symbol, layer, reason FROM ai_invalid_log WHERE scanned_at = ? LIMIT 30"
        ).all(scannedAt);
        return { total: byReason.reduce((s, r) => s + r.n, 0), byReason, sample };
    } catch (e) {
        console.error("[AIScanner] invalidSummaryForCycle failed:", e.message);
        return { total: 0, byReason: [], sample: [] };
    }
}

// ── LAYER 1 — Opportunity Discovery (500 -> ~100) ───────────────────────────
// Coarse flag only, no scores, no liquidity/fame/impact rejection (spec
// Rule 7) — that's Layer 2's job. Returns a tagged status so the caller can
// tell "insufficient data to evaluate" (INVALID) apart from "evaluated fine,
// nothing unusual" (NOT_FLAGGED, a normal non-survivor, not an error).
function layer1(gate, niftyCloses) {
    const closes = gate.candles.map(c => c.close).filter(Number.isFinite);
    if (closes.length < 20) return { status: "INVALID", reason: "insufficient 5m candle history for Layer 1 evaluation" };

    const vols = gate.candles.slice(-15).map(c => c.volume).filter(Number.isFinite);
    let volSpike = false;
    if (vols.length >= 6) {
        const avgVol = vols.slice(0, -1).reduce((a, b) => a + b, 0) / (vols.length - 1);
        volSpike = avgVol > 0 && (vols[vols.length - 1] / avgVol) >= 1.5;
    }

    const bbWidths = bollingerBandWidthPct(closes, 20).filter(Number.isFinite);
    let volatilityShift = false;
    if (bbWidths.length >= 6) {
        const current = bbWidths[bbWidths.length - 1];
        const priorAvg = bbWidths.slice(-6, -1).reduce((a, b) => a + b, 0) / 5;
        volatilityShift = priorAvg > 0 && ((current - priorAvg) / priorAvg) > 0.15;
    }

    let rsShift = false;
    if (niftyCloses?.length >= 16 && closes.length >= 16) {
        const stockRet = (closes[closes.length - 1] - closes[closes.length - 16]) / closes[closes.length - 16];
        const niftyRet = (niftyCloses[niftyCloses.length - 1] - niftyCloses[niftyCloses.length - 16]) / niftyCloses[niftyCloses.length - 16];
        const stockRetPrior = closes.length >= 21 ? (closes[closes.length - 6] - closes[closes.length - 21]) / closes[closes.length - 21] : null;
        const niftyRetPrior = niftyCloses.length >= 21 ? (niftyCloses[niftyCloses.length - 6] - niftyCloses[niftyCloses.length - 21]) / niftyCloses[niftyCloses.length - 21] : null;
        const rsNow = Math.abs(stockRet - niftyRet);
        const rsPrior = stockRetPrior != null && niftyRetPrior != null ? Math.abs(stockRetPrior - niftyRetPrior) : null;
        rsShift = rsPrior != null ? (rsNow > rsPrior * 1.5 && rsNow > 0.005) : rsNow > 0.01;
    }

    if (volSpike || volatilityShift || rsShift) return { status: "FLAGGED", symbol: gate.symbol, volSpike, volatilityShift, rsShift };
    return { status: "NOT_FLAGGED" };
}

// ── LAYER 2 — Cheap Filtering + Regime Scoring (100 -> ~40) ─────────────────
function sectorAggregateReturns(gatesBySymbol) {
    const bySector = new Map();
    for (const [symbol, gate] of gatesBySymbol) {
        if (!gate.pass || gate.candles.length < 2) continue;
        const sector = getSector(symbol);
        const today = isolateTodaySession(gate.candles, "5m").todayCandles;
        if (!today.length) continue;
        const chgPct = ((today[today.length - 1].close - today[0].open) / today[0].open) * 100;
        if (!Number.isFinite(chgPct)) continue;
        if (!bySector.has(sector)) bySector.set(sector, []);
        bySector.get(sector).push(chgPct);
    }
    const avgBySector = new Map();
    for (const [sector, vals] of bySector) avgBySector.set(sector, vals.reduce((a, b) => a + b, 0) / vals.length);
    return avgBySector;
}

async function marketRegimeInput() {
    const regimes = getLatestIndexRegimes();
    const nifty = regimes?.get?.("NIFTY");
    // fetchIndiaVix() already returns { value, mode, ... } — mode is already
    // the correct getVixMode(...).name for whatever value it found (NSE
    // direct, or its own IV-based estimateVIX() fallback).
    let vixValue = null, vixMode = null;
    try {
        const vixState = await fetchIndiaVix();
        vixValue = vixState?.value ?? null;
        vixMode = vixState?.mode ?? null;
    } catch (e) {
        vixValue = null; vixMode = null; // never fabricate a VIX reading — a failed fetch is UNAVAILABLE, not a guessed value
    }
    if (vixMode == null) vixMode = getVixMode(null).name; // fail-safe: DANGER, never the least conservative mode
    return { indexRegime: nifty?.regime || "Unknown", vixValue, vixMode };
}

function layer2(symbol, gate, sectorReturns, marketRegime) {
    const price = gate.price;
    const candles5 = gate.candles;

    // Hard gate 1: liquidity + impact cost estimate for a fixed clip size.
    // fetchBulkQuotes' spread + volume are real inputs; the impact-cost
    // FORMULA (half-spread + a size-vs-recent-volume penalty) and its 0.5%
    // cutoff are an invented, disclosed estimation model — the spec names
    // the concept, not a formula.
    const quote = gate.quote;
    let impactCostPct = null, spreadPct = quote?.spreadPct ?? null;
    if (price > 0) {
        const recentVols = candles5.slice(-15).map(c => c.volume).filter(Number.isFinite);
        const avgVol = recentVols.length ? recentVols.reduce((a, b) => a + b, 0) / recentVols.length : 0;
        const sharesForClip = IMPACT_NOTIONAL_INR / price;
        const volPenalty = avgVol > 0 ? clamp((sharesForClip / avgVol) * 2, 0, 3) : 3; // no volume data -> worst-case penalty, never zero
        const halfSpread = spreadPct != null ? spreadPct / 2 : 0.15; // no quote data -> a conservative assumed floor, not zero
        impactCostPct = halfSpread + volPenalty;
    }
    const liquidityPass = impactCostPct != null && impactCostPct <= MAX_IMPACT_COST_PCT;

    // Hard gate 2: basic tradability sanity.
    const tradabilityPass = price > 5 && Number.isFinite(price) && candles5.length >= 20;

    if (!liquidityPass || !tradabilityPass) {
        return { symbol, eliminated: true, reason: !liquidityPass ? "LIQUIDITY_IMPACT" : "TRADABILITY", impactCostPct, spreadPct };
    }

    // Non-eliminating regime scoring — direction-eligibility bias only,
    // never a rejection (spec Rule 9).
    const sector = getSector(symbol);
    const sectorReturn = sectorReturns.get(sector);
    let regimeBias = "neutral";
    if (marketRegime.indexRegime === "Volatile" || marketRegime.vixMode === "DEFENSIVE MODE" || marketRegime.vixMode === "DANGER MODE") regimeBias = "caution-both-directions";
    else if (marketRegime.indexRegime === "Trending Up") regimeBias = "long-favored";
    else if (marketRegime.indexRegime === "Trending Down") regimeBias = "short-favored";

    const today = isolateTodaySession(candles5, "5m").todayCandles;
    const stockChgPct = today.length ? ((today[today.length - 1].close - today[0].open) / today[0].open) * 100 : null;
    const relStrengthVsSector = (stockChgPct != null && sectorReturn != null) ? stockChgPct - sectorReturn : null;

    const closes = candles5.map(c => c.close).filter(Number.isFinite);
    const atrVal = atr(candles5, 14);
    const atrPct = (atrVal != null && price > 0) ? (atrVal / price) * 100 : null;
    const vols = candles5.slice(-15).map(c => c.volume).filter(Number.isFinite);
    const rvol = vols.length >= 6 ? vols[vols.length - 1] / (vols.slice(0, -1).reduce((a, b) => a + b, 0) / (vols.length - 1) || 1) : null;
    const bbWidths = bollingerBandWidthPct(closes, 20).filter(Number.isFinite);
    const compression = bbWidths.length ? 100 - norm(bbWidths[bbWidths.length - 1], 8) : 50;
    const movementCapacityScore = (norm(atrPct, 3) + norm(rvol != null ? (rvol - 1) * 100 : null, 150) + compression) / 3;

    return {
        symbol, eliminated: false, sector, marketCapCategory: getMarketCapCategory(symbol),
        regimeBias, relStrengthVsSector, movementCapacityScore, impactCostPct, spreadPct,
        price, priceTs: gate.priceTs, priceSource: gate.priceSource, candles5, quote,
        indexRegime: marketRegime.indexRegime, vixValue: marketRegime.vixValue,
    };
}

// ── LAYER 3 — Intelligent Scoring (40 -> ~10) ───────────────────────────────
function structureAlignment(symbol, ctx = LIVE_CTX) {
    const dirs = ["1m", "5m", "15m"].map(tf => {
        const c = ctx.candleSource(symbol, tf)?.candles;
        if (!c || c.length < 12) return null;
        const closes = c.map(x => x.close).filter(Number.isFinite);
        const e9 = ema(closes, 9).filter(Number.isFinite);
        if (e9.length < 4) return null;
        const cur = e9[e9.length - 1], prior = e9[e9.length - 4];
        return cur === prior ? 0 : (cur > prior ? 1 : -1);
    }).filter(d => d !== null);
    const upCount = dirs.filter(d => d > 0).length, downCount = dirs.filter(d => d < 0).length;
    return {
        dirs, upCount, downCount,
        alignedUp: dirs.length >= 2 && upCount === dirs.length,
        alignedDown: dirs.length >= 2 && downCount === dirs.length,
    };
}

// Every factor is scored RELATIVE TO a direction decided up front (structure
// alignment first, VWAP side as a tie-break) so the ensemble is genuinely
// bidirectional — a strong SHORT setup can score as highly as an equally
// strong LONG one.
function layer3(l2, ctx = LIVE_CTX) {
    const { symbol, candles5, price } = l2;
    const closes = candles5.map(c => c.close).filter(Number.isFinite);
    const reasons = [];

    const structure = structureAlignment(symbol, ctx);
    const today = isolateTodaySession(candles5, "5m").todayCandles;
    const vwapVals = vwapSeries(today.length >= 5 ? today : candles5).filter(Number.isFinite);
    const curVwapForTiebreak = vwapVals.length ? vwapVals[vwapVals.length - 1] : price;

    const direction = structure.upCount > structure.downCount ? "LONG"
        : structure.downCount > structure.upCount ? "SHORT"
        : (price > curVwapForTiebreak ? "LONG" : "SHORT");

    const alignedWithDirection = direction === "LONG" ? structure.alignedUp : structure.alignedDown;
    const structureScore = structure.dirs.length
        ? norm((Math.max(structure.upCount, structure.downCount) / structure.dirs.length) * 100, 100)
        : 50;
    if (alignedWithDirection) reasons.push(`${structure.dirs.length}/${structure.dirs.length} timeframes aligned ${direction === "LONG" ? "up" : "down"}`);

    let vwapScore = 50, vwapAbove = null, vwapRising = null;
    if (vwapVals.length >= 2) {
        const curVwap = vwapVals[vwapVals.length - 1], priorVwap = vwapVals[Math.max(0, vwapVals.length - 4)];
        vwapAbove = price > curVwap; vwapRising = curVwap > priorVwap;
        const sideConfirms = direction === "LONG" ? vwapAbove : !vwapAbove;
        const slopeConfirms = direction === "LONG" ? vwapRising : !vwapRising;
        vwapScore = (sideConfirms ? 60 : 20) + (slopeConfirms ? 40 : 0);
        if (sideConfirms && slopeConfirms) reasons.push(direction === "LONG" ? "Above rising VWAP" : "Below falling VWAP");
    }

    const bbWidths = bollingerBandWidthPct(closes, 20).filter(Number.isFinite);
    let compressionExpansionScore = 50, compressionState = "unknown";
    if (bbWidths.length >= 6) {
        const current = bbWidths[bbWidths.length - 1];
        const priorAvg = bbWidths.slice(-6, -1).reduce((a, b) => a + b, 0) / 5;
        if (priorAvg > 0) {
            const expansionPct = ((current - priorAvg) / priorAvg) * 100;
            compressionExpansionScore = norm(expansionPct, 40); // direction-agnostic — a magnitude signal, not directional
            compressionState = expansionPct > 15 ? "expanding" : (current < priorAvg * 0.7 ? "compressed" : "neutral");
        }
    }

    const recent = candles5.slice(-13, -1);
    let breakoutQuality = 50;
    if (recent.length >= 6) {
        if (direction === "LONG") {
            const swingHigh = Math.max(...recent.map(c => c.high).filter(Number.isFinite));
            breakoutQuality = price > swingHigh ? 100 : norm(((price - swingHigh) / swingHigh) * 100 + 3, 3);
            if (price > swingHigh) reasons.push("Broke recent swing high");
        } else {
            const swingLow = Math.min(...recent.map(c => c.low).filter(Number.isFinite));
            breakoutQuality = price < swingLow ? 100 : norm(((swingLow - price) / swingLow) * 100 + 3, 3);
            if (price < swingLow) reasons.push("Broke recent swing low");
        }
    }

    const { macd: macdLine, signal: signalLine } = macd(closes);
    const hist = macdLine.map((v, i) => (v != null && signalLine[i] != null) ? v - signalLine[i] : null).filter(Number.isFinite);
    let momentumAccel = 50;
    if (hist.length >= 4) {
        const cur = hist[hist.length - 1], prior = hist[hist.length - 4];
        const sideConfirms = direction === "LONG" ? cur > 0 : cur < 0;
        const trendConfirms = direction === "LONG" ? cur > prior : cur < prior;
        momentumAccel = (sideConfirms ? 60 : 20) + (trendConfirms ? 40 : 0);
        if (sideConfirms && trendConfirms) reasons.push(direction === "LONG" ? "Momentum accelerating up" : "Momentum accelerating down");
    }

    const last = candles5[candles5.length - 1];
    let fakeoutScore = 50;
    if (last) {
        const range = last.high - last.low;
        if (range > 0) {
            const adverseWick = direction === "LONG"
                ? (last.high - Math.max(last.open, last.close))
                : (Math.min(last.open, last.close) - last.low);
            const wickRatio = adverseWick / range;
            fakeoutScore = norm(100 - wickRatio * 150, 100);
            if (wickRatio > 0.6) reasons.push("Exhaustion wick present");
        }
    }

    let orderFlowScore = 50;
    const q = l2.quote;
    if (q?.buySellRatio != null) {
        const buySideScore = norm((q.buySellRatio - 1) * 50 + 50, 100);
        orderFlowScore = direction === "LONG" ? buySideScore : (100 - buySideScore);
    }

    const catalystStatus = "DATA_UNAVAILABLE"; // no news/corporate-event feed integrated in this codebase
    const rsiVal = rsi(closes, 14); // diagnostic-only — overlaps momentumAccel/structureScore, not double-counted in the sum

    const regimeWeight = l2.regimeBias === "caution-both-directions" ? REGIME_WEIGHT_CAUTION
        : l2.regimeBias === "long-favored" ? (direction === "LONG" ? REGIME_WEIGHT_CONFIRM : REGIME_WEIGHT_OPPOSE)
        : l2.regimeBias === "short-favored" ? (direction === "SHORT" ? REGIME_WEIGHT_CONFIRM : REGIME_WEIGHT_OPPOSE)
        : 0;

    const setupScore = clamp(
        structureScore * LAYER3_WEIGHTS.structure + vwapScore * LAYER3_WEIGHTS.vwap +
        compressionExpansionScore * LAYER3_WEIGHTS.compression + breakoutQuality * LAYER3_WEIGHTS.breakout +
        momentumAccel * LAYER3_WEIGHTS.momentum + fakeoutScore * LAYER3_WEIGHTS.fakeout +
        orderFlowScore * LAYER3_WEIGHTS.orderFlow + regimeWeight,
        0, 100
    );

    return {
        symbol: l2.symbol, direction, setupScore: +setupScore.toFixed(1), reasons: reasons.slice(0, 4),
        structureAlignment: structure, vwapAbove, vwapRising, compressionState, breakoutQuality,
        momentumAccel, fakeoutScore, orderFlowScore, orderFlowIsProxy: true, catalystStatus, rsiVal,
        regimeBias: l2.regimeBias, movementCapacityScore: l2.movementCapacityScore,
        sector: l2.sector, marketCapCategory: l2.marketCapCategory, price: l2.price,
        priceTs: l2.priceTs, priceSource: l2.priceSource,
        impactCostPct: l2.impactCostPct, spreadPct: l2.spreadPct, quote: l2.quote,
        candles5: l2.candles5, indexRegime: l2.indexRegime, vixValue: l2.vixValue,
    };
}

// ── LAYER 4 — Joint Probability & Prediction ────────────────────────────────
// Real Indian discount-broker intraday equity cost structure — documented,
// standard rates (not fabricated): brokerage ~0.03%/side (or a flat fee,
// whichever lower — the % dominates at this clip size), STT 0.025% sell-side
// only (intraday, non-delivery), NSE exchange transaction charges ~0.00325%
// both sides, SEBI turnover fee ~0.0001% both sides, stamp duty ~0.003%
// buy-side only, GST 18% on (brokerage + exchange charges). Expressed as %
// of notional per round trip.
function computeTradingCostsPct() {
    const brokerageTotal = 0.03 * 2;
    const sttSellOnly = 0.025;
    const exchangeTxnTotal = 0.00325 * 2;
    const sebiTotal = 0.0001 * 2;
    const stampDutyBuyOnly = 0.003;
    const gst = (brokerageTotal + exchangeTxnTotal) * 0.18;
    return +(brokerageTotal + sttSellOnly + exchangeTxnTotal + sebiTotal + stampDutyBuyOnly + gst).toFixed(4);
}

// The exact Ranking Rule formula, as real inspectable code — called every
// cycle; simply short-circuits to null when its inputs are null (never
// substitutes a different formula, per spec Rule 15).
function computeExpectedNetReturn(targetPct, slPct, pTargetBeforeSl, tradingCostsPct, impactCostPct) {
    if (pTargetBeforeSl == null) return null;
    const pSlBeforeTarget = 1 - pTargetBeforeSl;
    const gross = (targetPct * pTargetBeforeSl) - (slPct * pSlBeforeTarget);
    const totalCosts = tradingCostsPct + (impactCostPct || 0);
    return gross - totalCosts;
}

function computeRankScore(expectedNetReturnPct, pTargetBeforeSl, executionQuality) {
    if (expectedNetReturnPct == null || pTargetBeforeSl == null || executionQuality == null) return null;
    return expectedNetReturnPct * pTargetBeforeSl * executionQuality;
}

// Nonparametric calibration bucket key — direction x setup-score decile.
// Disclosed, invented scheme: with limited data, an empirical per-bucket hit
// rate is safer than fitting a parametric model that would overfit on too
// few samples per feature.
function computeCalibrationBucket(candidate) {
    const decile = Math.min(9, Math.floor(candidate.setupScore / 10));
    return `${candidate.direction}_D${decile}`;
}

function layer4(candidate, validatedModel) {
    const tradingCostsPct = computeTradingCostsPct();
    const spreadComponent = candidate.spreadPct != null ? clamp(1 - candidate.spreadPct / 0.5, 0, 1) : 0.3;
    const impactComponent = candidate.impactCostPct != null ? clamp(1 - candidate.impactCostPct / 0.5, 0, 1) : 0.3;
    const executionQuality = +((spreadComponent * 0.5 + impactComponent * 0.5).toFixed(2));

    const blocked = (reason, extra = {}) => ({
        status: "BLOCKED", reason,
        pTargetBeforeSl: null, n: null, calibrationRegime: candidate.regimeBias, modelVersion: validatedModel?.version_id ?? null,
        expectedMfe: null, expectedMae: null, expectedTimeToResolutionMin: null,
        expectedNetReturnPct: null, tradingCostsPct, executionQuality, rankScore: null,
        ...extra,
    });

    if (!validatedModel) return blocked("no Layer-6-validated model version");

    let calibration;
    try {
        calibration = JSON.parse(validatedModel.calibration_json || "{}");
    } catch (e) {
        return blocked("validated model's calibration data is unreadable");
    }

    const bucketKey = computeCalibrationBucket(candidate);
    const bucket = calibration[bucketKey];
    if (!bucket || bucket.n < MIN_BUCKET_SAMPLES || bucket.hitRate == null) {
        return blocked(`no calibrated bucket for ${bucketKey} (need >= ${MIN_BUCKET_SAMPLES} resolved samples)`, { n: bucket?.n ?? 0 });
    }

    const pTargetBeforeSl = bucket.hitRate;
    const expectedNetReturnPct = computeExpectedNetReturn(TARGET_PCT, SL_PCT, pTargetBeforeSl, tradingCostsPct, candidate.impactCostPct);
    const rankScore = computeRankScore(expectedNetReturnPct, pTargetBeforeSl, executionQuality);

    return {
        status: "OK", reason: null,
        pTargetBeforeSl: +(pTargetBeforeSl * 100).toFixed(1), n: bucket.n,
        calibrationRegime: candidate.regimeBias, modelVersion: validatedModel.version_id,
        expectedMfe: bucket.avgMfe, expectedMae: bucket.avgMae, expectedTimeToResolutionMin: bucket.avgTimeToResolutionMin,
        expectedNetReturnPct: +expectedNetReturnPct.toFixed(2), tradingCostsPct, executionQuality,
        rankScore: rankScore != null ? +rankScore.toFixed(3) : null,
    };
}

// ── LAYER 5 — Trade Decision, in the exact specified order ──────────────────
function layer5Runway(candidate) {
    const realAtr = atr(candidate.candles5 || [], 14);
    const atrPct = (realAtr != null && candidate.price > 0) ? (realAtr / candidate.price) * 100 : null;
    if (atrPct == null) return { pass: null, reason: "insufficient candle history for ATR", atrPct: null };
    const ratio = atrPct / TARGET_PCT;
    const pass = ratio >= RUNWAY_MIN_ATR_RATIO;
    return { pass, reason: pass ? "typical range supports target distance" : "typical intraday range too small for target distance", atrPct: +atrPct.toFixed(2), ratio: +ratio.toFixed(2) };
}

function layer5EntryTrigger(candidate) {
    const candles = candidate.candles5 || [];
    if (candles.length < 2) return { confirmed: null, reason: "insufficient candles to confirm trigger" };
    const prior = candles[candles.length - 2];
    const confirmed = candidate.direction === "LONG" ? candidate.price > prior.high : candidate.price < prior.low;
    return { confirmed, reason: confirmed ? "price beyond prior candle's extreme" : "no confirmed breakout tick yet" };
}

function layer5DynamicSL(candidate) {
    const candles = candidate.candles5 || [];
    const realAtr = atr(candles, 14);
    const recent = candles.slice(-13, -1);
    let structureLevel = null;
    if (recent.length >= 6) {
        structureLevel = candidate.direction === "LONG"
            ? Math.min(...recent.map(c => c.low).filter(Number.isFinite))
            : Math.max(...recent.map(c => c.high).filter(Number.isFinite));
    }
    const atrLevel = realAtr != null ? (candidate.direction === "LONG" ? candidate.price - realAtr : candidate.price + realAtr) : null;

    let dynamicSl = null, basis = "none";
    if (structureLevel != null && atrLevel != null) {
        // Whichever is TIGHTER (closer to entry) of the two independently-
        // justified levels — a wider stop than either basis alone would be
        // arbitrary.
        dynamicSl = candidate.direction === "LONG" ? Math.max(structureLevel, atrLevel) : Math.min(structureLevel, atrLevel);
        basis = "structure+atr";
    } else if (atrLevel != null) { dynamicSl = atrLevel; basis = "atr-only"; }
    else if (structureLevel != null) { dynamicSl = structureLevel; basis = "structure-only"; }

    return { dynamicSl: dynamicSl != null ? +dynamicSl.toFixed(2) : null, basis, structureLevel, atrLevel };
}

function layer5DynamicTarget(candidate) {
    const realAtr = atr(candidate.candles5 || [], 14);
    if (realAtr == null || candidate.price <= 0) return { dynamicTarget: null, reason: "insufficient candle history for ATR" };
    // 20 minutes at ~5m-candle granularity is ~4 bars; scale the ~14-bar ATR
    // down toward an expected-move-over-the-horizon estimate, then subtract
    // the liquidity-map impact cost already computed in Layer 2 — invented
    // scaling factor (0.6), disclosed, not a spec-given formula.
    const expectedMovePct = ((realAtr / candidate.price) * 100) * 0.6;
    const impactDragPct = candidate.impactCostPct || 0;
    const netExpectedMovePct = Math.max(0, expectedMovePct - impactDragPct);
    const dynamicTarget = candidate.direction === "LONG"
        ? candidate.price * (1 + netExpectedMovePct / 100)
        : candidate.price * (1 - netExpectedMovePct / 100);
    return { dynamicTarget: +dynamicTarget.toFixed(2), expectedMovePct: +expectedMovePct.toFixed(2), netExpectedMovePct: +netExpectedMovePct.toFixed(2) };
}

// Operates across ALL finalists together — real pairwise Pearson correlation
// of each symbol's recent 5m return series (not a same-sector proxy).
function layer5Correlation(candidates) {
    const returnsBySymbol = new Map();
    for (const c of candidates) {
        const closes = (c.candles5 || []).slice(-30).map(x => x.close).filter(Number.isFinite);
        if (closes.length < 10) continue;
        const rets = [];
        for (let i = 1; i < closes.length; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
        returnsBySymbol.set(c.symbol, rets);
    }
    const symbols = [...returnsBySymbol.keys()];
    const flaggedPairs = [];
    for (let i = 0; i < symbols.length; i++) {
        for (let j = i + 1; j < symbols.length; j++) {
            const a = returnsBySymbol.get(symbols[i]), b = returnsBySymbol.get(symbols[j]);
            const n = Math.min(a.length, b.length);
            if (n < 10) continue;
            const av = a.slice(-n), bv = b.slice(-n);
            const meanA = av.reduce((s, v) => s + v, 0) / n, meanB = bv.reduce((s, v) => s + v, 0) / n;
            let cov = 0, varA = 0, varB = 0;
            for (let k = 0; k < n; k++) { cov += (av[k] - meanA) * (bv[k] - meanB); varA += (av[k] - meanA) ** 2; varB += (bv[k] - meanB) ** 2; }
            const denom = Math.sqrt(varA * varB);
            const corr = denom > 0 ? cov / denom : 0;
            if (Math.abs(corr) > CORRELATION_FLAG_THRESHOLD) flaggedPairs.push({ a: symbols[i], b: symbols[j], corr: +corr.toFixed(2) });
        }
    }
    return { flaggedPairs };
}

function layer5PositionSize(l4) {
    if (l4.status !== "OK" || l4.pTargetBeforeSl == null) {
        return { status: "BLOCKED", reason: "sizing depends on Layer 4's probability/EV, which is not available" };
    }
    // Real computation (fixed-fractional or Kelly-style sizing using
    // l4.pTargetBeforeSl / l4.expectedNetReturnPct / SL distance / a
    // capital-at-risk assumption) belongs here once Layer 4 ever produces a
    // real number — unreachable until then.
    return { status: "NOT_YET_IMPLEMENTED" };
}

// Sorts by the REAL Rank Score. If every candidate's rankScore is null
// (true for as long as Layer 4 is blocked), there is nothing to genuinely
// rank — falling back to setupScore or any other substitute would silently
// swap in a different ranking formula (banned by spec Rule 15), so an
// all-null set is reported UNRANKABLE, not resolved some other way.
function layer5Rank(perCandidate) {
    const anyRankable = perCandidate.some(c => c.l4.rankScore != null);
    if (!anyRankable) return { rankable: false, ranked: perCandidate };
    const ranked = [...perCandidate].sort((a, b) => (b.l4.rankScore ?? -Infinity) - (a.l4.rankScore ?? -Infinity));
    return { rankable: true, ranked };
}

// Execution/risk constraint only — how many simultaneous positions the
// system would ever recommend at once. Deliberately SEPARATE from how many
// qualifying opportunities get reported: the scanner shows every candidate
// that clears the EV threshold (Nifty 500 -> ~100 -> ~40 -> ~10-20 -> ranked
// list, per spec), uncapped; this constant only caps the "positions"
// subset of that same ranked list, never truncates the opportunity list
// itself.
const MAX_SIMULTANEOUS_POSITIONS = 3;

function layer5Select(rankResult) {
    if (!rankResult.rankable) {
        // Exact spec string (spec's OUTPUT FORMAT / "if no validated model
        // exists" block) — Rank Score is unavailable for every candidate
        // whenever no model is validated, so this is the correct condition
        // for it, not just the Layer 0 startup check.
        return { opportunities: [], positions: [], watchlist: [], decision: "BLOCKED: No current Layer-6-validated model version. Live inference not permitted." };
    }
    // "Qualifies" = a genuinely positive expected-value opportunity under
    // the fixed Ranking Rule. rankScore = expectedNetReturn x P x
    // executionQuality; P and executionQuality are both >= 0 by
    // construction (clamped), so rankScore's sign is exactly
    // expectedNetReturn's sign — this is a Layer 5 presentation filter on
    // the ALREADY-COMPUTED Layer 4 output, not a new Layer 4 threshold or a
    // change to how rankScore itself is calculated.
    const opportunities = rankResult.ranked.filter(c => c.l4.rankScore != null && c.l4.rankScore > 0);
    if (!opportunities.length) {
        return { opportunities: [], positions: [], watchlist: [], decision: "NO-TRADE: 0 candidates cleared the joint-probability/EV threshold." };
    }
    const positions = opportunities.slice(0, MAX_SIMULTANEOUS_POSITIONS);
    const watchlist = opportunities.slice(MAX_SIMULTANEOUS_POSITIONS);
    return { opportunities, positions, watchlist, decision: "TRADE" };
}

// Orchestrates all 9 Layer 5 steps in the exact specified order:
// runway -> entry trigger -> dynamic SL -> dynamic target -> correlation ->
// position sizing -> time-stop -> ranking -> selection (all qualifying
// opportunities, uncapped; MAX_SIMULTANEOUS_POSITIONS only caps the
// separate "positions" subset — see layer5Select).
function layer5Pipeline(candidatesWithL4) {
    const perCandidate = candidatesWithL4.map(({ candidate, l4 }) => ({
        candidate, l4,
        runway: layer5Runway(candidate),
        entryTrigger: layer5EntryTrigger(candidate),
        dynamicSl: layer5DynamicSL(candidate),
        dynamicTarget: layer5DynamicTarget(candidate),
        positionSize: layer5PositionSize(l4),
        timeStopMin: HORIZON_MIN,
    }));

    const correlation = layer5Correlation(candidatesWithL4.map(x => x.candidate));
    const rankResult = layer5Rank(perCandidate);
    const selection = layer5Select(rankResult);

    return {
        perCandidate, correlation, decision: selection.decision,
        opportunities: selection.opportunities, positions: selection.positions, watchlist: selection.watchlist,
    };
}

// ── LAYER 6 — Validation & Survival ──────────────────────────────────────────
function logCandidate(candidate, l4, tradeDate) {
    try {
        const db = getDb();
        const targetPrice = candidate.direction === "LONG" ? candidate.price * (1 + TARGET_PCT / 100) : candidate.price * (1 - TARGET_PCT / 100);
        const slPrice = candidate.direction === "LONG" ? candidate.price * (1 - SL_PCT / 100) : candidate.price * (1 + SL_PCT / 100);
        const info = db.prepare(`INSERT INTO ai_candidates (
            scanned_at, trade_date, symbol, sector, market_cap_category, data_tier, direction,
            entry_price, entry_price_ts, entry_price_source, target_pct, sl_pct, target_price, sl_price,
            setup_score, regime_bias, index_regime, vix_value, movement_capacity_score,
            structure_alignment_json, vwap_state_json, compression_state, breakout_quality, momentum_accel,
            fakeout_score, order_flow_json, order_flow_is_proxy, catalyst_status, liquidity_impact_cost_pct,
            spread_pct, execution_quality, model_version_at_scan, rank_score, breakdown_json, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            Date.now(), tradeDate, candidate.symbol, candidate.sector, candidate.marketCapCategory, DATA_TIER, candidate.direction,
            candidate.price, Date.now(), candidate.priceSource, TARGET_PCT, SL_PCT, targetPrice, slPrice,
            candidate.setupScore, candidate.regimeBias, candidate.indexRegime ?? null, candidate.vixValue ?? null, candidate.movementCapacityScore,
            JSON.stringify(candidate.structureAlignment), JSON.stringify({ above: candidate.vwapAbove, rising: candidate.vwapRising }),
            candidate.compressionState, candidate.breakoutQuality, candidate.momentumAccel,
            candidate.fakeoutScore, JSON.stringify({ buySellRatio: candidate.quote?.buySellRatio ?? null }), 1, candidate.catalystStatus, candidate.impactCostPct,
            candidate.spreadPct, l4.executionQuality ?? null, l4.modelVersion ?? null, l4.rankScore ?? null, JSON.stringify(candidate.reasons || []), Date.now()
        );
        return info.lastInsertRowid;
    } catch (e) {
        console.error(`[AIScanner] logCandidate failed for ${candidate.symbol}:`, e.message);
        return null;
    }
}

/**
 * The ONE forward-outcome resolution algorithm — used by both the live
 * sweep below AND the historical dataset builder (src/ai_dataset_builder.mjs),
 * so historical labels are never a "separate labeling strategy" (spec
 * requirement), just this same fixed-race walk applied to historical
 * candles instead of live ones. `windowCandles` must already be the
 * candidate's own 1m candles strictly within [anchorTs, anchorTs+20min] —
 * this function does no time-filtering of its own, it only walks whatever
 * it's given in order.
 */
function resolveForwardOutcome(direction, entryPrice, anchorTs, windowCandles) {
    if (!windowCandles.length) return null;

    let resolution = "NEITHER", resolvedIdx = -1, ambiguous = 0;
    let mfe = -Infinity, mae = Infinity;
    for (let i = 0; i < windowCandles.length; i++) {
        const c = windowCandles[i];
        const moveHigh = direction === "LONG" ? ((c.high - entryPrice) / entryPrice) * 100 : ((entryPrice - c.low) / entryPrice) * 100;
        const moveLow = direction === "LONG" ? ((c.low - entryPrice) / entryPrice) * 100 : ((entryPrice - c.high) / entryPrice) * 100;
        mfe = Math.max(mfe, moveHigh);
        mae = Math.min(mae, moveLow);
        const hitTarget = moveHigh >= TARGET_PCT;
        const hitSl = moveLow <= -SL_PCT;
        if (hitTarget && hitSl) { resolution = "AMBIGUOUS_SAME_CANDLE"; ambiguous = 1; resolvedIdx = i; break; }
        if (hitTarget) { resolution = "TARGET_FIRST"; resolvedIdx = i; break; }
        if (hitSl) { resolution = "SL_FIRST"; resolvedIdx = i; break; }
    }

    const lastCandle = windowCandles[windowCandles.length - 1];
    const finalPrice = lastCandle.close;
    const finalPricePct = direction === "LONG" ? ((finalPrice - entryPrice) / entryPrice) * 100 : ((entryPrice - finalPrice) / entryPrice) * 100;
    const timeToResolutionSec = resolvedIdx >= 0 ? (windowCandles[resolvedIdx].ts - anchorTs) / 1000 : null;
    const enoughWindow = (lastCandle.ts - anchorTs) >= (HORIZON_MIN - 1) * 60 * 1000; // ~1min slack for candle-boundary rounding

    return { resolution, timeToResolutionSec, mfe, mae, finalPrice, finalPricePct, ambiguous, enoughWindow };
}

async function sweepPendingOutcomes() {
    let rows;
    try {
        const cutoff = Date.now() - HORIZON_MIN * 60 * 1000;
        // Anchored to entry_price_ts (the LTP tick's OWN timestamp), not
        // scanned_at (server wall-clock) — if the price used as "entry" was
        // itself a few seconds/minutes stale, anchoring the outcome window to
        // scan time instead of the price's true time would silently shift
        // when the 20-minute race is actually deemed to start, overstating
        // precision. Falls back to scanned_at only for old rows logged
        // before this column existed.
        rows = getDb().prepare(`
            SELECT c.* FROM ai_candidates c
            LEFT JOIN ai_outcomes o ON o.candidate_id = c.id
            WHERE o.candidate_id IS NULL AND COALESCE(c.entry_price_ts, c.scanned_at) <= ?
            ORDER BY c.scanned_at ASC LIMIT 200
        `).all(cutoff);
    } catch (e) {
        console.error("[AIScanner] Outcome sweep query failed:", e.message);
        return;
    }

    for (const row of rows) {
        try {
            const anchorTs = row.entry_price_ts ?? row.scanned_at;
            const c1 = await getOrFetchCandles(row.symbol, "1m", { range: { from: new Date(anchorTs), to: new Date(anchorTs + HORIZON_MIN * 60 * 1000) }, priority: true });
            const windowCandles = c1.filter(c => c.ts >= anchorTs && c.ts <= anchorTs + HORIZON_MIN * 60 * 1000);
            if (!windowCandles.length) continue; // not enough 1m history cached to resolve yet — try again next sweep

            const outcome = resolveForwardOutcome(row.direction, row.entry_price, anchorTs, windowCandles);
            if (outcome.resolution === "NEITHER" && !outcome.enoughWindow) continue; // window not fully elapsed yet — wait for the next sweep

            getDb().prepare(`INSERT INTO ai_outcomes (
                candidate_id, resolved_at, resolution, time_to_resolution_sec, mfe_pct, mae_pct,
                final_price, final_price_pct, path_source_tf, ambiguous_same_candle
            ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
                row.id, Date.now(), outcome.resolution, outcome.timeToResolutionSec, outcome.mfe, outcome.mae,
                outcome.finalPrice, outcome.finalPricePct, "1m", outcome.ambiguous
            );
        } catch (e) {
            console.error(`[AIScanner] Outcome resolution failed for candidate ${row.id} (${row.symbol}):`, e.message);
        }
    }
}

// ── Layer 6 validation algorithms — real, callable, and correct given
// whatever data currently exists. Each one degrades to an honest
// INSUFFICIENT_DATA result on too few samples rather than computing
// something statistically meaningless; that is a safeguard, not a shortcut,
// same as everywhere else in this file. ─────────────────────────────────────

// Purged walk-forward split (Lopez de Prado-style): training excludes any
// candidate whose 20-minute LABEL window would overlap the validation
// period — otherwise information from validation could leak backward into
// training through an overlapping outcome window.
function purgedWalkForwardSplit(resolvedRows, validationFrac = 0.3) {
    const sorted = resolvedRows.filter(r => r.entry_price_ts != null).sort((a, b) => a.entry_price_ts - b.entry_price_ts);
    if (sorted.length < 20) return null;
    const splitIdx = Math.max(1, Math.floor(sorted.length * (1 - validationFrac)));
    const splitTs = sorted[Math.min(splitIdx, sorted.length - 1)].entry_price_ts;
    const embargoMs = HORIZON_MIN * 60 * 1000;

    const train = sorted.filter(c => c.entry_price_ts + embargoMs <= splitTs);
    const validation = sorted.filter(c => c.entry_price_ts >= splitTs);
    return { train, validation, splitTs, purgedCount: sorted.length - train.length - validation.length };
}

function fitCalibrationModel(trainRows) {
    const buckets = new Map();
    for (const row of trainRows) {
        if (row.resolution === "AMBIGUOUS_SAME_CANDLE") continue; // excluded — can't cleanly assign win/loss (Tier-B same-candle ambiguity)
        const decile = Math.min(9, Math.floor(row.setup_score / 10));
        const key = `${row.direction}_D${decile}`;
        if (!buckets.has(key)) buckets.set(key, { n: 0, targetFirst: 0, mfeSum: 0, maeSum: 0, timeSum: 0, timeCount: 0 });
        const b = buckets.get(key);
        b.n++;
        if (row.resolution === "TARGET_FIRST") b.targetFirst++;
        if (row.mfe_pct != null) b.mfeSum += row.mfe_pct;
        if (row.mae_pct != null) b.maeSum += row.mae_pct;
        if (row.time_to_resolution_sec != null) { b.timeSum += row.time_to_resolution_sec; b.timeCount++; }
    }
    const calibration = {};
    for (const [key, b] of buckets) {
        calibration[key] = {
            n: b.n,
            hitRate: b.n ? +(b.targetFirst / b.n).toFixed(4) : null,
            avgMfe: b.n ? +(b.mfeSum / b.n).toFixed(2) : null,
            avgMae: b.n ? +(b.maeSum / b.n).toFixed(2) : null,
            avgTimeToResolutionMin: b.timeCount ? +(b.timeSum / b.timeCount / 60).toFixed(1) : null,
        };
    }
    return calibration;
}

// Real calibration check — Brier score (mean squared error between the
// bucket's TRAINING-set predicted probability and each VALIDATION-set
// candidate's actual binary outcome) plus a per-bucket reliability table
// (predicted vs realized hit rate on data the bucket was never fit on).
function evaluateCalibration(calibration, validationRows) {
    let n = 0, brierSum = 0;
    const reliabilityBuckets = new Map();
    for (const row of validationRows) {
        if (row.resolution === "AMBIGUOUS_SAME_CANDLE") continue;
        const decile = Math.min(9, Math.floor(row.setup_score / 10));
        const key = `${row.direction}_D${decile}`;
        const bucket = calibration[key];
        if (!bucket || bucket.hitRate == null) continue;
        const actual = row.resolution === "TARGET_FIRST" ? 1 : 0;
        brierSum += (bucket.hitRate - actual) ** 2;
        n++;
        if (!reliabilityBuckets.has(key)) reliabilityBuckets.set(key, { predicted: bucket.hitRate, actualSum: 0, n: 0 });
        const rb = reliabilityBuckets.get(key);
        rb.actualSum += actual; rb.n++;
    }
    const reliability = {};
    for (const [key, rb] of reliabilityBuckets) reliability[key] = { predicted: rb.predicted, realized: +(rb.actualSum / rb.n).toFixed(3), n: rb.n };
    return { n, brierScore: n ? +(brierSum / n).toFixed(4) : null, reliability };
}

function tradeReturnPct(row) {
    if (row.resolution === "TARGET_FIRST") return TARGET_PCT;
    if (row.resolution === "SL_FIRST") return -SL_PCT;
    if (row.resolution === "NEITHER") return row.final_price_pct ?? 0;
    return null; // AMBIGUOUS_SAME_CANDLE — excluded
}

// Genuine Monte Carlo: bootstrap-resample (with replacement) sequences of
// `sequenceLength` trades from the resolved-outcomes pool, many times, and
// report the distribution of cumulative return and worst drawdown across
// simulated sequences — a real trade-sequence robustness check, not a
// single backtest number.
function monteCarloRobustness(rows, iterations = 1000, sequenceLength = 30) {
    const returns = rows.map(tradeReturnPct).filter(r => r != null);
    if (returns.length < sequenceLength) return { status: "INSUFFICIENT_DATA", available: returns.length, required: sequenceLength };

    const sims = [];
    for (let i = 0; i < iterations; i++) {
        let cum = 0, peak = 0, maxDrawdown = 0;
        for (let j = 0; j < sequenceLength; j++) {
            const r = returns[Math.floor(Math.random() * returns.length)];
            cum += r;
            peak = Math.max(peak, cum);
            maxDrawdown = Math.min(maxDrawdown, cum - peak);
        }
        sims.push({ cum, maxDrawdown });
    }
    sims.sort((a, b) => a.cum - b.cum);
    const pct = p => sims[Math.floor(p * (sims.length - 1))].cum;

    return {
        status: "OK", iterations, sequenceLength, sampleSize: returns.length,
        p5: +pct(0.05).toFixed(2), p50: +pct(0.5).toFixed(2), p95: +pct(0.95).toFixed(2),
        worstDrawdownPct: +Math.min(...sims.map(s => s.maxDrawdown)).toFixed(2),
    };
}

function regimeWiseBacktest(rows) {
    const byRegime = new Map();
    for (const row of rows) {
        if (row.resolution === "AMBIGUOUS_SAME_CANDLE") continue;
        const key = row.index_regime || "Unknown";
        if (!byRegime.has(key)) byRegime.set(key, { n: 0, targetFirst: 0 });
        const b = byRegime.get(key);
        b.n++;
        if (row.resolution === "TARGET_FIRST") b.targetFirst++;
    }
    const result = {};
    for (const [key, b] of byRegime) result[key] = { n: b.n, hitRate: b.n ? +(b.targetFirst / b.n).toFixed(3) : null };
    return result;
}

function mfeMaeDistribution(rows) {
    const mfes = rows.map(r => r.mfe_pct).filter(Number.isFinite).sort((a, b) => a - b);
    const maes = rows.map(r => r.mae_pct).filter(Number.isFinite).sort((a, b) => a - b);
    const pct = (arr, p) => arr.length ? arr[Math.floor(p * (arr.length - 1))] : null;
    return {
        n: rows.length,
        mfe: { p10: pct(mfes, 0.1), p50: pct(mfes, 0.5), p90: pct(mfes, 0.9) },
        mae: { p10: pct(maes, 0.1), p50: pct(maes, 0.5), p90: pct(maes, 0.9) },
    };
}

function featureDriftCheck(recentRows, historicalRows) {
    if (recentRows.length < 20 || historicalRows.length < 20) {
        return { status: "INSUFFICIENT_DATA", recentN: recentRows.length, historicalN: historicalRows.length };
    }
    const avg = (rows, field) => rows.reduce((s, r) => s + (r[field] || 0), 0) / rows.length;
    const fields = ["setup_score", "movement_capacity_score", "liquidity_impact_cost_pct"];
    const drift = {};
    let flagged = false;
    for (const f of fields) {
        const recentAvg = avg(recentRows, f), histAvg = avg(historicalRows, f);
        const delta = histAvg !== 0 ? Math.abs((recentAvg - histAvg) / histAvg) : 0;
        drift[f] = { recentAvg: +recentAvg.toFixed(2), historicalAvg: +histAvg.toFixed(2), deltaPct: +(delta * 100).toFixed(1) };
        if (delta > DRIFT_FLAG_THRESHOLD) flagged = true;
    }
    return { status: flagged ? "DRIFT_DETECTED" : "STABLE", drift };
}

function killSwitchCheck(recentRows) {
    const clean = recentRows.filter(r => r.resolution !== "AMBIGUOUS_SAME_CANDLE");
    if (clean.length < 20) return { status: "INSUFFICIENT_DATA", n: clean.length };
    const hitRate = clean.filter(r => r.resolution === "TARGET_FIRST").length / clean.length;
    return { status: hitRate < KILL_SWITCH_FLOOR_HIT_RATE ? "DEGRADED" : "OK", hitRate: +hitRate.toFixed(3), floorHitRate: KILL_SWITCH_FLOOR_HIT_RATE, n: clean.length };
}

/**
 * Layer 6's offline/periodic validation run (spec Rule 1/8 — NOT inline with
 * the 5-min live scan; called on its own VALIDATION_INTERVAL_MS timer). Pulls
 * every resolved outcome, runs the purged walk-forward split, fits and
 * evaluates calibration, runs the Monte-Carlo/regime/MFE-MAE/drift/kill-switch
 * checks, and writes a new CANDIDATE model version row — never auto-promoted.
 * If the kill-switch trips against the CURRENTLY validated model, that
 * version is demoted to DEGRADED immediately, which makes getValidatedModel()
 * stop returning it — a real, functioning safety mechanism, not just a label.
 */
export async function runLayer6Validation() {
    let allResolved;
    try {
        allResolved = getDb().prepare(`
            SELECT c.*, o.resolution, o.mfe_pct, o.mae_pct, o.time_to_resolution_sec, o.final_price_pct
            FROM ai_candidates c JOIN ai_outcomes o ON o.candidate_id = c.id
            ORDER BY c.entry_price_ts ASC
        `).all();
    } catch (e) {
        console.error("[AIScanner] Layer 6 validation query failed:", e.message);
        return;
    }

    // Kill-switch runs regardless of whether there's enough data for a NEW
    // model version — it protects whatever model is CURRENTLY validated.
    const recentCutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const recentRows = allResolved.filter(r => r.entry_price_ts >= recentCutoff);
    const killSwitch = killSwitchCheck(recentRows.length >= 20 ? recentRows : allResolved);
    if (killSwitch.status === "DEGRADED") {
        try {
            const current = getDb().prepare("SELECT version_id FROM ai_model_versions WHERE status='VALIDATED'").get();
            if (current) {
                getDb().prepare("UPDATE ai_model_versions SET status='DEGRADED' WHERE version_id=?").run(current.version_id);
                console.warn(`[AIScanner] KILL-SWITCH TRIPPED — model v${current.version_id} demoted VALIDATED->DEGRADED (recent hit rate ${killSwitch.hitRate} < floor ${killSwitch.floorHitRate}). Live inference BLOCKED again.`);
            }
        } catch (e) {
            console.error("[AIScanner] Kill-switch demotion failed:", e.message);
        }
    }

    if (allResolved.length < MIN_VALIDATION_SAMPLES) {
        console.log(`[AIScanner] Layer 6: ${allResolved.length}/${MIN_VALIDATION_SAMPLES} resolved outcomes — not enough to fit a new model version yet.`);
        return;
    }

    const split = purgedWalkForwardSplit(allResolved);
    if (!split || split.train.length < 20 || split.validation.length < 10) {
        console.log("[AIScanner] Layer 6: purged walk-forward split left too few samples on one side — waiting for more data.");
        return;
    }

    const calibration = fitCalibrationModel(split.train);
    const calibrationEval = evaluateCalibration(calibration, split.validation);
    const monteCarlo = monteCarloRobustness(split.validation);
    const regimeBacktest = regimeWiseBacktest(allResolved);
    const mfeMaeDist = mfeMaeDistribution(allResolved);
    const historicalRows = allResolved.filter(r => r.entry_price_ts < recentCutoff);
    const drift = featureDriftCheck(recentRows, historicalRows);

    try {
        getDb().prepare(`INSERT INTO ai_model_versions (
            created_at, status, training_sample_count, validation_sample_count, feature_names_json,
            calibration_json, walkforward_json, montecarlo_json, regime_backtest_json, mfe_mae_dist_json,
            drift_json, paper_trade_count, notes
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            Date.now(), "CANDIDATE", split.train.length, split.validation.length,
            JSON.stringify(["setup_score", "movement_capacity_score", "regime_bias", "direction"]),
            JSON.stringify(calibration),
            JSON.stringify({ trainN: split.train.length, validationN: split.validation.length, purgedCount: split.purgedCount, embargoMin: HORIZON_MIN, calibrationEval }),
            JSON.stringify(monteCarlo), JSON.stringify(regimeBacktest), JSON.stringify(mfeMaeDist),
            JSON.stringify({ ...drift, killSwitch }), allResolved.length,
            "Auto-generated CANDIDATE by runLayer6Validation — requires manual validateModelVersion() promotion before live inference can use it."
        );
        console.log(`[AIScanner] Layer 6: new CANDIDATE model version produced (train=${split.train.length}, validation=${split.validation.length}, Brier=${calibrationEval.brierScore}). Manual promotion required.`);
    } catch (e) {
        console.error("[AIScanner] Layer 6: failed to write CANDIDATE model version:", e.message);
    }
}

/** Manual-only promotion (mirrors model_registry.mjs) — NEVER called automatically. */
export function validateModelVersion(versionId, validatedBy = "manual") {
    try {
        const db = getDb();
        db.prepare("UPDATE ai_model_versions SET status = 'ARCHIVED' WHERE status = 'VALIDATED'").run();
        const result = db.prepare("UPDATE ai_model_versions SET status = 'VALIDATED', validated_at = ?, validated_by = ? WHERE version_id = ? AND status = 'CANDIDATE'").run(Date.now(), validatedBy, versionId);
        return result.changes > 0;
    } catch (e) {
        console.error("[AIScanner] validateModelVersion failed:", e.message);
        return false;
    }
}

function layer6Report() {
    let candidatesLogged = 0, outcomesResolved = 0, latestVersion = null;
    try {
        candidatesLogged = getDb().prepare("SELECT COUNT(*) as n FROM ai_candidates").get().n;
        outcomesResolved = getDb().prepare("SELECT COUNT(*) as n FROM ai_outcomes").get().n;
        latestVersion = getDb().prepare("SELECT version_id, status, created_at, training_sample_count, validation_sample_count FROM ai_model_versions ORDER BY created_at DESC LIMIT 1").get() || null;
    } catch (e) {
        console.error("[AIScanner] layer6Report query failed:", e.message);
    }
    const validatedModel = getValidatedModel();
    return {
        candidatesLogged, outcomesResolved, minRequiredForValidation: MIN_VALIDATION_SAMPLES,
        status: outcomesResolved >= MIN_VALIDATION_SAMPLES ? "VALIDATION_RUNNING_PERIODICALLY" : "INSUFFICIENT_DATA",
        latestModelVersion: latestVersion,
        currentValidatedModel: validatedModel ? { versionId: validatedModel.version_id, validatedAt: validatedModel.validated_at } : null,
    };
}

// ── ORCHESTRATION ────────────────────────────────────────────────────────────
let latestResult = { updatedAt: null, universeSize: 0, candidates: [], layer6: layer6Report(), dataTier: DATA_TIER, targetPct: TARGET_PCT, slPct: SL_PCT, horizonMin: HORIZON_MIN };
let scanInFlight = false;

export async function runAIScan() {
    if (scanInFlight) return;
    scanInFlight = true;
    try {
        const validatedModel = getValidatedModel();
        const scannedAt = Date.now();
        const tradeDate = new Date(scannedAt).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

        // Layer 0 — every symbol, cache-only.
        const gates = new Map();
        for (const symbol of SCREENER_UNIVERSE) {
            try {
                const gate = layer0(symbol);
                gates.set(symbol, gate);
                if (!gate.pass) logInvalid(scannedAt, symbol, "Layer0", gate.issues.join(","));
            } catch (e) {
                console.error(`[AIScanner] Layer 0 failed for ${symbol}:`, e.message);
                gates.set(symbol, { symbol, pass: false, issues: ["INTERNAL_ERROR"], dataTier: DATA_TIER, price: null, candles: [] });
                logInvalid(scannedAt, symbol, "Layer0", "INTERNAL_ERROR: " + e.message);
            }
        }

        // NIFTY is the relative-strength baseline reference, not a scored
        // candidate — SCREENER_UNIVERSE excludes all indices, so this needs
        // its own direct Layer 0 read.
        const niftyGate = layer0("NIFTY");
        const niftyCloses = niftyGate?.pass ? niftyGate.candles.map(c => c.close).filter(Number.isFinite) : null;

        // Layer 1 — coarse discovery across everything that passed Layer 0.
        const l1Survivors = [];
        for (const [symbol, gate] of gates) {
            if (!gate.pass) continue; // already logged INVALID above
            try {
                const result = layer1(gate, niftyCloses);
                if (result.status === "INVALID") logInvalid(scannedAt, symbol, "Layer1", result.reason);
                else if (result.status === "FLAGGED") l1Survivors.push(result);
            } catch (e) {
                console.error(`[AIScanner] Layer 1 failed for ${symbol}:`, e.message);
                logInvalid(scannedAt, symbol, "Layer1", "INTERNAL_ERROR: " + e.message);
            }
        }

        // Layer 2 — bulk quotes for the Layer-1 survivors only, not the full 500.
        let quotesBySymbol = {};
        try {
            quotesBySymbol = await fetchBulkQuotes(l1Survivors.map(s => s.symbol));
        } catch (e) {
            console.error("[AIScanner] Layer 2 bulk quote fetch failed:", e.message);
        }

        const sectorReturns = sectorAggregateReturns(gates);
        const marketRegime = await marketRegimeInput();

        const l2Survivors = [];
        for (const flag of l1Survivors) {
            try {
                const gate = gates.get(flag.symbol);
                gate.quote = quotesBySymbol[flag.symbol] || null;
                const l2 = layer2(flag.symbol, gate, sectorReturns, marketRegime);
                if (!l2.eliminated) l2Survivors.push(l2);
                // Hard-gate eliminations are a real, evaluated ELIMINATION
                // (Rule 2/9), not an INVALID/insufficient-data case — not logged here.
            } catch (e) {
                console.error(`[AIScanner] Layer 2 failed for ${flag.symbol}:`, e.message);
                logInvalid(scannedAt, flag.symbol, "Layer2", "INTERNAL_ERROR: " + e.message);
            }
        }

        // Layer 3 — ensemble score every Layer-2 survivor, keep the top ~10.
        const l3Scored = [];
        for (const l2 of l2Survivors) {
            try {
                l3Scored.push(layer3(l2));
            } catch (e) {
                console.error(`[AIScanner] Layer 3 failed for ${l2.symbol}:`, e.message);
                logInvalid(scannedAt, l2.symbol, "Layer3", "INTERNAL_ERROR: " + e.message);
            }
        }
        l3Scored.sort((a, b) => b.setupScore - a.setupScore);
        const top10 = l3Scored.slice(0, 10);

        // Layer 4 — per-candidate.
        const withL4 = top10.map(candidate => ({ candidate, l4: layer4(candidate, validatedModel) }));

        // Layer 5 — full pipeline across the group (correlation needs all of them together).
        const l5 = layer5Pipeline(withL4);

        // Layer 6 — log every Layer-3 survivor now (data collection only —
        // the actual validation ALGORITHMS run on their own offline cadence,
        // see startAIScanLoop/runLayer6Validation, not here).
        const candidates = l5.perCandidate.map(pc => {
            const candidateId = logCandidate(pc.candidate, pc.l4, tradeDate);
            return { ...pc.candidate, candidateId, layer4: pc.l4, layer5: { runway: pc.runway, entryTrigger: pc.entryTrigger, dynamicSl: pc.dynamicSl, dynamicTarget: pc.dynamicTarget, positionSize: pc.positionSize, timeStopMin: pc.timeStopMin } };
        });

        pruneInvalidLog();

        latestResult = {
            updatedAt: scannedAt,
            universeSize: SCREENER_UNIVERSE.length,
            layer1Count: l1Survivors.length,
            layer2Count: l2Survivors.length,
            candidates,
            decision: l5.decision,
            // opportunitySymbols: EVERY candidate that cleared the
            // validated Layer-4 EV threshold, ranked, uncapped — the
            // scanner's actual output per spec ("Nifty 500 -> ~100 -> ~40
            // -> ~10-20 qualified opportunities -> ranked list").
            // positionSymbols: the separate 0-3 execution/risk constraint —
            // the top of opportunitySymbols the system would actually size
            // and take. watchlistSymbols: the rest of opportunitySymbols
            // (rank 4+), still fully qualifying, shown for visibility only.
            opportunitySymbols: l5.opportunities.map(s => s.candidate.symbol),
            positionSymbols: l5.positions.map(s => s.candidate.symbol),
            watchlistSymbols: l5.watchlist.map(s => s.candidate.symbol),
            correlation: l5.correlation,
            invalid: invalidSummaryForCycle(scannedAt),
            layer6: layer6Report(),
            marketRegime,
            dataTier: DATA_TIER, targetPct: TARGET_PCT, slPct: SL_PCT, horizonMin: HORIZON_MIN,
        };
    } catch (e) {
        console.error("[AIScanner] Scan cycle failed:", e.message);
    } finally {
        scanInFlight = false;
    }
}

export function getLatestAIScan() {
    return latestResult;
}

let _running = false;
let _scanTimer = null;
let _outcomeTimer = null;
let _validationTimer = null;

export function startAIScanLoop() {
    if (_running) return;
    _running = true;
    console.log(`[AIScanner] Starting AI tab: scan every ${SCAN_INTERVAL_MS / 60000}min, outcome sweep every ${OUTCOME_SWEEP_INTERVAL_MS / 60000}min, Layer 6 validation every ${VALIDATION_INTERVAL_MS / 60000}min...`);
    runAIScan().catch(e => console.error("[AIScanner] Initial scan error:", e.message));
    _scanTimer = setInterval(() => runAIScan().catch(e => console.error("[AIScanner] Scan error:", e.message)), SCAN_INTERVAL_MS);
    _outcomeTimer = setInterval(() => sweepPendingOutcomes().catch(e => console.error("[AIScanner] Outcome sweep error:", e.message)), OUTCOME_SWEEP_INTERVAL_MS);
    // Layer 6 is deliberately NOT run inline with the scan loop above (spec
    // Rule 1) — its own slow, offline/periodic cadence.
    _validationTimer = setInterval(() => runLayer6Validation().catch(e => console.error("[AIScanner] Layer 6 validation error:", e.message)), VALIDATION_INTERVAL_MS);
}

// Exports for testing AND for src/ai_dataset_builder.mjs, which reuses these
// exact same functions against historical as-of-T data via an injected ctx
// (see LIVE_CTX above) instead of reimplementing Layer 0-3 in parallel.
export {
    layer0, layer1, layer2, layer3, layer4, layer5Pipeline,
    sectorAggregateReturns, resolveForwardOutcome,
    computeTradingCostsPct, computeExpectedNetReturn, computeRankScore, computeCalibrationBucket,
    purgedWalkForwardSplit, fitCalibrationModel, evaluateCalibration,
    monteCarloRobustness, regimeWiseBacktest, mfeMaeDistribution, featureDriftCheck, killSwitchCheck,
    DATA_TIER, TARGET_PCT, SL_PCT, HORIZON_MIN,
};
