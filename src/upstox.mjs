import axios from "axios";
import {
    CREDS, LTP_URL, QUOTES_URL, HISTORICAL_CANDLE_BASE, OPTION_CHAIN_URL,
    HOLDINGS_URL, POSITIONS_URL, TF_DAYS,
} from "./config.mjs";
import {
    loadInstrumentMaster, isInstrumentMasterLoaded,
    resolveInstrumentKey, resolveInstrumentKeys, symbolForInstrumentKey,
} from "./instruments.mjs";

// Upstox Analytics Token is a long-lived (~1yr), read-only credential generated
// once from the Developer Apps dashboard — unlike Groww there is no daily
// interactive login/checksum flow. `verified` just tracks whether we've
// confirmed the token actually works against the live API.
let verified = false;

export function isLoggedIn() {
    return verified;
}

// Kept for compatibility with call sites that check "is a token configured".
export function loadSession() {
    return !!CREDS.accessToken;
}

export async function ensureSession() {
    return !!CREDS.accessToken;
}

// ── Global Rate Limiter ─────────────────────────────────────────────────────────
// Upstox's documented limits for market-data/standard APIs are 25-50 req/sec and
// 250-500 req/min depending on category. We use a conservative shared budget
// (well under the lowest published figure) since most live-price traffic now
// flows over the WebSocket feed instead of REST polling.
const rateLimitState = {
    requestsInWindow: [], // minute window
    lastRequestTime: 0,
    minGap: 125, // ~8 req/sec burst max
    maxPerMinute: 250,
    backoffuntil: 0
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function rateLimit() {
    while (true) {
        const now = Date.now();

        if (now < rateLimitState.backoffuntil) {
            await sleep(rateLimitState.backoffuntil - now);
            continue;
        }

        rateLimitState.requestsInWindow = rateLimitState.requestsInWindow.filter(t => now - t < 60000);

        if (rateLimitState.requestsInWindow.length >= rateLimitState.maxPerMinute) {
            await sleep(1000);
            continue;
        }

        const gap = now - rateLimitState.lastRequestTime;
        if (gap < rateLimitState.minGap) {
            await sleep(rateLimitState.minGap - gap);
            continue;
        }

        rateLimitState.requestsInWindow.push(now);
        rateLimitState.lastRequestTime = now;
        return;
    }
}

export function triggerBackoff(seconds = 5) {
    console.warn(`[RateLimit] Triggering backoff for ${seconds}s...`);
    rateLimitState.backoffuntil = Date.now() + (seconds * 1000);
}

function authHeaders() {
    return {
        "Authorization": `Bearer ${CREDS.accessToken}`,
        "Accept": "application/json",
    };
}

function describeError(e) {
    const errs = e.response?.data?.errors;
    if (Array.isArray(errs) && errs.length) {
        return errs.map(x => `${x.errorCode || "?"}: ${x.message || ""}`).join("; ");
    }
    return e.response?.data?.message || e.message;
}

/**
 * Verify the configured Upstox Access Token actually works. There is no
 * interactive login step with an Analytics Token — this just confirms the
 * token is valid by resolving the instrument master and requesting a single,
 * always-available LTP (Nifty 50).
 */
export async function login() {
    if (!CREDS.accessToken) {
        throw new Error("UPSTOX_ACCESS_TOKEN is not configured.");
    }

    if (!isInstrumentMasterLoaded()) {
        await loadInstrumentMaster();
    }

    const niftyKey = resolveInstrumentKey("NIFTY");
    if (!niftyKey) {
        throw new Error("Instrument master loaded but NIFTY could not be resolved.");
    }

    await rateLimit();
    try {
        await axios.get(LTP_URL, {
            params: { instrument_key: niftyKey },
            headers: authHeaders(),
            timeout: 15000,
        });
        verified = true;
        console.log("Upstox token verified ✓");
    } catch (e) {
        verified = false;
        const status = e.response?.status;
        if (status === 401 || status === 403) {
            throw new Error(`Upstox rejected the access token (${status}): ${describeError(e)}`);
        }
        if (status === 429) {
            triggerBackoff(15);
            throw new Error("Upstox rate-limited the verification request (429).");
        }
        throw new Error(`Upstox token verification failed: ${describeError(e)}`);
    }
}

// ── Historical Candles ───────────────────────────────────────────────────────────
const UNIT_INTERVAL_BY_TF = {
    "1m": { unit: "minutes", interval: 1 },
    "5m": { unit: "minutes", interval: 5 },
    "10m": { unit: "minutes", interval: 10 },
    "15m": { unit: "minutes", interval: 15 },
    "30m": { unit: "minutes", interval: 30 },
    "1h": { unit: "hours", interval: 1 },
    "1d": { unit: "days", interval: 1 },
};

function toDateStr(d) {
    return d.toISOString().split("T")[0];
}

// Upstox's v3 historical-candle endpoint rejects intraday (minutes/hours)
// date ranges wider than roughly a month (confirmed live: a 31-day 5m
// request succeeds, 33 days returns UDAPI1148 "Invalid date range"). The
// live scanner's own default TF_DAYS windows already stay under this, so
// this only matters for explicit wide `range` overrides (backtest.mjs).
// Kept conservative since the exact boundary may vary slightly by interval.
const INTRADAY_CHUNK_DAYS = 24;

async function fetchCandlesChunk(instrumentKey, unitInterval, from, to) {
    const url = [
        HISTORICAL_CANDLE_BASE,
        encodeURIComponent(instrumentKey),
        unitInterval.unit,
        unitInterval.interval,
        toDateStr(to),
        toDateStr(from),
    ].join("/");

    await rateLimit();
    try {
        const res = await axios.get(url, { headers: authHeaders(), timeout: 20000 });
        const candles = res.data?.data?.candles || [];
        // Upstox returns candles newest-first; the rest of this app (EMA/MACD/
        // RSI/buildSignal) assumes oldest-first chronological order.
        return candles.map(c => ({
            ts: Date.parse(c[0]),
            open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5],
        }));
    } catch (e) {
        if (e.response?.status === 429) triggerBackoff(15);
        throw new Error(describeError(e));
    }
}

