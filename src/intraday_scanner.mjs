// ─────────────────────────────────────────────────────────────────────────────
// intraday_scanner.mjs — Task 1: Top 10 Intraday F&O Calls
// Target: 20-50% premium gain same day
// Entry: 9:30-10:15 AM or 2:00-2:45 PM only (NEVER 12:00-1:30 PM lunch chop)
// Exit: Hard exit 3:00 PM
// ─────────────────────────────────────────────────────────────────────────────

import { calculateScore, getScoreBand } from "./operator_engine.mjs";
import {
  calculateEstimatedPremium,
  calculateATMStrike,
  formatExpiryDate,
  getNextThursday,
  calculateDTE,
  getStrikeInterval
} from "./premium_calc.mjs";
import {
  getVixMode,
  isTaskAllowed,
  getPositionSizeMultiplier,
  allowOTMOptions,
  getVixRiskFlag,
  getVixStatusLine
} from "./vix_manager.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// FULL INTRADAY CHECKLIST — per spec
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run full checklist on a stock for intraday trading
 * Returns { pass, checks, checklistScore } or null if fails hard rules
 */
function runIntradayChecklist(stock, tradeType, marketContext) {
  const isCE = tradeType === "CE";
  const price = stock.price || 0;
  if (price === 0) return null;

  // ── HARD SKIPS ──────────────────────────────────────────────────────────
  // F&O ban → skip immediately
  if (stock.isFOBanned) return null;

  // ATR check — need minimum volatility
  const atrPercent = stock.atrPercent || ((stock.dayH - stock.dayL) / price * 100) || 0;
  if (atrPercent < 1.5) {
    return { pass: false, reason: "ATR < 1.5% — insufficient volatility" };
  }

  // ── CHECKLIST ITEMS ─────────────────────────────────────────────────────
  const checks = [];

  // 1. In play: 30min volume > 3x avg?
  const volumeInPlay = stock.volumeRatio != null && stock.volumeRatio > 3;
  checks.push({ name: "volume_in_play", pass: volumeInPlay, weight: 3 });

  // 2. ORB triggered: broke first 15min high (CE) or low (PE)?
  // Simplified: use dayH/dayL position
  const dayRange = stock.dayH - stock.dayL;
  const closeInUpperRange = dayRange > 0 ? ((price - stock.dayL) / dayRange) : 0.5;
  const orbTriggered = isCE ? closeInUpperRange > 0.7 : closeInUpperRange < 0.3;
  checks.push({ name: "orb_triggered", pass: orbTriggered, weight: 3 });

  // 3. PDH broken and holding (CE) or PDL broken (PE)?
  const pdhBroken = isCE && stock.price > (stock.prevDayH || stock.dayH);
  const pdlBroken = !isCE && stock.price < (stock.prevDayL || stock.dayL);
  const pdLevelBroken = pdhBroken || pdlBroken;
  checks.push({ name: "pdh_pdl_broken", pass: pdLevelBroken, weight: 2 });

  // 4. Price vs VWAP: above (CE) / below (PE)?
  const vwapOk = isCE ? (stock.aboveVwap || false) : !(stock.aboveVwap || false);
  checks.push({ name: "price_vs_vwap", pass: vwapOk, weight: 3 });

  // 5. 5min EMA 9 vs 21: aligned?
  // Simplified: use daily EMA alignment
  const emaAligned = stock.emaAligned || false;
  checks.push({ name: "ema_aligned", pass: emaAligned, weight: 2 });

  // 6. MACD histogram direction confirmed?
  const macdOk = stock.macdConfirmed || false;
  checks.push({ name: "macd_confirmed", pass: macdOk, weight: 2 });

  // 7. RSI: 55-72 (CE) or 28-45 (PE)?
  const rsi = stock.rsi;
  let rsiOk = false;
  if (rsi != null && Number.isFinite(rsi)) {
    rsiOk = isCE ? (rsi >= 55 && rsi <= 72) : (rsi >= 28 && rsi <= 45);
  }
  checks.push({ name: "rsi_zone", pass: rsiOk, weight: 2 });

  // 8. Supertrend 15min: green (CE) / red (PE)?
  const supertrendOk = stock.supertrendAligned || false;
  checks.push({ name: "supertrend_aligned", pass: supertrendOk, weight: 2 });

  // 9. ATR > 1.5%?
  const atrOk = atrPercent >= 1.5;
  checks.push({ name: "atr_minimum", pass: atrOk, weight: 2 });

  // 10. OI rising in trade direction?
  const oiRising = stock.oiRising || (stock.oiChangePercent != null && stock.oiChangePercent > 10);
  checks.push({ name: "oi_rising", pass: oiRising, weight: 2 });

  // 11. PCR extreme reading?
  const pcrExtreme = stock.pcr != null && Number.isFinite(stock.pcr)
    ? (isCE ? stock.pcr < 0.7 : stock.pcr > 1.3)
    : false;
  checks.push({ name: "pcr_extreme", pass: pcrExtreme, weight: 1 });

  // 12. IV < 40%?
  const iv = stock.iv || null;
  const ivOk = iv === null || iv < 40;
  checks.push({ name: "iv_acceptable", pass: ivOk, weight: 2 });

  // 13. Clean air above (CE) — no resistance within 2%?
  const cleanAir = isCE && stock.cleanChart;
  checks.push({ name: "clean_air", pass: cleanAir || false, weight: 1 });

  // Calculate checklist score
  let totalWeight = 0;
  let passWeight = 0;
  for (const c of checks) {
    totalWeight += c.weight;
    if (c.pass) passWeight += c.weight;
  }
  const checklistScore = totalWeight > 0 ? (passWeight / totalWeight) * 100 : 0;

  // Need at least 50% checklist pass to qualify
  const pass = checklistScore >= 50;

  return {
    pass,
    checks,
    checklistScore: Math.round(checklistScore),
    atrPercent: +atrPercent.toFixed(2),
    ivCheck: iv !== null ? `${iv.toFixed(2)}%` : null
  };
}

