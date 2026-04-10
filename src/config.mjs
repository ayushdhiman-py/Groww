import path from "path";
import { fileURLToPath } from "url";

export const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const TOKEN_FILE = path.join(__dirname, "..", ".groww_session.json");

// ── Environment Variable Handling ──────────────────────────────────────────────
// Render sets process.env.* automatically from Environment Variables section.
// No dotenv needed. No file loading needed.

// Helper: Get env var with trimming and required check
const getEnv = (key, fallback) => {
    const val = process.env[key];
    if (val === undefined || val === "") {
        if (fallback) {
            console.log(`[Config] ⚠️ ${key} not set, using fallback (local dev only)`);
            return fallback;
        }
        throw new Error(`[Config] ❌ Missing required environment variable: ${key}`);
    }
    return val.trim(); // Remove invisible newlines/whitespace
};

// Helper: Decode base64 secret if prefixed
const getApiSecret = () => {
    const raw = getEnv("GROWW_API_SECRET", null);
    
    // Base64 encoded (recommended for Render to avoid special char corruption)
    if (raw.startsWith("base64:")) {
        const decoded = Buffer.from(raw.slice(7), "base64").toString("utf-8");
        console.log(`[Config] ✅ API Secret decoded from base64. Length: ${decoded.length}`);
        return decoded;
    }
    
    // Raw value (may have corrupted special chars if pasted directly)
    console.log(`[Config] ✅ API Secret loaded from env. Length: ${raw.length} (expected: 30)`);
    return raw;
};

export const CREDS = {
    apiKey: getEnv("GROWW_API_KEY", "***REDACTED_JWT***"),
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
