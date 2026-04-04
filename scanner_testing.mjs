// ─────────────────────────────────────────────────────────────────────────────
// Ayush's Personal Scanner — Groww Trading API
// EMA 20/50 Golden Cross + MACD + Volume + RSI
// Run: node scanner_testing.mjs
// Open: http://localhost:4001
// ─────────────────────────────────────────────────────────────────────────────

import express from "express";
import axios from "axios";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, ".groww_session.json");
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 4001;

// ─────────────────────────────────────────────────────────────────────────────
// ✏️  GROWW API CREDENTIALS
// i have these - api key ***REDACTED_JWT***

// , api secret - ***REDACTED_SECRET***
// ─────────────────────────────────────────────────────────────────────────────
const CREDS = {
    apiKey: process.env.GROWW_API_KEY || "***REDACTED_JWT***",
    apiSecret: process.env.GROWW_API_SECRET || "***REDACTED_SECRET***",
};

// ── Groww API URLs ────────────────────────────────────────────────────────────
const BASE = "https://api.groww.in";
const TOKEN_URL = `${BASE}/v1/token/api/access`;
const CANDLE_URL = `${BASE}/v1/historical/candle/range`;

// ── Session ───────────────────────────────────────────────────────────────────
let session = { accessToken: null, expires: 0 };

function loadSession() {
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

function saveSession(accessToken) {
    session = { accessToken, expires: Date.now() + 23 * 3600 * 1000 };
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(session));
}

// ── Auth: SHA256(secret + timestamp) ──────────────────────────────────────────
async function login() {
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
        // Groww returns the token in the "token" field
        const token = res.data?.token || res.data?.accessToken || res.data?.access_token || res.data?.data?.token;
        if (!token) throw new Error("No token in response: " + JSON.stringify(res.data));
        saveSession(token);
        console.log("Groww login successful ✓");
    } catch (e) {
        console.error("Groww login error:", e.response?.status, e.response?.data || e.message);
        throw new Error(e.response?.data?.message || e.response?.data?.error || e.message);
    }
}

async function ensureSession() {
    if (session.accessToken && Date.now() < session.expires) return;
    await login();
}

// ── Candle fetch (Groww API) ──────────────────────────────────────────────────
const TF_MAP = {
    "1m": "1minute", "5m": "5minute", "10m": "10minute",
    "15m": "15minute", "30m": "30minute", "1h": "1hour", "1d": "1day"
};
const TF_DAYS = { "1m": 5, "5m": 10, "10m": 15, "15m": 20, "30m": 30, "1h": 60, "1d": 365 };

function fmtGroww(d) {
    const ist = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const p = n => String(n).padStart(2, "0");
    return `${ist.getFullYear()}-${p(ist.getMonth() + 1)}-${p(ist.getDate())} ${p(ist.getHours())}:${p(ist.getMinutes())}:${p(ist.getSeconds())}`;
}

// Rate limiter: Groww allows 10 req/sec for market data
const rl = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rateLimit() {
    while (true) {
        const now = Date.now();
        while (rl.length && now - rl[0] > 1000) rl.shift();
        if (rl.length < 4) { rl.push(Date.now()); return; }
        await sleep(250);
    }
}

