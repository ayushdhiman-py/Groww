// ─────────────────────────────────────────────────────────────────────────────
// data_fetcher.mjs — Robust Multi-Source Data Fetcher
// Fetches from NSE, Yahoo Finance, Groww, and alternative APIs
// Ensures data availability even when primary sources fail
// ─────────────────────────────────────────────────────────────────────────────

import axios from "axios";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const DATA_SOURCES = {
  nse: {
    base: "https://www.nseindia.com",
    timeout: 10000,
    retries: 2
  },
  yahoo: {
    base: "https://query1.finance.yahoo.com/v8/finance/chart",
    timeout: 8000,
    retries: 2
  },
  nseArchives: {
    base: "https://nseindia.com/api",
    timeout: 10000
  },
  externalVix: {
    url: "https://India-vix-default-value.onrender.com",
    timeout: 5000
  }
};

// NSE session management
let nseSession = { cookies: "", expiresAt: 0, refreshing: false, blocked: false, lastAttempt: 0 };

async function refreshNseSession() {
  if (nseSession.refreshing) return false;
  
  // If NSE is blocked, only retry once every 30 minutes
  if (nseSession.blocked && Date.now() - nseSession.lastAttempt < 30 * 60 * 1000) {
    return false;
  }
  
  nseSession.refreshing = true;
  nseSession.lastAttempt = Date.now();
  try {
    const res = await axios.get(DATA_SOURCES.nse.base, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
      },
      timeout: DATA_SOURCES.nse.timeout,
      maxRedirects: 5,
    });
    const setCookies = res.headers["set-cookie"] || [];
    nseSession.cookies = setCookies.map(c => c.split(";")[0]).join("; ");
    nseSession.expiresAt = Date.now() + 15 * 60 * 1000; // 15 min
    nseSession.blocked = false;
    console.log("[NSE] Session refreshed ✓");
    return true;
  } catch (e) {
    nseSession.blocked = true;
    nseSession.cookies = "";
    nseSession.expiresAt = 0;
    return false; // Don't log - it's expected to fail
  } finally {
    nseSession.refreshing = false;
  }
}

async function nseFetch(path, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (Date.now() > nseSession.expiresAt || !nseSession.cookies) {
      const ok = await refreshNseSession();
      if (!ok) {
        if (attempt === retries) return null;
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
    }
    try {
      const res = await axios.get(DATA_SOURCES.nse.base + path, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": DATA_SOURCES.nse.base + "/",
          "Cookie": nseSession.cookies,
        },
        timeout: DATA_SOURCES.nse.timeout,
      });
      return res.data;
    } catch (e) {
      if (e.response?.status === 401 || e.response?.status === 403) {
        nseSession.expiresAt = 0; // Force refresh
        continue;
      }
      if (attempt === retries) {
        console.log(`[NSE Fetch] Failed for ${path}: ${e.message}`);
        return null;
      }
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Yahoo Finance Fallback
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch stock data from Yahoo Finance as fallback
 * Returns { price, volume, dayHigh, DayLow, atr, rsi, etc. }
 */
export async function fetchFromYahoo(symbol) {
  try {
    // Yahoo Finance chart API
    const url = `${DATA_SOURCES.yahoo.base}/${symbol}.NS?interval=1d&range=3mo`;
    const res = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      timeout: DATA_SOURCES.yahoo.timeout
    });

    const result = res.data?.chart?.result?.[0];
    if (!result) return null;

    const meta = result.meta;
    const timestamps = result.timestamp || [];
    const quotes = result.indicators?.quote?.[0] || {};
    const closes = (quotes.close || []).filter(v => v !== null && Number.isFinite(v));
    const highs = (quotes.high || []).filter(v => v !== null && Number.isFinite(v));
    const lows = (quotes.low || []).filter(v => v !== null && Number.isFinite(v));
    const volumes = (quotes.volume || []).filter(v => v !== null && Number.isFinite(v));

    // Calculate ATR from recent data
    let atr = null;
    if (closes.length >= 15) {
      const trs = [];
      for (let i = 1; i < closes.length; i++) {
        const tr = Math.max(
          highs[i] - lows[i],
          Math.abs(highs[i] - closes[i - 1]),
          Math.abs(lows[i] - closes[i - 1])
        );
        trs.push(tr);
      }
      if (trs.length >= 14) {
        atr = trs.slice(-14).reduce((a, b) => a + b, 0) / 14;
      }
    }

    return {
      symbol: meta.symbol?.replace('.NS', ''),
      price: meta.regularMarketPrice,
      dayHigh: meta.regularMarketDayHigh,
      dayLow: meta.regularMarketDayLow,
      volume: meta.regularMarketVolume,
      avgVolume: meta.fiftyDayAverageVolume || null,
      atr,
      marketCap: meta.marketCap,
      source: "yahoo"
    };
  } catch (e) {
    console.log(`[Yahoo Finance] Fetch failed for ${symbol}: ${e.message}`);
    return null;
  }
}

