// ─────────────────────────────────────────────────────────────────────────────
// options_feed.mjs — Background Poller for Option Chain & Greeks
// Includes OI delta tracking (change in OI between polls)
// ─────────────────────────────────────────────────────────────────────────────
import { fetchOptionChain } from "./upstox.mjs";
import { UNIVERSE } from "./universe.mjs";
import { UNAVAILABLE } from "./data_quality.mjs";

// symbol -> { topCalls, topPuts, spot, oiDelta, iv, pcr, updatedAt }
export const optionsCache = new Map();

// The round-robin poller (below) visits one symbol every ~2s, so a full
// sweep of the universe takes UNIVERSE.length * 2s — a single symbol's
// entry can legitimately be that old between its own polls. Anything older
// than 3 full sweeps means polling itself has stalled for that symbol
// (delisted/expired/consistently erroring), not just "hasn't come up yet."
const OPTIONS_STALE_AFTER_MS = () => UNIVERSE.length * 2000 * 3;

/**
 * Read the options cache for a symbol WITH an explicit staleness verdict —
 * never returns a silently-ancient snapshot as if it were current.
 */
export function getOptionsCacheWithFreshness(symbol) {
    const cached = optionsCache.get(symbol);
    if (!cached) return { ...UNAVAILABLE("never polled"), data: null };
    const ts = Date.parse(cached.updatedAt);
    const ageMs = Date.now() - ts;
    const stale = !Number.isFinite(ageMs) || ageMs > OPTIONS_STALE_AFTER_MS();
    return { data: cached, ts, ageMs, stale, source: stale ? "cache-stale" : "cache" };
}

// OI tracking: symbol -> { totalCallOI, totalPutOI, timestamp }
const oiHistory = new Map();

let _timer = null;
let _running = false;
let currentIndex = 0;

/**
 * Calculate OI change between current and previous poll
 */
function calculateOIDelta(symbol, currentCallOI, currentPutOI) {
  const prev = oiHistory.get(symbol);
  if (!prev) {
    // First poll — store baseline. callOIDelta/putOIDelta are null (not 0)
    // here: there is no real "no change" reading yet, only a starting
    // point, and 0 would be indistinguishable from a genuine unchanged OI.
    oiHistory.set(symbol, {
      totalCallOI: currentCallOI,
      totalPutOI: currentPutOI,
      timestamp: Date.now()
    });
    return { callOIDelta: null, putOIDelta: null, pcr: null, baseline: true };
  }

  const callDelta = currentCallOI - prev.totalCallOI;
  const putDelta = currentPutOI - prev.totalPutOI;
  const pcr = currentPutOI > 0 ? currentCallOI / currentPutOI : null;

  // Update history
  oiHistory.set(symbol, {
    totalCallOI: currentCallOI,
    totalPutOI: currentPutOI,
    timestamp: Date.now()
  });

  return { callOIDelta, putOIDelta, pcr };
}

export async function processOptionChain(symbol) {
    const data = await fetchOptionChain(symbol);
    // If no data or strikes (e.g. non-F&O stock), just skip
    if (!data || !data.strikes) return false;

    const calls = [];
    const puts = [];
    let totalCallOI = 0;
    let totalPutOI = 0;
    let ivSum = 0, ivCount = 0;

    for (const [strikeStr, optionsData] of Object.entries(data.strikes)) {
        const strike = parseFloat(strikeStr);
        if (optionsData.CE) {
            calls.push({ strike, type: 'CE', ...optionsData.CE });
            totalCallOI += (optionsData.CE.open_interest || optionsData.CE.oi || 0);
            if (optionsData.CE.impliedVolatility) {
                ivSum += optionsData.CE.impliedVolatility;
                ivCount++;
            }
        }
        if (optionsData.PE) {
            puts.push({ strike, type: 'PE', ...optionsData.PE });
            totalPutOI += (optionsData.PE.open_interest || optionsData.PE.oi || 0);
            if (optionsData.PE.impliedVolatility) {
                ivSum += optionsData.PE.impliedVolatility;
                ivCount++;
            }
        }
    }

    // Groww API returns empty strikes — skip caching if no data
    if (calls.length === 0 && puts.length === 0) return false;

    // Sort heavily by Open Interest, then by Volume, highest first
    const sortFn = (a, b) => {
        const aScore = (a.open_interest || 0) * 2 + (a.volume || 0);
        const bScore = (b.open_interest || 0) * 2 + (b.volume || 0);
        return bScore - aScore;
    };

    calls.sort(sortFn);
    puts.sort(sortFn);

    // Grab Top 5
    const topCalls = calls.slice(0, 5);
    const topPuts = puts.slice(0, 5);

    // Calculate OI delta and PCR
    const { callOIDelta, putOIDelta, pcr, baseline } = calculateOIDelta(symbol, totalCallOI, totalPutOI);
    const avgIV = ivCount > 0 ? ivSum / ivCount : null;
    const oiChangePercent = (!baseline && callOIDelta != null && totalCallOI > 0)
        ? (callOIDelta / (totalCallOI - callOIDelta)) * 100
        : null;

    optionsCache.set(symbol, {
        spot: data.underlying_ltp,
        topCalls,
        topPuts,
        updatedAt: new Date().toISOString(),
        // OI tracking
        totalCallOI,
        totalPutOI,
        oiChange: oiChangePercent,
        callOIDelta,
        putOIDelta,
        oiBaseline: !!baseline,
        pcr,
        iv: avgIV
    });

    return true;
}

/**
 * Get OI history for a symbol (useful for footprint detection)
 */
export function getOIHistory(symbol) {
    return oiHistory.get(symbol) || null;
}

/**
 * Clear OI history (useful for session reset)
 */
export function clearOIHistory() {
    oiHistory.clear();
}

async function pollNext() {
    if (!_running) return;

    const symbol = UNIVERSE[currentIndex];
    // Advance index cyclically
    currentIndex = (currentIndex + 1) % UNIVERSE.length;

    let successful = false;
    try {
        successful = await processOptionChain(symbol);
    } catch (e) {
        // Was completely silent — a genuinely broken symbol and a transient
        // API blip looked identical with no trace at all.
        console.error(`[OptionsFeed] ${symbol} poll failed: ${e.message}`);
    }

    // Polling 1 option chain every 2000ms = 30 req/min.
    _timer = setTimeout(pollNext, 2000);

}

export function startOptionsFeed() {
    if (_running) return;
    _running = true;
    console.log("[OptionsFeed] Starting background option caching (1 seq/sec)...");
    pollNext();
}

export function stopOptionsFeed() {
    _running = false;
    if (_timer) {
        clearTimeout(_timer);
        _timer = null;
    }
}
