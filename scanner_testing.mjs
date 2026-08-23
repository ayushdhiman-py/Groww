import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { __dirname as srcDirname } from "./src/config.mjs";
import { login, fetchBulkLtp, fetchOptionChain, fetchHoldings, fetchPositions, portfolioApiStatus } from "./src/upstox.mjs";
import { state, scanning, isAuthenticated, setIsAuthenticated, scanAll, startScan, scanProgress } from "./src/scanner.mjs";
import { startOptionsFeed, optionsCache } from "./src/options_feed.mjs";
import { startFeed, livePrices, getLtp } from "./src/feed.mjs";
import { UNIVERSE } from "./src/universe.mjs";
import { isMarketOpen } from "./src/scanner.mjs";
import { theoreticalOptionChain } from "./src/indicators.mjs";
import { runOperatorScan, getOperatorState, buildMarketSummary, formatMarketSummaryBlock, transformScannerData } from "./src/operator_scanner.mjs";
import { isDividendServiceAvailable } from "./src/dividend.mjs";

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

// Lightweight LTP endpoint - returns only live prices (tiny payload ~2KB)
app.get("/api/ltp", (_, res) => {
    res.json(Object.fromEntries(livePrices));
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

app.get("/api/status", (_, res) => res.json({
    authenticated: isAuthenticated,
    scanning,
    scanProgress,
    lastUpdated: state.lastUpdated,
    errors: state.errors.length,
    universe: UNIVERSE.length,
    dividendAvailable: isDividendServiceAvailable(),
}));

// Starts (or no-ops if already running) background scanning + live feeds.
// Safe to call from both server boot and /api/login, since scanAll/startFeed/
// startOptionsFeed all guard against double-starting internally.
function activateMarketData() {
    startScan();
    startFeed(() => {});
    startOptionsFeed();
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

    // 2. Check shared cache (populated by background feed)
    const cached = optionsCache.get(sym);
    if (cached) {
        const result = { ...cached, source: "cache", fetchedAt: cached.updatedAt };
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
                if (optionsData.CE) {
                    calls.push({
                        strikePrice: strike,
                        ltp: optionsData.CE.lastPrice || 0,
                        openInterest: optionsData.CE.open_interest || 0,
                        oiChange: optionsData.CE.changeInOI || 0,
                        volume: optionsData.CE.volume || 0,
                        greeks: {
                            delta: optionsData.CE.delta || 0,
                            gamma: optionsData.CE.gamma || 0,
                            theta: optionsData.CE.theta || 0,
                            vega: optionsData.CE.vega || 0,
                            iv: optionsData.CE.impliedVolatility || 0,
                        },
                        type: "CE",
                    });
                }
                if (optionsData.PE) {
                    puts.push({
                        strikePrice: strike,
                        ltp: optionsData.PE.lastPrice || 0,
                        openInterest: optionsData.PE.open_interest || 0,
                        oiChange: optionsData.PE.changeInOI || 0,
                        volume: optionsData.PE.volume || 0,
                        greeks: {
                            delta: optionsData.PE.delta || 0,
                            gamma: optionsData.PE.gamma || 0,
                            theta: optionsData.PE.theta || 0,
                            vega: optionsData.PE.vega || 0,
                            iv: optionsData.PE.impliedVolatility || 0,
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
                spot: rawChain.underlying_ltp || 0,
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

    // 4. Fallback: Generate theoretical option chain from scanner data (Black-Scholes)
    let rowData = null;
    for (const tf of ["5m", "15m", "1h", "1d"]) {
        const found = (state.data[`${tf}_ALL`] || []).find(r => r.symbol === sym);
        if (found) { rowData = found; break; }
    }

    if (rowData) {
        const now = new Date();
        const day = now.getDay();
        const daysToThursday = ((4 - day + 7) % 7) || 7;

        const chain = theoreticalOptionChain(rowData.price, rowData.hv || 0.25, daysToThursday, sym);
        const fetchedAt = new Date().toISOString();

        const result = {
            symbol: sym,
            spot: rowData.price,
            hv: chain.hv,
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

    // 5. Nothing available
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
        // any index not yet warmed up in the feed.
        const missing = INDEX_LABELS.filter(label => getLtp(label) == null);
        const restPrices = missing.length > 0 ? await fetchBulkLtp(missing) : {};

        const result = INDEX_LABELS.map(label => {
            const ltp = getLtp(label) ?? restPrices[label] ?? null;

            // Try to find scanned data for accurate change info
            let priceChange = null, chgPct = null;
            const scanned = (state.data["15m_ALL"] || []).find(r => r.symbol === label) ||
                          (state.data["1d_ALL"] || []).find(r => r.symbol === label);
            if (scanned) {
                priceChange = scanned.priceChange;
                chgPct = scanned.chgPct;
            }

            return { symbol: label, ltp, priceChange, chgPct };
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

    const chain = theoreticalOptionChain(rowData.price, rowData.hv || 0.25, daysToThursday);
    res.json({
        symbol: sym,
        spot: rowData.price,
        hv: chain.hv,
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
            const currentPrice = h.last_price ?? h.average_price ?? 0;
            const currentValue = currentPrice * (h.quantity || 0);
            const investedValue = (h.average_price || 0) * (h.quantity || 0);
            const pnl = h.pnl ?? (currentValue - investedValue);
            const pnlPercent = investedValue !== 0 ? (pnl / investedValue) * 100 : 0;

            return {
                ...h,
                current_price: +currentPrice.toFixed(2),
                current_value: +currentValue.toFixed(2),
                invested_value: +investedValue.toFixed(2),
                pnl: +pnl.toFixed(2),
                pnl_percent: +pnlPercent.toFixed(2),
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
            const currentPrice = p.last_price ?? p.average_price ?? 0;
            const pnl = p.pnl ?? ((p.realised || 0) + (p.unrealised || 0));

            return {
                ...p,
                current_price: +currentPrice.toFixed(2),
                entry_price: +(p.average_price || 0).toFixed(2),
                pnl: +pnl.toFixed(2),
                is_closed: qty === 0,
                type: "position",
                segment: segmentForExchange(p.exchange)
            };
        });

        // Calculate totals
        const totalInvested = holdingsWithPnL.reduce((sum, h) => sum + h.invested_value, 0);
        const totalCurrent = holdingsWithPnL.reduce((sum, h) => sum + h.current_value, 0);
        const totalHoldingsPnL = totalCurrent - totalInvested;
        const totalPositionsPnL = allPositions.reduce((sum, p) => sum + (p.pnl || 0), 0);

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
                positions_count: allPositions.length
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
    const transformedData = transformScannerData(state, optionsCache);

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
