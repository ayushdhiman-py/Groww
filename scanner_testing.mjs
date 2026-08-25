import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { __dirname as srcDirname } from "./src/config.mjs";
import { login, fetchBulkLtp, fetchOptionChain, fetchHoldings, fetchPositions, portfolioApiStatus } from "./src/upstox.mjs";
import { state, scanning, isAuthenticated, setIsAuthenticated, scanAll, startScan, scanProgress, refreshSymbolNow } from "./src/scanner.mjs";
import { cacheStats } from "./src/candle_cache.mjs";
import { startOptionsFeed, getOptionsCacheWithFreshness } from "./src/options_feed.mjs";
import { startFeed, livePrices, getLtpWithFreshness, isConnected, msSinceLastTick } from "./src/feed.mjs";
import { isInstrumentMasterLoaded, isInstrumentMasterStale } from "./src/instruments.mjs";
import { UNIVERSE } from "./src/universe.mjs";
import { isMarketOpen } from "./src/scanner.mjs";
import { theoreticalOptionChain } from "./src/indicators.mjs";
import { runOperatorScan, getOperatorState, buildMarketSummary, formatMarketSummaryBlock, transformScannerData } from "./src/operator_scanner.mjs";
import { isDividendServiceAvailable } from "./src/dividend.mjs";
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

// ── Routes ─────────────────────────────────────────────────────────────────────

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
}