/**
 * Fetch VIX from alternative sources
 * Priority: Yahoo Finance (most reliable) → NSE → External APIs
 */
export async function fetchVIXFromAlternatives() {
  // Try multiple sources in order of reliability
  const sources = [
    {
      name: "Yahoo Finance",
      fn: async () => {
        try {
          const res = await axios.get(
            "https://query1.finance.yahoo.com/v8/finance/chart/%5EINDIAVIX?range=1d&interval=1d",
            {
              headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
              },
              timeout: 8000
            }
          );
          const result = res.data?.chart?.result?.[0];
          const vix = result?.meta?.regularMarketPrice;
          if (vix && !isNaN(vix) && vix > 0 && vix < 100) return vix;
        } catch {}
        return null;
      }
    },
    {
      name: "NSE India",
      fn: async () => {
        try {
          const data = await nseFetch("/api/vix");
          if (data) {
            const vix = parseFloat(data.indiaVIX || data.VIX || data.value);
            if (!isNaN(vix) && vix > 0) return vix;
          }
        } catch {}
        return null;
      }
    },
    {
      name: "External API",
      fn: async () => {
        try {
          const res = await axios.get("https://india-vix-api.vercel.app/api/vix", {
            timeout: 5000
          });
          const vix = parseFloat(res.data?.vix || res.data?.value);
          if (!isNaN(vix) && vix > 0 && vix < 100) return vix;
        } catch {}
        return null;
      }
    }
  ];

  for (const source of sources) {
    try {
      const vix = await source.fn();
      if (vix && vix > 0 && vix < 100) {
        console.log(`[VIX] Fetched from ${source.name}: ${vix.toFixed(2)}`);
        return { value: vix, source: source.name };
      }
    } catch (e) {
      console.log(`[VIX] ${source.name} failed: ${e.message}`);
    }
  }

  // All sources failed — do NOT substitute a hardcoded "default estimate".
  // A fabricated 14.5 would be indistinguishable from a real calm-market
  // reading downstream, when VIX is actually unknown.
  console.log("[VIX] All sources failed — VIX unavailable this cycle");
  return { value: null, source: "unavailable" };
}

// ─────────────────────────────────────────────────────────────────────────────
// F&O Ban List — Multi-source (NSE → Sensibull → Moneycontrol → Cache)
// ─────────────────────────────────────────────────────────────────────────────

let foBanCache = { data: new Set(), ts: 0, ttl: 5 * 60 * 1000 };

/**
 * Freshness verdict for the F&O ban list. `ts:0` means no source has EVER
 * succeeded — an empty Set at that point means "unknown," not "confirmed no
 * bans," which matters because intraday_scanner.mjs/overnight_scanner.mjs
 * hard-block a symbol on `isFOBanned` — a silently-empty list from a failed
 * fetch would let an actually-banned stock through undetected.
 */
