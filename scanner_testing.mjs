import express from "express";
import compression from "compression";
import path from "path";
import { fileURLToPath } from "url";
import { createHash, timingSafeEqual } from "crypto";
import { __dirname as srcDirname } from "./src/config.mjs";
import { login, fetchBulkLtp, fetchOptionChain, fetchHoldings, fetchPositions, portfolioApiStatus } from "./src/upstox.mjs";
import { state, scanning, isAuthenticated, setIsAuthenticated, scanAll, startScan, scanProgress, refreshSymbolNow, markIntradayActive, startTrialMinuteWorker } from "./src/scanner.mjs";
import { cacheStats } from "./src/candle_cache.mjs";
import { startOptionsFeed, getOptionsCacheWithFreshness } from "./src/options_feed.mjs";
import { startFeed, livePrices, getLtpWithFreshness, isConnected, msSinceLastTick, forceFeedRestart } from "./src/feed.mjs";
import { isInstrumentMasterLoaded, isInstrumentMasterStale } from "./src/instruments.mjs";
import { UNIVERSE } from "./src/universe.mjs";
import { isMarketOpen } from "./src/scanner.mjs";
import { theoreticalOptionChain } from "./src/indicators.mjs";
import { runOperatorScan, getOperatorState, buildMarketSummary, formatMarketSummaryBlock, transformScannerData } from "./src/operator_scanner.mjs";
import { isDividendServiceAvailable } from "./src/dividend.mjs";
import { startIntradayMoversLoop, getLatestMovers } from "./src/intraday_movers.mjs";
import { startAIScanLoop, getLatestAIScan } from "./src/ai_scanner.mjs";
import { startIndexRegimeLoop, getLatestIndexRegimes } from "./src/index_regime.mjs";
import { startFastSnapshotLoop, getLatestFullUniverseSnapshot, getLatestChartFields, setActiveChartTf, computeSymbolAllTimeframes } from "./src/stage1_filter.mjs";
import { screenerState, startScreenerScan } from "./src/screener.mjs";
import {
    markCritical, listCriticalTrades,
    updateCriticalTrade, closeCriticalTrade, deleteCriticalTrade,
} from "./src/critical_trades.mjs";
import { startCriticalMonitor } from "./src/critical_monitor.mjs";
import { runDailyLearningJob, startDailyLearningScheduler } from "./src/daily_learning_job.mjs";
import { getDb } from "./src/learning_db.mjs";
import { proposeNewWeights, validateWeights, meetsPromotionCriteria, promoteModelVersion, rollbackToVersion } from "./src/model_registry.mjs";

// Fix __dirname for root directory (scanner_testing.mjs is in root)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Every route below is unauthenticated by design for localhost-only use —
// once this server is reachable over a public tunnel URL, anyone with the
// link can read portfolio data or close live trades via the API. Gate the
// whole app behind Basic Auth whenever DASHBOARD_USER/DASHBOARD_PASS are
// set (they must be for any non-localhost exposure); skip only for local
// dev where they're intentionally left unset.
const { DASHBOARD_USER, DASHBOARD_PASS, AUTH_TOKEN } = process.env;
if (DASHBOARD_USER && DASHBOARD_PASS) {
    const expectedUser = Buffer.from(DASHBOARD_USER);
    const expectedPass = Buffer.from(DASHBOARD_PASS);
    const expectedToken = AUTH_TOKEN ? Buffer.from(AUTH_TOKEN) : null;

    const tokenMatches = (candidate) => {
        if (!expectedToken || !candidate) return false;
        const candidateBuf = Buffer.from(candidate);
        return candidateBuf.length === expectedToken.length && timingSafeEqual(candidateBuf, expectedToken);
    };

    app.use((req, res, next) => {
        // 1) One-click login link (?auth=TOKEN) — no embedded credentials in the
        //    URL, so it isn't flagged/blocked by mobile browsers' phishing
        //    heuristics the way user:pass@host links are. Sets a long-lived
        //    cookie, then redirects to the clean URL so the token doesn't
        //    linger in the address bar.
        if (tokenMatches(req.query.auth)) {
            res.cookie("auth_token", AUTH_TOKEN, {
                maxAge: 10 * 365 * 24 * 60 * 60 * 1000,
                httpOnly: true,
                secure: true,
                sameSite: "Lax",
            });
            return res.redirect(req.path);
        }

        // 2) Existing session cookie from a previous ?auth= visit.
        const cookies = Object.fromEntries((req.headers.cookie || "").split(";").map(p => {
            const i = p.indexOf("=");
            return i === -1 ? [p.trim(), ""] : [p.slice(0, i).trim(), decodeURIComponent(p.slice(i + 1).trim())];
        }));
        if (tokenMatches(cookies.auth_token)) return next();

        // 3) Manual Basic Auth fallback (browser login prompt).
        const header = req.headers.authorization || "";
        const [scheme, encoded] = header.split(" ");
        if (scheme === "Basic" && encoded) {
            const [user, pass] = Buffer.from(encoded, "base64").toString().split(":");
            const userBuf = Buffer.from(user || "");
            const passBuf = Buffer.from(pass || "");
            const userOk = userBuf.length === expectedUser.length && timingSafeEqual(userBuf, expectedUser);
            const passOk = passBuf.length === expectedPass.length && timingSafeEqual(passBuf, expectedPass);
            if (userOk && passOk) return next();
        }
        res.set("WWW-Authenticate", 'Basic realm="Scanner"');
        res.status(401).send("Authentication required");
    });
} else {
    console.warn("⚠️  DASHBOARD_USER/DASHBOARD_PASS not set — running with NO AUTH. Do not expose this server over a public tunnel until they're set.");
}

