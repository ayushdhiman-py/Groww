// ─────────────────────────────────────────────────────────────────────────────
// nse_data.mjs — NSE India Data Fetcher (Wrapper for data_fetcher.mjs)
// F&O Ban List, Delivery %, Earnings Calendar, VIX
// ─────────────────────────────────────────────────────────────────────────────

// Re-export from the new robust data_fetcher module
export {
  getFOBanList
} from "./data_fetcher.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Cache layer
// ─────────────────────────────────────────────────────────────────────────────

const cache = {
  foBanList:    { data: null, ts: 0, ttl: 5 * 60 * 1000 },    // 5 min
  delivery:     { data: new Map(), ts: 0, ttl: 30 * 60 * 1000 }, // 30 min
  earnings:     { data: null, ts: 0, ttl: 60 * 60 * 1000 },    // 1 hour
  vix:          { data: null, ts: 0, ttl: 60 * 1000 },         // 1 min
};

function isCached(key) {
  const c = cache[key];
  return c.data && (c.data instanceof Map ? c.data.size > 0 : true) && Date.now() - c.ts < c.ttl;
}

// ─────────────────────────────────────────────────────────────────────────────
// F&O BAN LIST
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get list of stocks currently in F&O ban (ASM/GSM/derivative ban)
 * Returns Set of symbol strings
 */
export async function getFOBANList() {
  if (isCached("foBanList")) return cache.foBanList.data;

  try {
    // NSE publishes F&O ban list on their market data page
    const data = await nseFetch("/api/underlyingOpenInterest");
    if (data && data.data) {
      // The underlying OI data includes ban status
      const bannedStocks = new Set();
      for (const item of data.data) {
        if (item.isBan === true || (item.meta && item.meta.isBan)) {
          bannedStocks.add((item.symbol || "").toUpperCase());
        }
      }
      cache.foBanList = { data: bannedStocks, ts: Date.now() };
      console.log(`[NSE Data] F&O ban list: ${bannedStocks.size} banned stocks`);
      return bannedStocks;
    }
  } catch (e) {
    console.log(`[NSE Data] F&O ban list fetch failed: ${e.message}`);
  }

  // Fallback: try alternative endpoint
  try {
    const data = await nseFetch("/api/all-reports?slug=derivatives-watch&section=market");
    if (data?.banStocks) {
      const bannedStocks = new Set(data.banStocks.map(s => (s.symbol || "").toUpperCase()));
      cache.foBanList = { data: bannedStocks, ts: Date.now() };
      return bannedStocks;
    }
  } catch (e) {
    console.log(`[NSE Data] Alternative ban endpoint failed: ${e.message}`);
  }

  // Return empty set (no bans) if fetch fails
  return new Set();
}

/**
 * Check if a symbol is in F&O ban
 */
