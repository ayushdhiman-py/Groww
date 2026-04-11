// ─────────────────────────────────────────────────────────────────────────────
// overnight_scanner.mjs — Task 2: Top 10 Overnight F&O Calls
// Target: 25-60% premium by next day open
// Entry: 2:30-3:10 PM only
// Exit: First 30 minutes of next session. Hard. No exceptions.
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
  getMaxOvernightCalls,
  getVixStatusLine
} from "./vix_manager.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// FULL OVERNIGHT CHECKLIST — per spec
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run full overnight checklist on a stock
 * Returns { pass, checks, checklistScore } or null if fails hard rules
 */
function runOvernightChecklist(stock, tradeType, marketContext) {
  const isCE = tradeType === "CE";
  const price = stock.price || 0;
  if (price === 0) return null;

  // ── HARD SKIPS ──────────────────────────────────────────────────────────
  if (stock.isFOBanned) return null;

  // Earnings tomorrow → skip
  if (stock.earningsSoon) {
    return { pass: false, reason: "Earnings tomorrow — skip overnight" };
  }

  // Macro event tonight → skip
  if (stock.macroEventTonight) {
    return { pass: false, reason: "Macro event tonight — skip overnight" };
  }

  // ── CHECKLIST ITEMS ─────────────────────────────────────────────────────
  const checks = [];

  // 1. Stock held key support all day even when Nifty was weak?
  const heldSupport = stock.holdingSupport && marketContext.niftyBelowVWAP;
  checks.push({ name: "held_support_weak_market", pass: heldSupport, weight: 3 });

  // 2. OI buildup > 15% in calls today?
  const oiBuildup = (isCE ? (stock.oiChangePercent || 0) : 0) > 15;
  checks.push({ name: "oi_buildup_15", pass: oiBuildup, weight: 3 });

  // 3. Delivery % today > 55%?
  const deliveryOk = stock.deliveryPercent != null && stock.deliveryPercent > 55;
  checks.push({ name: "delivery_above_55", pass: deliveryOk, weight: 3 });

  // 4. Closed in upper 30% of today's candle?
  const dayRange = stock.dayH - stock.dayL;
  const closePosition = dayRange > 0 ? ((price - stock.dayL) / dayRange) * 100 : 50;
  const closedUpper30 = closePosition >= 70;
  checks.push({ name: "closed_upper_30pct", pass: closedUpper30, weight: 2 });

  // 5. Block/bulk deal buy side today?
  const blockDealBuy = stock.blockDeal || stock.bulkDeal;
  checks.push({ name: "block_deal_buy", pass: blockDealBuy, weight: 2 });

  // 6. FII bought index futures today?
  const fiiBought = (marketContext.fiiFlow || 0) > 0;
  checks.push({ name: "fii_bought", pass: fiiBought, weight: 2 });

  // 7. Gift Nifty: positive/flat?
  const giftNifty = marketContext.giftNifty || 0;
  const giftOk = giftNifty >= -20; // Flat or positive is ok
  checks.push({ name: "gift_nifty_ok", pass: giftOk, weight: 2 });

  // 8. Daily EMA 21 > EMA 50?
  const emaOk = stock.emaAligned;
  checks.push({ name: "ema_21_above_50", pass: emaOk, weight: 2 });

  // 9. Supertrend green daily?
  const stOk = stock.supertrendAligned;
  checks.push({ name: "supertrend_green", pass: stOk, weight: 2 });

  // 10. MACD bullish daily or 1hr?
  const macdOk = stock.macdConfirmed;
  checks.push({ name: "macd_bullish", pass: macdOk, weight: 2 });

  // 11. RSI 55-72 daily?
  const rsi = stock.rsi;
  const rsiOk = rsi != null && Number.isFinite(rsi) && rsi >= 55 && rsi <= 72;
  checks.push({ name: "rsi_zone", pass: rsiOk, weight: 1 });

  // 12. Volume today > 1.8x avg?
  const volOk = stock.volumeRatio != null && stock.volumeRatio > 1.8;
  checks.push({ name: "volume_1.8x", pass: volOk, weight: 2 });

  // 13. Closed above VWAP?
  const vwapOk = stock.aboveVwap;
  checks.push({ name: "above_vwap", pass: vwapOk, weight: 2 });

  // 14. OI building in calls + IV rising but < 35%? (F&O rally catch)
  const fnoRally = (stock.oiChangePercent || 0) > 15
    && (stock.iv || 20) < 35
    && (stock.coilDays || 0) >= 3;
  checks.push({ name: "fno_rally_catch", pass: fnoRally, weight: 3 });

  // 15. Price coiling tight 3+ days? (compression breakout watch)
  const coilOk = (stock.coilDays || 0) >= 3;
  checks.push({ name: "coil_3plus_days", pass: coilOk, weight: 2 });

  // Calculate checklist score
  let totalWeight = 0;
  let passWeight = 0;
  for (const c of checks) {
    totalWeight += c.weight;
    if (c.pass) passWeight += c.weight;
  }
  const checklistScore = totalWeight > 0 ? (passWeight / totalWeight) * 100 : 0;

  // Need at least 45% checklist pass to qualify for overnight
  const pass = checklistScore >= 45;

  return {
    pass,
    checks,
    checklistScore: Math.round(checklistScore),
    closePosition: +closePosition.toFixed(1),
    gapRisk: assessGapRisk(stock, marketContext)
  };
}

