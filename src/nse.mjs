import axios from "axios";
import { UNIVERSE } from "./universe.mjs";

const NSE_BASE = "https://www.nseindia.com";
let nseSession = { cookies: "", expiresAt: 0 };

// ── NSE Session (mimics browser visit to get valid cookies) ──────────────────
async function refreshNseSession() {
    try {
        const res = await axios.get(NSE_BASE + "/market-data/live-equity-market", {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                "Accept-Encoding": "gzip, deflate, br",
                "Connection": "keep-alive",
                "Cache-Control": "no-cache",
            },
            timeout: 20000,
        });
        const setCookies = res.headers["set-cookie"] || [];
        nseSession.cookies = setCookies.map(c => c.split(";")[0]).join("; ");
        nseSession.expiresAt = Date.now() + 20 * 60 * 1000; // 20 min
        console.log("[NSE] Session refreshed ✓");
        return true;
    } catch (e) {
        console.error("[NSE] Session refresh failed:", e.message);
        return false;
    }
}

async function nseGet(path) {
    if (Date.now() > nseSession.expiresAt) {
        await refreshNseSession();
    }
    const res = await axios.get(NSE_BASE + path, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate, br",
            "Connection": "keep-alive",
            "Referer": NSE_BASE + "/",
            "Cookie": nseSession.cookies,
            "X-Requested-With": "XMLHttpRequest",
        },
        timeout: 20000,
    });
    return res.data;
}

// ── Cache layer ──────────────────────────────────────────────────────────────
const cache = {
    bulkDeals:  { data: null, ts: 0 },
    blockDeals: { data: null, ts: 0 },
    fiiDii:     { data: null, ts: 0 },
};
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ── Bulk Deals ───────────────────────────────────────────────────────────────
export async function getBulkDeals() {
    if (cache.bulkDeals.data && Date.now() - cache.bulkDeals.ts < CACHE_TTL) {
        return cache.bulkDeals.data;
    }
    try {
        const raw = await nseGet("/api/bulk-deals");
        const deals = (raw?.data || []).map(d => ({
            date:       d.BD_DT_DATE || d.date || "",
            symbol:     (d.BD_SYMBOL || d.symbol || "").toUpperCase(),
            name:       d.BD_COMP_NAME || d.name || "",
            clientName: d.BD_CLIENT_NAME || d.clientName || "",
            buySell:    (d.BD_BUY_SELL || d.buySell || "").toUpperCase(),
            qty:        +(d.BD_QTY_TRD || d.qty || 0),
            price:      +(d.BD_TP_WATP || d.price || 0),
            remarks:    d.BD_REMARKS || "",
        }));
        // Filter to only our universe + keep all for context
        const universeSet = new Set(UNIVERSE);
        const watchlistDeals = deals.filter(d => universeSet.has(d.symbol));
        const result = { all: deals, watchlist: watchlistDeals, fetchedAt: new Date().toISOString() };
        cache.bulkDeals = { data: result, ts: Date.now() };
        return result;
    } catch (e) {
        console.error("[NSE] Bulk deals error:", e.message);
        return cache.bulkDeals.data || { all: [], watchlist: [], fetchedAt: null, error: e.message };
    }
}

// ── Block Deals ──────────────────────────────────────────────────────────────
export async function getBlockDeals() {
    if (cache.blockDeals.data && Date.now() - cache.blockDeals.ts < CACHE_TTL) {
        return cache.blockDeals.data;
    }
    try {
        const raw = await nseGet("/api/block-deals");
        const deals = (raw?.data || []).map(d => ({
            date:       d.BD_DT_DATE || "",
            symbol:     (d.BD_SYMBOL || "").toUpperCase(),
            name:       d.BD_COMP_NAME || "",
            clientName: d.BD_CLIENT_NAME || "",
            buySell:    (d.BD_BUY_SELL || "").toUpperCase(),
            qty:        +(d.BD_QTY_TRD || 0),
            price:      +(d.BD_TP_WATP || 0),
        }));
        const universeSet = new Set(UNIVERSE);
        const watchlistDeals = deals.filter(d => universeSet.has(d.symbol));
        const result = { all: deals, watchlist: watchlistDeals, fetchedAt: new Date().toISOString() };
        cache.blockDeals = { data: result, ts: Date.now() };
        return result;
    } catch (e) {
        console.error("[NSE] Block deals error:", e.message);
        return cache.blockDeals.data || { all: [], watchlist: [], fetchedAt: null, error: e.message };
    }
}

// ── FII / DII Flow ───────────────────────────────────────────────────────────
export async function getFiiDii() {
    if (cache.fiiDii.data && Date.now() - cache.fiiDii.ts < CACHE_TTL) {
        return cache.fiiDii.data;
    }
    try {
        const raw = await nseGet("/api/fiidiiTradeReact");
        const rows = (Array.isArray(raw) ? raw : raw?.data || []).map(d => ({
            date:        d.date || "",
            category:    d.category || "",
            buyVal:      +(d.buyVal || d.buy_val || 0),
            sellVal:     +(d.sellVal || d.sell_val || 0),
            netVal:      +(d.netVal || d.net || 0),
        }));
        const result = { data: rows, fetchedAt: new Date().toISOString() };
        cache.fiiDii = { data: result, ts: Date.now() };
        return result;
    } catch (e) {
        console.error("[NSE] FII/DII error:", e.message);
        return cache.fiiDii.data || { data: [], fetchedAt: null, error: e.message };
    }
}

// Pre-warm the NSE session on module load
refreshNseSession().catch(() => {});
