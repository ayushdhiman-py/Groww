import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

export const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Environment Variable Loading (Local + Production) ─────────────────────────
// Render: Sets process.env.* automatically from dashboard
// Local: Load from .env file if it exists

const require = createRequire(import.meta.url);

// Try to load dotenv for local development (won't affect Render)
try {
    const dotenvPath = path.join(__dirname, "..", ".env");
    const fs = await import("fs");
    if (fs.existsSync(dotenvPath)) {
        const dotenv = require("dotenv");
        dotenv.config({ path: dotenvPath });
        console.log("[Config] ✅ Loaded .env file for local development");
    }
} catch (e) {
    // dotenv not installed or .env doesn't exist - that's fine for Render
    if (e.code !== "MODULE_NOT_FOUND" && !e.message.includes("dotenv")) {
        console.log("[Config] Note: Running without .env file (Render hosting mode)");
    }
}

// ── Environment Variable Handling ──────────────────────────────────────────────

// Helper: Get env var with trimming and required check
const getEnv = (key, fallback) => {
    let val = process.env[key];
    if (val === undefined || val === "") {
        if (fallback !== undefined) {
            if (fallback !== null) {
                console.log(`[Config] ⚠️ ${key} not set, using fallback (local dev only)`);
            }
            return fallback;
        }
        throw new Error(`[Config] ❌ Missing required environment variable: ${key}`);
    }

    val = val.trim();
    // Strip quotes if present
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
    }
    return val;
};

// ── Upstox Credentials ──────────────────────────────────────────────────────────
// Upstox Analytics Token: long-lived (~1yr), read-only, generated once from the
// Upstox Developer Apps dashboard. No daily login/checksum flow is required.
export const CREDS = {
    accessToken: getEnv("UPSTOX_ACCESS_TOKEN", null),
};

if (CREDS.accessToken) {
    console.log(`[Config] ✅ Upstox access token loaded. Length: ${CREDS.accessToken.length}`);
} else {
    console.warn("[Config] ⚠️ UPSTOX_ACCESS_TOKEN not set. Market data calls will fail until it is configured.");
}

// ── Upstox API URLs ──────────────────────────────────────────────────────────────
export const BASE_URL = "https://api.upstox.com";
export const LTP_URL = `${BASE_URL}/v3/market-quote/ltp`;
export const QUOTES_URL = `${BASE_URL}/v2/market-quote/quotes`; // full quote incl. bid/ask depth
export const HISTORICAL_CANDLE_BASE = `${BASE_URL}/v3/historical-candle`;
export const OPTION_CHAIN_URL = `${BASE_URL}/v2/option/chain`;
export const HOLDINGS_URL = `${BASE_URL}/v2/portfolio/long-term-holdings`;
export const POSITIONS_URL = `${BASE_URL}/v2/portfolio/short-term-positions`;
export const INSTRUMENT_MASTER_URL = "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

export const TF_MAP = {
    "1m": 1, "5m": 5, "10m": 10, "15m": 15, "30m": 30,
    "1h": 60, "1d": 1440
};

export const TF_DAYS = {
    "1m": 5, "5m": 10, "10m": 15, "15m": 20,
    "30m": 30, "1h": 60, "1d": 365
};

// ── Intraday Actionable-Quality layer (src/trade_plan.mjs, position_sizing.mjs,
// actionable_score.mjs) — tunable via env vars, sane defaults otherwise.
// Capital is a configured ASSUMPTION for sizing math, never a live broker
// balance read (see position_sizing.mjs).
export const DEFAULT_CAPITAL_INR = Number(process.env.DEFAULT_CAPITAL_INR) || 750000;
export const MAX_RISK_PCT_PER_TRADE = Number(process.env.MAX_RISK_PCT_PER_TRADE) || 1;
export const MAX_CAPITAL_ALLOCATION_PCT_PER_TRADE = Number(process.env.MAX_CAPITAL_ALLOCATION_PCT_PER_TRADE) || 20;
export const MIN_RR_RATIO = Number(process.env.MIN_RR_RATIO) || 1.3;
export const MIN_ACTIONABLE_SCORE_FLOOR = Number(process.env.MIN_ACTIONABLE_SCORE_FLOOR) || 75;
export const MAX_DISPLAYED_OPPORTUNITIES = Number(process.env.MAX_DISPLAYED_OPPORTUNITIES) || 50;
// Size of the Intraday-only cheap-prefilter candidate pool (src/stage1_filter.mjs's
// selectIntradayCandidates) — independent of Stage-2's own ~55-100 shortlist,
// so a stock isn't excluded from Intraday merely because Stage-2 didn't pick it.
export const INTRADAY_PREFILTER_TOP_N = Number(process.env.INTRADAY_PREFILTER_TOP_N) || 80;
