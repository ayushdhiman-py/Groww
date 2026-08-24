// ─────────────────────────────────────────────────────────────────────────────
// stage1_filter.mjs — cheap, full-universe pre-filter that runs every cycle
// with near-zero REST cost (cache reads + free WebSocket LTP only), used to
// narrow the 241-symbol curated universe down to a Stage-2 deep-analysis
// shortlist. This is what makes a real ~5-minute cycle possible: Stage-2
// (buildSignal across all 7 timeframes) only runs on the symbols this module
// selects, not the whole universe every time.
//
// IMPORTANT: computeFullUniverseSnapshot() must stay full-universe every
// cycle — Market Regime's breadth calculation depends on it covering all 241
// symbols, not just symbols that already look strong. If this were computed
// only from Stage-2 survivors, breadth would be permanently biased bullish
// (a "regime computed only from stocks that already look strong" selection-
// bias trap).
// ─────────────────────────────────────────────────────────────────────────────
import { peekCandles } from "./candle_cache.mjs";
import { isolateTodaySession } from "./session_candles.mjs";
import { vwap } from "./indicators.mjs";
import { getLtpWithFreshness } from "./feed.mjs";
import { UNIVERSE, getSector } from "./universe.mjs";

// symbol -> last time it got a real Stage-2 deep refresh. Lives here (not
// scanner.mjs) so stage1_filter.mjs and scanner.mjs can both read/write it
// without a circular import.
const lastDeepScanAt = new Map();

export function markDeepScanned(symbol) {
    lastDeepScanAt.set(symbol, Date.now());
}

export function getLastDeepScanAt(symbol) {
    return lastDeepScanAt.get(symbol) ?? 0;
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

/**
 * Full-universe cheap read, every cycle. Reads ONLY the live WebSocket LTP
 * (free) and whatever candles are already cached (peekCandles — never
 * triggers a fetch) — zero new REST requests. A symbol whose cache hasn't
 * warmed up yet (e.g. right after boot) simply gets a lower-confidence
 * cheapScore of 0, not an error — it'll get picked up by the fairness
 * rotation in selectStage2Symbols() and warm up naturally.
 */
export function computeFullUniverseSnapshot(universe = UNIVERSE) {
    const snapshot = new Map();
    for (const symbol of universe) {
        const priceFresh = getLtpWithFreshness(symbol);
        const livePrice = priceFresh.value;

        const d1 = peekCandles(symbol, "1d");
        const c5 = peekCandles(symbol, "5m");
        const prevClose = d1?.candles?.length ? d1.candles[d1.candles.length - 1].close : null;

        let dayOpen = null, pctFromOpenCheap = null, aboveVwapCheap = null, relVolumeCheap = null;
        if (c5?.candles?.length) {
            const { todayCandles } = isolateTodaySession(c5.candles, "5m");
            if (todayCandles.length) {
                dayOpen = todayCandles[0].open;
                if (dayOpen && livePrice != null) pctFromOpenCheap = ((livePrice - dayOpen) / dayOpen) * 100;
                const v = vwap(todayCandles);
                if (v != null && livePrice != null) aboveVwapCheap = livePrice > v;
            }
            const vols = c5.candles.slice(-10).map(c => c.volume).filter(Number.isFinite);
            const avgVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : null;
            const lastVol = vols[vols.length - 1];
            if (avgVol) relVolumeCheap = lastVol / avgVol;
        }

        const chgPctCheap = prevClose && livePrice != null ? ((livePrice - prevClose) / prevClose) * 100 : null;

        // Simple, transparent composite — this is a CHEAP pre-filter, not the
        // real Opportunity Score (that's entry_score.mjs, run only on the
        // Stage-2 shortlist against fresh data). Rewards a moderate move off
        // the open, elevated relative volume, and positive change vs prior
        // close — the same directional signals the real score uses, just
        // computed from whatever's already cached instead of a fresh fetch.
        const cheapScore =
            (pctFromOpenCheap != null ? clamp(pctFromOpenCheap, -5, 5) * 4 : 0) +
            (relVolumeCheap != null ? clamp(relVolumeCheap - 1, 0, 3) * 8 : 0) +
            (chgPctCheap != null ? clamp(chgPctCheap, -5, 5) * 3 : 0);

        snapshot.set(symbol, {
            symbol,
            sector: getSector(symbol),
            cheapScore,
            chgPctCheap,
            aboveVwapCheap,
            pctFromOpenCheap,
            relVolumeCheap,
            priceFreshness: priceFresh.source,
            candleAgeMs: c5 ? Date.now() - c5.fetchedAt : null,
            lastDeepScanAt: getLastDeepScanAt(symbol),
        });
    }
    return snapshot; // Map<symbol, cheapRow> — ALL universe.length symbols, always
}

/**
 * Selection policy for the Stage-2 deep-analysis pass.
 * Always includes: INDEX-sector symbols (NIFTY/BANKNIFTY/etc — needed for
 * market context/RS calculations everywhere) and any symbol with an active
 * Critical trade (their full 7-timeframe row data still needs to stay
 * populated for entry_score/screener even though their minute-to-minute
 * health now comes from the dedicated Critical monitor, not this pass).
 * Then: top-N by cheap score, plus a fairness-rotation slice (oldest/never
 * deep-scanned first) so a symbol that never top-ranks still gets refreshed
 * periodically — without this, a currently-out-of-favor stock could never
 * be rediscovered once its cache goes stale, and its 52W/ATR would go
 * permanently null past the existing 26h staleness cap.
 */
export function selectStage2Symbols(snapshot, { activeCriticalSymbols = [], topN = 55, rotationSize = 20, cap = 100 } = {}) {
    const always = new Set([...snapshot.values()].filter(r => r.sector === "INDEX").map(r => r.symbol));
    for (const s of activeCriticalSymbols) always.add(s);

    const rest = [...snapshot.values()].filter(r => !always.has(r.symbol));
    const top = rest.slice().sort((a, b) => b.cheapScore - a.cheapScore).slice(0, topN).map(r => r.symbol);

    const chosenSoFar = new Set([...always, ...top]);
    const rotation = rest
        .filter(r => !chosenSoFar.has(r.symbol))
        .sort((a, b) => a.lastDeepScanAt - b.lastDeepScanAt) // oldest / never-scanned first
        .slice(0, rotationSize)
        .map(r => r.symbol);

    return [...new Set([...always, ...top, ...rotation])].slice(0, cap);
}
