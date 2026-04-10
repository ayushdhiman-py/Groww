import express from "express";
import path from "path";
import { __dirname } from "./src/config.mjs";
import { loadSession, login, fetchBulkLtp } from "./src/groww.mjs";
import { state, scanning, isAuthenticated, setIsAuthenticated, scanAll, startScan, scanProgress } from "./src/scanner.mjs";
import { startOptionsFeed, optionsCache } from "./src/options_feed.mjs";
import { UNIVERSE } from "./src/universe.mjs";
import { isMarketOpen } from "./src/scanner.mjs";
import { theoreticalOptionChain } from "./src/indicators.mjs";

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

    // 1. Check shared cache first (populated by background feed)
    const cached = optionsCache.get(sym);
    if (cached) {
        return res.json({ ...cached, source: "cache", fetchedAt: cached.updatedAt });
    }

    // 2. Generate theoretical option chain from scanner data (Black-Scholes)
    let rowData = null;
    for (const tf of ["5m", "15m", "1h", "1d"]) {
        const found = (state.data[`${tf}_ALL`] || []).find(r => r.symbol === sym);
        if (found) { rowData = found; break; }
    }

    if (rowData) {
        // Days to next Thursday (NSE weekly expiry)
        const now = new Date();
        const day = now.getDay();
        const daysToThursday = ((4 - day + 7) % 7) || 7;

        const chain = theoreticalOptionChain(rowData.price, rowData.hv || 0.25, daysToThursday, sym);
        const fetchedAt = new Date().toISOString();

        return res.json({
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
        });
    }

    // 3. Nothing available (scanner hasn't processed this symbol yet)
    return res.status(404).json({ error: "no_data", message: `Scanner hasn't processed ${sym} yet. Please wait for the next scan cycle.` });
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
