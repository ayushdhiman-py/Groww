import express from "express";
import path from "path";
import { __dirname } from "./src/config.mjs";
import { loadSession, login } from "./src/groww.mjs";
import { state, scanning, isAuthenticated, setIsAuthenticated, scanAll, startScan } from "./src/scanner.mjs";
import { UNIVERSE } from "./src/universe.mjs";

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
    lastUpdated: state.lastUpdated,
    errors: state.errors.length,
    universe: UNIVERSE.length,
}));

app.post("/api/login", async (req, res) => {
    try {
        await login();
        setIsAuthenticated(true);
        scanAll();
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
    console.log(`\n⚡ Ayush's Personal Scanner (Groww API) → http://localhost:${PORT}`);
    if (loadSession()) {
        setIsAuthenticated(true);
        console.log("Existing Groww session found. Starting scan...\n");
        startScan(); // Start background loop
    } else {
        console.log("No active session. Please login via the UI to start scanning.\n");
        // Start background loop anyway so it can pick up auth later
        startScan();
    }
});
