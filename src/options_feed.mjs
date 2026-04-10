// ─────────────────────────────────────────────────────────────────────────────
// options_feed.mjs — Background Poller for Option Chain & Greeks
// ─────────────────────────────────────────────────────────────────────────────
import { fetchOptionChain } from "./groww.mjs";
import { UNIVERSE } from "./universe.mjs";

// symbol -> { topCalls: [ ... ], topPuts: [ ... ], updatedAt }
export const optionsCache = new Map();

let _timer = null;
let _running = false;
let currentIndex = 0;

export async function processOptionChain(symbol) {
    const data = await fetchOptionChain(symbol);
    // If no data or strikes (e.g. non-F&O stock), just skip
    if (!data || !data.strikes) return false;

    const calls = [];
    const puts = [];

    for (const [strikeStr, optionsData] of Object.entries(data.strikes)) {
        const strike = parseFloat(strikeStr);
        if (optionsData.CE) {
            calls.push({ strike, type: 'CE', ...optionsData.CE });
        }
        if (optionsData.PE) {
            puts.push({ strike, type: 'PE', ...optionsData.PE });
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

    optionsCache.set(symbol, {
        spot: data.underlying_ltp,
        topCalls,
        topPuts,
        updatedAt: new Date().toISOString()
    });

    return true;
}

async function pollNext() {
    if (!_running) return;

    const symbol = UNIVERSE[currentIndex];
    // Advance index cyclically
    currentIndex = (currentIndex + 1) % UNIVERSE.length;

    let successful = false;
    try {
        successful = await processOptionChain(symbol);
    } catch (e) { }

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