export function getFOBanListStatus() {
  const ageMs = foBanCache.ts ? Date.now() - foBanCache.ts : null;
  return {
    available: foBanCache.ts > 0,
    stale: foBanCache.ts === 0 || ageMs > foBanCache.ttl * 3,
    ageMs,
    count: foBanCache.data.size,
  };
}

export async function getFOBanList() {
  if (foBanCache.data.size > 0 && Date.now() - foBanCache.ts < foBanCache.ttl) {
    return foBanCache.data;
  }

  // Try NSE first
  try {
    const data = await nseFetch("/api/underlyingOpenInterest");
    if (data && data.data) {
      const bannedStocks = new Set();
      for (const item of data.data) {
        if (item.isBan === true || (item.meta && item.meta.isBan)) {
          bannedStocks.add((item.symbol || "").toUpperCase());
        }
      }
      if (bannedStocks.size > 0) {
        foBanCache = { ...foBanCache, data: bannedStocks, ts: Date.now() };
        console.log(`[F&O Ban] NSE: ${bannedStocks.size} banned stocks`);
        return bannedStocks;
      }
    }
  } catch (e) {
    // Silently fail - NSE is usually blocked
  }

  // Fallback 1: Sensibull API
  try {
    const res = await axios.get("https://api.sensibull.com/v1/fno-ban-stocks", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      timeout: 8000
    });
    if (res.data?.data?.fno_ban_stocks) {
      const bannedStocks = new Set(
        res.data.data.fno_ban_stocks.map(s => (s.symbol || s).toUpperCase())
      );
      if (bannedStocks.size > 0) {
        foBanCache = { ...foBanCache, data: bannedStocks, ts: Date.now() };
        console.log(`[F&O Ban] Sensibull: ${bannedStocks.size} banned stocks`);
        return bannedStocks;
      }
    }
  } catch (e) {
    // Silently fail
  }

  // Fallback 2: Alternative NSE endpoint
  try {
    const data = await nseFetch("/api/all-reports?slug=derivatives-watch&section=market");
    if (data?.banStocks) {
      const bannedStocks = new Set(data.banStocks.map(s => (s.symbol || "").toUpperCase()));
      if (bannedStocks.size > 0) {
        foBanCache = { ...foBanCache, data: bannedStocks, ts: Date.now() };
        console.log(`[F&O Ban] NSE Alternative: ${bannedStocks.size} banned stocks`);
        return bannedStocks;
      }
    }
  } catch (e) {
    // Silently fail
  }

  // Return cached or empty set
  console.log(`[F&O Ban] Using cached/empty: ${foBanCache.data.size} stocks (NSE blocked, scanners will proceed without ban data)`);
  return foBanCache.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Delivery Percentage — Multi-source with Smart Estimation
// Primary: NSE API → Fallbacks: Previous days → Estimation from volume patterns
// ─────────────────────────────────────────────────────────────────────────────

let deliveryCache = { data: new Map(), ts: 0, ttl: 30 * 60 * 1000 };

export function getDeliveryDataStatus() {
  const ageMs = deliveryCache.ts ? Date.now() - deliveryCache.ts : null;
  return { available: deliveryCache.ts > 0, stale: deliveryCache.ts === 0 || ageMs > deliveryCache.ttl * 3, ageMs, count: deliveryCache.data.size };
}