async function fetchCandles(symbol, tf) {
    await ensureSession();
    const to = new Date(), from = new Date(to - TF_DAYS[tf] * 86400000);
    // Groww uses interval_in_minutes for both intraday and daily
    const intervalMap = {
        "1m": 1, "5m": 5, "10m": 10,
        "15m": 15, "30m": 30, "1h": 60, "1d": 1440
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

// ── Indicators ────────────────────────────────────────────────────────────────
function ema(values, period) {
    if (values.length < period) return new Array(values.length).fill(null);
    const k = 2 / (period + 1);
    let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const out = new Array(period - 1).fill(null);
    out.push(e);
    for (let i = period; i < values.length; i++) { e = values[i] * k + e * (1 - k); out.push(e); }
    return out;
}

function macd(closes, fast = 12, slow = 26, sig = 9) {
    const ef = ema(closes, fast), es = ema(closes, slow);
    const ml = ef.map((v, i) => v !== null && es[i] !== null ? v - es[i] : null);
    const valid = ml.filter(v => v !== null);
    const sl = ema(valid, sig);
    const pad = ml.length - valid.length + sig - 1;
    const slFull = new Array(pad).fill(null).concat(sl.filter(v => v !== null));
    return { macd: ml, signal: slFull };
}

function rsi(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let g = 0, l = 0;
    for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
    let ag = g / period, al = l / period;
    for (let i = period + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        ag = (ag * (period - 1) + Math.max(d, 0)) / period;
        al = (al * (period - 1) + Math.max(-d, 0)) / period;
    }
    return al === 0 ? 100 : +(100 - 100 / (1 + ag / al)).toFixed(2);
}

// ── Universe ──────────────────────────────────────────────────────────────────
const UNIVERSE = [
    "ADANIENT", "ADANIPORTS", "APOLLOHOSP", "ASIANPAINT", "AXISBANK",
    "BAJAJ-AUTO", "BAJFINANCE", "BAJAJFINSV", "BHARTIARTL", "BPCL",
    "BRITANNIA", "CIPLA", "COALINDIA", "DIVISLAB", "DRREDDY",
    "EICHERMOT", "ETERNAL", "GRASIM", "HCLTECH", "HDFCBANK",
    "HDFCLIFE", "HEROMOTOCO", "HINDALCO", "HINDUNILVR", "ICICIBANK",
    "INFY", "ITC", "INDUSINDBK", "INDIGO", "JSWSTEEL",
    "KOTAKBANK", "LT", "M&M", "MARUTI", "NESTLEIND",
    "NTPC", "ONGC", "POWERGRID", "RELIANCE", "SBILIFE",
    "SBIN", "SHRIRAMFIN", "SUNPHARMA", "TCS", "TATACONSUM",
    "TATAMOTORS", "TATASTEEL", "TECHM", "TITAN", "ULTRACEMCO", "WIPRO",
    "BANKBARODA", "PNB", "AUBANK", "FEDERALBNK", "CANBK",
    "BANDHANBNK", "IDFCFIRSTB", "BANKINDIA"
];

const SECTOR = {
    IT: ["INFY", "TCS", "HCLTECH", "TECHM", "WIPRO"],
    PHARMA: ["SUNPHARMA", "DRREDDY", "CIPLA", "DIVISLAB", "APOLLOHOSP"],
    BANK: ["HDFCBANK", "ICICIBANK", "AXISBANK", "SBIN", "KOTAKBANK", "INDUSINDBK", "BANDHANBNK", "IDFCFIRSTB", "AUBANK", "FEDERALBNK", "BANKBARODA", "PNB", "CANBK", "BANKINDIA"],
    ENERGY: ["RELIANCE", "ONGC", "BPCL", "NTPC", "POWERGRID", "COALINDIA"],
    AUTO: ["MARUTI", "TATAMOTORS", "BAJAJ-AUTO", "HEROMOTOCO", "EICHERMOT", "M&M"],
    METAL: ["TATASTEEL", "JSWSTEEL", "HINDALCO"],
    FMCG: ["HINDUNILVR", "ITC", "BRITANNIA", "NESTLEIND", "TATACONSUM"],
    INFRA: ["LT", "GRASIM", "ULTRACEMCO", "ADANIPORTS", "ADANIENT"],
    FINANCE: ["BAJFINANCE", "BAJAJFINSV", "SBILIFE", "HDFCLIFE", "SHRIRAMFIN"],
};
const getSector = s => Object.keys(SECTOR).find(k => SECTOR[k].includes(s)) || "OTHER";

// ── Signal builder ─────────────────────────────────────────────────────────────
function buildSignal(candles, tf, symbol) {
    const cls = candles.map(c => c.close).filter(Number.isFinite);
    const vol = candles.map(c => c.volume).filter(Number.isFinite);
    if (cls.length < 55 || vol.length < 15) return null;

    const e21 = ema(cls, 21), e50 = ema(cls, 50);
    const { macd: ml, signal: sl } = macd(cls, 12, 26, 9);
    const rsiVal = rsi(cls);
    const n = cls.length;

    const c21 = e21[n - 1], p21 = e21[n - 2];
    const c50 = e50[n - 1], p50 = e50[n - 2];
    const cM = ml[n - 1], pM = ml[n - 2];
    const cS = sl[n - 1], pS = sl[n - 2];

    const goldenCross = p21 !== null && p50 !== null && p21 <= p50 && c21 > c50;
    const deathCross = p21 !== null && p50 !== null && p21 >= p50 && c21 < c50;
    const ema21above = c21 > c50;
    const macdBull = pM !== null && pS !== null && pM <= pS && cM > cS;
    const macdBear = pM !== null && pS !== null && pM >= pS && cM < cS;
    const macdAbove = cM !== null && cS !== null && cM > cS;

    const recentVol = vol.slice(-10);
    const avgVol = recentVol.reduce((a, b) => a + b, 0) / recentVol.length;
    const lastVol = vol[vol.length - 1];
    const prevVol = vol[vol.length - 2] || 0;
    const volSpike = lastVol > avgVol * 1.5;

    const last = candles[candles.length - 1];
    const chgPct = ((last.close - last.open) / last.open) * 100;
    const emaGap = c50 ? +(((c21 - c50) / c50) * 100).toFixed(3) : 0;

    const normalizeTs = ts => ts < 10000000000 ? ts * 1000 : ts;
    const lastTs = normalizeTs(last.ts);
    const tzStr = new Date(lastTs).toLocaleDateString("en-US", { timeZone: "Asia/Kolkata" });
    const weekThresh = lastTs - (7 * 86400000);
    let dayH = -Infinity, dayL = Infinity;
    let weekH = -Infinity, weekL = Infinity;
    for (let i = n - 1; i >= 0; i--) {
        const c = candles[i];
        const ts = normalizeTs(c.ts);
        if (ts < weekThresh) break;
        weekH = Math.max(weekH, c.high);
        weekL = Math.min(weekL, c.low);
        if (new Date(ts).toLocaleDateString("en-US", { timeZone: "Asia/Kolkata" }) === tzStr) {
            dayH = Math.max(dayH, c.high);
            dayL = Math.min(dayL, c.low);
        }
    }
    if (dayH === -Infinity) { dayH = last.high; dayL = last.low; }
    if (weekH === -Infinity) { weekH = dayH; weekL = dayL; }

    const histLen = 20;
    const priceHist = cls.slice(-histLen);
    const ema21Hist = e21.slice(-histLen);
    const ema50Hist = e50.slice(-histLen);

    const checks = {
        "Golden Cross (EMA 21>50)": goldenCross,
        "EMA 21 above 50": ema21above,
        "MACD Bull cross": macdBull,
        "MACD above signal": macdAbove,
        "Vol spike + price up": volSpike && chgPct > 0,
        "RSI healthy (45-75)": rsiVal !== null && rsiVal >= 45 && rsiVal <= 75,
    };

    const redFlags = {
        "Death Cross": deathCross,
        "MACD Bear cross": macdBear,
        "RSI overbought >80": rsiVal !== null && rsiVal > 80,
        "RSI oversold <25": rsiVal !== null && rsiVal < 25,
        "Volume collapsing": lastVol < avgVol * 0.4,
    };

    const techScore = Object.values(checks).filter(Boolean).length;
    const redCount = Object.values(redFlags).filter(Boolean).length;

    let signal = "NONE";
    if (goldenCross) signal = "BUY";
    else if (deathCross) signal = "SELL";
    else if (ema21above && macdBull) signal = "BUY";
    else if (!ema21above && macdBear) signal = "SELL";

    const rating = techScore >= 5 ? "STRONG BUY" : techScore >= 3 ? "WATCHLIST" : "SKIP";

    return {
        symbol, sector: getSector(symbol), tf, signal,
        goldenCross, deathCross,
        price: +last.close.toFixed(2), open: +last.open.toFixed(2),
        high: +last.high.toFixed(2), low: +last.low.toFixed(2),
        dayH, dayL, weekH, weekL,
        chgPct: +chgPct.toFixed(2),
        volume: lastVol, volumeChange: lastVol - prevVol, volSpike,
        ema21: c21 !== null ? +c21.toFixed(2) : null,
        ema50: c50 !== null ? +c50.toFixed(2) : null,
        emaGap, ema21above,
        ema21Hist, ema50Hist, priceHist,
        macdBull, macdBear, macdAbove,
        macdVal: cM !== null ? +cM.toFixed(4) : null,
        rsi: rsiVal,
        checks, redFlags,
        techScore, redCount,
        rating,
        ts: last.ts,
        isNew: false, isNewGolden: false,
    };
}

// ── Scan state ────────────────────────────────────────────────────────────────
function emptyState() {
    const data = {};
    for (const tf of Object.keys(TF_MAP)) { data[`${tf}_BUY`] = []; data[`${tf}_SELL`] = []; data[`${tf}_ALL`] = []; data[`${tf}_GOLDEN`] = []; }
    return { lastUpdated: null, data, errors: [], universe: UNIVERSE.length };
}

function generateDummyState() {
    const s = emptyState();
    s.lastUpdated = new Date().toISOString();
    for (const tf of Object.keys(TF_MAP)) {
        const dummyRow1 = {
            symbol: "RELIANCE", sector: "ENERGY", tf, signal: "BUY",
            goldenCross: true, deathCross: false,
            price: 2950.50, open: 2900, high: 2960, low: 2890,
            chgPct: 1.74, volume: 5000000, volumeChange: 200000, volSpike: true,
            ema20: 2900, ema50: 2850, emaGap: 1.75, ema20above: true,
            macdBull: true, macdBear: false, macdAbove: true,
            macdVal: 15.2, rsi: 65,
            checks: { "Golden Cross (EMA 20>50)": true, "EMA 20 above 50": true, "MACD Bull cross": true, "MACD above signal": true, "Vol spike + price up": true },
            redFlags: {}, techScore: 5, redCount: 0, rating: "STRONG BUY",
            ts: new Date().toISOString(), isNew: true, isNewGolden: true
        };
        const dummyRow2 = {
            symbol: "HDFCBANK", sector: "BANK", tf, signal: "SELL",
            goldenCross: false, deathCross: true,
            price: 1510.20, open: 1530, high: 1540, low: 1500,
            chgPct: -1.29, volume: 8000000, volumeChange: -100000, volSpike: false,
            ema20: 1550, ema50: 1580, emaGap: -1.89, ema20above: false,
            macdBull: false, macdBear: true, macdAbove: false,
            macdVal: -4.5, rsi: 35,
            checks: {}, redFlags: { "Death Cross": true },
            techScore: 0, redCount: 3, rating: "SKIP",
            ts: new Date().toISOString(), isNew: false, isNewGolden: false
        };
        const dummyRow3 = {
            symbol: "TCS", sector: "IT", tf, signal: "NONE",
            goldenCross: false, deathCross: false,
            price: 4050.00, open: 4040, high: 4080, low: 4020,
            chgPct: 0.24, volume: 1500000, volumeChange: 50000, volSpike: false,
            ema20: 4000, ema50: 3950, emaGap: 1.26, ema20above: true,
            macdBull: false, macdBear: false, macdAbove: true,
            macdVal: 5.1, rsi: 55,
            checks: { "EMA 20 above 50": true }, redFlags: {},
            techScore: 3, redCount: 0, rating: "WATCHLIST",
            ts: new Date().toISOString(), isNew: false, isNewGolden: false
        };
        s.data[`${tf}_ALL`].push(dummyRow1, dummyRow2, dummyRow3);
        s.data[`${tf}_BUY`].push(dummyRow1);
        s.data[`${tf}_SELL`].push(dummyRow2);
        s.data[`${tf}_GOLDEN`].push(dummyRow1);
    }
    return s;
}

let state = emptyState();
const prevSigs = new Map();
let scanning = false;
let isAuthenticated = false;

async function scanSymbol(symbol, buckets, errors) {
    for (const tf of Object.keys(TF_MAP)) {
        try {
            await rateLimit();
            const candles = await fetchCandles(symbol, tf);
            const row = buildSignal(candles, tf, symbol);
            if (!row) continue;

            const key = `${symbol}|${tf}`;
            const prev = prevSigs.get(key);
            row.isNew = !prev || prev !== row.signal;
            row.isNewGolden = row.goldenCross && row.isNew;
            prevSigs.set(key, row.signal);

            buckets[`${tf}_ALL`].push(row);
            if (row.signal === "BUY") buckets[`${tf}_BUY`].push(row);
            if (row.signal === "SELL") buckets[`${tf}_SELL`].push(row);
            if (row.goldenCross) buckets[`${tf}_GOLDEN`].push(row);
        } catch (e) {
            if (errors.length === 0) {
                console.error(`First error — ${symbol}/${tf}:`, e.response?.status, JSON.stringify(e.response?.data || e.message).substring(0, 300));
                console.error("Request URL:", e.config?.url);
                console.error("Request params:", JSON.stringify(e.config?.params));
            }
            errors.push(`${symbol}/${tf}: ${e.response?.data?.message || e.response?.data?.error || e.message}`);
        }
    }
}

async function pool(items, concurrency, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => { while (i < items.length) { const x = items[i++]; await fn(x); } }));
}

