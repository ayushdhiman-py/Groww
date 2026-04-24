import fs from "fs";
import axios from "axios";
import { createHash } from "crypto";
import path from "path";
import { TOKEN_FILE, CREDS, TOKEN_URL, CANDLE_URL, TF_DAYS, BASE_URL, __dirname } from "./config.mjs";

const BACKOFF_FILE = path.join(__dirname, "..", ".groww_backoff.json");

let session = { accessToken: null, expires: 0 };

export function isLoggedIn() {
    return !!(session.accessToken && Date.now() < session.expires);
}

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

let loginPromise = null;
let lastLoginAttempt = 0;
const LOGIN_COOLDOWN = 60000;

// ── Persistent backoff (survives restarts) ────────────────────────────────────
function loadBackoff() {
    try {
        if (fs.existsSync(BACKOFF_FILE)) {
            const d = JSON.parse(fs.readFileSync(BACKOFF_FILE, "utf8"));
            if (d.until && d.until > Date.now()) {
                rateLimitState.backoffuntil = d.until;
                const waitSec = Math.ceil((d.until - Date.now()) / 1000);
                console.warn(`[Login] ⏳ Persistent backoff active — ${waitSec}s remaining (from previous session)`);
            } else {
                fs.unlinkSync(BACKOFF_FILE); // expired, clean up
            }
        }
    } catch (_) {}
}

function saveBackoff(until) {
    try { fs.writeFileSync(BACKOFF_FILE, JSON.stringify({ until })); } catch (_) {}
}

function clearBackoff() {
    try { if (fs.existsSync(BACKOFF_FILE)) fs.unlinkSync(BACKOFF_FILE); } catch (_) {}
}


// ── Global Rate Limiter ───────────────────────────────────────────────────────
// Groww API Limit: 10 req/sec and 300 req/min (Live Data Group)
// We use a safe buffer: 8 req/sec and 250/min
const rateLimitState = {
    requestsInWindow: [], // minute window
    lastRequestTime: 0,
    minGap: 125, // 8 req/sec burst max
    maxPerMinute: 250,
    backoffuntil: 0
};

export async function rateLimit(priority = 'normal') {
    while (true) {
        const now = Date.now();
        
        // Check backoff
        if (now < rateLimitState.backoffuntil) {
            await sleep(rateLimitState.backoffuntil - now);
            continue;
        }

        // Cleanup minute window
        rateLimitState.requestsInWindow = rateLimitState.requestsInWindow.filter(t => now - t < 60000);

        // Check minute limit
        if (rateLimitState.requestsInWindow.length >= rateLimitState.maxPerMinute) {
            await sleep(1000);
            continue;
        }

        // Check burst (8/sec)
        const gap = now - rateLimitState.lastRequestTime;
        if (gap < rateLimitState.minGap) {
            await sleep(rateLimitState.minGap - gap);
            continue;
        }

        // All clear
        rateLimitState.requestsInWindow.push(now);
        rateLimitState.lastRequestTime = now;
        return;
    }
}