export async function getDeliveryData() {
  if (deliveryCache.data.size > 0 && Date.now() - deliveryCache.ts < deliveryCache.ttl) {
    return deliveryCache.data;
  }

  // Try NSE daily delivery report (today)
  try {
    const today = new Date();
    const dateStr = `${today.getDate().toString().padStart(2, "0")}-${(today.getMonth() + 1).toString().padStart(2, "0")}-${today.getFullYear()}`;

    const data = await nseFetch(`/api/merged-daily-delivery-report?date=${dateStr}`);
    if (data && data.data && data.data.length > 0) {
      const deliveryMap = new Map();
      for (const row of data.data) {
        const sym = (row.symbol || "").toUpperCase();
        const delPct = parseFloat(row.deliveryToTradedQuantity || row.deliveryPercent || 0);
        if (sym && !isNaN(delPct) && delPct > 0) {
          deliveryMap.set(sym, delPct);
        }
      }
      if (deliveryMap.size > 0) {
        deliveryCache = { ...deliveryCache, data: deliveryMap, ts: Date.now() };
        console.log(`[Delivery] NSE Today: ${deliveryMap.size} stocks`);
        return deliveryMap;
      }
    }
  } catch (e) {
    // Silently fail - NSE is usually blocked
  }

  // Fallback: Previous day's NSE data
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = `${yesterday.getDate().toString().padStart(2, "0")}-${(yesterday.getMonth() + 1).toString().padStart(2, "0")}-${yesterday.getFullYear()}`;

    const data = await nseFetch(`/api/merged-daily-delivery-report?date=${dateStr}`);
    if (data && data.data && data.data.length > 0) {
      const deliveryMap = new Map();
      for (const row of data.data) {
        const sym = (row.symbol || "").toUpperCase();
        const delPct = parseFloat(row.deliveryToTradedQuantity || row.deliveryPercent || 0);
        if (sym && !isNaN(delPct) && delPct > 0) {
          deliveryMap.set(sym, delPct);
        }
      }
      if (deliveryMap.size > 0) {
        deliveryCache = { ...deliveryCache, data: deliveryMap, ts: Date.now() };
        console.log(`[Delivery] NSE Previous Day: ${deliveryMap.size} stocks`);
        return deliveryMap;
      }
    }
  } catch (e) {
    // Silently fail
  }

  // Return cached/empty - scanners will handle null delivery gracefully
  console.log(`[Delivery] Using cached/empty: ${deliveryCache.data.size} stocks (NSE blocked, using fallbacks in scanners)`);
  return deliveryCache.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Earnings Calendar — Multi-source (NSE → Yahoo Finance → Cache)
// ─────────────────────────────────────────────────────────────────────────────

let earningsCache = { data: [], ts: 0, ttl: 60 * 60 * 1000 };

export function getEarningsCalendarStatus() {
  const ageMs = earningsCache.ts ? Date.now() - earningsCache.ts : null;
  return { available: earningsCache.ts > 0, stale: earningsCache.ts === 0 || ageMs > earningsCache.ttl * 3, ageMs, count: earningsCache.data.length };
}

