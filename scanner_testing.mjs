import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { __dirname as srcDirname } from "./src/config.mjs";
import { loadSession, login, fetchBulkLtp, fetchOptionChain, fetchHoldings, fetchPositions } from "./src/groww.mjs";
import { state, scanning, isAuthenticated, setIsAuthenticated, scanAll, startScan, scanProgress } from "./src/scanner.mjs";
import { startOptionsFeed, optionsCache } from "./src/options_feed.mjs";
import { livePrices } from "./src/feed.mjs";
import { UNIVERSE } from "./src/universe.mjs";
import { isMarketOpen } from "./src/scanner.mjs";
import { theoreticalOptionChain } from "./src/indicators.mjs";

// Fix __dirname for root directory (scanner_testing.mjs is in root)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend - point to public/ in root
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 4000;

// ── Option Chain Cache with TTL (10s) ────────────────────────────────────────
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

// ── Routes ────────────────────────────────────────────────────────────────────

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
}));

app.post("/api/login", async (req, res) => {
    try {
        await login();
        setIsAuthenticated(true);
        // scanAll(); // Trigger immediate scan
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

    // 3. Fetch REAL option chain from Groww API
    try {
        const rawChain = await fetchOptionChain(sym);

        if (rawChain) {
            const fetchedAt = new Date().toISOString();

            // Parse and format real data
            const rawStrikes = rawChain.strikes || rawChain.strikeData || {};
            const calls = [];
            const puts = [];

            // Handle both array and object formats for strike data
            if (Array.isArray(rawStrikes)) {
                // Array format: [{ strikePrice, callOption, putOption }, ...]
                rawStrikes.forEach(s => {
                    if (s.callOption) {
                        calls.push({
                            strikePrice: s.strikePrice || s.strike,
                            ltp: s.callOption?.lastPrice || s.callOption?.ltp || 0,
                            openInterest: s.callOption?.openInterest || s.callOption?.oi || 0,
                            oiChange: s.callOption?.changeInOI || s.callOption?.oiChange || 0,
                            volume: s.callOption?.totalTradedVolume || s.callOption?.volume || 0,
                            greeks: {
                                delta: s.callOption?.delta || 0,
                                gamma: s.callOption?.gamma || 0,
                                theta: s.callOption?.theta || 0,
                                vega: s.callOption?.vega || 0,
                                iv: (s.callOption?.impliedVolatility || s.callOption?.iv || 0) * 100,
                            },
                            type: "CE",
                        });
                    }
                    if (s.putOption) {
                        puts.push({
                            strikePrice: s.strikePrice || s.strike,
                            ltp: s.putOption?.lastPrice || s.putOption?.ltp || 0,
                            openInterest: s.putOption?.openInterest || s.putOption?.oi || 0,
                            oiChange: s.putOption?.changeInOI || s.putOption?.oiChange || 0,
                            volume: s.putOption?.totalTradedVolume || s.putOption?.volume || 0,
                            greeks: {
                                delta: s.putOption?.delta || 0,
                                gamma: s.putOption?.gamma || 0,
                                theta: s.putOption?.theta || 0,
                                vega: s.putOption?.vega || 0,
                                iv: (s.putOption?.impliedVolatility || s.putOption?.iv || 0) * 100,
                            },
                            type: "PE",
                        });
                    }
                });
            } else if (typeof rawStrikes === 'object' && rawStrikes !== null) {
                // Object format: { "1000": { CE: {...}, PE: {...} }, "1100": {...} }
                for (const [strikePrice, optionsData] of Object.entries(rawStrikes)) {
                    const strike = parseFloat(strikePrice);
                    if (optionsData.CE) {
                        calls.push({
                            strikePrice: strike,
                            ltp: optionsData.CE.lastPrice || optionsData.CE.ltp || 0,
                            openInterest: optionsData.CE.openInterest || optionsData.CE.oi || 0,
                            oiChange: optionsData.CE.changeInOI || optionsData.CE.oiChange || 0,
                            volume: optionsData.CE.totalTradedVolume || optionsData.CE.volume || 0,
                            greeks: {
                                delta: optionsData.CE.delta || 0,
                                gamma: optionsData.CE.gamma || 0,
                                theta: optionsData.CE.theta || 0,
                                vega: optionsData.CE.vega || 0,
                                iv: (optionsData.CE.impliedVolatility || optionsData.CE.iv || 0) * 100,
                            },
                            type: "CE",
                        });
                    }
                    if (optionsData.PE) {
                        puts.push({
                            strikePrice: strike,
                            ltp: optionsData.PE.lastPrice || optionsData.PE.ltp || 0,
                            openInterest: optionsData.PE.openInterest || optionsData.PE.oi || 0,
                            oiChange: optionsData.PE.changeInOI || optionsData.PE.oiChange || 0,
                            volume: optionsData.PE.totalTradedVolume || optionsData.PE.volume || 0,
                            greeks: {
                                delta: optionsData.PE.delta || 0,
                                gamma: optionsData.PE.gamma || 0,
                                theta: optionsData.PE.theta || 0,
                                vega: optionsData.PE.vega || 0,
                                iv: (optionsData.PE.impliedVolatility || optionsData.PE.iv || 0) * 100,
                            },
                            type: "PE",
                        });
                    }
                }
            } else {
                console.warn(`[OptionChain] Unexpected strike data format for ${sym}:`, typeof rawStrikes);
            }

            // Sort by volume and pick top 5
            const topCalls = calls.sort((a, b) => b.volume - a.volume).slice(0, 5);
            const topPuts = puts.sort((a, b) => b.volume - a.volume).slice(0, 5);

            const result = {
                symbol: sym,
                spot: rawChain.underlyingValue || rawChain.spot || 0,
                expiry: rawChain.expiryDate || rawChain.expiry,
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
        console.error(`[OptionChain] Groww API error for ${sym}:`, err.message);
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

// ── Indices LTP endpoint ──────────────────────────────────────────────────────
const INDEX_SYMBOLS = ["NIFTY 50", "NIFTY BANK", "NIFTY FIN SERVICE", "SENSEX", "NIFTY MID SELECT"];
const INDEX_LABELS  = ["NIFTY",   "BANKNIFTY", "FINNIFTY",          "SENSEX", "MIDCPNIFTY"];
let   indexCache    = { ts: 0, data: [] };

app.get("/api/indices", async (_, res) => {
    try {
        if (!isAuthenticated) return res.json([]);
        if (Date.now() - indexCache.ts < 3000) return res.json(indexCache.data);

        // Fetch using the central bulk LTP utility
        // Need to pass exactly what's requested. We use INDEX_SYMBOLS and map back.
        // Wait, fetchBulkLtp uses Groww format (e.g. BSE_SENSEX, NSE_NIFTY 50)...
        const rawSymbols = INDEX_LABELS.map(sym => 
            sym === "SENSEX" ? "BSE_SENSEX" : `NSE_${sym}`
        );
        
        const prices = await fetchBulkLtp(rawSymbols);
        
        const result = INDEX_LABELS.map(label => {
            const lookupLabel = label === "MIDCPNIFTY" ? "NIFTYMIDSELECT" : label === "SENSEX" ? "SENSEX" : label;
            const ltp = prices[lookupLabel] || null;
            
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

// ── Portfolio endpoint — fetch holdings + positions with LTP ──────────────
app.get("/api/portfolio", async (req, res) => {
    if (!isAuthenticated) return res.status(401).json({ error: "Not authenticated" });

    try {
        // Fetch holdings (long-term investments)
        const holdings = await fetchHoldings();

        // Fetch positions for all segments
        const [cashPositions, fnoPositions, commodityPositions] = await Promise.all([
            fetchPositions("CASH"),
            fetchPositions("FNO"),
            fetchPositions("COMMODITY")
        ]);

        // Get current LTP for holdings (equity/cash segment)
        const holdingSymbols = holdings.map(h => h.trading_symbol);
        const cashPositionSymbols = cashPositions.map(p => p.trading_symbol);
        const isFnoSymbol = (sym) => /\d{2}(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{2,4}(CE|PE)/i.test(sym);
        const equitySymbols = [...new Set([...holdingSymbols, ...cashPositionSymbols])].filter(s => !isFnoSymbol(s));

        // Get open F&O positions and fetch their LTP from FNO segment
        const openFnoPositions = fnoPositions.filter(p => (p.quantity || 0) > 0);
        const fnoSymbols = [...new Set(openFnoPositions.map(p => p.trading_symbol))];

        // Get open commodity positions
        const openCommodityPositions = commodityPositions.filter(p => (p.quantity || 0) > 0);
        const commoditySymbols = [...new Set(openCommodityPositions.map(p => p.trading_symbol))];

        let equityLtpMap = {};
        let fnoLtpMap = {};
        let commodityLtpMap = {};

        if (equitySymbols.length > 0) {
            try {
                equityLtpMap = await fetchBulkLtp(equitySymbols, "CASH");
            } catch (e) {
                console.error("[Portfolio] Equity LTP fetch error:", e.message);
            }
        }

        if (fnoSymbols.length > 0) {
            try {
                console.log(`[Portfolio] Fetching F&O LTP for:`, fnoSymbols);
                fnoLtpMap = await fetchBulkLtp(fnoSymbols, "FNO");
                console.log(`[Portfolio] F&O LTP result:`, fnoLtpMap);
            } catch (e) {
                console.error("[Portfolio] F&O LTP fetch error:", e.message);
            }
        }

        if (commoditySymbols.length > 0) {
            try {
                console.log(`[Portfolio] Fetching Commodity LTP for:`, commoditySymbols);
                commodityLtpMap = await fetchBulkLtp(commoditySymbols, "COMMODITY");
                console.log(`[Portfolio] Commodity LTP result:`, commodityLtpMap);
            } catch (e) {
                console.error("[Portfolio] Commodity LTP fetch error:", e.message);
            }
        }

        const ltpMap = { ...equityLtpMap, ...fnoLtpMap, ...commodityLtpMap };

        // Calculate holdings with current values and P&L
        const holdingsWithPnL = holdings.map(h => {
            const currentPrice = ltpMap[h.trading_symbol] || h.average_price;
            const currentValue = currentPrice * h.quantity;
            const investedValue = h.average_price * h.quantity;
            const pnl = currentValue - investedValue;
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

        // Calculate positions with proper unrealised P&L for open positions
        const formatPosition = (p, segment = "CASH") => {
            const qty = p.quantity || 0;
            const isClosed = qty === 0;
            const entryPrice = p.net_price || 0;
            const currentPrice = ltpMap[p.trading_symbol] || entryPrice;

            let unrealisedPnl = 0;
            if (isClosed) {
                // Closed position: only realised P&L
                unrealisedPnl = p.realised_pnl || 0;
            } else {
                // Open position: calculate unrealised P&L
                // For long: (current - entry) * qty
                // For short: (entry - current) * qty
                if (qty > 0) {
                    unrealisedPnl = (currentPrice - entryPrice) * qty;
                } else {
                    // Net short position
                    unrealisedPnl = (entryPrice - currentPrice) * Math.abs(qty);
                }
                // Add any realised P&L from partial closes
                unrealisedPnl += (p.realised_pnl || 0);
            }

            return {
                ...p,
                current_price: +currentPrice.toFixed(2),
                entry_price: +entryPrice.toFixed(2),
                pnl: +unrealisedPnl.toFixed(2),
                is_closed: isClosed,
                type: "position",
                segment: segment
            };
        };

        const allPositions = [
            ...cashPositions.map(p => formatPosition(p, "CASH")),
            ...fnoPositions.map(p => formatPosition(p, "FNO")),
            ...commodityPositions.map(p => formatPosition(p, "COMMODITY"))
        ];

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
            }
        });
    } catch (e) {
        console.error("[Portfolio] Error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Catch-all Route: Serve SPA frontend ─────────────────────────────────────
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
    
    console.log(`\n⚡ Ayush's Scanner (Groww API) → http://localhost:${PORT}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    
    // Mark server as ready for health checks
    process.env.SERVER_READY = 'true';

    if (loadSession()) {
        setIsAuthenticated(true);
        console.log("✅ Session active. Starting background scan...\n");
        startScan();
        startOptionsFeed();
    } else {
        console.log("❌ No session. Login via UI to begin.\n");
        startScan();
        startOptionsFeed();
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