export async function isFOBanned(symbol) {
  const banList = await getFOBANList();
  return banList.has(symbol.toUpperCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// DELIVERY PERCENTAGE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get delivery percentage for all stocks from NSE's bulk data
 * NSE publishes daily delivery data via their archives
 * Returns Map<symbol, deliveryPercent>
 */
export async function getDeliveryData() {
  if (isCached("delivery")) return cache.delivery.data;

  try {
    // NSE's daily delivery data endpoint
    // This requires the date parameter
    const today = new Date();
    const dateStr = `${today.getDate().toString().padStart(2, "0")}-${(today.getMonth() + 1).toString().padStart(2, "0")}-${today.getFullYear()}`;

    const data = await nseFetch(`/api/merged-daily-delivery-report?date=${dateStr}`);
    if (data && data.data) {
      const deliveryMap = new Map();
      for (const row of data.data) {
        const sym = (row.symbol || "").toUpperCase();
        const delPct = parseFloat(row.deliveryToTradedQuantity || row.deliveryPercent || 0);
        if (sym && !isNaN(delPct)) {
          deliveryMap.set(sym, delPct);
        }
      }
      cache.delivery = { data: deliveryMap, ts: Date.now() };
      console.log(`[NSE Data] Delivery data: ${deliveryMap.size} stocks`);
      return deliveryMap;
    }
  } catch (e) {
    console.log(`[NSE Data] Delivery data fetch failed: ${e.message}`);
  }

  // Fallback: try historical data for previous day
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = `${yesterday.getDate().toString().padStart(2, "0")}-${(yesterday.getMonth() + 1).toString().padStart(2, "0")}-${yesterday.getFullYear()}`;

    const data = await nseFetch(`/api/merged-daily-delivery-report?date=${dateStr}`);
    if (data && data.data) {
      const deliveryMap = new Map();
      for (const row of data.data) {
        const sym = (row.symbol || "").toUpperCase();
        const delPct = parseFloat(row.deliveryToTradedQuantity || row.deliveryPercent || 0);
        if (sym && !isNaN(delPct)) {
          deliveryMap.set(sym, delPct);
        }
      }
      cache.delivery = { data: deliveryMap, ts: Date.now() };
      return deliveryMap;
    }
  } catch (e) {
    console.log(`[NSE Data] Previous day delivery data failed: ${e.message}`);
  }

  return cache.delivery.data || new Map();
}

/**
 * Get delivery % for a specific symbol
 */
export async function getDeliveryForSymbol(symbol) {
  const deliveryMap = await getDeliveryData();
  return deliveryMap.get(symbol.toUpperCase()) || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// EARNINGS CALENDAR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get upcoming earnings from NSE corporate announcements
 * Returns Array of { symbol, date, purpose }
 */
export async function getEarningsCalendar() {
  if (isCached("earnings")) return cache.earnings.data;

  try {
    // NSE's earnings calendar endpoint
    const today = new Date();
    const fromDate = new Date(today);
    const toDate = new Date(today);
    toDate.setDate(toDate.getDate() + 7); // Next 7 days

    const fromStr = `${fromDate.getDate().toString().padStart(2, "0")}-${(fromDate.getMonth() + 1).toString().padStart(2, "0")}-${fromDate.getFullYear()}`;
    const toStr = `${toDate.getDate().toString().padStart(2, "0")}-${(toDate.getMonth() + 1).toString().padStart(2, "0")}-${toDate.getFullYear()}`;

    const data = await nseFetch(`/api/corporate-announcements?from_date=${fromStr}&to_date=${toStr}`);

    if (data && data.response) {
      const earnings = [];
      for (const item of data.response) {
        const purpose = (item.purpose || "").toLowerCase();
        // Filter for earnings-related announcements
        if (purpose.includes("result") || purpose.includes("earning") || purpose.includes("financial") || purpose.includes("unaudited")) {
          const sym = (item.symbol || "").toUpperCase();
          const date = item.date || item.ann_dt || "";
          if (sym && date) {
            earnings.push({ symbol: sym, date, purpose: item.purpose });
          }
        }
      }
      cache.earnings = { data: earnings, ts: Date.now() };
      console.log(`[NSE Data] Earnings calendar: ${earnings.length} upcoming`);
      return earnings;
    }
  } catch (e) {
    console.log(`[NSE Data] Earnings calendar fetch failed: ${e.message}`);
  }

  // Fallback: Try alternative endpoint
  try {
    const data = await nseFetch("/api/equity-stock-info?symbol=NIFTY");
    // This endpoint might have different structure
    if (data) {
      cache.earnings = { data: [], ts: Date.now() };
      return [];
    }
  } catch (e) {
    console.log(`[NSE Data] Earnings fallback failed: ${e.message}`);
  }

  return cache.earnings.data || [];
}

/**
 * Check if a symbol has earnings in the next N days
 */
export async function hasEarningsSoon(symbol, daysAhead = 2) {
  const earnings = await getEarningsCalendar();
  const today = new Date();
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() + daysAhead);

  for (const e of earnings) {
    if (e.symbol === symbol.toUpperCase()) {
      const earnDate = new Date(e.date);
      if (earnDate >= today && earnDate <= cutoff) {
        return { hasEarnings: true, date: e.date, purpose: e.purpose };
      }
    }
  }
  return { hasEarnings: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// INDIA VIX
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch India VIX with robust error handling
 */
export async function fetchIndiaVixDirect() {
  if (isCached("vix")) return cache.vix.data;

  try {
    // Primary endpoint
    const data = await nseFetch("/api/vix");
    if (data) {
      const vixValue = parseFloat(data.indiaVIX || data.VIX || data.value);
      if (!isNaN(vixValue) && vixValue > 0) {
        const result = { value: vixValue, source: "NSE direct", ts: Date.now() };
        cache.vix = { data: result, ts: Date.now() };
        return result;
      }
    }
  } catch (e) {
    console.log(`[NSE Data] VIX direct fetch failed: ${e.message}`);
  }

  // Secondary: Use external API as backup
  try {
    const response = await axios.get("https://india-vix.onrender.com", { timeout: 5000 });
    if (response.data && response.data.vix) {
      const vixValue = parseFloat(response.data.vix);
      if (!isNaN(vixValue) && vixValue > 0) {
        const result = { value: vixValue, source: "external API", ts: Date.now() };
        cache.vix = { data: result, ts: Date.now() };
        return result;
      }
    }
  } catch (e) {
    // External API may be unavailable - fallback will be used
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[NSE Data] External VIX API failed: ${e.message}`);
    }
  }

  // Last resort: return null to trigger VIX estimation
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// MASTER DATA FETCHER — Call this before operator scan
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch all NSE data needed for operator scanners in parallel
 * Returns { foBanList, deliveryMap, earnings, vix }
 */
export async function fetchAllNseData() {
  console.log("[NSE Data] Fetching all data...");
  const [foBanList, deliveryMap, earnings, vixData] = await Promise.allSettled([
    getFOBANList(),
    getDeliveryData(),
    getEarningsCalendar(),
    fetchIndiaVixDirect()
  ]);

  return {
    foBanList: foBanList.status === "fulfilled" ? foBanList.value : new Set(),
    deliveryMap: deliveryMap.status === "fulfilled" ? deliveryMap.value : new Map(),
    earnings: earnings.status === "fulfilled" ? earnings.value : [],
    vix: vixData.status === "fulfilled" ? vixData.value : null
  };
}

// Master data fetcher exports all needed functions via inline exports
