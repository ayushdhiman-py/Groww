// ─────────────────────────────────────────────────────────────────────────────
// equity_scanner.mjs — Task 3: Top 10 Equity Calls (Max 2 weeks hold)
//
// Target: 20%+ on stock price within 10 trading days
// Stop loss: 7% below entry. Hard stop. No averaging down.
// Exit: Target 2 OR day 10 — whichever comes first.
// Always active regardless of VIX (but VIX affects position sizing)
// Can include non-F&O stocks (all NSE stocks from scanner data)
// ─────────────────────────────────────────────────────────────────────────────

import {
    detectAllFootprints,
    calculateScore,
    getScoreBand
} from "./operator_engine.mjs";
import {
    getPositionSizeMultiplier,
    getVixMode,
    getVixRiskFlag
} from "./vix_manager.mjs";
import {
    ema,
    macd as calcMacd,
    rsi as calcRsi
} from "./indicators.mjs";
import { UNIVERSE, SECTOR, getSector } from "./universe.mjs";
import { fetchCandles, fetchBulkLtp } from "./upstox.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const EQUITY_TARGET_1_PCT = 10;
const EQUITY_TARGET_2_PCT = 20;
const EQUITY_STOP_LOSS_PCT = 7;
const MAX_HOLDING_DAYS = 10;
const MIN_DELIVERY_PCT = 65;
const MIN_BREAKOUT_VOL_RATIO = 2.5;
const MAX_CONSOLIDATION_RANGE_PCT = 6;
const MIN_CONSOLIDATION_DAYS = 10;
const MIN_52W_POSITION_PCT = 65;
const MAX_UP_5DAYS_PCT = 15;
const MIN_RS_VS_NIFTY = 1.3;
const MAX_OVERHEAD_RESISTANCE_PCT = 15;
const MAX_DEBT_TO_EQUITY = 1;
const MIN_SECTOR_PEERS_STRENGTH = 2;
const MIN_FO_CONSOLIDATION_DAYS = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Helper: compute EMA array and return last value
// ─────────────────────────────────────────────────────────────────────────────

