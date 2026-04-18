import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

export const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const TOKEN_FILE = path.join(__dirname, "..", ".groww_session.json");

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
        if (fallback) {
            console.log(`[Config] ⚠️ ${key} not set, using fallback (local dev only)`);
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

// Helper: Decode base64 secret if prefixed
const getApiSecret = () => {
    const raw = getEnv("GROWW_API_SECRET", null);
    
    let secret = raw;
    // Base64 encoded (recommended for Render to avoid special char corruption)
    if (raw.startsWith("base64:")) {
        secret = Buffer.from(raw.slice(7), "base64").toString("utf-8");
        console.log(`[Config] ✅ API Secret decoded from base64. Length: ${secret.length}`);
    } else {
        console.log(`[Config] ✅ API Secret loaded from env. Length: ${secret.length} (expected: 30)`);
    }
    
    if (secret.length < 30 || secret.length > 32) {
        console.warn(`[Config] ⚠️ WARNING: API Secret length is ${secret.length}, expected 30-32. Login may fail.`);
    } else {
        console.log(`[Config] ✅ API Secret length: ${secret.length} (valid)`);
    }
    
    return secret;
};

export const CREDS = {
    apiKey: getEnv("GROWW_API_KEY", null),
    apiSecret: getApiSecret(),
};

export const BASE_URL = "https://api.groww.in";
export const TOKEN_URL = `${BASE_URL}/v1/token/api/access`;
export const CANDLE_URL = `${BASE_URL}/v1/historical/candle/range`;

export const TF_MAP = {
    "1m": 1, "5m": 5, "10m": 10, "15m": 15, "30m": 30,
    "1h": 60, "1d": 1440
};

export const TF_DAYS = {
    "1m": 5, "5m": 10, "10m": 15, "15m": 20,
    "30m": 30, "1h": 60, "1d": 365
};