async function scanAll() {
    if (!isAuthenticated || scanning) return;
    scanning = true;
    console.log("Scan started:", new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }));
    const next = emptyState();
    try {
        await pool(UNIVERSE, 2, sym => scanSymbol(sym, next.data, next.errors));
        const sortFn = (a, b) => {
            if (a.goldenCross !== b.goldenCross) return a.goldenCross ? -1 : 1;
            if (b.techScore !== a.techScore) return b.techScore - a.techScore;
            return Math.abs(b.volumeChange) - Math.abs(a.volumeChange);
        };
        for (const tf of Object.keys(TF_MAP)) {
            next.data[`${tf}_BUY`].sort(sortFn);
            next.data[`${tf}_GOLDEN`].sort(sortFn);
            next.data[`${tf}_ALL`].sort((a, b) => b.techScore - a.techScore);
        }
        next.lastUpdated = new Date().toISOString();
        state = next;
        console.log(`Scan done | Errors: ${next.errors.length}`);
    } finally { scanning = false; }
}

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
        isAuthenticated = true;
        scanAll();
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── UI ────────────────────────────────────────────────────────────────────────
app.get("/", (_, res) => res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Ayush's Scanner — Groww</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Sora:wght@400;600;700&display=swap" rel="stylesheet"/>
<style>
:root{
  --bg:#07090f;--card:#0d1220;--card2:#111927;--border:#1c2a3f;
  --text:#dce8f5;--muted:#526a85;--green:#22c55e;--red:#ef4444;
  --accent:#00d4aa;--yellow:#f59e0b;--purple:#a78bfa;
  --mono:'JetBrains Mono',monospace;--sans:'Sora',sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0;}
body{background:var(--bg);color:var(--text);font-family:var(--sans);min-height:100vh;}
body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(0,212,170,.018) 1px,transparent 1px),linear-gradient(90deg,rgba(0,212,170,.018) 1px,transparent 1px);background-size:40px 40px;pointer-events:none;z-index:0;}
.wrap{position:relative;z-index:1;max-width:1450px;margin:0 auto;padding:16px;}