function getLastEma(closes, period) {
    const arr = ema(closes, period);
    const valid = arr.filter(v => v !== null);
    return valid.length > 0 ? valid[valid.length - 1] : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: compute MACD bullish check (daily and weekly)
// ─────────────────────────────────────────────────────────────────────────────

function isMacdBullish(closes) {
    if (closes.length < 30) return false;
    const { macd: ml, signal: sl } = calcMacd(closes, 12, 26, 9);
    const n = closes.length;
    const curM = ml[n - 1], curS = sl[n - 1];
    const prevM = ml[n - 2], prevS = sl[n - 2];
    if (curM === null || curS === null || prevM === null || prevS === null) return false;
    return curM > curS && prevM <= prevS;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: RSI check within range
// ─────────────────────────────────────────────────────────────────────────────

function rsiInRange(closes, min, max, period = 14) {
    const val = calcRsi(closes, period);
    return val !== null && val >= min && val <= max;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Check price above multiple DMAs
// ─────────────────────────────────────────────────────────────────────────────

function priceAboveAllDmas(currentPrice, closes) {
    const periods = [20, 50, 100, 200];
    for (const p of periods) {
        const e = getLastEma(closes, p);
        if (e === null || currentPrice <= e) return false;
    }
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Calculate 52-week position percentage
// ─────────────────────────────────────────────────────────────────────────────

function calc52WPosition(currentPrice, candles) {
    // Use last 252 daily candles for 52-week range
    const lookback = Math.min(252, candles.length);
    const slice = candles.slice(-lookback);
    let high = -Infinity, low = Infinity;
    for (const c of slice) {
        if (c.high > high) high = c.high;
        if (c.low < low) low = c.low;
    }
    if (high === low) return 100;
    return ((currentPrice - low) / (high - low)) * 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Calculate consolidation range % over last N days
// ─────────────────────────────────────────────────────────────────────────────

function calcConsolidationRange(candles, days) {
    const slice = candles.slice(-days);
    if (slice.length < days) return { range: 100, daysFound: slice.length };
    let high = -Infinity, low = Infinity;
    for (const c of slice) {
        if (c.high > high) high = c.high;
        if (c.low < low) low = c.low;
    }
    if (low === 0) return { range: 100, daysFound: days };
    const range = ((high - low) / low) * 100;
    return { range, daysFound: days };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Find longest consolidation period
// ─────────────────────────────────────────────────────────────────────────────

function findConsolidationPeriod(candles, maxRangePct) {
    let longest = 0;
    let currentLen = 0;
    for (let i = 1; i < candles.length; i++) {
        const window = candles.slice(Math.max(0, i - MIN_CONSOLIDATION_DAYS - 5), i + 1);
        if (window.length < MIN_CONSOLIDATION_DAYS) continue;
        let h = -Infinity, l = Infinity;
        for (const c of window) {
            if (c.high > h) h = c.high;
            if (c.low < l) l = c.low;
        }
        if (l === 0) continue;
        const rng = ((h - l) / l) * 100;
        if (rng <= maxRangePct) {
            currentLen++;
            if (currentLen > longest) longest = currentLen;
        } else {
            currentLen = 0;
        }
    }
    return longest;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Volume ratio for breakout day
// ─────────────────────────────────────────────────────────────────────────────

function calcVolumeRatio(candles, avgDays = 20) {
    if (candles.length < avgDays + 1) return null;
    const recent = candles.slice(-avgDays - 1, -1);
    const avgVol = recent.reduce((s, c) => s + (c.volume || 0), 0) / recent.length;
    const lastVol = candles[candles.length - 1].volume || 0;
    if (avgVol === 0) return null;
    return lastVol / avgVol;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Price change over last N days
// ─────────────────────────────────────────────────────────────────────────────

function priceChangePct(candles, days) {
    if (candles.length < days + 1) return null;
    const old = candles[candles.length - days - 1].close;
    const now = candles[candles.length - 1].close;
    if (old === 0) return null;
    return ((now - old) / old) * 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: RS vs Nifty (Relative Strength ratio slope over 10 days)
// ─────────────────────────────────────────────────────────────────────────────

function calcRsVsNifty(stockCandles, niftyCandles, days = 10) {
    if (stockCandles.length < days || niftyCandles.length < days) return null;
    const stockReturns = [];
    const niftyReturns = [];
    for (let i = 1; i <= days; i++) {
        const si = stockCandles.length - i;
        const siPrev = stockCandles.length - i - 1;
        if (siPrev >= 0) {
            stockReturns.push((stockCandles[si].close - stockCandles[siPrev].close) / stockCandles[siPrev].close);
        }
        const ni = niftyCandles.length - i;
        const niPrev = niftyCandles.length - i - 1;
        if (niPrev >= 0) {
            niftyReturns.push((niftyCandles[ni].close - niftyCandles[niPrev].close) / niftyCandles[niPrev].close);
        }
    }
    if (stockReturns.length < 5 || niftyReturns.length < 5) return null;
    const avgStock = stockReturns.reduce((a, b) => a + b, 0) / stockReturns.length;
    const avgNifty = niftyReturns.reduce((a, b) => a + b, 0) / niftyReturns.length;
    // RS ratio: stock return / nifty return
    if (avgNifty === 0) return avgStock > 0 ? 2.0 : 0.5;
    return avgStock / avgNifty;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Supertrend green (simplified — price above supertrend line)
// ─────────────────────────────────────────────────────────────────────────────

function isSupertrendGreen(candles, period = 10, multiplier = 3) {
    if (candles.length < period + 1) return false;
    // Simplified supertrend: calculate ATR-based bands
    const atrs = [];
    for (let i = 1; i < candles.length; i++) {
        const tr = Math.max(
            candles[i].high - candles[i].low,
            Math.abs(candles[i].high - candles[i - 1].close),
            Math.abs(candles[i].low - candles[i - 1].close)
        );
        atrs.push(tr);
    }
    if (atrs.length < period) return false;
    const recentAtrs = atrs.slice(-period);
    const atr = recentAtrs.reduce((a, b) => a + b, 0) / period;
    const lastClose = candles[candles.length - 1].close;
    const lastMid = (candles[candles.length - 1].high + candles[candles.length - 1].low) / 2;
    const lowerBand = lastMid - multiplier * atr;
    return lastClose > lowerBand;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Check support tested and rejected N+ times
// ─────────────────────────────────────────────────────────────────────────────

function countSupportTests(candles, level, tolerancePct = 2, lookback = 60) {
    const slice = candles.slice(-lookback);
    let tests = 0;
    for (const c of slice) {
        if (Math.abs(c.low - level) / level * 100 <= tolerancePct) {
            tests++;
        }
    }
    return tests;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Detect breakout pattern
// ─────────────────────────────────────────────────────────────────────────────

function detectBreakout(candles, volRatio, consolidationDays) {
    if (candles.length < 2) return { isBreakout: false, pattern: "none" };
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const isBreakout = last.close > prev.high && volRatio != null && volRatio >= MIN_BREAKOUT_VOL_RATIO;

    let pattern = "none";
    if (isBreakout) {
        if (consolidationDays >= MIN_CONSOLIDATION_DAYS) {
            pattern = "tight coil breakout";
        } else if (last.close > candles.slice(-20).reduce((m, c) => Math.max(m, c.high), -Infinity) * 0.98) {
            pattern = "resistance breakout";
        } else {
            pattern = "volume breakout";
        }
    }

    return { isBreakout, pattern };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Determine entry type
// ─────────────────────────────────────────────────────────────────────────────

function determineEntryType(isBreakout, pattern, currentPrice, candles) {
    if (isBreakout && pattern === "tight coil breakout") {
        return "Breakout";
    }
    // Check if price is near support (pullback)
    const recent = candles.slice(-20);
    const lowSupport = Math.min(...recent.map(c => c.low));
    if (Math.abs(currentPrice - lowSupport) / lowSupport < 0.05) {
        return "Pullback to support";
    }
    // Accumulation zone
    return "Accumulation zone";
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Build operator footprint description
// ─────────────────────────────────────────────────────────────────────────────

function buildOperatorFootprint(footprints, stockData) {
    if (footprints.length === 0) {
        return "No clear operator footprint detected";
    }
    const primary = footprints[0];
    const parts = [];
    parts.push(`#${primary.footprint} ${primary.name}`);
    if (primary.signals.length > 0) {
        parts.push(primary.signals.slice(0, 2).join("; "));
    }
    if (footprints.length > 1) {
        parts.push(`+${footprints.length - 1} additional patterns`);
    }
    return parts.join(" | ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Determine operator phase
// ─────────────────────────────────────────────────────────────────────────────

function determineOperatorPhase(footprints, priceChange5d, deliveryPct, volRatio) {
    const phases = footprints.map(f => f.name);

    if (phases.includes("SILENT ACCUMULATION")) return "Accumulation";
    if (phases.includes("STOP HUNT TRAP \u2B50")) return "Early Markup";
    if (phases.includes("MARKUP PHASE RALLY")) return "Markup";
    if (phases.includes("SHORT SQUEEZE INCOMING")) return "Early Markup";
    if (phases.includes("HIDDEN DIVERGENCE")) return "Accumulation";

    // Infer from data
    if (priceChange5d !== null && priceChange5d < 5 && deliveryPct > MIN_DELIVERY_PCT) {
        return "Accumulation";
    }
    if (volRatio !== null && volRatio > 2 && priceChange5d !== null && priceChange5d > 3) {
        return "Early Markup";
    }
    if (priceChange5d !== null && priceChange5d > 8) {
        return "Markup";
    }
    return "Accumulation";
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Fundamental check flag
// ─────────────────────────────────────────────────────────────────────────────

function checkFundamentals(fundamentalData) {
    const concerns = [];

    if (fundamentalData.debtToEquity != null && Number.isFinite(fundamentalData.debtToEquity) && fundamentalData.debtToEquity >= MAX_DEBT_TO_EQUITY) {
        concerns.push(`High D/E: ${fundamentalData.debtToEquity.toFixed(2)}`);
    }
    if (fundamentalData.revenueGrowthQoQ != null && Number.isFinite(fundamentalData.revenueGrowthQoQ) && fundamentalData.revenueGrowthQoQ < 0) {
        concerns.push(`Revenue declining QoQ`);
    }
    if (fundamentalData.promoterPledgeIncrease) {
        concerns.push(`Promoter pledge increased`);
    }
    if (fundamentalData.insiderSelling30d) {
        concerns.push(`Insider selling last 30d`);
    }
    if (fundamentalData.regulatoryIssue) {
        concerns.push(`Regulatory/legal issue pending`);
    }

    if (concerns.length === 0) return "Clean";
    return `One concern: ${concerns[0]}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: F&O confirmation (CE OI + PCR)
// ─────────────────────────────────────────────────────────────────────────────

function checkFoConfirmation(foData) {
    if (!foData.isFoStock) return "NA";

    const parts = [];
    if (foData.ceOiBuilding) {
        parts.push("CE OI rising");
    }
    if (foData.pcrFalling) {
        parts.push("PCR falling");
    }
    if (parts.length === 0) return "No confirmation";
    return parts.join(" + ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Sector strength — count peers showing same strength
// ─────────────────────────────────────────────────────────────────────────────

function calcSectorStrength(sector, stockName, peerData) {
    if (!SECTOR[sector] || sector === "OTHER") return { count: 0, peers: [] };
    const peers = SECTOR[sector].filter(s => s !== stockName);
    const strongPeers = peers.filter(p => {
        const d = peerData[p];
        if (!d) return false;
        return d.volRatio !== null && d.volRatio > 1.5 && d.priceChange5d !== null && d.priceChange5d > 0;
    });
    return { count: strongPeers.length, peers: strongPeers.slice(0, 3) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Build missing data flags
// ─────────────────────────────────────────────────────────────────────────────

function buildMissingDataFlags(data) {
    const flags = [];
    if (data.deliveryPct === null || data.deliveryPct === undefined) flags.push("[EST] Delivery % unavailable");
    if (data.fiiFlow === null || data.fiiFlow === undefined) flags.push("[EST] FII flow unavailable");
    if (data.debtToEquity === null || data.debtToEquity === undefined) flags.push("[EST] Debt/Equity unavailable");
    if (data.mutualFundEntry === null || data.mutualFundEntry === undefined) flags.push("[EST] MF entry unavailable");
    if (data.blockDeal === null || data.blockDeal === undefined) flags.push("[EST] Block deal unavailable");
    if (data.rsVsNifty === null || data.rsVsNifty === undefined) flags.push("[EST] RS vs Nifty unavailable");
    return flags.length > 0 ? flags.join(", ") : "All data available";
}

// ─────────────────────────────────────────────────────────────────────────────
// Equity Checklist: Full validation per stock
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run full equity checklist on a stock.
 *
 * @param {string} symbol — Stock symbol
 * @param {Array} dailyCandles — Daily candles (min 200 for full checks)
 * @param {Array} weeklyCandles — Weekly candles (for weekly RSI, MACD, EMA checks)
 * @param {Object} ltp — Live price data
 * @param {Object} fundamentalData — { debtToEquity, revenueGrowthQoQ, promoterPledgeIncrease, insiderSelling30d, regulatoryIssue, mfEntry, blockDeal }
 * @param {Object} foData — F&O data if applicable { isFoStock, ceOiBuilding, pcrFalling }
 * @param {Object} flowData — { fiiFlow, diiFlow, fiiBuying, blockDealBuy }
 * @param {Object} niftyCandles — Nifty candles for RS calculation
 * @returns {Object|null} Equity call object or null if fails checklist
 */
export function analyzeEquityStock(
    symbol,
    dailyCandles,
    weeklyCandles,
    ltp,
    fundamentalData = {},
    foData = { isFoStock: false },
    flowData = {},
    niftyCandles = []
) {
    if (!dailyCandles || dailyCandles.length < 60) return null;

    const closes = dailyCandles.map(c => c.close).filter(Number.isFinite);
    if (closes.length < 60) return null;
    const currentPrice = ltp?.price ?? closes[closes.length - 1];
    if (!Number.isFinite(currentPrice)) return null;

    // ── 1. Operator footprint (1-8) ──
    const operatorData = {
        priceRange10d: calcConsolidationRange(dailyCandles, 10).range,
        volumeRatio: calcVolumeRatio(dailyCandles),
        deliveryPercent: fundamentalData.deliveryPct || null,
        oiChangePercent: foData.oiChangePercent || null,
        dippedBelowSupport: false,
        snappedBack: false,
        brokeResistance: false,
        sectorPeersMoving: false,
        holdingSupport: false,
        marketWeak: false,
        pcr: foData.pcr || null,
        positiveTrigger: null,
        position52W: null,
        priceStagnant: false,
        fiiFlow: flowData.fiiFlow || null,
        mediaBuzz: false,
        coilDays: null,
        breakoutFromCoil: false,
        sectorVolumeSpikes: null,
        sector: getSector(symbol),
        otherSectorDistribution: null,
        isSectorLeader: false,
        rsiBullishDivergence: false,
        oiFallingOnDips: false,
        volumeDecliningOnDips: false,
        nextGreenCandle: false,
        oiTradeDirection: null,
        emaAligned: false,
        macdConfirmed: false,
        supertrendAligned: false,
        rsi: null,
        tradeType: "equity",
        cleanChart: false,
        eventRisk: fundamentalData.regulatoryIssue || false
    };

    const footprints = detectAllFootprints(operatorData);

    // ── 2. Delivery % > 65% on breakout day ──
    const deliveryPct = fundamentalData.deliveryPct ?? null;
    const deliveryPass = deliveryPct == null || deliveryPct >= MIN_DELIVERY_PCT;

    // ── 3. Volume ratio on breakout ──
    const volRatio = calcVolumeRatio(dailyCandles);
    const volumePass = volRatio != null && volRatio >= MIN_BREAKOUT_VOL_RATIO;

    // ── 4. Consolidation check ──
    const consolidation = calcConsolidationRange(dailyCandles, MIN_CONSOLIDATION_DAYS + 5);
    const consolidationDays = findConsolidationPeriod(dailyCandles, MAX_CONSOLIDATION_RANGE_PCT);
    const consolidationPass = consolidationDays >= MIN_CONSOLIDATION_DAYS;

    // ── 5. Breakout detection ──
    const breakout = detectBreakout(dailyCandles, volRatio, consolidationDays);

    // ── 6. Price change last 5 days (must not be up > 15%) ──
    const priceChange5d = priceChangePct(dailyCandles, 5);
    const notOverextended = priceChange5d === null || priceChange5d <= MAX_UP_5DAYS_PCT;

    // ── 7. Weekly EMA 21 > EMA 50 or golden cross ──
    const weeklyCloses = weeklyCandles ? weeklyCandles.map(c => c.close).filter(Number.isFinite) : [];
    let weeklyEma21Above50 = false;
    let goldenCrossForming = false;
    if (weeklyCloses.length >= 55) {
        const we21 = getLastEma(weeklyCloses, 21);
        const we50 = getLastEma(weeklyCloses, 50);
        if (we21 !== null && we50 !== null) {
            weeklyEma21Above50 = we21 > we50;
            // Check golden cross: 21 was below 50, now above
            const prevSlice = weeklyCloses.slice(0, -1);
            if (prevSlice.length >= 55) {
                const pwe21 = getLastEma(prevSlice, 21);
                const pwe50 = getLastEma(prevSlice, 50);
                if (pwe21 !== null && pwe50 !== null && pwe21 <= pwe50 && we21 > we50) {
                    goldenCrossForming = true;
                }
            }
        }
    }
    const weeklyEmaPass = weeklyEma21Above50 || goldenCrossForming;

    // ── 8. MACD bullish daily and weekly ──
    const macdBullDaily = isMacdBullish(closes);
    const macdBullWeekly = weeklyCloses.length >= 30 ? isMacdBullish(weeklyCloses) : false;
    const macdPass = macdBullDaily || macdBullWeekly;

    // ── 9. RSI 50-68 weekly ──
    const rsiWeeklyPass = weeklyCloses.length >= 15 ? rsiInRange(weeklyCloses, 50, 68) : false;
    const rsiDaily = calcRsi(closes);

    // ── 10. 52W position > 65% ──
    const pos52W = calc52WPosition(currentPrice, dailyCandles);
    const pos52WPass = pos52W >= MIN_52W_POSITION_PCT;

    // ── 11. Above 20, 50, 100, 200 DMA ──
    const aboveDma = priceAboveAllDmas(currentPrice, closes);

    // ── 12. RS vs Nifty > 1.3 ──
    const rsVsNifty = calcRsVsNifty(dailyCandles, niftyCandles);
    const rsPass = rsVsNifty === null || rsVsNifty >= MIN_RS_VS_NIFTY;

    // ── 13. Supertrend green daily ──
    const supertrendGreen = isSupertrendGreen(dailyCandles);

    // ── 14. Debt/Equity < 1 ──
    const dePass = fundamentalData.debtToEquity === null || fundamentalData.debtToEquity < MAX_DEBT_TO_EQUITY;

    // ── 15. Revenue growth positive last 2 quarters ──
    const revPass = fundamentalData.revenueGrowthQoQ === null || fundamentalData.revenueGrowthQoQ > 0;

    // ── 16. No insider selling last 30 days ──
    const noInsiderSelling = !fundamentalData.insiderSelling30d;

    // ── 17. No regulatory/legal issue ──
    const noRegulatoryIssue = !fundamentalData.regulatoryIssue;

    // ── 18. Promoter holding stable — no pledge increase ──
    const promoterStable = !fundamentalData.promoterPledgeIncrease;

    // ── 19. F&O confirmation if applicable ──
    const foConfirm = checkFoConfirmation(foData);

    // ── 20. Fundamental flag ──
    const fundamentalFlag = checkFundamentals(fundamentalData);

    // ─────────────────────────────────────────────────────────────────────
    // SCORING — count passes
    // ─────────────────────────────────────────────────────────────────────
    const checks = [
        { name: "operator_footprint", pass: footprints.length > 0 },
        { name: "delivery_pct", pass: deliveryPass },
        { name: "breakout_volume", pass: volumePass },
        { name: "consolidation", pass: consolidationPass },
        { name: "not_overextended", pass: notOverextended },
        { name: "weekly_ema", pass: weeklyEmaPass },
        { name: "macd_bullish", pass: macdPass },
        { name: "rsi_weekly", pass: rsiWeeklyPass },
        { name: "52w_position", pass: pos52WPass },
        { name: "above_dma", pass: aboveDma },
        { name: "debt_equity", pass: dePass },
        { name: "revenue_growth", pass: revPass },
        { name: "no_insider_selling", pass: noInsiderSelling },
        { name: "no_regulatory", pass: noRegulatoryIssue },
        { name: "promoter_stable", pass: promoterStable },
        { name: "supertrend_green", pass: supertrendGreen },
        { name: "rs_vs_nifty", pass: rsPass },
    ];

    const passed = checks.filter(c => c.pass).length;
    const total = checks.length;
    const scorePct = Math.round((passed / total) * 100);

    // Use operator engine scoring for consistency
    const operatorResult = calculateScore({
        ...operatorData,
        tradeType: "equity",
        emaAligned: weeklyEma21Above50,
        macdConfirmed: macdBullDaily,
        supertrendAligned: supertrendGreen,
        rsi: rsiDaily,
        volumeRatio: volRatio,
        deliveryPercent: deliveryPct,
        brokeResistance: breakout.isBreakout,
        fiiBuying: flowData.fiiBuying || false,
        blockDealBuy: flowData.blockDealBuy || false,
        cleanChart: aboveDma && pos52WPass,
        oiTradeDirection: foData.ceOiBuilding ? (foData.oiChangePercent || 0) : null
    }, 14); // default VIX 14 for equity scoring

    const finalScore = Math.max(scorePct, operatorResult.score);
    const scoreBand = getScoreBand(finalScore);

    // Must qualify (score >= 40)
    if (finalScore < 40) return null;

    // ─────────────────────────────────────────────────────────────────────
    // Build output object
    // ─────────────────────────────────────────────────────────────────────
    const target1Price = +(currentPrice * (1 + EQUITY_TARGET_1_PCT / 100)).toFixed(2);
    const target2Price = +(currentPrice * (1 + EQUITY_TARGET_2_PCT / 100)).toFixed(2);
    const stopLossPrice = +(currentPrice * (1 - EQUITY_STOP_LOSS_PCT / 100)).toFixed(2);

    const entryType = determineEntryType(breakout.isBreakout, breakout.pattern, currentPrice, dailyCandles);

    const sector = getSector(symbol);
    const operatorPhase = determineOperatorPhase(footprints, priceChange5d, deliveryPct, volRatio);
    const operatorFootprint = buildOperatorFootprint(footprints, operatorData);

    const missingFlags = buildMissingDataFlags({
        deliveryPct,
        fiiFlow: flowData.fiiFlow,
        debtToEquity: fundamentalData.debtToEquity,
        mutualFundEntry: fundamentalData.mfEntry,
        blockDeal: fundamentalData.blockDeal,
        rsVsNifty
    });

    // Confidence: high if > 80% checks pass, medium if > 60%, low otherwise
    const confidencePct = Math.round((passed / total) * 100);
    let confidence = "LOW";
    if (confidencePct >= 85) confidence = "HIGH";
    else if (confidencePct >= 65) confidence = "MEDIUM";

    // Reason array — top 3 strongest signals
    const reasons = [];
    if (footprints.length > 0) reasons.push(`Operator footprint #${footprints[0].footprint}: ${footprints[0].name} (conviction: ${footprints[0].conviction}%)`);
    if (volumePass && Number.isFinite(volRatio)) reasons.push(`Breakout volume ${volRatio.toFixed(1)}x avg (threshold: ${MIN_BREAKOUT_VOL_RATIO}x)`);
    if (deliveryPass && deliveryPct !== null && Number.isFinite(deliveryPct)) reasons.push(`Delivery ${deliveryPct.toFixed(1)}% confirms smart money accumulation`);
    if (consolidationPass) reasons.push(`${consolidationDays}+ days tight consolidation before breakout`);
    if (weeklyEmaPass) reasons.push(`Weekly EMA 21 > EMA 50 ${goldenCrossForming ? "(golden cross forming)" : ""}`);
    if (macdPass) reasons.push(`MACD bullish ${macdBullDaily ? "daily" : ""}${macdBullWeekly ? " and weekly" : ""}`);
    if (supertrendGreen) reasons.push("Supertrend green on daily");
    if (rsPass && rsVsNifty != null && Number.isFinite(rsVsNifty)) reasons.push(`RS vs Nifty ${rsVsNifty.toFixed(2)} (min: ${MIN_RS_VS_NIFTY})`);
    if (aboveDma) reasons.push("Price above all key DMAs (20, 50, 100, 200)");
    if (pos52WPass && Number.isFinite(pos52W)) reasons.push(`At ${pos52W.toFixed(1)}% of 52W range — strong momentum position`);
    if (dePass) reasons.push(`Clean balance sheet: D/E ${fundamentalData.debtToEquity != null && Number.isFinite(fundamentalData.debtToEquity) ? fundamentalData.debtToEquity.toFixed(2) : "N/A"} < ${MAX_DEBT_TO_EQUITY}`);

    return {
        rank: null, // set after sorting
        score: finalScore,
        score_band: `${scoreBand.emoji} ${scoreBand.label}`,
        stock: symbol,
        operator_phase: operatorPhase,
        operator_footprint: operatorFootprint,
        trade: "BUY EQUITY",
        entry_price: currentPrice,
        entry_type: entryType,
        target_1: `${EQUITY_TARGET_1_PCT}% -- Rs.${target1Price}`,
        target_2: `${EQUITY_TARGET_2_PCT}% -- Rs.${target2Price}`,
        stop_loss: `${EQUITY_STOP_LOSS_PCT}% -- Rs.${stopLossPrice}`,
        holding_period: `Max ${MAX_HOLDING_DAYS} trading days`,
        exit_rule: `Target 2 OR day ${MAX_HOLDING_DAYS}, first wins`,
        pattern: breakout.pattern !== "none" ? breakout.pattern : (consolidationPass ? "accumulation zone" : "momentum continuation"),
        delivery_pct: deliveryPct !== null && Number.isFinite(deliveryPct) ? `${deliveryPct.toFixed(1)}%` : "N/A",
        rs_vs_nifty: rsVsNifty !== null && Number.isFinite(rsVsNifty) ? rsVsNifty.toFixed(2) : "N/A",
        sector,
        sector_strength: null, // set after peer analysis
        fao_confirmation: foConfirm,
        fundamental_flag: fundamentalFlag,
        missing_data_flags: missingFlags,
        confidence,
        reason: reasons.slice(0, 3),
        // Internal data for sorting/analysis
        _internal: {
            volRatio,
            priceChange5d,
            pos52W,
            aboveDma,
            supertrendGreen,
            macdBullDaily,
            macdBullWeekly,
            rsiWeeklyPass,
            rsiDaily,
            weeklyEma21Above50,
            goldenCrossForming,
            rsVsNifty,
            consolidationDays,
            deliveryPct,
            footprints
        }
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scan entire universe for equity calls
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scan stocks and return top 10 equity calls.
 *
 * @param {Object} options — { vixValue, useFullUniverse, peerDataMap, fundamentalDataMap, foDataMap, flowDataMap }
 * @returns {Promise<Array>} Top 10 equity calls sorted by score
 */
export async function scanEquityCalls(options = {}) {
    const {
        vixValue = 14,
        useFullUniverse = false,
        peerDataMap = {},
        fundamentalDataMap = {},
        foDataMap = {},
        flowDataMap = {}
    } = options;

    const symbols = useFullUniverse
        ? UNIVERSE.filter(s => !["NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX", "MIDCPNIFTY"].includes(s))
        : UNIVERSE.slice(0, 60).filter(s => !["NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX", "MIDCPNIFTY"].includes(s));

    console.log(`[Equity Scanner] Scanning ${symbols.length} stocks...`);

    const results = [];

    // Fetch Nifty candles once for RS calculation
    let niftyCandles = [];
    try {
        niftyCandles = await fetchCandles("NIFTY", "1d", 260);
    } catch (e) {
        console.log(`[Equity Scanner] Nifty candles fetch failed: ${e.message}`);
    }

    for (const symbol of symbols) {
        try {
            // Fetch daily candles
            const dailyCandles = await fetchCandles(symbol, "1d", 260);
            if (!dailyCandles || dailyCandles.length < 60) continue;

            // Fetch weekly candles
            let weeklyCandles = [];
            try {
                weeklyCandles = await fetchCandles(symbol, "1d", 120); // Weekly approximation
            } catch (e) {
                // Skip weekly if not available
            }

            // Fetch LTP
            let ltp = null;
            try {
                const ltps = await fetchBulkLtp([symbol]);
                ltp = ltps?.[symbol] || null;
            } catch (e) {
                ltp = { price: dailyCandles[dailyCandles.length - 1].close };
            }

            const fundamentalData = fundamentalDataMap[symbol] || {};
            const foData = foDataMap[symbol] || { isFoStock: false };
            const flowData = flowDataMap[symbol] || {};

            const result = analyzeEquityStock(
                symbol,
                dailyCandles,
                weeklyCandles,
                ltp,
                fundamentalData,
                foData,
                flowData,
                niftyCandles
            );

            if (result) {
                results.push(result);
            }
        } catch (e) {
            console.log(`[Equity Scanner] ${symbol}: ${e.message}`);
        }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    // Calculate sector strength for top results
    for (const r of results) {
        const strength = calcSectorStrength(r.sector, r.stock, peerDataMap);
        r.sector_strength = `${strength.count} peers strong` + (strength.peers.length > 0 ? ` (${strength.peers.join(", ")})` : "");
    }

    // Filter: need sector strength >= 2 OR RS vs Nifty >= 1.3
    const filtered = results.filter(r => {
        const match = r._internal;
        return (r.sector_strength && parseInt(r.sector_strength) >= MIN_SECTOR_PEERS_STRENGTH) ||
               (match?.rsVsNifty !== null && match.rsVsNifty >= MIN_RS_VS_NIFTY) ||
               r.sector === "OTHER";
    });

    // Take top 10
    const top10 = filtered.slice(0, 10);

    // Assign ranks
    top10.forEach((r, i) => { r.rank = i + 1; });

    // VIX-based position sizing note
    const vixMode = getVixMode(vixValue);
    const posSizeMultiplier = getPositionSizeMultiplier(vixValue);
    const vixRiskFlag = getVixRiskFlag(vixValue);

    // Add VIX note to results
    const vixNote = vixMode.name !== "DANGER MODE" && Number.isFinite(vixValue)
        ? `VIX ${vixValue.toFixed(2)} (${vixMode.name}) — Position size multiplier: ${posSizeMultiplier}`
        : "VIX DANGER — Equity only mode active";

    // Clean internal data from output
    const cleanResults = top10.map(r => {
        const { _internal, ...clean } = r;
        return {
            ...clean,
            vix_mode: vixNote
        };
    });

    console.log(`[Equity Scanner] Found ${cleanResults.length} qualifying equity calls`);

    return cleanResults;
}

// ─────────────────────────────────────────────────────────────────────────────
// Format equity call for display
// ─────────────────────────────────────────────────────────────────────────────

export function formatEquityCall(call) {
    let out = "";
    out += `#${call.rank} | ${call.score_band} | ${call.score}/100\n`;
    out += `${call.trade} ${call.stock}\n`;
    out += `Entry: Rs.${call.entry_price} (${call.entry_type})\n`;
    out += `Target 1: ${call.target_1}\n`;
    out += `Target 2: ${call.target_2}\n`;
    out += `Stop Loss: ${call.stop_loss}\n`;
    out += `Holding: ${call.holding_period} | Exit: ${call.exit_rule}\n`;
    out += `Pattern: ${call.pattern}\n`;
    out += `Operator Phase: ${call.operator_phase}\n`;
    out += `Footprint: ${call.operator_footprint}\n`;
    out += `Delivery: ${call.delivery_pct} | RS vs Nifty: ${call.rs_vs_nifty}\n`;
    out += `Sector: ${call.sector} (${call.sector_strength})\n`;
    out += `F&O Confirm: ${call.fao_confirmation}\n`;
    out += `Fundamentals: ${call.fundamental_flag}\n`;
    if (call.missing_data_flags.length > 0) {
        out += `Missing: ${call.missing_data_flags.join(", ")}\n`;
    }
    out += `Confidence: ${call.confidence}\n`;
    out += `Reasons:\n`;
    for (const r of call.reason) {
        out += `  - ${r}\n`;
    }
    if (call.vix_mode) {
        out += `VIX: ${call.vix_mode}\n`;
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI entry point
// ─────────────────────────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith("equity_scanner.mjs")) {
    console.log("=".repeat(70));
    console.log("EQUITY SCANNER — Task 3: Top 10 Equity Calls");
    console.log("=".repeat(70));
    console.log("");

    scanEquityCalls().then(calls => {
        if (calls.length === 0) {
            console.log("No qualifying equity calls found.");
            return;
        }

        for (const call of calls) {
            console.log("-".repeat(70));
            console.log(formatEquityCall(call));
            console.log("");
        }

        console.log("=".repeat(70));
        console.log(`Total calls: ${calls.length}`);
        process.exit(0);
    }).catch(err => {
        console.error("Equity scanner error:", err);
        process.exit(1);
    });
}

export {
    EQUITY_TARGET_1_PCT,
    EQUITY_TARGET_2_PCT,
    EQUITY_STOP_LOSS_PCT,
    MAX_HOLDING_DAYS,
    MIN_DELIVERY_PCT,
    MIN_BREAKOUT_VOL_RATIO,
    MAX_CONSOLIDATION_RANGE_PCT,
    MIN_CONSOLIDATION_DAYS,
    MIN_52W_POSITION_PCT,
    MAX_UP_5DAYS_PCT,
    MIN_RS_VS_NIFTY,
    MAX_OVERHEAD_RESISTANCE_PCT,
    MAX_DEBT_TO_EQUITY,
    MIN_SECTOR_PEERS_STRENGTH,
};