/**
 * Scan for intraday F&O opportunities
 */
export function scanIntradayFO(scannerData, vixValue, marketContext = {}) {
  const vixStatus = getVixStatusLine(vixValue);

  // Check if task is allowed
  if (!isTaskAllowed(1, vixValue)) {
    return {
      calls: [],
      discarded: scannerData.length,
      reason: `Task 1 disabled for VIX ${vixValue.toFixed(2)} (DEFENSIVE/DANGER mode)`,
      summary: { given: 0, discarded: scannerData.length, foBan: 0, scoreBelow40: 0 }
    };
  }

  const allowOTM = allowOTMOptions(vixValue);
  const positionMultiplier = getPositionSizeMultiplier(vixValue);

  const scored = [];
  let discardedCount = 0;
  let bannedCount = 0;
  let lowScoreCount = 0;
  let checklistFailCount = 0;

  for (const stock of scannerData) {
    // Skip if not F&O stock
    if (!stock.isFO) {
      discardedCount++;
      continue;
    }

    // Skip if F&O ban
    if (stock.isFOBanned) {
      bannedCount++;
      discardedCount++;
      continue;
    }

    // Build stock data for operator engine
    const stockData = buildIntradayStockData(stock, marketContext);

    // Determine trade direction FIRST (needed for checklist)
    const tradeType = determineTradeType(stock, marketContext, stockData);
    if (!tradeType) {
      discardedCount++;
      continue;
    }

    // Run full intraday checklist
    const checklistResult = runIntradayChecklist(stock, tradeType, marketContext);
    if (!checklistResult || !checklistResult.pass) {
      checklistFailCount++;
      discardedCount++;
      continue;
    }

    // Calculate operator score
    const scoring = calculateScore(stockData, vixValue);

    if (!scoring.qualifies) {
      lowScoreCount++;
      discardedCount++;
      continue;
    }

    // ── CALCULATE OPTION DETAILS ──────────────────────────────────────────
    const atmStrike = calculateATMStrike(stock.price, stock.symbol);
    const strikesAway = allowOTM ? 1 : 0;
    const interval = getStrikeInterval(stock.price);
    const strike = tradeType === "CE"
      ? atmStrike + (strikesAway * interval)
      : atmStrike - (strikesAway * interval);

    const nextExpiry = getNextThursday();
    const dte = calculateDTE(nextExpiry);
    const optimalDTE = dte <= 2 ? dte + 7 : dte; // Avoid theta decay trap

    // Estimate premium
    const atrPercent = checklistResult.atrPercent;
    const premiumCalc = calculateEstimatedPremium(
      stock.price,
      atrPercent,
      vixValue,
      optimalDTE,
      strikesAway,
      stock.iv || null
    );

    // ── VIX ADJUSTMENTS ───────────────────────────────────────────────────
    let avoidIf = "Nifty below VWAP at entry";
    if (marketContext.niftyBelowVWAP) {
      if (tradeType === "CE") {
        avoidIf = "⚠️ Nifty below VWAP — HIGH RISK for CE. Reduce capital by 50%";
      } else {
        avoidIf = "Nifty below VWAP — PE preferred";
      }
    }

    // CAUTION mode: flag CE as elevated risk
    let vixWarning = null;
    if (vixValue >= 17 && vixValue < 20 && tradeType === "CE") {
      vixWarning = "⚡ ELEVATED RISK — CAUTION MODE active";
    } else if (vixValue >= 20 && vixValue <= 25) {
      vixWarning = "⚠️ HIGH VIX WARNING — DEFENSIVE MODE";
    }

    // ── BUILD CALL OBJECT ─────────────────────────────────────────────────
    const call = {
      rank: 0,
      score: scoring.score,
      score_band: `${scoring.band.emoji} ${scoring.band.label}`,
      stock: stock.symbol,
      operator_footprint: scoring.footprints.length > 0
        ? `#${scoring.footprints[0].footprint}: ${scoring.footprints[0].name} — ${scoring.footprints[0].action}`
        : "No clear footprint detected",
      trade: `BUY ${tradeType}`,
      strike: `${strike} ${strikesAway > 0 ? "[EST]" : ""}`,
      expiry: `${formatExpiryDate(nextExpiry)} ${dte <= 2 ? "[EST - Next Week]" : ""}`,
      entry_price_range: `₹${premiumCalc.entryRange.low}–₹${premiumCalc.entryRange.high} [EST-PREMIUM]`,
      premium_calc: premiumCalc,
      iv_check: checklistResult.ivCheck
        ? `${checklistResult.ivCheck} — acceptable`
        : `${estimateIVFromVIX(vixValue).toFixed(2)}% [EST-IV] — acceptable`,
      entry_window: getOptimalEntryWindow(),
      target_premium: "20-50% gain",
      stop_loss: "30% of premium paid",
      exit_rule: "Hard exit 3:00 PM regardless of P&L",
      avoid_if: avoidIf,
      liquidity_check: checkLiquidity(stock, premiumCalc),
      missing_data_flags: buildMissingDataFlags(stock, checklistResult),
      confidence: Math.min(10, Math.round(scoring.score / 10)),
      reason: buildReasonStrings(scoring, stockData, tradeType, checklistResult),
      position_size_adjustment: positionMultiplier < 1
        ? `Reduce by ${((1 - positionMultiplier) * 100).toFixed(0)}% (VIX adjustment)`
        : "Normal size",
      vix_warning: vixWarning,
      checklist_score: `${checklistResult.checklistScore}%`,
      // VIX status line for API output
      vix_status: vixStatus.statusLine
    };

    scored.push(call);
  }

  // Sort by score and take top 10
  scored.sort((a, b) => b.score - a.score);
  const top10 = scored.slice(0, 10);

  // Assign ranks
  top10.forEach((call, idx) => {
    call.rank = idx + 1;
  });

  return {
    calls: top10,
    summary: {
      given: top10.length,
      discarded: discardedCount,
      foBan: bannedCount,
      scoreBelow40: lowScoreCount,
      checklistFail: checklistFailCount,
      vixMode: vixStatus.mode,
      positionMultiplier: positionMultiplier.toFixed(2),
      vixStatusLine: vixStatus.statusLine
    }
  };
}