export function triggerBackoff(seconds = 5, persist = false) {
    console.warn(`[RateLimit] Triggering backoff for ${seconds}s...`);
    const until = Date.now() + (seconds * 1000);
    rateLimitState.backoffuntil = until;
    if (persist) saveBackoff(until);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function login() {
    // Singleton login lock
    if (loginPromise) return loginPromise;

    // Check cooldown
    const nowTs = Date.now();
    if (nowTs - lastLoginAttempt < LOGIN_COOLDOWN) {
        const wait = Math.ceil((LOGIN_COOLDOWN - (nowTs - lastLoginAttempt)) / 1000);
        console.warn(`[Login] Cooldown active. Please wait ${wait}s to prevent rate limits...`);
        return Promise.reject(new Error(`Login cooldown active (${wait}s remaining)`));
    }

    lastLoginAttempt = nowTs;

    loginPromise = (async () => {

        // Check persistent backoff before attempting login
        loadBackoff();
        if (Date.now() < rateLimitState.backoffuntil) {
            const waitSec = Math.ceil((rateLimitState.backoffuntil - Date.now()) / 1000);
            const err = new Error(`Login rate limited. Wait ${waitSec}s before retrying.`);
            loginPromise = null;
            throw err;
        }

        const timestamp = Math.floor(Date.now() / 1000).toString();
        const checksum = createHash("sha256").update(CREDS.apiSecret + timestamp).digest("hex");
        console.log("Logging in to Groww API...");
        console.log(`[Debug] API Key length: ${CREDS.apiKey?.length || 0}, starts with: ${CREDS.apiKey?.substring(0, 20)}...`);
        console.log(`[Debug] API Secret length: ${CREDS.apiSecret?.length || 0} (expected: 30-32)`);
        console.log(`[Debug] Token URL: ${TOKEN_URL}`);
        console.log(`[Debug] Timestamp: ${timestamp}, Checksum: ${checksum.substring(0, 16)}...`);

        // Wait for rate limit slot for login too
        await rateLimit();

        let attempts = 0, maxAttempts = 12; // 60 seconds total

        try {
            while (attempts < maxAttempts) {
                attempts++;
                try {
                    console.log(`[Login] Attempt ${attempts}/${maxAttempts}...`);
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

                    console.log(`[Login] Response status: ${res.status}`);
                    console.log(`[Login] Response data:`, JSON.stringify(res.data).substring(0, 200));

                    const token = res.data?.token || res.data?.accessToken || res.data?.access_token || res.data?.data?.token;
                    if (token) {
                        saveSession(token);
                        clearBackoff(); // successful login clears any persisted backoff
                        console.log("Groww login successful ✓");
                        return;
                    }
                    console.error(`[Login] ERROR: No token in response. Response keys: ${Object.keys(res.data || {}).join(', ')}`);
                    throw new Error("No token in response");
                } catch (e) {
                    console.error(`[Login] Attempt ${attempts} failed:`);
                    
                    if (e.response) {
                        // Server responded with error
                        console.error(`  Status: ${e.response.status}`);
                        console.error(`  Status Text: ${e.response.statusText}`);
                        console.error(`  Response Data: ${JSON.stringify(e.response.data).substring(0, 500)}`);
                        console.error(`  Headers: ${JSON.stringify(e.response.headers).substring(0, 200)}`);
                    } else if (e.request) {
                        // Request was made but no response
                        console.error(`  No response received. Network error or timeout.`);
                        console.error(`  Request: ${e.request}`);
                    } else {
                        // Something else happened
                        console.error(`  Error: ${e.message}`);
                        console.error(`  Stack: ${e.stack}`);
                    }

                    if (e.response?.status === 429) {
                        // Persist backoff so restarts don't hammer the endpoint again
                        const backoffSec = 600; // 10 min hard cooldown on login 429
                        triggerBackoff(backoffSec, true);
                        console.warn(`[Login] ❌ Rate limited (429). Backing off ${backoffSec}s and saving to disk.`);
                        console.warn(`[Login] Do NOT restart the server — wait ${backoffSec / 60} minutes then click Login in the UI.`);
                        throw new Error(`Login rate limited by Groww. Wait ${backoffSec / 60} minutes before retrying.`);
                    }

                    if (e.response?.status === 401) {
                        console.error(`[Login] ❌ AUTHENTICATION FAILED (401)`);
                        console.error(`[Login] Possible causes:`);
                        console.error(`  1. API Key is invalid or expired`);
                        console.error(`  2. API Secret is wrong (check for spaces/corruption)`);
                        console.error(`  3. Environment variables not set correctly`);
                        console.error(`  4. Secret needs base64 encoding (use: base64:VUlY...)`);
                        throw new Error(`Authentication failed: ${e.response.status} ${e.response.statusText} - ${JSON.stringify(e.response.data).substring(0, 200)}`);
                    }

                    const isApprovalPending = e.response?.status === 403 &&
                        (JSON.stringify(e.response?.data).toLowerCase().includes("approval required") ||
                            JSON.stringify(e.response?.data).toLowerCase().includes("pending"));

                    if (isApprovalPending) {
                        console.warn(`[Login] ⏳ Approval pending. Please approve in your Groww mobile app.`);
                        if (attempts < maxAttempts) {
                            await sleep(5000);
                            continue;
                        }
                        console.error(`[Login] ❌ Timed out waiting for approval after ${maxAttempts} attempts`);
                        throw new Error("Login timed out: Session approval not received.");
                    }

                    // If it's a 401 or other fatal error, don't retry
                    if (e.response?.status === 401 || e.message.includes("No token")) {
                        throw e;
                    }

                    // Continue retrying for other errors
                    if (attempts < maxAttempts) {
                        console.warn(`[Login] Retrying in 5 seconds...`);
                        await sleep(5000);
                    }
                }
            }
        } finally {
            loginPromise = null;
        }
    })();

    return loginPromise;
}

export function isRateLimited() {
    loadBackoff();
    return Date.now() < rateLimitState.backoffuntil;
}

export function getRateLimitWait() {
    return Math.max(0, Math.ceil((rateLimitState.backoffuntil - Date.now()) / 1000));
}

export async function ensureSession() {
    if (session.accessToken && Date.now() < session.expires) return;
    // Check persistent backoff — don't auto-login if rate limited
    loadBackoff();
    if (Date.now() < rateLimitState.backoffuntil) {
        const waitSec = Math.ceil((rateLimitState.backoffuntil - Date.now()) / 1000);
        throw new Error(`Login rate limited. Wait ${waitSec}s before retrying.`);
    }
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
    const tradingSymbolMap = {
        "MIDCPNIFTY": "NIFTYMIDSELECT",
        "PRISMJOHN": "PRSMJOHNSN"
    };
    const mappedSymbol = tradingSymbolMap[symbol] || symbol;

    const params = {
        exchange: symbol === "SENSEX" ? "BSE" : "NSE",
        segment: "CASH",
        trading_symbol: mappedSymbol,
        start_time: from.getTime(),
        end_time: to.getTime(),
        interval_in_minutes: interval
    };
    const headers = {
        "Authorization": `Bearer ${session.accessToken}`,
        "X-API-VERSION": "1.0",
        "Accept": "application/json",
    };
    await rateLimit();
    try {
        const res = await axios.get(CANDLE_URL, { params, headers, timeout: 20000 });
        const candles = res.data?.payload?.candles || res.data?.candles || res.data?.data?.candles || [];
        return candles.map(c => ({
            ts: c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5]
        }));
    } catch (e) {
        if (e.response?.status === 429) triggerBackoff(15);
        throw e;
    }
}