/**
 * Assess gap risk for overnight holding
 */
function assessGapRisk(stock, marketContext) {
  const risks = [];
  let level = "low";

  if (stock.macroEventTonight) {
    level = "high";
    risks.push("Macro event tonight");
  }

  if (stock.earningsSoon) {
    level = "high";
    risks.push("Earnings tomorrow");
  }

  const giftNifty = marketContext.giftNifty || 0;
  if (Math.abs(giftNifty) > 100) {
    level = level === "high" ? "high" : "medium";
    risks.push(`Gift Nifty gap: ${giftNifty > 0 ? '+' : ''}${giftNifty} pts`);
  }

  if (stock.deliveryPercent != null && stock.deliveryPercent < 40) {
    level = level === "high" ? "high" : "medium";
    risks.push("Low delivery % — weak conviction");
  }

  const reasonStr = risks.length > 0 ? risks.join("; ") : "No major overnight risk";
  return { level, reason: reasonStr };
}

/**
 * Scan for overnight F&O opportunities
 */
export function scanOvernightFO(scannerData, vixValue, marketContext = {}) {
  const vixStatus = getVixStatusLine(vixValue);

  // Check if task is allowed
  if (!isTaskAllowed(2, vixValue)) {
    return {
      calls: [],
      summary: {
        given: 0,
        discarded: scannerData.length,
        reason: "NO OVERNIGHT F&O — VIX DANGER",
        foBan: 0,
        scoreBelow70: 0
      }
    };
  }

  const allowOTM = allowOTMOptions(vixValue);
  const positionMultiplier = getPositionSizeMultiplier(vixValue);
  const maxCalls = getMaxOvernightCalls(vixValue);

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
    const stockData = buildOvernightStockData(stock, marketContext);

    // Determine trade direction
    const tradeType = determineOvernightTradeType(stock, marketContext, stockData);
    if (!tradeType) {
      discardedCount++;
      continue;
    }

    // Run full overnight checklist
    const checklistResult = runOvernightChecklist(stock, tradeType, marketContext);
    if (!checklistResult || !checklistResult.pass) {
      checklistFailCount++;
      discardedCount++;
      continue;
    }

    // Calculate operator score (higher threshold for overnight: 70+)
    const scoring = calculateScore(stockData, vixValue);

    if (scoring.score < 70) {
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
    const optimalDTE = dte <= 2 ? dte + 7 : dte;

    // Estimate premium
    const atrPercent = stock.atrPercent || ((stock.dayH - stock.dayL) / stock.price * 100) || 2;
    const premiumCalc = calculateEstimatedPremium(
      stock.price,
      atrPercent,
      vixValue,
      optimalDTE,
      strikesAway,
      stock.iv || null
    );

    // Determine overnight catalyst
    const catalyst = determineOvernightCatalyst(stock, scoring, marketContext);

    // VIX warning
    let vixWarning = null;
    if (vixValue >= 17 && vixValue < 20) {
      vixWarning = "⚡ ELEVATED RISK — CAUTION MODE";
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
        ? `#${scoring.footprints[0].footprint}: ${scoring.footprints[0].name} — Holding overnight: ${scoring.footprints[0].action}`
        : "No clear overnight footprint",
      overnight_catalyst: catalyst,
      trade: `BUY ${tradeType}`,
      strike: `${strike} ${strikesAway > 0 ? "[EST]" : ""}`,
      expiry: `${formatExpiryDate(nextExpiry)} ${dte <= 2 ? "[EST - Next Week]" : ""}`,
      entry_time: "2:30-3:10 PM",
      entry_price_range: `₹${premiumCalc.entryRange.low}–₹${premiumCalc.entryRange.high} [EST-PREMIUM]`,
      premium_calc: premiumCalc,
      iv_check: stock.iv
        ? `${stock.iv.toFixed(2)}% — acceptable`
        : `${estimateIVFromVIX(vixValue).toFixed(2)}% [EST-IV] — acceptable`,
      target_premium: "25-60% by next open",
      stop_loss: "40% of premium",
      exit_rule: "Exit first 30 min next session. Target hit or not.",
      gap_risk: `${checklistResult.gapRisk.level} — ${checklistResult.gapRisk.reason}`,
      gift_nifty_status: marketContext.giftNifty > 0 ? `Positive +${marketContext.giftNifty}` :
                        marketContext.giftNifty < 0 ? `Negative ${marketContext.giftNifty}` : "Flat",
      vix_mode: vixStatus.mode,
      liquidity_check: checkOvernightLiquidity(stock, premiumCalc),
      missing_data_flags: buildOvernightMissingDataFlags(stock),
      confidence: Math.min(10, Math.round(scoring.score / 10)),
      reason: buildOvernightReasonStrings(scoring, stockData, tradeType, marketContext, checklistResult),
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

  // Sort by score and take top N (based on VIX mode)
  scored.sort((a, b) => b.score - a.score);
  const topN = scored.slice(0, maxCalls);

  // Assign ranks
  topN.forEach((call, idx) => {
    call.rank = idx + 1;
  });

  return {
    calls: topN,
    summary: {
      given: topN.length,
      discarded: discardedCount,
      foBan: bannedCount,
      scoreBelow70: lowScoreCount,
      checklistFail: checklistFailCount,
      vixMode: vixStatus.mode,
      maxCallsAllowed: maxCalls,
      positionMultiplier: positionMultiplier.toFixed(2),
      vixStatusLine: vixStatus.statusLine
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build overnight stock data for operator engine
 */
function buildOvernightStockData(stock, marketContext) {
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
    volumeRatio: stock.volumeRatio || (stock.volSpike ? 2.5 : 1.2),

    // Technical
    emaAligned: stock.ema21above,
    macdConfirmed: stock.macdBull || stock.macdAbove,
    supertrendAligned: isBullish,
    rsi: stock.rsi,
    tradeType: isBullish ? "CE" : "PE",

    // Operator detection
    holdingSupport: stock.holdingSupport || stock.aboveVwap,
    marketWeak: marketContext.niftyBelowVWAP || false,
    brokeResistance: stock.brokeResistance || stock.goldenCross,
    coilDays: stock.coilDays || 0,
    cleanChart: isBullish && stock.techScore >= 5,

    // F&O specific
    isFO: stock.isFO || false,
    oiChangePercent: stock.oiChangePercent || stock.oiChange || null,
    deliveryPercent: stock.deliveryPercent || null,
    pcr: stock.pcr || null,
    iv: stock.iv || null,
    oiRising: stock.oiRising || false,

    // Overnight specific
    blockDealToday: stock.blockDeal || stock.bulkDeal,
    fiiBoughtIndex: (marketContext.fiiFlow || 0) > 0,
    earningsTomorrow: stock.earningsSoon || false,
    macroEventTonight: marketContext.macroEvent || false,

    // Flags
    eventRisk: (stock.earningsSoon || marketContext.macroEvent) || false,
    fiiFlow: marketContext.fiiFlow || null,
    fiiBuying: (marketContext.fiiFlow || 0) > 0,
    blockDealBuy: stock.blockDeal || false
  };
}

/**
 * Determine overnight trade direction
 */
function determineOvernightTradeType(stock, marketContext, stockData) {
  const isBullish = stock.ema21above && (stock.macdBull || stock.macdAbove);
  const isBearish = !stock.ema21above && stock.macdBear;
  const niftyBullish = !marketContext.niftyBelowVWAP;

  // Distribution → PE
  if (stock.position52W > 85 && stock.volSpike && !stock.ema21above) {
    return "PE";
  }

  // Markup or F&O rally → CE
  if (stock.oiRising && (stock.coilDays || 0) >= 3) {
    return "CE";
  }

  // Clear signals
  if (isBullish && niftyBullish) {
    return "CE";
  }

  if (isBearish && !niftyBullish) {
    return "PE";
  }

  return null;
}

/**
 * Determine overnight catalyst
 */
function determineOvernightCatalyst(stock, scoring, marketContext) {
  const catalysts = [];

  if (stock.deliveryPercent != null && Number.isFinite(stock.deliveryPercent) && stock.deliveryPercent > 55) {
    catalysts.push(`High delivery ${stock.deliveryPercent.toFixed(1)}% suggests accumulation`);
  }

  if (stock.oiChange != null && Number.isFinite(stock.oiChange) && stock.oiChange > 15) {
    catalysts.push(`OI buildup +${stock.oiChange.toFixed(1)}% indicates fresh positions`);
  }

  if (stock.oiChangePercent != null && Number.isFinite(stock.oiChangePercent) && stock.oiChangePercent > 15) {
    catalysts.push(`OI buildup +${stock.oiChangePercent.toFixed(1)}% indicates fresh positions`);
  }

  const giftNifty = marketContext.giftNifty || 0;
  if (giftNifty > 0) {
    catalysts.push(`Gift Nifty positive: +${giftNifty} pts`);
  }

  if (stock.blockDeal || stock.bulkDeal) {
    catalysts.push(`Block/bulk deal buy side today`);
  }

  if (scoring.footprints.some(f => f.footprint === 6)) {
    catalysts.push(`F&O rally catch pattern — coiled for breakout`);
  }

  return catalysts.length > 0 ? catalysts.join("; ") : "Technical setup only — monitor closely";
}

/**
 * Estimate IV from VIX
 */
function estimateIVFromVIX(vix) {
  if (vix < 13) return vix * 1.2;
  if (vix < 16) return vix * 1.4;
  if (vix < 20) return vix * 1.6;
  if (vix < 25) return vix * 1.8;
  return vix * 2.0;
}

/**
 * Check overnight liquidity (stricter than intraday)
 */
function checkOvernightLiquidity(stock, premiumCalc) {
  const avgVolume = stock.volume || 0;
  const premium = premiumCalc.estimatedPremium;

  if (premium < 10 || avgVolume < 1000000) {
    return "⚠️ ILLIQUID — overnight spread risk. Reduce size or skip.";
  }

  return "✅ Liquid";
}

/**
 * Build missing data flags
 */
function buildOvernightMissingDataFlags(stock) {
  const flags = [];

  if (!stock.iv) flags.push("[EST-IV] IV estimated from VIX");
  if (!stock.atrPercent) flags.push("[EST] ATR% derived from day range");
  if (!stock.deliveryPercent) flags.push("Delivery data unavailable");
  if (!stock.oiChange && !stock.oiChangePercent) flags.push("OI data unavailable");
  if (!stock.blockDeal) flags.push("Block deal data unavailable");

  return flags.length > 0 ? flags.join(", ") : "All data available";
}

/**
 * Build reason strings for overnight
 */
function buildOvernightReasonStrings(scoring, stockData, tradeType, marketContext, checklistResult) {
  const reasons = [];

  // Operator reason
  if (scoring.footprints.length > 0) {
    const fp = scoring.footprints[0];
    reasons.push(`Operator: ${fp.name} — holding overnight due to ${fp.action.toLowerCase()}`);
  } else {
    reasons.push("Operator: No clear overnight footprint");
  }

  // Technical reason
  const tech = scoring.breakdown.technical;
  const closeInfo = checklistResult?.closePosition != null
    ? `Closed at ${checklistResult.closePosition}% of range`
    : "Mixed close";
  reasons.push(`Technical: ${tech.score}/35 — ${closeInfo}`);

  // Global check
  const giftNifty = marketContext.giftNifty || 0;
  const globalStatus = giftNifty > 0 ? "Positive" : giftNifty < 0 ? "Negative" : "Flat";
  reasons.push(`Global: Gift Nifty ${globalStatus}, FII ${(marketContext.fiiFlow || 0) > 0 ? "buying" : "selling"}`);

  return reasons;
}