// The JSON poll endpoints (/api/state, /api/ltp, ...) are 40-90KB uncompressed
// and hit every few seconds by an open browser tab — compression must be
// registered before any route so every response goes through it.
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend - point to public/ in root
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 4000;

// ── Option Chain Cache with TTL (10s) ─────────────────────────────────────────────
const optionChainCacheTTL = 10000; // 10 seconds
const optionChainCache = new Map(); // symbol → { data, timestamp }

function getCachedOptionChain(symbol) {
    const cached = optionChainCache.get(symbol);
    if (cached && Date.now() - cached.timestamp < optionChainCacheTTL) {
        return cached.data;
    }
    optionChainCache.delete(symbol); // Expired
    return null;
}

function setCachedOptionChain(symbol, data) {
    optionChainCache.set(symbol, { data, timestamp: Date.now() });
}

// ── Routes ────────────────────────────────────────────────────────────

// Lightweight LTP endpoint - returns only live prices (tiny payload ~2KB).
// `meta` is additive — old clients reading the flat map keep working;
// clients that need to know how fresh each price actually is read `meta`.
app.get("/api/ltp", (_, res) => {
    const prices = Object.fromEntries(livePrices);
    const meta = {};
    for (const symbol of livePrices.keys()) {
        const f = getLtpWithFreshness(symbol);
        meta[symbol] = { ts: f.ts, ageMs: f.ageMs, source: f.source };
    }
    res.json({ ...prices, meta });
});

// ETag support for /api/state - skip if unchanged
let lastStateEtag = null;
app.get("/api/state", (req, res) => {
    const etag = createHash("md5").update(JSON.stringify(state.lastUpdated)).digest("hex");
    if (req.headers["if-none-match"] === etag) {
        return res.sendStatus(304); // Not modified
    }
    lastStateEtag = etag;
    res.set("ETag", etag);
    res.json(state);
});

// Cheap full-Nifty-500 snapshot (price/chgPct/volume, no Stage-2 indicators)
// — backed by stage1_filter.mjs's fast independent loop, not the slow
// Stage-2 cycle. Used by the Stocks tab's "All" chip, which wants every
// symbol refreshed quickly rather than a computed-but-partial, minutes-stale
// subset. Chart/EMA fields are computed separately, per the requested `tf`
// (?tf=1m|5m|10m|15m|30m|1h|1d, default 5m) — see stage1_filter.mjs's
// comment on why those are kept OUT of the canonical snapshot above: that
// one's pctFromOpenCheap/aboveVwapCheap/relVolumeCheap feed cheapScore,
// which Stage-2 symbol selection depends on, and must stay on a fixed basis
// regardless of what timeframe the user has the chart set to.
const VALID_CHART_TFS = new Set(["1m", "5m", "10m", "15m", "30m", "1h", "1d"]);
app.get("/api/universe-snapshot", (req, res) => {
    const tf = VALID_CHART_TFS.has(req.query.tf) ? req.query.tf : "5m";
    setActiveChartTf(tf);

    const snapshot = getLatestFullUniverseSnapshot();
    const chartFields = getLatestChartFields();
    const rows = snapshot ? [...snapshot.values()].map(row => ({ ...row, ...chartFields.get(row.symbol) })) : [];
    res.json(rows);
});