/* login */
.ls{width:100%;min-height:100vh;display:flex;align-items:center;justify-content:center;}
.lc{background:var(--card);border:1px solid var(--border);border-radius:20px;padding:40px 44px;max-width:500px;width:100%;text-align:center;}
.lt{font-size:22px;font-weight:700;color:var(--accent);margin-bottom:8px;}
.lsub{color:var(--muted);font-size:13px;margin-bottom:22px;line-height:1.7;}
.step{background:var(--card2);border:1px solid var(--border);border-radius:10px;padding:13px;margin-bottom:10px;text-align:left;font-size:12px;line-height:1.7;}
.step b{color:var(--accent);}
code{background:#000;padding:2px 6px;border-radius:4px;font-family:var(--mono);color:var(--yellow);font-size:11px;}
.lbtn{width:100%;background:var(--accent);color:#041a14;padding:13px;border-radius:10px;font-weight:700;font-size:14px;border:none;cursor:pointer;font-family:var(--sans);margin-top:6px;}
.lbtn:hover{opacity:.87;}
.note{font-size:11px;color:var(--muted);margin-top:14px;line-height:1.6;}

/* top */
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid var(--border);}
.brand{display:flex;align-items:center;gap:10px;font-size:18px;font-weight:700;}
.dot{width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:0 0 12px var(--accent);animation:pulse 2s infinite;}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(1.4)}}
.brand span{color:var(--accent);}
.top-r{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.pill{background:var(--card);border:1px solid var(--border);color:var(--muted);padding:5px 12px;border-radius:999px;font-size:11px;font-family:var(--mono);display:flex;align-items:center;gap:6px;}
.live{width:6px;height:6px;border-radius:50%;background:var(--green);}
.live.dead{background:var(--red);}
.tbtn{padding:5px 13px;border-radius:999px;font-size:11px;cursor:pointer;font-family:var(--sans);font-weight:600;background:rgba(0,212,170,.1);border:1px solid rgba(0,212,170,.3);color:var(--accent);}
.groww-badge{background:rgba(0,180,70,.12);border:1px solid rgba(0,180,70,.3);color:#22c55e;padding:5px 12px;border-radius:999px;font-size:10px;font-family:var(--mono);font-weight:700;}

/* stat cards */
.stats{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;}
.sc{flex:1;min-width:90px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:11px 13px;}
.scl{font-size:9px;color:var(--muted);font-family:var(--mono);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;}
.scv{font-size:20px;font-weight:700;font-family:var(--mono);}
.g{color:var(--green);}.r{color:var(--red);}.a{color:var(--accent);}.y{color:var(--yellow);}.p{color:var(--purple);}
.scv.sm{font-size:11px;color:var(--muted);}

/* controls */
.controls{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;}
.controls input,.controls select{background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:9px 12px;font-size:12px;font-family:var(--sans);outline:none;}
.controls input:focus,.controls select:focus{border-color:var(--accent);}
.controls input{flex:2;min-width:180px;}
.controls select{min-width:135px;}

/* legend */
.legend{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:10px 16px;margin-bottom:10px;font-size:11px;display:flex;gap:14px;flex-wrap:wrap;align-items:center;color:var(--muted);}
.lb{padding:2px 7px;border-radius:4px;font-weight:700;font-family:var(--mono);font-size:10px;}
.lb.sb{background:rgba(34,197,94,.18);color:var(--green);}
.lb.wl{background:rgba(245,158,11,.18);color:var(--yellow);}
.lb.sk{background:rgba(239,68,68,.12);color:var(--red);}

/* fund note */
.fundnote{background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.18);border-radius:10px;padding:10px 15px;color:var(--yellow);font-size:11px;margin-bottom:10px;line-height:1.7;}

/* tabs */
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;}
.tab{padding:7px 16px;border-radius:999px;border:1px solid var(--border);background:var(--card);color:var(--muted);cursor:pointer;font-size:12px;font-weight:600;}
.tab.active{background:var(--accent);color:#041a14;border-color:var(--accent);}
.tab.tb.active{background:var(--green);border-color:var(--green);color:#fff;}
.tab.tg.active{background:var(--purple);border-color:var(--purple);color:#fff;}
.tab.ts.active{background:var(--red);border-color:var(--red);color:#fff;}

.meta{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px;color:var(--muted);font-size:11px;font-family:var(--mono);}

/* table */
.tw{overflow:auto;border:1px solid var(--border);border-radius:14px;}
table{width:100%;border-collapse:collapse;min-width:1120px;}
thead th{position:sticky;top:0;background:var(--card2);text-align:left;font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);padding:10px 12px;border-bottom:1px solid var(--border);cursor:pointer;font-family:var(--mono);white-space:nowrap;user-select:none;}
thead th:hover{color:var(--text);}
tbody td{padding:10px 12px;border-bottom:1px solid rgba(28,42,63,.8);font-size:12px;white-space:nowrap;}
tbody tr:hover{background:rgba(255,255,255,.016);}
tbody tr.gc-row{background:rgba(167,139,250,.04);}
tbody tr.new-row{background:rgba(0,212,170,.03);}

.sym{font-weight:700;font-family:var(--mono);font-size:13px;}
.sec{font-size:9px;color:var(--muted);}
.bgc{display:inline-block;background:rgba(167,139,250,.18);border:1px solid rgba(167,139,250,.35);color:var(--purple);padding:1px 5px;border-radius:3px;font-size:8px;font-family:var(--mono);margin-left:4px;vertical-align:middle;}
.bnew{display:inline-block;background:rgba(0,212,170,.13);border:1px solid rgba(0,212,170,.32);color:var(--accent);padding:1px 5px;border-radius:3px;font-size:8px;font-family:var(--mono);margin-left:3px;vertical-align:middle;}
.sb{color:var(--green);font-weight:700;}.ss{color:var(--red);font-weight:700;}.sn{color:var(--muted);}
.up{color:var(--green);}.dn{color:var(--red);}
.ea{color:var(--green);font-size:10px;}.eb{color:var(--red);font-size:10px;}
.spike{color:var(--yellow);font-weight:700;}
.rat-sb{background:rgba(34,197,94,.12);color:var(--green);padding:2px 7px;border-radius:4px;font-size:10px;font-family:var(--mono);font-weight:700;}
.rat-wl{background:rgba(245,158,11,.12);color:var(--yellow);padding:2px 7px;border-radius:4px;font-size:10px;font-family:var(--mono);font-weight:700;}
.rat-sk{background:rgba(239,68,68,.10);color:var(--red);padding:2px 7px;border-radius:4px;font-size:10px;font-family:var(--mono);font-weight:700;}
.checks{display:flex;gap:2px;}
.ck{width:10px;height:10px;border-radius:2px;display:inline-block;cursor:default;}
.ck.on{background:var(--green);}.ck.off{background:rgba(255,255,255,.09);}
.rf{color:var(--red);font-size:10px;}

.errbar{background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.18);border-radius:10px;padding:9px 13px;color:var(--red);font-size:11px;font-family:var(--mono);margin-bottom:10px;}
.empty{padding:40px;text-align:center;color:var(--muted);}
.scanning{padding:30px;text-align:center;color:var(--muted);font-family:var(--mono);font-size:12px;}

[title]{cursor:help;}

.sparkline{width:100px;height:30px;display:block;margin-bottom:4px;border-radius:4px;background:rgba(255,255,255,0.02);padding:2px;}
.spark-p{stroke:rgba(255,255,255,0.2);stroke-width:1;fill:none;}
.spark-21{stroke:var(--green);stroke-width:1.5;fill:none;}
.spark-50{stroke:var(--red);stroke-width:1.5;fill:none;}
.ema-cell{display:flex;flex-direction:column;gap:2px;}
.ema-val{font-size:10px;font-weight:600;display:flex;align-items:center;gap:4px;}

@media(max-width:700px){.controls{flex-direction:column;}.sc{min-width:80px;}}
</style>
</head>
<body>

<!-- LOGIN SCREEN -->
<div id="LS" style="display:none">
<div class="ls"><div class="lc">
  <div class="lt">⚡ Ayush's Scanner</div>
  <div class="lsub">EMA 21/50 Golden Cross · MACD 12/26/9 · Volume Spike · RSI<br>Powered by <b style="color:#22c55e">Groww Trading API</b></div>
  <div class="step"><b>Step 1:</b> Your Groww API Key and Secret are already configured in the server.</div>
  <div class="step"><b>Step 2:</b> Click Login to authenticate with the Groww API. Access token is auto-generated using your API secret.</div>
  <div class="step"><b>Step 3:</b> Once authenticated, the scanner starts scanning all 59 NSE stocks across 8 timeframes.</div>
  <button class="lbtn" onclick="doLogin()">🔐 Login with Groww API</button>
  <div class="note">Token auto-refreshes. Only reads historical data — no orders placed.<br>Rate limit: 10 req/sec (Groww market data limit).</div>
</div></div>
</div>

<!-- MAIN APP -->
<div id="APP" style="display:none">
<div class="wrap">

<div class="top">
  <div class="brand"><div class="dot"></div>Ayush's Personal <span>Scanner</span></div>
  <div class="top-r">
    <div class="groww-badge">GROWW API</div>
    <div class="pill"><div class="live" id="liveInd"></div><span id="mktTxt">--</span></div>
    <div class="pill" id="timerPill">Next: --</div>
    <button class="tbtn" onclick="doLogin()">Re-Login</button>
    <button class="tbtn" onclick="load()">↺ Refresh</button>
  </div>
</div>

<div class="stats">
  <div class="sc"><div class="scl">Universe</div><div class="scv a" id="sU">--</div></div>
  <div class="sc"><div class="scl">🟣 Golden</div><div class="scv p" id="sG">--</div></div>
  <div class="sc"><div class="scl">▲ BUY</div><div class="scv g" id="sB">--</div></div>
  <div class="sc"><div class="scl">▼ SELL</div><div class="scv r" id="sS">--</div></div>
  <div class="sc"><div class="scl">Vol Spikes</div><div class="scv y" id="sSp">--</div></div>
  <div class="sc"><div class="scl">Strong Buy</div><div class="scv g" id="sSB">--</div></div>
  <div class="sc"><div class="scl">Watchlist</div><div class="scv y" id="sWL">--</div></div>
  <div class="sc"><div class="scl">Errors</div><div class="scv r" id="sE">--</div></div>
  <div class="sc"><div class="scl">Last Scan</div><div class="scv sm" id="sT">--</div></div>
</div>

<!--
<div class="fundnote">
  📊 <b>Scoring (tech only, auto-computed):</b>
  Checks: Golden Cross · EMA 21 above 50 · MACD Bull · MACD Above Signal · Vol Spike + Price Up · RSI 45–75.
  Score 5–6 = STRONG BUY &nbsp;|&nbsp; 3–4 = WATCHLIST &nbsp;|&nbsp; <3 = SKIP.<br>
  🔌 <b>Fundamental signals</b> (FII/DII/promoter/earnings/bulk deals) show <b>N/A</b> until you wire in Screener.in / Trendlyne / BSE bulk deals APIs.
</div>
-->

<div class="legend">
  <b style="color:var(--muted);font-size:10px">RATING:</b>
  <span class="lb sb">STRONG BUY</span> 5–6 tech signals &nbsp;
  <span class="lb wl">WATCHLIST</span> 3–4 signals &nbsp;
  <span class="lb sk">SKIP</span> &lt;3 or red flags &nbsp;
  <span style="font-size:10px">🟩 = signal ON &nbsp; ⬜ = signal OFF &nbsp; (hover for label)</span>
</div>

<div class="controls">
  <input id="search" placeholder="Search symbol or sector (IT, BANK, PHARMA...)"/>
  <select id="tf">
    <option value="ALL" selected>All Timeframes</option>
    <option value="1m">1 Min</option>
    <option value="5m">5 Min</option>
    <option value="10m">10 Min</option>
    <option value="15m">15 Min</option>
    <option value="30m">30 Min</option>
    <option value="1h">1 Hour</option>
    <option value="1d">1 Day</option>
  </select>
  <select id="sigF">
    <option value="ALL">All Signals</option>
    <option value="BUY">BUY only</option>
    <option value="SELL">SELL only</option>
  </select>
  <select id="sortBy">
    <option value="techScore">Tech Score</option>
    <option value="goldenCross">Golden Cross first</option>
    <option value="volumeChange">Vol Change</option>
    <option value="chgPct">% Change</option>
    <option value="emaGap">EMA Gap</option>
    <option value="rsi">RSI</option>
  </select>
</div>

<div id="errBar" class="errbar" style="display:none"></div>
<div class="meta">
  <span id="rowCount">Showing --</span>
  <span id="lastScan">Last scan: --</span>
</div>

<div class="tabs">
  <div class="tab tg active" data-set="GOLDEN">🟣 Golden Cross</div>
  <div class="tab tb" data-set="BUY">▲ BUY</div>
  <div class="tab ts" data-set="SELL">▼ SELL</div>
  <div class="tab" data-set="ALL">All Stocks</div>
</div>

<div class="tw">
<table>
  <thead><tr>
    <th onclick="setSort('symbol')">Stock / Sector / Change%</th>
    <th onclick="setSort('volume')">Volume</th>
    <th onclick="setSort('price')">CMP</th>
    <th onclick="setSort('emaGap')">EMA</th>
    <th>MACD</th>
    <th>Day H/L</th>
    <th>Week H/L</th>
    <th onclick="setSort('techScore')">Score</th>
    <th title="6 tech checks — hover squares for label">Checks</th>
    <th>Green Flag</th>
    <th>Red Flag</th>
    <th>Rating</th>
  </tr></thead>
  <tbody id="tbody"></tbody>
</table>
</div>
<div id="empty" class="empty" style="display:none">No results for current filter.</div>
<div id="scanning" class="scanning" style="display:none">⚙ Scan in progress — this takes 3–5 minutes on first run. Refresh in a moment.</div>

</div><!-- /wrap -->
</div><!-- /APP -->

<script>
if("Notification" in window) Notification.requestPermission().catch(()=>{});
function notify(t,b){try{if(Notification.permission==="granted") new Notification(t,{body:b});}catch(_){}}

let activeSet="GOLDEN", data=null, sortCol="techScore", sortAsc=false, nextAt=null;
const seen=new Set();

async function checkAuth(){
  try{
    const s=await fetch("/api/status").then(r=>r.json());
    if(!s.authenticated){show("LS");hide("APP");}
    else{hide("LS");show("APP");document.getElementById("sU").textContent=s.universe;load();}
  }catch(e){console.error(e);}
}
function show(id){document.getElementById(id).style.display=id==="LS"?"flex":"block";}
function hide(id){document.getElementById(id).style.display="none";}

async function doLogin(){
  const btn=document.querySelector(".lbtn");
  if(btn){btn.textContent="Logging in...";btn.disabled=true;}
  try{
    const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
    const d=await r.json();
    if(d.ok){setTimeout(()=>window.location.reload(),1500);}
    else{alert("Login failed: "+d.error);}
  }catch(e){alert("Login error: "+e.message);}
  finally{if(btn){btn.textContent="🔐 Login with Groww API";btn.disabled=false;}}
}

document.querySelectorAll(".tab").forEach(t=>t.addEventListener("click",()=>{
  document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));
  t.classList.add("active");activeSet=t.dataset.set;render();
}));
["search","tf","sigF","sortBy"].forEach(id=>{
  const el=document.getElementById(id);
  if(el){el.addEventListener("change",()=>{if(id==="tf")load();else render();});el.addEventListener("input",render);}
});
function setSort(c){if(sortCol===c)sortAsc=!sortAsc;else{sortCol=c;sortAsc=false;}render();}