/**
 * @param {string} symbol
 * @param {string} tf
 * @param {{to?: Date, from?: Date}} [range] — override the default "last
 *   TF_DAYS[tf] days up to now" window. Used by backtest.mjs to pull a
 *   specific historical window; live scanning never passes this.
 */
export async function fetchCandles(symbol, tf, range = null) {
    if (!isInstrumentMasterLoaded()) await loadInstrumentMaster();
    const instrumentKey = resolveInstrumentKey(symbol);
    if (!instrumentKey) {
        throw new Error(`No Upstox instrument_key found for symbol "${symbol}"`);
    }

    const unitInterval = UNIT_INTERVAL_BY_TF[tf];
    if (!unitInterval) throw new Error(`Unsupported timeframe "${tf}"`);

    const to = range?.to ?? new Date();
    const from = range?.from ?? new Date(to.getTime() - TF_DAYS[tf] * 86400000);

    const spanDays = (to.getTime() - from.getTime()) / 86400000;
    const needsChunking = unitInterval.unit !== "days" && spanDays > INTRADAY_CHUNK_DAYS;

    let all;
    if (!needsChunking) {
        all = await fetchCandlesChunk(instrumentKey, unitInterval, from, to);
    } else {
        all = [];
        let chunkTo = to;
        while (chunkTo > from) {
            const chunkFrom = new Date(Math.max(from.getTime(), chunkTo.getTime() - INTRADAY_CHUNK_DAYS * 86400000));
            const part = await fetchCandlesChunk(instrumentKey, unitInterval, chunkFrom, chunkTo);
            all.push(...part);
            chunkTo = new Date(chunkFrom.getTime() - 86400000); // step back a day to avoid re-requesting the same boundary day
        }
    }

    // Dedupe (chunk boundaries can overlap by a day) and sort chronologically.
    const seen = new Set();
    const deduped = [];
    for (const c of all) {
        if (seen.has(c.ts)) continue;
        seen.add(c.ts);
        deduped.push(c);
    }
    deduped.sort((a, b) => a.ts - b.ts);
    return deduped;
}

// ── Bulk LTP ─────────────────────────────────────────────────────────────────────
export async function fetchBulkLtp(symbols) {
    if (!symbols || symbols.length === 0) return {};
    if (!isInstrumentMasterLoaded()) await loadInstrumentMaster();

    const { instrumentKeyBySymbol, unresolved } = resolveInstrumentKeys(symbols);
    if (unresolved.length > 0 && process.env.NODE_ENV !== "production") {
        console.warn(`[Upstox] LTP: ${unresolved.length} symbol(s) unresolved: ${unresolved.slice(0, 5).join(", ")}${unresolved.length > 5 ? "..." : ""}`);
    }

    const keys = [...instrumentKeyBySymbol.values()];
    if (keys.length === 0) return {};

    // Upstox v3 LTP allows up to 500 instrument keys per request.
    const chunks = [];
    for (let i = 0; i < keys.length; i += 500) chunks.push(keys.slice(i, i + 500));

    const fetchChunk = async (chunkKeys) => {
        await rateLimit();
        try {
            const res = await axios.get(LTP_URL, {
                params: { instrument_key: chunkKeys.join(",") },
                headers: authHeaders(),
                timeout: 15000,
            });
            return res.data?.data || {};
        } catch (e) {
            if (e.response?.status === 429) triggerBackoff(30);
            console.error(`[Upstox] LTP fetch error:`, describeError(e));
            return {};
        }
    };

    const results = await Promise.all(chunks.map(fetchChunk));
    const prices = {};
    for (const data of results) {
        for (const entry of Object.values(data)) {
            const sym = symbolForInstrumentKey(entry.instrument_token);
            if (sym) prices[sym] = entry.last_price ?? 0;
        }
    }
    return prices;
}