export async function fetchBulkLtp(symbols, segment = "CASH") {
    await ensureSession();
    const url = `https://api.groww.in/v1/live-data/ltp`;
    
    // Groww API limit: max 50 symbols per request
    const chunks = [];
    for (let i = 0; i < symbols.length; i += 50) {
        chunks.push(symbols.slice(i, i + 50));
    }

    const headers = {
        "Authorization": `Bearer ${session.accessToken}`,
        "X-API-VERSION": "1.0",
        "Accept": "application/json",
    };

    const fetchChunk = async (chunk) => {
        await rateLimit();
        const exchangeSymbols = chunk.map(s => {
            if (s.startsWith("NSE_") || s.startsWith("BSE_") || s.startsWith("MCX_")) return s;
            return s === "SENSEX" ? `BSE_SENSEX` : `NSE_${s}`;
        }).join(",");
        
        try {
            const res = await axios.get(url, { params: { segment, exchange_symbols: exchangeSymbols }, headers, timeout: 15000 });
            return res.data?.payload || {};
        } catch (e) {
            if (e.response?.status === 429) triggerBackoff(30);
            console.error(`[Groww API] LTP Fetch Error:`, e.response?.data || e.message);
            return {};
        }
    };

    try {
        const results = await Promise.all(chunks.map(c => fetchChunk(c)));
        const allPrices = {};
        
        for (const data of results) {
            for (const [sym, price] of Object.entries(data)) {
                const cleanSym = sym.replace("NSE_", "").replace("BSE_", "").replace("MCX_", "");
                allPrices[cleanSym] = price || 0;
            }
        }
        return allPrices;
    } catch (e) {
        console.error(`[Groww API] LTP Bulk Fetch Error:`, e.message);
        throw e;
    }
}