export async function getEarningsCalendar() {
  if (earningsCache.data.length > 0 && Date.now() - earningsCache.ts < earningsCache.ttl) {
    return earningsCache.data;
  }

  // Try NSE first
  try {
    const today = new Date();
    const fromDate = new Date(today);
    const toDate = new Date(today);
    toDate.setDate(toDate.getDate() + 7);

    const fromStr = `${fromDate.getDate().toString().padStart(2, "0")}-${(fromDate.getMonth() + 1).toString().padStart(2, "0")}-${fromDate.getFullYear()}`;
    const toStr = `${toDate.getDate().toString().padStart(2, "0")}-${(toDate.getMonth() + 1).toString().padStart(2, "0")}-${toDate.getFullYear()}`;

    const data = await nseFetch(`/api/corporate-announcements?from_date=${fromStr}&to_date=${toStr}`);

    if (data && data.response) {
      const earnings = [];
      for (const item of data.response) {
        const purpose = (item.purpose || "").toLowerCase();
        if (purpose.includes("result") || purpose.includes("earning") ||
            purpose.includes("financial") || purpose.includes("unaudited")) {
          const sym = (item.symbol || "").toUpperCase();
          const date = item.date || item.ann_dt || "";
          if (sym && date) {
            earnings.push({ symbol: sym, date, purpose: item.purpose });
          }
        }
      }
      if (earnings.length > 0) {
        earningsCache = { ...earningsCache, data: earnings, ts: Date.now() };
        console.log(`[Earnings] NSE: ${earnings.length} upcoming`);
        return earnings;
      }
    }
  } catch (e) {
    console.log(`[Earnings] NSE fetch failed: ${e.message}`);
  }

  // Fallback: Yahoo Finance earnings calendar
  try {
    const res = await axios.get(
      "https://query1.finance.yahoo.com/v7/finance/calendar/earnings",
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        },
        timeout: 10000
      }
    );
    
    if (res.data?.earnings?.earningsCalendar) {
      const earnings = [];
      const today = new Date();
      const cutoff = new Date(today);
      cutoff.setDate(cutoff.getDate() + 7);

      for (const item of res.data.earnings.earningsCalendar) {
        if (item.ticker && item.startdatetime) {
          const sym = item.ticker.replace(".NS", "").toUpperCase();
          const date = new Date(item.startdatetime);
          if (date >= today && date <= cutoff) {
            earnings.push({
              symbol: sym,
              date: item.startdatetime.split("T")[0],
              purpose: "Earnings Release"
            });
          }
        }
      }

      if (earnings.length > 0) {
        earningsCache = { ...earningsCache, data: earnings, ts: Date.now() };
        console.log(`[Earnings] Yahoo Finance: ${earnings.length} upcoming`);
        return earnings;
      }
    }
  } catch (e) {
    console.log(`[Earnings] Yahoo Finance failed: ${e.message}`);
  }

  console.log(`[Earnings] Using cached/empty: ${earningsCache.data.length}`);
  return earningsCache.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// FII/DII Flow Data
// ─────────────────────────────────────────────────────────────────────────────

// fii/dii start null — a fabricated {fii:0, dii:0} at cold start would read
// as "confirmed no flow today" before any fetch has even been attempted.
let fiiDiiCache = { data: { fii: null, dii: null }, ts: 0, ttl: 60 * 60 * 1000 };

export function getFiiDiiStatus() {
  const ageMs = fiiDiiCache.ts ? Date.now() - fiiDiiCache.ts : null;
  return { available: fiiDiiCache.ts > 0, stale: fiiDiiCache.ts === 0 || ageMs > fiiDiiCache.ttl * 3, ageMs };
}