/**
 * Build intraday stock data for operator engine
 */
function buildIntradayStockData(stock, marketContext) {
  const isBullish = stock.ema21above && (stock.macdBull || stock.macdAbove);

  return {
    // Price action
    price: stock.price,
    dayH: stock.dayH,
    dayL: stock.dayL,
    weekH: stock.weekH,
    weekL: stock.weekL,
    position52W: stock.w52H && stock.w52L
      ? ((stock.price - stock.w52L) / (stock.w52H - stock.w52L)) * 100
      : null,

    // Volume
    volume: stock.volume,
    avgVolume: stock.volume / (stock.volSpike ? 2 : 1),
    volumeRatio: stock.volumeRatio || (stock.volSpike ? 2.0 : 1.0),

    // Technical
    emaAligned: stock.ema21above,
    macdConfirmed: stock.macdBull || stock.macdAbove,
    supertrendAligned: isBullish,
    rsi: stock.rsi,
    tradeType: isBullish ? "CE" : "PE",

    // Operator detection
    dippedBelowSupport: stock.dippedBelowSupport || false,
    snappedBack: stock.snappedBack || false,
    recoveryPercent: stock.recoveryPercent || null,
    brokeResistance: stock.brokeResistance || stock.goldenCross,
    holdingSupport: stock.holdingSupport || stock.aboveVwap,
    marketWeak: marketContext.niftyBelowVWAP || false,
    cleanChart: isBullish && stock.techScore >= 4,
    coilDays: stock.coilDays || null,

    // F&O specific
    isFO: stock.isFO || false,
    oiChangePercent: stock.oiChangePercent || stock.oiChange || null,
    deliveryPercent: stock.deliveryPercent || null,
    pcr: stock.pcr || null,
    iv: stock.iv || null,
    oiRising: stock.oiRising || false,

    // Flags
    eventRisk: false,
    fiiFlow: marketContext.fiiFlow || null,
    fiiBuying: (marketContext.fiiFlow || 0) > 0,
    blockDealBuy: stock.blockDeal || false
  };
}