app.post("/api/login", async (req, res) => {
    try {
        await login();
        setIsAuthenticated(true);
        activateMarketData();
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get("/api/option-chain/:symbol", async (req, res) => {
    const sym = req.params.symbol;

    // 1. Check TTL cache first (10s cache to reduce API calls)
    const ttlCached = getCachedOptionChain(sym);
    if (ttlCached) {
        return res.json(ttlCached);
    }

    // 2. Check shared cache (populated by background feed) — but only trust
    // it as current if it hasn't outlived the round-robin poller's own
    // refresh cadence; past that, the poller has stalled for this symbol,
    // so fall through and try a live fetch instead of serving it unlabeled.
    const cachedWithFreshness = getOptionsCacheWithFreshness(sym);
    if (cachedWithFreshness.data && !cachedWithFreshness.stale) {
        const result = { ...cachedWithFreshness.data, source: "cache", fetchedAt: cachedWithFreshness.data.updatedAt, ageMs: cachedWithFreshness.ageMs };
        setCachedOptionChain(sym, result);
        return res.json(result);
    }

    // 3. Fetch REAL option chain from Upstox API
    try {
        const rawChain = await fetchOptionChain(sym);

        if (rawChain && rawChain.strikes) {
            const fetchedAt = new Date().toISOString();
            const calls = [];
            const puts = [];

            // upstox.mjs's fetchOptionChain always normalizes to
            // { strikes: { "<strike>": { CE, PE } } } — iv is already a
            // percentage (Upstox convention), not a 0-1 fraction.
            for (const [strikePrice, optionsData] of Object.entries(rawChain.strikes)) {
                const strike = parseFloat(strikePrice);
                // `??` (not `||`) — a field Upstox genuinely omitted must
                // surface as null ("unavailable"), never as a look-like-real
                // 0; a genuinely-zero value (e.g. delta on a deep OTM option)
                // must also not be discarded by a falsy-0 check.
                if (optionsData.CE) {
                    calls.push({
                        strikePrice: strike,
                        ltp: optionsData.CE.lastPrice ?? null,
                        openInterest: optionsData.CE.open_interest ?? null,
                        oiChange: optionsData.CE.changeInOI ?? null,
                        volume: optionsData.CE.volume ?? null,
                        greeks: {
                            delta: optionsData.CE.delta ?? null,
                            gamma: optionsData.CE.gamma ?? null,
                            theta: optionsData.CE.theta ?? null,
                            vega: optionsData.CE.vega ?? null,
                            iv: optionsData.CE.impliedVolatility ?? null,
                        },
                        type: "CE",
                    });
                }
                if (optionsData.PE) {
                    puts.push({
                        strikePrice: strike,
                        ltp: optionsData.PE.lastPrice ?? null,
                        openInterest: optionsData.PE.open_interest ?? null,
                        oiChange: optionsData.PE.changeInOI ?? null,
                        volume: optionsData.PE.volume ?? null,
                        greeks: {
                            delta: optionsData.PE.delta ?? null,
                            gamma: optionsData.PE.gamma ?? null,
                            theta: optionsData.PE.theta ?? null,
                            vega: optionsData.PE.vega ?? null,
                            iv: optionsData.PE.impliedVolatility ?? null,
                        },
                        type: "PE",
                    });
                }
            }

            // Sort by volume and pick top 5
            const topCalls = calls.sort((a, b) => b.volume - a.volume).slice(0, 5);
            const topPuts = puts.sort((a, b) => b.volume - a.volume).slice(0, 5);

            const result = {
                symbol: sym,
                spot: rawChain.underlying_ltp ?? null,
                expiry: rawChain.expiryDate,
                topCalls,
                topPuts,
                callOptions: calls,
                putOptions: puts,
                strikes: {},
                theoretical: false,
                source: "live",
                fetchedAt,
            };

            setCachedOptionChain(sym, result);
            return res.json(result);
        }
    } catch (err) {
        console.error(`[OptionChain] Upstox API error for ${sym}:`, err.message);
    }

    // 4. Live fetch failed — a stale-but-real snapshot is still more
    // informative than a purely synthetic model, as long as it's clearly
    // labeled as stale rather than presented as current.
    if (cachedWithFreshness.data) {
        const result = { ...cachedWithFreshness.data, source: "cache-stale", fetchedAt: cachedWithFreshness.data.updatedAt, ageMs: cachedWithFreshness.ageMs };
        return res.json(result);
    }

    // 5. Fallback: Generate theoretical option chain from scanner data (Black-Scholes)
    let rowData = null;
    for (const tf of ["5m", "15m", "1h", "1d"]) {
        const found = (state.data[`${tf}_ALL`] || []).find(r => r.symbol === sym);
        if (found) { rowData = found; break; }
    }

    if (rowData) {
        const now = new Date();
        const day = now.getDay();
        const daysToThursday = ((4 - day + 7) % 7) || 7;

        // rowData.hv is nullish only for a row shape that never went through
        // buildSignal()'s HV computation at all — hvEstimated:true in that
        // case flags the 0.25 fallback honestly rather than implying a real
        // computed HV backs this theoretical chain.
        const chain = theoreticalOptionChain(rowData.price, rowData.hv ?? 0.25, daysToThursday, sym);
        const fetchedAt = new Date().toISOString();

        const result = {
            symbol: sym,
            spot: rowData.price,
            spotSource: rowData.priceSource || "UNKNOWN", // the spot this model is built on may itself be HISTORICAL, not live
            spotTs: rowData.priceTs ?? null,
            hv: chain.hv,
            hvEstimated: rowData.hvEstimated ?? (rowData.hv == null),
            daysToExpiry: chain.daysToExpiry,
            topCalls: chain.calls,
            topPuts: chain.puts,
            callOptions: chain.calls,
            putOptions: chain.puts,
            strikes: {},
            theoretical: true,
            source: "theoretical",
            fetchedAt,
        };
        setCachedOptionChain(sym, result);
        return res.json(result);
    }

    // 6. Nothing available
    return res.status(404).json({ error: "no_data", message: `Option chain not available for ${sym}.` });
});

// ── Indices LTP endpoint ─────────────────────────────────────────────────────────
const INDEX_SYMBOLS = ["NIFTY 50", "NIFTY BANK", "NIFTY FIN SERVICE", "SENSEX", "NIFTY MID SELECT"];
const INDEX_LABELS  = ["NIFTY",   "BANKNIFTY", "FINNIFTY",          "SENSEX", "MIDCPNIFTY"];
let   indexCache    = { ts: 0, data: [] };

app.get("/api/indices", async (_, res) => {
    try {
        if (!isAuthenticated) return res.json([]);
        if (Date.now() - indexCache.ts < 3000) return res.json(indexCache.data);

        // Prefer the live WebSocket feed (already subscribed to the whole
        // UNIVERSE, indices included); fall back to a one-off REST call for
        // any index not yet warmed up in the feed. Both branches are
        // freshness-tagged — a REST fallback is DELAYED, never presented as
        // indistinguishable from a fresh WS tick.
        const missing = INDEX_LABELS.filter(label => getLtpWithFreshness(label).value == null);
        const restPrices = missing.length > 0 ? await fetchBulkLtp(missing) : {};
        const restFetchedAt = Date.now();

        const result = INDEX_LABELS.map(label => {
            const wsFresh = getLtpWithFreshness(label);
            let ltp, ltpSource, ltpTs;
            if (wsFresh.value != null) {
                ltp = wsFresh.value; ltpSource = wsFresh.source; ltpTs = wsFresh.ts;
            } else if (restPrices[label] != null) {
                ltp = restPrices[label]; ltpSource = "DELAYED"; ltpTs = restFetchedAt;
            } else {
                ltp = null; ltpSource = "UNAVAILABLE"; ltpTs = null;
            }

            // Scan-derived change% comes from a DIFFERENT, possibly older
            // snapshot than the LTP above — expose its own source/age
            // explicitly rather than implying it's as fresh as `ltp`.
            let priceChange = null, chgPct = null, chgSource = "UNAVAILABLE", chgTs = null;
            const scanned = (state.data["15m_ALL"] || []).find(r => r.symbol === label) ||
                          (state.data["1d_ALL"] || []).find(r => r.symbol === label);
            if (scanned) {
                priceChange = scanned.priceChange;
                chgPct = scanned.chgPct;
                chgSource = scanned.priceSource || "UNKNOWN";
                chgTs = scanned.priceTs ?? null;
            }

            return { symbol: label, ltp, ltpSource, ltpTs, priceChange, chgPct, chgSource, chgTs };
        });

        indexCache = { ts: Date.now(), data: result };
        res.json(result);
    } catch (e) {
        console.error("[Indices] fetch error:", e.message);
        res.json(indexCache.data.length ? indexCache.data : []);
    }
});

// Theoretical option chain endpoint — uses Black-Scholes with scanner data
app.get("/api/theoretical-chain/:symbol", (req, res) => {
    const sym = req.params.symbol;
    // Find the stock in any timeframe bucket
    let rowData = null;
    for (const tf of ["5m", "15m", "1h", "1d"]) {
        const found = (state.data[`${tf}_ALL`] || []).find(r => r.symbol === sym);
        if (found) { rowData = found; break; }
    }
    if (!rowData) return res.status(404).json({ error: "Symbol not in scanner data" });

    // Days to next NSE expiry (next Thursday)
    const now = new Date();
    const day = now.getDay(); // 0=Sun, 4=Thu
    const daysToThursday = ((4 - day + 7) % 7) || 7;

    const chain = theoreticalOptionChain(rowData.price, rowData.hv ?? 0.25, daysToThursday);
    res.json({
        symbol: sym,
        spot: rowData.price,
        spotSource: rowData.priceSource || "UNKNOWN",
        spotTs: rowData.priceTs ?? null,
        hv: chain.hv,
        hvEstimated: rowData.hvEstimated ?? (rowData.hv == null),
        daysToExpiry: chain.daysToExpiry,
        callOptions: chain.calls,
        putOptions: chain.puts,
        theoretical: true,
        source: "Black-Scholes (Historical Volatility)",
    });
});

// ── Portfolio endpoint — Upstox holdings/positions already include last_price + pnl ──
app.get("/api/portfolio", async (req, res) => {
    if (!isAuthenticated) return res.status(401).json({ error: "Not authenticated" });

    try {
        const [holdings, positions] = await Promise.all([fetchHoldings(), fetchPositions()]);

        const holdingsWithPnL = holdings.map(h => {
            // NEVER substitute average_price (cost basis) for a missing
            // current price — that fabricates a ~0% "flat" P&L for a
            // position whose real current price we simply don't have.
            const currentPrice = h.last_price ?? null;
            const priceSource = currentPrice != null ? "LIVE" : "UNAVAILABLE";
            // Genuinely "now" — this IS a fresh Upstox REST call every time
            // this route is hit, not a cached value, so this timestamp is an
            // honest baseline for the frontend's 5s WS-refresh loop to age
            // against for holdings the WS feed never actually covers.
            const priceTs = currentPrice != null ? Date.now() : null;
            const investedValue = (h.average_price || 0) * (h.quantity || 0);
            const currentValue = currentPrice != null ? currentPrice * (h.quantity || 0) : null;
            const pnl = currentValue != null ? (h.pnl ?? (currentValue - investedValue)) : null;
            const pnlPercent = pnl != null && investedValue !== 0 ? (pnl / investedValue) * 100 : null;

            return {
                ...h,
                current_price: currentPrice != null ? +currentPrice.toFixed(2) : null,
                price_source: priceSource,
                price_ts: priceTs,
                current_value: currentValue != null ? +currentValue.toFixed(2) : null,
                invested_value: +investedValue.toFixed(2),
                pnl: pnl != null ? +pnl.toFixed(2) : null,
                pnl_percent: pnlPercent != null ? +pnlPercent.toFixed(2) : null,
                type: "holding"
            };
        });

        // Upstox reports exchange per-position (NSE/BSE cash, NFO/BFO F&O, MCX commodity)
        const segmentForExchange = (exchange) => {
            if (exchange === "NFO" || exchange === "BFO" || exchange === "CDS") return "FNO";
            if (exchange === "MCX") return "COMMODITY";
            return "CASH";
        };

        const allPositions = positions.map(p => {
            const qty = p.quantity || 0;
            const currentPrice = p.last_price ?? null;
            const priceSource = currentPrice != null ? "LIVE" : "UNAVAILABLE";
            const pnl = currentPrice != null ? (p.pnl ?? ((p.realised || 0) + (p.unrealised || 0))) : null;

            return {
                ...p,
                current_price: currentPrice != null ? +currentPrice.toFixed(2) : null,
                price_source: priceSource,
                entry_price: +(p.average_price || 0).toFixed(2),
                pnl: pnl != null ? +pnl.toFixed(2) : null,
                is_closed: qty === 0,
                type: "position",
                segment: segmentForExchange(p.exchange)
            };
        });

        // Totals only sum holdings/positions whose current price is actually
        // known — a missing price is excluded, never treated as 0, so the
        // total doesn't silently understate real exposure.
        const pricedHoldings = holdingsWithPnL.filter(h => h.current_value != null);
        const pricedPositions = allPositions.filter(p => p.pnl != null);
        const totalInvested = pricedHoldings.reduce((sum, h) => sum + h.invested_value, 0);
        const totalCurrent = pricedHoldings.reduce((sum, h) => sum + h.current_value, 0);
        const totalHoldingsPnL = totalCurrent - totalInvested;
        const totalPositionsPnL = pricedPositions.reduce((sum, p) => sum + p.pnl, 0);
        const pricingIncomplete = pricedHoldings.length < holdingsWithPnL.length || pricedPositions.length < allPositions.length;

        res.json({
            holdings: holdingsWithPnL,
            positions: allPositions,
            summary: {
                total_holdings_invested: +totalInvested.toFixed(2),
                total_holdings_current: +totalCurrent.toFixed(2),
                total_holdings_pnl: +totalHoldingsPnL.toFixed(2),
                total_positions_pnl: +totalPositionsPnL.toFixed(2),
                total_portfolio_pnl: +(totalHoldingsPnL + totalPositionsPnL).toFixed(2),
                holdings_count: holdingsWithPnL.length,
                positions_count: allPositions.length,
                // true if any total above excludes a holding/position whose
                // current price was unavailable — the total is real but partial.
                pricing_incomplete: pricingIncomplete,
            },
            // Non-null here means Upstox rejected the request for an account/
            // infra reason (e.g. static IP not configured) rather than there
            // simply being no data — the UI should show this, not "no holdings".
            restricted: {
                holdings: portfolioApiStatus.holdings?.message || null,
                positions: portfolioApiStatus.positions?.message || null,
            }
        });
    } catch (e) {
        console.error("[Portfolio] Error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Operator Scanner API endpoints — Intraday, Overnight, Equity ─────────────────

// Run full operator scan (all 3 tasks)
app.post("/api/operator/scan", async (req, res) => {
  if (!isAuthenticated) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  try {
    const marketContext = req.body.marketContext || {};

    // Transform scanner data
    const transformedData = transformScannerData(state);

    // Run operator scan
    const result = await runOperatorScan(transformedData, marketContext);

    res.json({
      ok: true,
      timestamp: result.lastScan,
      vix: result.vixState,
      task1: result.task1,
      task2: result.task2,
      task3: result.task3,
      starPicks: result.starPicks || [],
      alphaPicks: result.alphaPicks || [],
      marketSummary: buildMarketSummary()
    });
  } catch (e) {
    console.error("[Operator] Scan error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get current operator state (cached)
app.get("/api/operator/state", (_, res) => {
  res.json({
    ok: true,
    state: getOperatorState(),
    marketSummary: buildMarketSummary()
  });
});

// Get Task 1: Intraday F&O calls
app.get("/api/operator/intraday", (_, res) => {
  const opState = getOperatorState();
  res.json({
    ok: true,
    task: "Intraday F&O",
    calls: opState.task1.calls,
    summary: opState.task1.summary,
    vix: opState.vixState
  });
});

// Get Task 2: Overnight F&O calls
app.get("/api/operator/overnight", (_, res) => {
  const opState = getOperatorState();
  res.json({
    ok: true,
    task: "Overnight F&O",
    calls: opState.task2.calls,
    summary: opState.task2.summary,
    vix: opState.vixState
  });
});

// Get Task 3: Equity calls
app.get("/api/operator/equity", (_, res) => {
  const opState = getOperatorState();
  res.json({
    ok: true,
    task: "Equity Calls",
    calls: opState.task3.calls,
    summary: opState.task3.summary,
    vix: opState.vixState
  });
});

// Get market summary block (formatted text)
app.get("/api/operator/market-summary", (_, res) => {
  res.json({
    ok: true,
    summary: formatMarketSummaryBlock()
  });
});

// ── Operator Scanner UI Route ─────────────────────────────────────────────────
app.get("/operator", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "operator.html"));
});

// ── Catch-all Route: Serve SPA frontend ──────────────────────────────────────
app.get("*", (req, res) => {
    // Only serve index.html for non-API routes
    if (!req.path.startsWith("/api/") && !req.path.startsWith("/public/")) {
        res.sendFile(path.join(__dirname, "public", "index.html"));
    } else {
        res.status(404).json({ error: "Not Found", path: req.path });
    }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
    // Don't clear console in production (cloud hosting)
    if (process.env.NODE_ENV !== 'production') {
        console.clear();
    }

    console.log(`\n⚡ Ayush's Scanner (Upstox API) → http://localhost:${PORT}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);

    // Mark server as ready for health checks
    process.env.SERVER_READY = 'true';

    try {
        await login(); // verifies UPSTOX_ACCESS_TOKEN against a live Upstox call
        setIsAuthenticated(true);
        console.log("✅ Upstox token verified. Starting background scan + live feeds...\n");
        activateMarketData();
    } catch (e) {
        console.log(`❌ Upstox authentication failed: ${e.message}`);
        console.log("⏸️ Background market feeds are disabled until a valid UPSTOX_ACCESS_TOKEN is configured. Use the Login button to retry.");
    }
});

// Graceful shutdown for cloud platforms
process.on('SIGTERM', () => {
    console.log('\n🛑 SIGTERM received. Shutting down gracefully...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('\n🛑 SIGINT received. Shutting down gracefully...');
    process.exit(0);
});

// upstox-js-sdk's MarketDataStreamerV3 registers its own internal "open"
// listener that auto-resubscribes on every reconnect. If the underlying
// WebSocket isn't fully OPEN at that exact instant, MarketDataFeederV3.subscribe()
// throws synchronously several frames deep inside the SDK's own event-emission
// chain — a call stack we never enter, so there is no try/catch we can place
// around it from feed.mjs. Left unhandled, this kills the whole Node process
// and Render cold-restarts everything, wiping all in-memory scan progress —
// the actual cause behind repeated "stuck/empty" symptoms, distinct from
// ordinary Render free-tier sleep. This subsystem doesn't touch scan state,
// the DB, or the Express server, so surviving it is safe; feed.mjs's own
// reconnect loop keeps running underneath. Anything else still crashes.
process.on('uncaughtException', (err) => {
    if (err?.message?.includes('Failed to subscribe: WebSocket is not open') ||
        err?.message?.includes('Failed to changeMode: WebSocket is not open')) {
        console.error(`[Feed] Swallowed known upstox-js-sdk reconnect race: ${err.message}`);
        return;
    }
    console.error('Uncaught exception, exiting:', err);
    process.exit(1);
});
