import fs from "fs";
import axios from "axios";
import { createHash } from "crypto";
import { TOKEN_FILE, CREDS, TOKEN_URL, CANDLE_URL, TF_DAYS } from "./config.mjs";

let session = { accessToken: null, expires: 0 };

export function loadSession() {
    try {
        if (fs.existsSync(TOKEN_FILE)) {
            const d = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
            if (d.accessToken && Date.now() < d.expires) {
                session = d;
                console.log("Session loaded — valid until:", new Date(d.expires).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }));
                return true;
            }
        }
    } catch (_) { }
    return false;
}

export function saveSession(accessToken) {
    session = { accessToken, expires: Date.now() + 23 * 3600 * 1000 };
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(session));
}

export async function login() {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const checksum = createHash("sha256").update(CREDS.apiSecret + timestamp).digest("hex");
    console.log("Logging in to Groww API...");
    console.log("Timestamp:", timestamp, "| Checksum:", checksum.substring(0, 12) + "...");
    try {
        const res = await axios.post(TOKEN_URL, {
            key_type: "approval",
            checksum,
            timestamp,
        }, {
            headers: {
                "Authorization": `Bearer ${CREDS.apiKey}`,
                "Content-Type": "application/json",
                "X-API-VERSION": "1.0",
            },
            timeout: 15000,
        });
        console.log("Groww auth response:", JSON.stringify(res.data).substring(0, 200));
        const token = res.data?.token || res.data?.accessToken || res.data?.access_token || res.data?.data?.token;
        if (!token) throw new Error("No token in response: " + JSON.stringify(res.data));
        saveSession(token);
        console.log("Groww login successful ✓");
    } catch (e) {
        console.error("Groww login error:", e.response?.status, e.response?.data || e.message);
        throw new Error(e.response?.data?.message || e.response?.data?.error || e.message);
    }
}

export async function ensureSession() {
    if (session.accessToken && Date.now() < session.expires) return;
    await login();
}

export async function fetchCandles(symbol, tf) {
    await ensureSession();
    const to = new Date(), from = new Date(to - TF_DAYS[tf] * 86400000);
    const intervalMap = {
        "1m": 1, "5m": 5, "10m": 10, "15m": 15,
        "30m": 30, "1h": 60, "1d": 1440
    };
    const interval = intervalMap[tf];
    const params = {
        exchange: "NSE",
        segment: "CASH",
        trading_symbol: symbol,
        start_time: from.getTime(),
        end_time: to.getTime(),
        interval_in_minutes: interval
    };
    const headers = {
        "Authorization": `Bearer ${session.accessToken}`,
        "X-API-VERSION": "1.0",
        "Accept": "application/json",
    };
    const res = await axios.get(CANDLE_URL, { params, headers, timeout: 20000 });
    const candles = res.data?.payload?.candles || res.data?.candles || res.data?.data?.candles || [];
    return candles.map(c => ({
        ts: c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5]
    }));
}