// ── Bulk Quotes (bid/ask depth) ───────────────────────────────────────────────
// Upstox's v3 LTP endpoint (used everywhere else in this app) doesn't carry
// quote/spread data at all — only this older v2 "full quote" endpoint does,
// via best-5 market depth. Used sparingly (Intraday Opportunities shortlist
// + active Critical trades only, not the whole scanned universe every
// cycle) since it's a separate, heavier call than the LTP path.
export async function fetchBulkQuotes(symbols) {
    if (!symbols || symbols.length === 0) return {};
    if (!isInstrumentMasterLoaded()) await loadInstrumentMaster();

    const { instrumentKeyBySymbol, unresolved } = resolveInstrumentKeys(symbols);
    if (unresolved.length > 0 && process.env.NODE_ENV !== "production") {
        console.warn(`[Upstox] Quotes: ${unresolved.length} symbol(s) unresolved: ${unresolved.slice(0, 5).join(", ")}`);
    }
    const keys = [...instrumentKeyBySymbol.values()];
    if (keys.length === 0) return {};

    const chunks = [];
    for (let i = 0; i < keys.length; i += 500) chunks.push(keys.slice(i, i + 500));

    const fetchChunk = async (chunkKeys) => {
        await rateLimit();
        try {
            const res = await axios.get(QUOTES_URL, {
                params: { instrument_key: chunkKeys.join(",") },
                headers: authHeaders(),
                timeout: 15000,
            });
            return res.data?.data || {};
        } catch (e) {
            if (e.response?.status === 429) triggerBackoff(20);
            console.error(`[Upstox] Quotes fetch error:`, describeError(e));
            return {};
        }
    };

    const results = await Promise.all(chunks.map(fetchChunk));
    const quotes = {};
    for (const data of results) {
        for (const entry of Object.values(data)) {
            const sym = symbolForInstrumentKey(entry.instrument_token);
            if (!sym) continue;
            const bestBid = entry.depth?.buy?.[0]?.price ?? null;
            const bestAsk = entry.depth?.sell?.[0]?.price ?? null;
            let spread = null, spreadPct = null;
            if (bestBid != null && bestAsk != null && bestBid > 0 && bestAsk > bestBid) {
                spread = +(bestAsk - bestBid).toFixed(2);
                const mid = (bestAsk + bestBid) / 2;
                spreadPct = +((spread / mid) * 100).toFixed(3);
            }
            quotes[sym] = { bestBid, bestAsk, spread, spreadPct, lastPrice: entry.last_price ?? null };
        }
    }
    return quotes;
}

// ── Option Chain ─────────────────────────────────────────────────────────────────
// Upstox resolves relative expiries via keywords. Weekly-expiry availability
// varies by symbol/regulation over time, so we try the near-term expiry first
// and fall back to the monthly one rather than hardcoding a specific weekday.
const EXPIRY_KEYWORDS = ["current_week", "current_month"];

export async function fetchOptionChain(symbol) {
    if (!isInstrumentMasterLoaded()) await loadInstrumentMaster();
    const instrumentKey = resolveInstrumentKey(symbol);
    if (!instrumentKey) return null;

    for (const expiryKeyword of EXPIRY_KEYWORDS) {
        await rateLimit();
        try {
            const res = await axios.get(OPTION_CHAIN_URL, {
                params: { instrument_key: instrumentKey, expiry_date: expiryKeyword },
                headers: authHeaders(),
                timeout: 20000,
            });
            const rows = res.data?.data;
            if (Array.isArray(rows) && rows.length > 0) {
                return normalizeOptionChain(symbol, rows);
            }
        } catch (e) {
            if (e.response?.status === 429) triggerBackoff(20);
            if (e.response?.status !== 404 && e.response?.status !== 400) {
                console.error(`[Upstox] Option chain fetch error [${symbol}]:`, describeError(e));
            }
        }
    }
    return null;
}

