import express from "express";
import path from "path";
import { __dirname } from "./src/config.mjs";
import { loadSession, login, fetchOptionChain, fetchBulkLtp } from "./src/groww.mjs";
import { state, scanning, isAuthenticated, setIsAuthenticated, scanAll, startScan, scanProgress } from "./src/scanner.mjs";
import { startOptionsFeed } from "./src/options_feed.mjs";
import { UNIVERSE } from "./src/universe.mjs";
import { isMarketOpen } from "./src/scanner.mjs";
import { theoreticalOptionChain } from "./src/indicators.mjs";

// In-memory cache for option chain data: symbol -> { data, fetchedAt }
const optionChainCache = new Map();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend
app.use(express.static(path.join(__dirname, "..", "public")));

const PORT = process.env.PORT || 4000;

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/api/state", (_, res) => res.json(state));
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
    const marketOpen = isMarketOpen();

    // If market is open, try fetching live data
    if (marketOpen) {
        try {
            const liveData = await fetchOptionChain(sym);
            if (liveData && (liveData.callOptions || liveData.calls)) {
                // Cache it with timestamp
                optionChainCache.set(sym, { data: liveData, fetchedAt: new Date().toISOString() });
                return res.json({ ...liveData, theoretical: false, source: "live", fetchedAt: optionChainCache.get(sym).fetchedAt });
            }
        } catch (e) {
            console.error(`Option chain live fetch error [${sym}]:`, e.message);
        }
    }

    // Market closed or live failed: serve from cache if available
    const cached = optionChainCache.get(sym);
    if (cached) {
        return res.json({ ...cached.data, source: "cache", fetchedAt: cached.fetchedAt });
    }

    // Nothing available
    return res.status(404).json({ error: "no_data", message: "No option chain data available. Open the market hours to fetch live data." });
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
            return { symbol: label, ltp };
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
