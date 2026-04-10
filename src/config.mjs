import path from "path";
import { fileURLToPath } from "url";

export const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const TOKEN_FILE = path.join(__dirname, "..", ".groww_session.json");

// Environment variable handling for special characters in secrets
// If secret contains special chars, URL-encode it or use base64 encoding
const getApiSecret = () => {
    const envSecret = process.env.GROWW_API_SECRET;
    if (envSecret) {
        // If it starts with "base64:", decode it
        if (envSecret.startsWith("base64:")) {
            return Buffer.from(envSecret.slice(7), "base64").toString("utf-8");
        }
        // Otherwise use as-is (Render may have corrupted special chars)
        return envSecret;
    }
    // Fallback to hardcoded secret (only for local dev)
    return "***REDACTED_SECRET***";
};

export const CREDS = {
    apiKey: process.env.GROWW_API_KEY || "***REDACTED_JWT***",
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