function isOpen(){
  const ist=new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Kolkata"}));
  const h=ist.getHours(),m=ist.getMinutes(),d=ist.getDay();
  return d>0&&d<6&&(h>9||(h===9&&m>=15))&&(h<15||(h===15&&m<=30));
}
function tick(){
  const o=isOpen();
  const li=document.getElementById("liveInd"),mt=document.getElementById("mktTxt");
  if(li)li.className=o?"live":"live dead";
  if(mt)mt.textContent=o?"Market Open":"Market Closed";
  if(nextAt){
    const s=Math.max(0,Math.floor((nextAt-Date.now())/1000));
    const tp=document.getElementById("timerPill");
    if(tp)tp.textContent="Next: "+Math.floor(s/60)+"m "+String(s%60).padStart(2,"0")+"s";
  }
}

async function load(){
  try{
    const res=await fetch("/api/state");
    if(res.status===401){checkAuth();return;}
    const next=await res.json();
    data=next; nextAt=Date.now()+30000;
    const tf=document.getElementById("tf")?.value||"ALL";
    let all=[], buys=[], sells=[], golden=[];
    if (tf === "ALL") {
        const allTfs = ["1m", "5m", "10m", "15m", "30m", "1h", "1d"];
        allTfs.forEach(t => {
            all.push(...(next.data[t+"_ALL"]||[]));
            buys.push(...(next.data[t+"_BUY"]||[]));
            sells.push(...(next.data[t+"_SELL"]||[]));
            golden.push(...(next.data[t+"_GOLDEN"]||[]));
        });
    } else {
        all=next.data[tf+"_ALL"]||[]; buys=next.data[tf+"_BUY"]||[]; sells=next.data[tf+"_SELL"]||[]; golden=next.data[tf+"_GOLDEN"]||[];
    }
    const spikes=all.filter(r=>r.volSpike).length;
    const sbCount=all.filter(r=>r.rating==="STRONG BUY").length;
    const wlCount=all.filter(r=>r.rating==="WATCHLIST").length;
    const g=id=>document.getElementById(id);
    if(g("sG"))g("sG").textContent=golden.length;
    if(g("sB"))g("sB").textContent=buys.length;
    if(g("sS"))g("sS").textContent=sells.length;
    if(g("sSp"))g("sSp").textContent=spikes;
    if(g("sSB"))g("sSB").textContent=sbCount;
    if(g("sWL"))g("sWL").textContent=wlCount;
    if(g("sE"))g("sE").textContent=next.errors?.length||0;
    if(g("sT"))g("sT").textContent=next.lastUpdated?new Date(next.lastUpdated).toLocaleTimeString("en-IN",{timeZone:"Asia/Kolkata"}):"Scanning...";
    if(g("lastScan"))g("lastScan").textContent="Last: "+(next.lastUpdated?new Date(next.lastUpdated).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"}):"--");
    const eb=g("errBar");
    if(eb){eb.style.display=next.errors?.length?"block":"none";if(next.errors?.length)eb.textContent="Errors ("+next.errors.length+"): "+next.errors.slice(0,4).join(" | ");}
    golden.forEach(r=>{if(r.isNew){const k=r.symbol+"|"+r.tf;if(!seen.has(k)){seen.add(k);notify("🟣 Golden Cross — "+r.symbol+" ("+r.tf+")","EMA 21 > EMA 50 | Score: "+r.techScore+"/6 | "+r.rating);}}});
    document.getElementById("scanning").style.display="none";
    render();
  }catch(e){
    console.error(e);
    document.getElementById("scanning").style.display="block";
  }
}

function render(){
  if(!data)return;
  
  const genSparkline = (pHist, e21Hist, e50Hist) => {
    if(!pHist || !e21Hist || !e50Hist || pHist.length < 2) return "";
    const w = 100, h = 30;
    const all = [...pHist, ...e21Hist, ...e50Hist];
    const min = Math.min(...all), max = Math.max(...all), range = max - min || 1;
    const getX = i => (i / (pHist.length - 1)) * w;
    const getY = v => h - ((v - min) / range) * h;
    
    const mkPath = (arr, cls) => {
        let d = "M " + getX(0) + " " + getY(arr[0]);
        for(let i=1; i<arr.length; i++) d += " L " + getX(i) + " " + getY(arr[i]);
        return "<path class='" + cls + "' d='" + d + "' />";
    };
    
    return "<svg class='sparkline' viewBox='0 0 " + w + " " + h + "'>"
      + mkPath(pHist, 'spark-p')
      + mkPath(e50Hist, 'spark-50')
      + mkPath(e21Hist, 'spark-21')
      + "</svg>";
  };

  const tf=document.getElementById("tf")?.value||"ALL";
  const sigF=document.getElementById("sigF")?.value||"ALL";
  const q=(document.getElementById("search")?.value||"").trim().toUpperCase();
  const sortBy=document.getElementById("sortBy")?.value||sortCol;

  let rows = [];
  if (tf === "ALL") {
      const allTfs = ["1m", "5m", "10m", "15m", "30m", "1h", "1d"];
      allTfs.forEach(t => {
          rows.push(...(data.data[t+"_"+activeSet]||[]));
      });
  } else {
      rows=(data.data[tf+"_"+activeSet]||[]).slice();
  }
  
  if(sigF!=="ALL") rows=rows.filter(r=>r.signal===sigF);
  if(q) rows=rows.filter(r=>r.symbol.includes(q)||r.sector?.includes(q));

  const tfOrder = {"1m": 1, "5m": 2, "10m": 3, "15m": 4, "30m": 5, "1h": 6, "1d": 7};
  rows.sort((a,b)=>{
    if (tf === "ALL" && a.tf !== b.tf) return tfOrder[a.tf] - tfOrder[b.tf];
    if(sortBy==="symbol") return sortAsc?a.symbol.localeCompare(b.symbol):b.symbol.localeCompare(a.symbol);
    if(sortBy==="goldenCross"){if(a.goldenCross!==b.goldenCross)return a.goldenCross?-1:1;return b.techScore-a.techScore;}
    const va=+a[sortBy]||0, vb=+b[sortBy]||0;
    return sortAsc?va-vb:vb-va;
  });

  const totalCount = tf === "ALL" ? data.universe * 7 : (data.data[tf+"_"+activeSet]||[]).length;
  document.getElementById("rowCount").textContent="Showing "+rows.length+" of "+totalCount;
  const tbody=document.getElementById("tbody");
  const empty=document.getElementById("empty");
  if(!rows.length){tbody.innerHTML="";empty.style.display="block";return;}
  empty.style.display="none";

  tbody.innerHTML=rows.map(r=>{
    const sc=r.signal==="BUY"?"sb":r.signal==="SELL"?"ss":"sn";
    const cc=r.chgPct>=0?"up":"dn";
    const chg=(r.chgPct>=0?"+":"")+r.chgPct.toFixed(2)+"%";
    let emaTxt = "";
    
    const gapTxt = "<span class='ema-val " + cc + "'>Gap: " + Math.abs(r.emaGap).toFixed(2) + "%</span>";
    let statusTxt = "";
    if (r.goldenCross) {
        statusTxt = "<span class='ea lb sb' style='display:inline-block'>CROSS 21>50 UP</span>";
    } else if (r.deathCross) {
        statusTxt = "<span class='eb lb sk' style='display:inline-block'>CROSS 21<50 DOWN</span>";
    } else {
        statusTxt = r.ema21above ? "<span class='ea'>EMA 21 > 50</span>" : "<span class='eb'>EMA 21 < 50</span>";
    }
    
    emaTxt = "<div class='ema-cell'>" + genSparkline(r.priceHist, r.ema21Hist, r.ema50Hist) + statusTxt + gapTxt + "</div>";
    const macdVal = r.macdVal !== null ? r.macdVal.toFixed(2) : "—";
    const macdTxt = r.macdAbove 
      ? "<span class='up'>▲ Bull <small style='opacity:0.6'>(" + macdVal + ")</small></span>" 
      : "<span class='dn'>▼ Bear <small style='opacity:0.6'>(" + macdVal + ")</small></span>";
    const volTxt=r.volSpike?"<span class='spike'>⚡"+fmtV(r.volume)+"</span>":fmtV(r.volume);
    const gcBadge=r.goldenCross?"<span class='bgc'>🟣GC</span>":"";
    const newBadge=r.isNew&&r.signal!=="NONE"?"<span class='bnew'>NEW</span>":"";
    const rsiTxt=r.rsi!==null?r.rsi:"—";
    const rsiCls=r.rsi>75?"r":r.rsi<35?"y":"";
    const checkKeys=Object.keys(r.checks||{});
    const boxes=checkKeys.map(k=>"<span class='ck "+(r.checks[k]?"on":"off")+"' title='"+k+"'></span>").join("");
    const gf=r.techScore>0?"<span class='ea' style='font-size:10px;font-weight:bold'>⚑ "+r.techScore+"</span>":"—";
    const rf=r.redCount>0?"<span class='rf'>⚑ "+r.redCount+"</span>":"—";
    const ratCls=r.rating==="STRONG BUY"?"rat-sb":r.rating==="WATCHLIST"?"rat-wl":"rat-sk";
    return "<tr class='"+(r.goldenCross?"gc-row":r.isNew?"new-row":"")+"'>"
      +"<td><div class='sym'>"+r.symbol+" <span style='font-size:10px;color:rgba(167,139,250,0.8);font-weight:600'>("+r.tf+")</span>"+gcBadge+newBadge+"</div><div class='sec'>"+r.sector+" · <span class='"+cc+"'>"+chg+"</span></div></td>"
      +"<td>"+volTxt+"</td>"
      +"<td>₹"+r.price.toFixed(2)+"</td>"
      +"<td>"+emaTxt+"</td>"
      +"<td>"+macdTxt+"</td>"
      +"<td style='font-size:11px;color:var(--muted)'>"+(r.dayH?r.dayH.toFixed(1):"--")+" / "+(r.dayL?r.dayL.toFixed(1):"--")+"</td>"
      +"<td style='font-size:11px;color:var(--muted)'>"+(r.weekH?r.weekH.toFixed(1):"--")+" / "+(r.weekL?r.weekL.toFixed(1):"--")+"</td>"
      +"<td style='text-align:center'><b>"+r.techScore+"</b><span style='color:var(--muted)'>/6</span></td>"
      +"<td><div class='checks'>"+boxes+"</div></td>"
      +"<td>"+gf+"</td>"
      +"<td>"+rf+"</td>"
      +"<td><span class='"+ratCls+"'>"+r.rating+"</span></td>"
      +"</tr>";
  }).join("");
}

function fmtV(v){
  if(!v)return"—";
  if(v>=10000000)return(v/10000000).toFixed(1)+"Cr";
  if(v>=100000)return(v/100000).toFixed(1)+"L";
  if(v>=1000)return(v/1000).toFixed(0)+"K";
  return String(v);
}

setInterval(tick,1000);
setInterval(load,30000);
tick();
checkAuth();
</script>
</body>
</html>`));

// ── Boot ──────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
    console.log(`\n⚡ Ayush's Personal Scanner (Groww API) → http://localhost:${PORT}`);
    if (loadSession()) {
        isAuthenticated = true;
        console.log("Existing Groww session found. Starting scan...\n");
        scanAll();
    } else {
        console.log("No active session. Please login via the UI to start scanning.\n");
    }
});