/**
 * Determine trade direction (CE or PE) — uses data, not scoring footprints
 */
function determineTradeType(stock, marketContext, stockData) {
  const isBullish = stock.ema21above && (stock.macdBull || stock.macdAbove);
  const isBearish = !stock.ema21above && stock.macdBear;
  const niftyBullish = !marketContext.niftyBelowVWAP;

  // Check for distribution pattern (Footprint 5) → PE
  if (stockData.brokeResistance === false && stock.position52W > 85 && stock.volSpike) {
    return "PE";
  }

  // Stop hunt recovery → always CE
  if (stock.dippedBelowSupport && stock.snappedBack) {
    return "CE";
  }

  // Clear bullish signal
  if (isBullish && (niftyBullish || stock.dippedBelowSupport)) {
    return "CE";
  }

  // Clear bearish signal
  if (isBearish && !niftyBullish) {
    return "PE";
  }

  // Default: no clear signal
  return null;
}

/**
 * Estimate IV from VIX (consistent with premium_calc)
 */
function estimateIVFromVIX(vix) {
  if (vix < 13) return vix * 1.2;
  if (vix < 16) return vix * 1.4;
  if (vix < 20) return vix * 1.6;
  if (vix < 25) return vix * 1.8;
  return vix * 2.0;
}

/**
 * Get optimal entry window — avoid lunch chop zone
 */
function getOptimalEntryWindow() {
  const hour = new Date().getHours();
  const minute = new Date().getMinutes();
  const timeDecimal = hour + minute / 60;

  // NEVER enter during 12:00-1:30 PM — operator lunch, chop zone
  if (timeDecimal >= 12 && timeDecimal < 13.5) {
    return "⚠️ LUNCH CHOP ZONE — Wait for 2:00 PM session";
  }

  if (timeDecimal >= 9.5 && timeDecimal < 10.25) {
    return "9:30-10:15 AM (Morning session)";
  }
  if (timeDecimal >= 14 && timeDecimal < 14.75) {
    return "2:00-2:45 PM (Afternoon session)";
  }

  return "9:30-10:15 AM or 2:00-2:45 PM";
}

/**
 * Check liquidity — flag illiquid options
 */
function checkLiquidity(stock, premiumCalc) {
  const avgVolume = stock.volume || 0;
  const premium = premiumCalc.estimatedPremium;

  if (premium < 5 || avgVolume < 500000) {
    return "⚠️ ILLIQUID — wide spread risk. Reduce size.";
  }

  return "✅ Liquid";
}

/**
 * Build missing data flags — consistent [EST] tagging
 */
function buildMissingDataFlags(stock, checklistResult) {
  const flags = [];

  if (!stock.iv) flags.push("[EST-IV] IV estimated from VIX");
  if (!stock.atrPercent) flags.push("[EST] ATR% derived from day range");
  if (!stock.deliveryPercent) flags.push("Delivery data unavailable");
  if (!stock.oiChange && !stock.oiChangePercent) flags.push("OI data unavailable");
  if (!checklistResult?.ivCheck) flags.push("[EST-IV] IV estimated");

  return flags.length > 0 ? flags.join(", ") : "All data available";
}

/**
 * Build reason strings — top 3 strongest signals
 */
function buildReasonStrings(scoring, stockData, tradeType, checklistResult) {
  const reasons = [];

  // Operator reason
  if (scoring.footprints.length > 0) {
    const fp = scoring.footprints[0];
    reasons.push(`Operator: ${fp.name} (conviction: ${fp.conviction}%)`);
  } else {
    reasons.push("Operator: No clear footprint");
  }

  // Technical reason
  const tech = scoring.breakdown.technical;
  const techDetail = tech.details.slice(0, 2).join(", ");
  reasons.push(`Technical: ${tech.score}/35 — Checklist ${checklistResult?.checklistScore || 0}% — ${techDetail}`);

  // Risk reason
  const risk = scoring.breakdown.risk;
  reasons.push(`Risk: ${risk.score}/25 — ${tradeType === "CE" ? "Bullish setup" : "Bearish setup"}`);

  return reasons;
}