/**
 * Normalize Upstox's option-chain rows (one row per strike, with nested
 * call_options/put_options) into the flat { strikes: { [strike]: {CE,PE} } }
 * shape the rest of this app (options_feed.mjs, scanner_testing.mjs) expects
 * from the old Groww response.
 */
export function normalizeOptionChain(symbol, rows) {
    const strikes = {};
    let underlyingLtp = null;
    let expiryDate = null;

    for (const row of rows) {
        underlyingLtp = row.underlying_spot_price ?? underlyingLtp;
        expiryDate = row.expiry ?? expiryDate;

        const strikeKey = String(row.strike_price);
        const entry = strikes[strikeKey] || {};

        if (row.call_options) {
            const md = row.call_options.market_data || {};
            const gk = row.call_options.option_greeks || {};
            entry.CE = {
                instrument_key: row.call_options.instrument_key,
                lastPrice: md.ltp || 0,
                ltp: md.ltp || 0,
                open_interest: md.oi || 0,
                oi: md.oi || 0,
                changeInOI: md.oi != null && md.prev_oi != null ? md.oi - md.prev_oi : 0,
                volume: md.volume || 0,
                impliedVolatility: gk.iv || 0,
                delta: gk.delta || 0,
                gamma: gk.gamma || 0,
                theta: gk.theta || 0,
                vega: gk.vega || 0,
            };
        }
        if (row.put_options) {
            const md = row.put_options.market_data || {};
            const gk = row.put_options.option_greeks || {};
            entry.PE = {
                instrument_key: row.put_options.instrument_key,
                lastPrice: md.ltp || 0,
                ltp: md.ltp || 0,
                open_interest: md.oi || 0,
                oi: md.oi || 0,
                changeInOI: md.oi != null && md.prev_oi != null ? md.oi - md.prev_oi : 0,
                volume: md.volume || 0,
                impliedVolatility: gk.iv || 0,
                delta: gk.delta || 0,
                gamma: gk.gamma || 0,
                theta: gk.theta || 0,
                vega: gk.vega || 0,
            };
        }
        strikes[strikeKey] = entry;
    }

    return {
        symbol,
        underlying_ltp: underlyingLtp,
        underlyingValue: underlyingLtp,
        expiryDate,
        strikes,
    };
}

// ── Portfolio API ─────────────────────────────────────────────────────────────────
// UDAPI1221 ("permitted only from the static IP configured in your account")
// is an account/infra restriction, not a transient failure — retrying it on
// every Portfolio-tab open just wastes a request and logs the same error
// forever. Once seen, skip the network call for a cooldown window and let
// callers (the /api/portfolio route) surface a clear, static message instead.
const STATIC_IP_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
export const portfolioApiStatus = { holdings: null, positions: null }; // null | { blockedUntil, message }

function isStaticIpError(e) {
    return e.response?.data?.errors?.some(x => x.errorCode === "UDAPI1221") ?? false;
}

export async function fetchHoldings() {
    if (portfolioApiStatus.holdings && Date.now() < portfolioApiStatus.holdings.blockedUntil) return [];

    await rateLimit();
    try {
        const res = await axios.get(HOLDINGS_URL, { headers: authHeaders(), timeout: 15000 });
        portfolioApiStatus.holdings = null;
        return res.data?.data || [];
    } catch (e) {
        if (e.response?.status === 429) triggerBackoff(10);
        if (isStaticIpError(e)) {
            portfolioApiStatus.holdings = { blockedUntil: Date.now() + STATIC_IP_COOLDOWN_MS, message: describeError(e) };
        } else {
            console.error(`[Upstox] Holdings fetch error:`, describeError(e));
        }
        return [];
    }
}

export async function fetchPositions() {
    if (portfolioApiStatus.positions && Date.now() < portfolioApiStatus.positions.blockedUntil) return [];

    await rateLimit();
    try {
        const res = await axios.get(POSITIONS_URL, { headers: authHeaders(), timeout: 15000 });
        portfolioApiStatus.positions = null;
        return res.data?.data || [];
    } catch (e) {
        if (e.response?.status === 429) triggerBackoff(10);
        if (isStaticIpError(e)) {
            portfolioApiStatus.positions = { blockedUntil: Date.now() + STATIC_IP_COOLDOWN_MS, message: describeError(e) };
        } else {
            console.error(`[Upstox] Positions fetch error:`, describeError(e));
        }
        return [];
    }
}