// "ALL" timeframe for a single searched stock — see stage1_filter.mjs's
// computeSymbolAllTimeframes for why this is a separate, on-demand,
// single-symbol endpoint rather than a universe-wide "ALL" mode: 1 symbol ×
// 7 real timeframes is cheap (worst case 7 fetches); 500 symbols × 7 would
// have meant ~7x the background REST cost and per-tick CPU of a single
// timeframe, for a feature only ever useful on one stock at a time anyway.
app.get("/api/symbol-all-timeframes/:symbol", async (req, res) => {
    try {
        const rows = await computeSymbolAllTimeframes(req.params.symbol.toUpperCase());
        res.json({ symbol: req.params.symbol.toUpperCase(), rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Intraday tab's data source — see src/intraday_movers.mjs for the full
// design rationale. Fully independent of the Stage-2 scan cycle and every
// other tab's data; zero Upstox REST cost (own background loop, cache-reads
// only).
app.get("/api/intraday-movers", (_, res) => {
    res.json(getLatestMovers());
});

// AI tab's data source — see src/ai_scanner.mjs for the full 7-layer design.
// Fully independent of every other tab's data/loops. Layers 4-5 (joint
// probability, Rank Score, trade decision) are BLOCKED in every response
// until a Layer-6-validated model version exists — see that file's header.
app.get("/api/ai-scan", (_, res) => {
    res.json(getLatestAIScan());
});

app.get("/api/status", (_, res) => {
    const nextCycleEtaMs = scanProgress?.lastCycleDurationMs != null && scanProgress?.cycleStartedAt != null
        ? Math.max(0, scanProgress.cycleStartedAt + Math.max(scanProgress.lastCycleDurationMs, 5 * 60 * 1000) - Date.now())
        : null;
    res.json({
        authenticated: isAuthenticated,
        scanning,
        scanProgress,
        nextCycleEtaMs,
        // Server truth, not the client's own clock — the frontend's market-
        // open/closed badge previously recomputed this independently from
        // `new Date()` in the browser, which could silently disagree with
        // what the backend (and every freshness classification it makes)
        // actually uses if the client's clock is wrong.
        marketOpen: isMarketOpen(),
        lastUpdated: state.lastUpdated,
        dataAsOf: state.dataAsOf ?? null,
        errors: state.errors.length,
        universe: UNIVERSE.length,
        dividendAvailable: isDividendServiceAvailable(),
        feed: { connected: isConnected(), msSinceLastTick: msSinceLastTick() },
        instrumentMaster: { loaded: isInstrumentMasterLoaded(), stale: isInstrumentMasterStale() },
        candleCache: cacheStats(),
    });
});

// Trial feed endpoint — compact ranked feed produced by the minute worker
app.get("/api/trial", (_, res) => {
    try {
        const feed = state.trialFeed || { generatedAt: null, items: [] };
        // sanitized minimal payload to keep responses small
        const items = (feed.items || []).map(i => ({
            symbol: i.symbol,
            price: i.price,
            chg1m: i.chg1m,
            chg5m: i.chg5m,
            chg15m: i.chg15m,
            indicators: i.indicators,
            estimator: i.estimator,
            signal: i.signal,
            sourceTs: i.sourceTs,
        }));
        res.json({ generatedAt: feed.generatedAt, count: items.length, items });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Intraday tab active-heartbeat — the frontend calls this while the
// Intraday tab is visible and active (see public/ui-managers.mjs's
// LivePriceUpdater) so the backend's Actionable Intraday layer
// (trade plan/position sizing/Actionable Quality Score — see
// src/scanner.mjs's isIntradayHeartbeatFresh) only runs when someone is
// actually looking at it, and stops within ~20s of the tab going inactive.
// No auth required — this carries no data, just a liveness ping.
app.post("/api/intraday/heartbeat", (_, res) => {
    markIntradayActive();
    res.json({ ok: true });
});

// Manual on-demand refresh of a single symbol — force-bypasses the candle
// cache so the result is genuinely current. Meets the "<60s manual refresh"
// target (7 sequential timeframe fetches, no rate-limit contention from the
// general scan).
app.post("/api/scan/refresh/:symbol", async (req, res) => {
    if (!isAuthenticated) return res.status(401).json({ ok: false, error: "Not authenticated" });
    try {
        const result = await refreshSymbolNow(req.params.symbol.toUpperCase());
        res.json({ ok: true, ...result });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// Manual trigger for the learning layer's once-daily job — for testing
// without waiting for the real 15:45 IST schedule. `force:true` re-runs an
// already-finalized day (finalizeOutcomes/backfillTakenTrades are both
// idempotent, so this is safe).
app.post("/api/learning/retrain", async (req, res) => {
    try {
        const result = await runDailyLearningJob({ force: !!req.body?.force, tradeDate: req.body?.tradeDate });
        res.json({ ok: true, ...result });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ── MODEL / LEARNING dashboard — read-only inspection of the learning layer.
// Every route here is diagnostic only: nothing it returns feeds back into
// live scoring (that's Phase 5's weight adaptation, still gated behind a
// manual promotion). All four wrap getDb() in try/catch so a learning-layer
// problem can never surface as anything worse than a 500 on these specific
// dashboard calls — the live scanner routes above don't depend on this file.
app.get("/api/learning/overview", (_, res) => {
    try {
        const db = getDb();
        const snapshotCount = db.prepare("SELECT COUNT(*) c FROM snapshots").get().c;
        const outcomeCount = db.prepare("SELECT COUNT(*) c FROM outcomes").get().c;
        const takenCount = db.prepare("SELECT COUNT(*) c FROM snapshots WHERE was_taken = 1").get().c;
        const latestAsOfDate = db.prepare("SELECT MAX(as_of_date) d FROM rolling_stats").get().d;
        const lastJobRun = db.prepare("SELECT * FROM job_runs ORDER BY run_date DESC LIMIT 1").get() ?? null;
        const productionModel = db.prepare("SELECT * FROM model_versions WHERE status = 'PRODUCTION' LIMIT 1").get() ?? null;
        const openDriftFlags = latestAsOfDate
            ? db.prepare("SELECT COUNT(*) c FROM drift_log WHERE flagged = 1 AND checked_at >= ?").get(Date.now() - 24 * 60 * 60 * 1000).c
            : 0;
        const regimeOverview = latestAsOfDate
            ? db.prepare(`
                SELECT segment_key, window, sample_count, win_rate, sufficient_sample
                FROM rolling_stats
                WHERE as_of_date = ? AND segment_key LIKE 'regime:%' AND segment_key NOT LIKE '%|bucket:%'
                ORDER BY segment_key, window
            `).all(latestAsOfDate)
            : [];
        res.json({
            ok: true, snapshotCount, outcomeCount, takenCount, latestAsOfDate, lastJobRun, productionModel,
            recentDriftFlagCount: openDriftFlags, regimeOverview,
        });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// All rolling_stats rows for the latest as-of date (or ?asOfDate=YYYY-MM-DD),
// optionally narrowed with ?window=RECENT|HISTORICAL.
app.get("/api/learning/segments", (req, res) => {
    try {
        const db = getDb();
        const asOfDate = req.query.asOfDate || db.prepare("SELECT MAX(as_of_date) d FROM rolling_stats").get().d;
        if (!asOfDate) return res.json({ ok: true, asOfDate: null, segments: [] });
        const windowFilter = req.query.window === "RECENT" || req.query.window === "HISTORICAL" ? req.query.window : null;
        const rows = windowFilter
            ? db.prepare("SELECT * FROM rolling_stats WHERE as_of_date = ? AND window = ? ORDER BY segment_key").all(asOfDate, windowFilter)
            : db.prepare("SELECT * FROM rolling_stats WHERE as_of_date = ? ORDER BY segment_key, window").all(asOfDate);
        res.json({ ok: true, asOfDate, segments: rows });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// Drift log, most recent first — ?all=1 includes non-flagged comparisons too (default: flagged only).
app.get("/api/learning/drift", (req, res) => {
    try {
        const db = getDb();
        const includeAll = req.query.all === "1" || req.query.all === "true";
        const rows = includeAll
            ? db.prepare("SELECT * FROM drift_log ORDER BY checked_at DESC LIMIT 200").all()
            : db.prepare("SELECT * FROM drift_log WHERE flagged = 1 ORDER BY checked_at DESC LIMIT 200").all();
        res.json({ ok: true, drift: rows });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// Full model-version history.
app.get("/api/learning/versions", (_, res) => {
    try {
        const db = getDb();
        const rows = db.prepare("SELECT * FROM model_versions ORDER BY version_id DESC").all();
        res.json({ ok: true, versions: rows });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ── Weight adaptation (Phase 5) — propose/validate are safe to call anytime
// (they only ever write a PROPOSED row); promote/rollback are the ONLY
// calls that ever change live scoring, and are always a deliberate manual
// action (dashboard button), never automatic.
app.post("/api/learning/propose", (req, res) => {
    try {
        const { from, to } = req.body || {};
        if (!from || !to) return res.status(400).json({ ok: false, error: "from and to (trade dates) are required" });
        res.json(proposeNewWeights({ from, to }));
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.post("/api/learning/validate/:versionId", (req, res) => {
    try {
        const { from, to } = req.body || {};
        if (!from || !to) return res.status(400).json({ ok: false, error: "from and to (trade dates) are required" });
        res.json(validateWeights(+req.params.versionId, { from, to }));
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.get("/api/learning/versions/:versionId/criteria", (req, res) => {
    try {
        res.json({ ok: true, ...meetsPromotionCriteria(+req.params.versionId) });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.post("/api/learning/promote/:versionId", (req, res) => {
    try {
        const version = promoteModelVersion(+req.params.versionId, { promotedBy: req.body?.promotedBy || "dashboard" });
        res.json({ ok: true, version });
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

app.post("/api/learning/rollback/:versionId", (req, res) => {
    try {
        const version = rollbackToVersion(+req.params.versionId, { promotedBy: req.body?.promotedBy || "dashboard-rollback" });
        res.json({ ok: true, version });
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

// Market-wide screeners (Nifty 500) — Top Gainers/Losers, Volume Shockers,
// 52-Week breakouts, and pattern scans. Refreshes on its own ~15min cadence
// (see src/screener.mjs), independent of the main 241-symbol deep scan.
app.get("/api/screener", (_, res) => res.json(screenerState));

// ── Market Regime — BULLISH / BEARISH / SIDEWAYS, refreshed once per scan ──
app.get("/api/regime", (_, res) => res.json(state.marketRegime || { regime: "UNKNOWN", notes: ["No scan completed yet"] }));

// ── Critical Trades ────────────────────────────────────────────────────────
// MARK CRITICAL persists a trade; every subsequent full scan (~30s) updates
// its Trade Health, minute history, trap classification, and notifications
// (see src/critical_trades.mjs onScanComplete(), called from scanner.mjs).
app.get("/api/critical", (req, res) => {
    const includeClosed = req.query.includeClosed === "1" || req.query.includeClosed === "true";
    res.json({ trades: listCriticalTrades({ includeClosed }) });
});

app.post("/api/critical", (req, res) => {
    try {
        const { symbol, entryPrice, quantity, entryTime, stopLoss, target } = req.body || {};
        const trade = markCritical({ symbol, entryPrice, quantity, entryTime, stopLoss, target });
        res.json({ ok: true, trade });
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

app.patch("/api/critical/:id", (req, res) => {
    const trade = updateCriticalTrade(req.params.id, req.body || {});
    if (!trade) return res.status(404).json({ ok: false, error: "Trade not found" });
    res.json({ ok: true, trade });
});

app.post("/api/critical/:id/close", (req, res) => {
    const trade = closeCriticalTrade(req.params.id, req.body?.reason || "manual");
    if (!trade) return res.status(404).json({ ok: false, error: "Trade not found" });
    res.json({ ok: true, trade });
});

app.delete("/api/critical/:id", (req, res) => {
    const ok = deleteCriticalTrade(req.params.id);
    if (!ok) return res.status(404).json({ ok: false, error: "Trade not found" });
    res.json({ ok: true });
});

// Starts (or no-ops if already running) background scanning + live feeds.
// Safe to call from both server boot and /api/login, since scanAll/startFeed/
// startOptionsFeed all guard against double-starting internally.
function activateMarketData() {
    startScan();
    startFeed(() => {});
    startOptionsFeed();
    startScreenerScan();
    startCriticalMonitor();
    startDailyLearningScheduler();
    startFastSnapshotLoop();
    startIndexRegimeLoop();
    startIntradayMoversLoop();
    startAIScanLoop();

    // Start Trial minute worker (lightweight 1m scanner) — non-blocking
    try {
        startTrialMinuteWorker();
    } catch (e) {
        console.error("[Activate] Failed to start Trial minute worker:", e?.message || e);
    }
}

app.post("/api/login", async (req, res) => {
    try {
        await login();
        setIsAuthenticated(true);
        activateMarketData();
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ... rest of the file remains unchanged (no further edits) ...
