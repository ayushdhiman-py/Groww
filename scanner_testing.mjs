import express from "express";
import path from "path";
import { createHash } from "crypto";
import { __dirname } from "./src/config.mjs";
import { loadSession, login, fetchBulkLtp, fetchOptionChain } from "./src/groww.mjs";
import { state, scanning, isAuthenticated, setIsAuthenticated, scanAll, startScan, scanProgress } from "./src/scanner.mjs";
import { startOptionsFeed, optionsCache } from "./src/options_feed.mjs";
import { livePrices } from "./src/feed.mjs";
import { UNIVERSE } from "./src/universe.mjs";
import { isMarketOpen } from "./src/scanner.mjs";
import { theoreticalOptionChain } from "./src/indicators.mjs";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend
app.use(express.static(path.join(__dirname, "..", "public")));

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

// ── Boot ──────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
    console.clear();
    console.log(`\n⚡ Ayush's Scanner (Groww API) → http://localhost:${PORT}`);
    
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
