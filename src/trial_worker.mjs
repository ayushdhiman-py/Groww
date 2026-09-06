import { state, markIntradayActive } from "./scanner.mjs";
import { getOrFetchCandles } from "./candle_cache.mjs";
import { getLtpWithFreshness } from "./feed.mjs";
import { UNIVERSE } from "./universe.mjs";
import { estimate5mByFeatures } from "./short_term_estimator.mjs";
import { rsi, macd, supertrend } from "./indicators.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
let trialWorkerRunning = false;

export function startTrialMinuteWorker({ intervalMs = 60_000 } = {}) {
    if (trialWorkerRunning) return;
    trialWorkerRunning = true;

    (async function loop() {
        while (trialWorkerRunning) {
            const cycleStart = Date.now();
            try {
                const items = [];

                // Iterate the full UNIVERSE (no hard limit)
                for (const sym of UNIVERSE) {
                    try {
                        // Get a live price if available (used only as a label / quick reference)
                        const priceMeta = getLtpWithFreshness(sym);
                        const price = priceMeta?.value ?? null;

                        // Fetch canonical, completed candles from the TTL cache / REST path.
                        // We rely on getOrFetchCandles to return completed bars only; if
                        // history is insufficient we mark this symbol as `insufficient`.
                        const c1 = await getOrFetchCandles(sym, '1m').catch(() => null);
                        const c5 = await getOrFetchCandles(sym, '5m').catch(() => null);
                        const c15 = await getOrFetchCandles(sym, '15m').catch(() => null);

                        // Defensive: require at least 2 completed bars in each timeframe
                        if (!Array.isArray(c1) || c1.length < 2 || !Array.isArray(c5) || c5.length < 2 || !Array.isArray(c15) || c15.length < 2) {
                            items.push({ symbol: sym, estimator: { insufficient: true } });
                            continue;
                        }

                        // Take recent windows (bounded)
                        const recent1m = c1.slice(-60);
                        const recent5m = c5.slice(-12);
                        const recent15m = c15.slice(-8);

                        // Compute simple deltas (percent) over last completed bar(s)
                        const last1 = recent1m[recent1m.length - 1];
                        const prev1 = recent1m[recent1m.length - 2];
                        const chg1m = prev1 && prev1.close ? +(((last1.close - prev1.close) / prev1.close) * 100).toFixed(2) : null;
                        const last5 = recent5m[recent5m.length - 1];
                        const prev5 = recent5m[recent5m.length - 2];
                        const chg5m = prev5 && prev5.close ? +(((last5.close - prev5.close) / prev5.close) * 100).toFixed(2) : null;
                        const last15 = recent15m[recent15m.length - 1];
                        const prev15 = recent15m[recent15m.length - 2];
                        const chg15m = prev15 && prev15.close ? +(((last15.close - prev15.close) / prev15.close) * 100).toFixed(2) : null;

                        // Indicators (use completed candles only)
                        const closes1 = recent1m.map(c => c.close).filter(Number.isFinite);
                        const closes5 = recent5m.map(c => c.close).filter(Number.isFinite);
                        const closes15 = recent15m.map(c => c.close).filter(Number.isFinite);

                        // Require a minimal number of samples for stable indicators
                        if (closes1.length < 8 || closes5.length < 4 || closes15.length < 3) {
                            items.push({ symbol: sym, estimator: { insufficient: true } });
                            continue;
                        }

                        const rsi1 = rsi(closes1);
                        const mac1 = macd(closes1, 12, 26, 9);
                        const mac5 = macd(closes5, 12, 26, 9);

                        const macdHist1 = (mac1.macd.length && mac1.signal.length) ? (mac1.macd[mac1.macd.length - 1] - mac1.signal[mac1.signal.length - 1]) : null;
                        const macdHist5 = (mac5.macd.length && mac5.signal.length) ? (mac5.macd[mac5.macd.length - 1] - mac5.signal[mac5.signal.length - 1]) : null;

                        const st1 = supertrend(recent1m, 10, 3);
                        const dir1 = st1.direction[st1.direction.length - 1] ?? null;

                        // Relative volume (RVOL): last 1m vol vs avg of prior
                        const vols1 = recent1m.map(c => c.volume).filter(v => v != null && Number.isFinite(v));
                        const lastVol = vols1.length ? vols1[vols1.length - 1] : null;
                        const avgVol = vols1.length > 1 ? (vols1.slice(0, -1).reduce((a, b) => a + b, 0) / Math.max(1, vols1.length - 1)) : null;
                        const rvol = lastVol != null && avgVol != null ? +(lastVol / avgVol).toFixed(2) : null;

                        // Estimator features and call
                        const features = { symbol: sym, rsi: rsi1, macdHist: macdHist1, relativeVolume: rvol, price: price, ts: Date.now() };
                        let est = null;
                        try { est = await estimate5mByFeatures(features); } catch (e) { est = { insufficient: true }; }

                        // Build item
                        const item = {
                            symbol: sym,
                            price: price != null ? +price.toFixed(2) : null,
                            chg1m, chg5m, chg15m,
                            indicators: {
                                rsi: rsi1 != null ? Math.round(rsi1) : null,
                                macd1: macdHist1 != null ? +macdHist1.toFixed(4) : null,
                                macd5: macdHist5 != null ? +macdHist5.toFixed(4) : null,
                                supertrend1: dir1,
                                rvol,
                                lastVol,
                            },
                            estimator: est,
                            sourceTs: priceMeta?.ts ?? null,
                        };

                        items.push(item);
                    } catch (symErr) {
                        // Per-symbol error must not break the whole loop
                        console.error('[Trial] symbol processing error for', sym, symErr?.message || symErr);
                        continue;
                    }
                }

                // Ranking: primary pReach15 desc, then pContinue, expectedReturnPct, confidence
                const ranked = items.filter(i => i.estimator && !i.estimator.insufficient).sort((a, b) => {
                    const ea = a.estimator, eb = b.estimator;
                    if (eb.pReach15 !== ea.pReach15) return eb.pReach15 - ea.pReach15;
                    if (eb.pContinue !== ea.pContinue) return eb.pContinue - ea.pContinue;
                    const ra = (ea.expectedReturnPct || 0), rb = (eb.expectedReturnPct || 0);
                    if (rb !== ra) return rb - ra;
                    return (eb.confidence || 0) - (ea.confidence || 0);
                }).slice(0, 200);

                state.trialFeed = { generatedAt: new Date().toISOString(), items: ranked };

            } catch (e) {
                console.error('[Trial] Minute worker error:', e?.message || e);
            } finally {
                const elapsed = Date.now() - cycleStart;
                const wait = Math.max(0, intervalMs - elapsed);
                await sleep(wait);
            }
        }
    })();
}

export function stopTrialMinuteWorker() { trialWorkerRunning = false; }