// ── Expiry Date Utility ────────────────────────────────────────────────────────
export function getExpiryDate(symbol, isIndex = false) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    if (!isIndex) {
        let year = now.getFullYear();
        let month = now.getMonth();
        let d = new Date(year, month + 1, 0);
        let offset = (d.getDay() - 4 + 7) % 7;
        let lastThursday = new Date(d.setDate(d.getDate() - offset));
        
        if (today > lastThursday || (today.getTime() === lastThursday.getTime() && now.getHours() >= 16)) {
            d = new Date(year, month + 2, 0);
            offset = (d.getDay() - 4 + 7) % 7;
            lastThursday = new Date(d.setDate(d.getDate() - offset));
        }
        return lastThursday.toISOString().split("T")[0];
    } else {
        const expiryMap = {
            "NIFTY": 4,         // Thursday
            "BANKNIFTY": 3,     // Wednesday
            "FINNIFTY": 2,      // Tuesday
            "MIDCPNIFTY": 1,    // Monday
            "SENSEX": 5         // Friday
        };
        const targetDay = expiryMap[symbol] || 4; // Default Thursday
        const todayDay = now.getDay();
        let daysToAdd = (targetDay - todayDay + 7) % 7;
        
        // If today is the expiry day but market has closed (post 3:30 PM)
        if (daysToAdd === 0 && now.getHours() >= 16) {
           daysToAdd = 7;
        }
        
        const nextExpiry = new Date(now);
        nextExpiry.setDate(now.getDate() + daysToAdd);
        return nextExpiry.toISOString().split("T")[0];
    }
}

export async function fetchOptionChain(symbol) {
    await ensureSession();
    const isIndex = ["NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX", "MIDCPNIFTY"].includes(symbol);
    const expiry = getExpiryDate(symbol, isIndex);
    
    const exchange = symbol === "SENSEX" ? "BSE" : "NSE";
    const url = `https://api.groww.in/v1/option-chain/exchange/${exchange}/underlying/${symbol}?expiry_date=${expiry}`;
    
    const headers = {
        "Authorization": `Bearer ${session.accessToken}`,
        "X-API-VERSION": "1.0",
        "Accept": "application/json",
    };
    
    await rateLimit();
    try {
        const res = await axios.get(url, { headers, timeout: 20000 });
        return res.data?.payload || null;
    } catch (e) {
        if (e.response?.status === 429) triggerBackoff(20);
        if (e.response?.status !== 404 && e.response?.status !== 400) {
            console.error(`[Groww API] Option Chain Fetch Error [${symbol}]:`, e.response?.data || e.message);
        }
        return null;
    }
}

// ── Portfolio API ────────────────────────────────────────────────────────

export async function fetchHoldings() {
    await ensureSession();
    const url = `https://api.groww.in/v1/holdings/user`;

    const headers = {
        "Authorization": `Bearer ${session.accessToken}`,
        "X-API-VERSION": "1.0",
        "Accept": "application/json",
    };

    await rateLimit();
    try {
        const res = await axios.get(url, { headers, timeout: 15000 });
        return res.data?.payload?.holdings || [];
    } catch (e) {
        if (e.response?.status === 429) triggerBackoff(10);
        console.error(`[Groww API] Holdings Fetch Error:`, e.response?.data || e.message);
        return [];
    }
}

export async function fetchPositions(segment = null) {
    await ensureSession();
    let url = `https://api.groww.in/v1/positions/user`;
    if (segment) url += `?segment=${segment}`;

    const headers = {
        "Authorization": `Bearer ${session.accessToken}`,
        "X-API-VERSION": "1.0",
        "Accept": "application/json",
    };

    await rateLimit();
    try {
        const res = await axios.get(url, { headers, timeout: 15000 });
        return res.data?.payload?.positions || [];
    } catch (e) {
        if (e.response?.status === 429) triggerBackoff(10);
        console.error(`[Groww API] Positions Fetch Error:`, e.response?.data || e.message);
        return [];
    }
}