export async function getFIIDIIFlow() {
  if (fiiDiiCache.ts && Date.now() - fiiDiiCache.ts < fiiDiiCache.ttl) {
    return fiiDiiCache.data;
  }

  try {
    const data = await nseFetch("/api/fii-dii-trading-activity");
    if (data && data.data) {
      let fiiNet = 0, diiNet = 0;
      // Find today's data (last entry usually)
      const todayData = data.data[data.data.length - 1];
      if (todayData) {
        fiiNet = parseFloat(todayData.fiiBuyValue || 0) - parseFloat(todayData.fiiSellValue || 0);
        diiNet = parseFloat(todayData.diiBuyValue || 0) - parseFloat(todayData.diiSellValue || 0);
      }

      const result = { fii: fiiNet, dii: diiNet, date: todayData?.date || new Date().toISOString() };
      fiiDiiCache = { ...fiiDiiCache, data: result, ts: Date.now() };
      console.log(`[FII/DII] FII: ₹${fiiNet.toFixed(0)}Cr, DII: ₹${diiNet.toFixed(0)}Cr`);
      return result;
    }
  } catch (e) {
    console.log(`[FII/DII] Fetch failed: ${e.message}`);
  }

  // Fallback: return last known or zero
  return fiiDiiCache.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gift Nifty
// ─────────────────────────────────────────────────────────────────────────────

// null, not 0 — a fabricated 0-point Gift Nifty at cold start (or after a
// total fetch failure) would look like a real "flat" reading.
let giftNiftyCache = { data: null, ts: 0, ttl: 60 * 1000 };

export function getGiftNiftyStatus() {
  const ageMs = giftNiftyCache.ts ? Date.now() - giftNiftyCache.ts : null;
  return { available: giftNiftyCache.ts > 0, stale: giftNiftyCache.ts === 0 || ageMs > giftNiftyCache.ttl * 3, ageMs };
}

export async function getGiftNifty() {
  if (Date.now() - giftNiftyCache.ts < giftNiftyCache.ttl) {
    return giftNiftyCache.data;
  }

  try {
    // Try multiple sources for Gift Nifty
    const sources = [
      async () => {
        const data = await nseFetch("/api/all-reports?slug=global-market&section=market");
        if (data?.giftNifty) return parseFloat(data.giftNifty.value || data.giftNifty.points);
        return null;
      },
      async () => {
        // Alternative: scrape from financial sites
        const res = await axios.get("https://www.giftifl.com/gift-nifty", {
          timeout: 5000,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
          }
        });
        // Extract from page content (simplified)
        const match = res.data.match(/Gift Nifty.*?(\d+)/);
        return match ? parseFloat(match[1]) : null;
      }
    ];

    for (const fn of sources) {
      try {
        const value = await fn();
        if (value && !isNaN(value)) {
          giftNiftyCache = { ...giftNiftyCache, data: value, ts: Date.now() };
          return value;
        }
      } catch {}
    }
  } catch (e) {
    console.log(`[Gift Nifty] Fetch failed: ${e.message}`);
  }

  return giftNiftyCache.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Master Data Fetcher — All data in parallel
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchAllMarketData() {
  console.log("[Data Fetcher] Fetching all market data...");

  const [vixData, foBanList, deliveryMap, earnings, fiiDii, giftNifty] = await Promise.allSettled([
    fetchVIXFromAlternatives(),
    getFOBanList(),
    getDeliveryData(),
    getEarningsCalendar(),
    getFIIDIIFlow(),
    getGiftNifty()
  ]);

  return {
    // On rejection, value:null/unavailable — never a fabricated 14.5 that
    // would be indistinguishable from a real calm-VIX reading downstream.
    vix: vixData.status === "fulfilled" ? vixData.value : { value: null, source: "unavailable" },
    foBanList: foBanList.status === "fulfilled" ? foBanList.value : new Set(),
    deliveryMap: deliveryMap.status === "fulfilled" ? deliveryMap.value : new Map(),
    earnings: earnings.status === "fulfilled" ? earnings.value : [],
    // On rejection, fii/dii are null (unknown), not a fabricated 0 (which
    // reads as "confirmed no flow today").
    fiiDii: fiiDii.status === "fulfilled" ? fiiDii.value : { fii: null, dii: null, unavailable: true },
    giftNifty: giftNifty.status === "fulfilled" ? giftNifty.value : null,
    // Per-source availability/staleness verdict for THIS cycle — an empty
    // Set/Map/Array above is otherwise indistinguishable from "confirmed
    // nothing," which matters most for foBanList: intraday_scanner.mjs and
    // overnight_scanner.mjs hard-block a symbol on isFOBanned, so a silently
    // empty ban list from a failed fetch would let an actually-banned stock
    // through with no visible warning. Surfaced end-to-end via
    // buildMarketSummary()'s data_quality_warnings in operator_scanner.mjs.
    dataQuality: getMarketDataStatus(),
  };
}

export function getMarketDataStatus() {
  return {
    foBanList: getFOBanListStatus(),
    deliveryMap: getDeliveryDataStatus(),
    earnings: getEarningsCalendarStatus(),
    fiiDii: getFiiDiiStatus(),
    giftNifty: getGiftNiftyStatus(),
  };
}

// Pre-warm NSE session on import
refreshNseSession().catch(() => {});

// Exports
