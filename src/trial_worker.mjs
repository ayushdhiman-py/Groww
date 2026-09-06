import { state, markIntradayActive } from "./scanner.mjs";
import { getRecentCandles, appendTickTo1m } from "./candle_cache.mjs";
import { getLtpWithFreshness, livePrices } from "./feed.mjs";
import { UNIVERSE } from "./universe.mjs";
import { estimate5mByFeatures } from "./short_term_estimator.mjs";
import { rsi, macd, supertrend } from "./indicators.mjs";

let trialWorkerRunning = false;

// Picks N symbols from UNIVERSE (NIFTY 500) — reuse existing UNIVERSE constant
function pickUniverseSymbols(limit = 200) {
    // Prefer an explicit NIFTY 500 slice if present; otherwise, fallback to UNIVERSE itself
    return UNIVERSE.slice(0, limit);
}

// Compute simple deltas (percent) over available derived candles
function computeDelta(candles) {
    if (!candles || candles.length < 2) return null;
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    if (!prev || !prev.close) return null;
    return ((last.close - prev.close) / prev.close) * 100;
}

export function startTrialMinuteWorker({ intervalMs = 60_000, limit = 200 } = {}) {
    if (trialWorkerRunning) return;
    trialWorkerRunning = true;

    // Background loop — one tick per minute
    (async function loop() {
        while (trialWorkerRunning) {
            try {
                const symbols = pickUniverseSymbols(limit);
                const items = [];
                for (const sym of symbols) {
                    // Use WS live price if available
                    const ltp = getLtpWithFreshness(sym);
                    const price = ltp?.value ?? (livePrices.get(sym) ?? null);
                    if (price == null) continue;

                    // Append tick to 1m (no volume supplied by WS in general)
                    appendTickTo1m(sym, price, null, Date.now());

                    // Read recent candles
                    const c1 = getRecentCandles(sym, '1m', 2);
                    const c5 = getRecentCandles(sym, '5m', 2);
                    const c15 = getRecentCandles(sym, '15m', 2);

                    const chg1m = computeDelta(c1);
                    const chg5m = computeDelta(c5);
                    const chg15m = computeDelta(c15);

                    // indicators from 1m history (use up to last 60)
                    const last1m = getRecentCandles(sym, '1m', 60);
                    const closes = last1m.map(c => c.close).filter(v => v != null);
                    const rsiVal = closes.length ? rsi(closes) : null;
                    const macdRes = closes.length ? macd(closes) : { macd: [], signal: [] };
                    const macdVal = macdRes.macd.length ? macdRes.macd[macdRes.macd.length - 1] : null;
                    const st = last1m.length ? supertrend(last1m) : null;

                    const indicators = { rsi: rsiVal, macdVal, supertrend: st?.trend ?? null, relativeVolume: null };

                    // Estimator: conservative — may return { insufficient: true }
                    const estimator = await estimate5mByFeatures({ symbol: sym, rsi: rsiVal, macdHist: macdRes.macd, relativeVolume: null, price: price, ts: Date.now() });

                    // Build simple signal based on Supertrend + estimator confidence
                    let signal = 'NONE';
                    if (!estimator.insufficient && estimator.confidence >= 0.4) {
                        if (st?.trend === 'UP' && chg1m > 0) signal = 'BUY';
                        else if (st?.trend === 'DOWN' && chg1m < 0) signal = 'SELL';
                    }

                    items.push({ symbol: sym, price: +price.toFixed(2), chg1m: chg1m != null ? +chg1m.toFixed(2) : null, chg5m: chg5m != null ? +chg5m.toFixed(2) : null, chg15m: chg15m != null ? +chg15m.toFixed(2) : null, indicators, estimator, signal, sourceTs: Date.now() });
                }

                // Rank by estimator.pReach15 * confidence * chg1m factor
                const ranked = items.sort((a, b) => {
                    const as = (a.estimator?.pReach15 || 0) * (a.estimator?.confidence || 0) * (Math.max(0.5, (a.chg1m || 0) / 1 + 0.0001));
                    const bs = (b.estimator?.pReach15 || 0) * (b.estimator?.confidence || 0) * (Math.max(0.5, (b.chg1m || 0) / 1 + 0.0001));
                    return bs - as;
                });

                state.trialFeed = { generatedAt: new Date().toISOString(), items: ranked.slice(0, 60) };
            } catch (e) {
                console.error('[Trial worker] tick error:', e?.message || e);
            }

            // Sleep until next minute boundary
            const now = Date.now();
            const msToNext = intervalMs - (now % intervalMs) + 50; // +50ms buffer
            await new Promise(r => setTimeout(r, msToNext));
        }
    })();
}

export function stopTrialMinuteWorker() { trialWorkerRunning = false; }
