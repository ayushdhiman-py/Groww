// ─────────────────────────────────────────────────────────────────────────────
// overnight_scanner.mjs — Task 2: Top 10 Overnight F&O Calls
// Target: 25-60% premium by next day open
// Entry: 2:30-3:10 PM only
// Exit: First 30 minutes of next session. Hard. No exceptions.
// ─────────────────────────────────────────────────────────────────────────────

import { calculateScore } from "./operator_engine.mjs";
import { 
  calculateEstimatedPremium, 
  calculateATMStrike, 
  formatExpiryDate,
  getNextThursday,
  calculateDTE
} from "./premium_calc.mjs";
import { 
  getVixMode, 
  isTaskAllowed, 
  getPositionSizeMultiplier,
  allowOTMOptions,
  getVixRiskFlag,
  getMaxOvernightCalls
} from "./vix_manager.mjs";

/**
 * Scan for overnight F&O opportunities
 */
export function scanOvernightFO(scannerData, vixValue, marketContext = {}) {
  // Check if task is allowed
  if (!isTaskAllowed(2, vixValue)) {
    return {
      calls: [],
      summary: { 
        given: 0, 
        discarded: scannerData.length,
        reason: "NO OVERNIGHT F&O — VIX DANGER"
      }
    };
  }
  
  const vixMode = getVixMode(vixValue);
  const allowOTM = allowOTMOptions(vixValue);
  const positionMultiplier = getPositionSizeMultiplier(vixValue);
  const maxCalls = getMaxOvernightCalls(vixValue);
  
  const scored = [];
  let discardedCount = 0;
  let bannedCount = 0;
  let lowScoreCount = 0;
  
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
    
    // Calculate score (higher threshold for overnight: 70+)
    const scoring = calculateScore(stockData, vixValue);
    
    // Overnight requires higher conviction
    if (scoring.score < 70) {
      lowScoreCount++;
      discardedCount++;
      continue;
    }
    
    // Determine trade direction
    const tradeType = determineOvernightTradeType(stock, marketContext, scoring);
    
    if (!tradeType) {
      discardedCount++;
      continue;
    }
    
    // Calculate option details
    const atmStrike = calculateATMStrike(stock.price, stock.symbol);
    const strikesAway = allowOTM ? 1 : 0;
    const strike = tradeType === "CE" 
      ? atmStrike + (strikesAway * getStrikeInterval(atmStrike))
      : atmStrike - (strikesAway * getStrikeInterval(atmStrike));
    
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
    
    // Assess gap risk
    const gapRisk = assessGapRisk(stock, marketContext);
    
    // Build call object
    const call = {
      rank: 0,
      score: scoring.score,
      score_band: `${scoring.band.emoji} ${scoring.band.label}`,
      stock: stock.symbol,
      operator_footprint: scoring.footprints.length > 0 
        ? `#${scoring.footprints[0].footprint}: ${scoring.footprints[0].name} — Why holding overnight: ${scoring.footprints[0].action}`
        : "No clear overnight footprint",
      overnight_catalyst: catalyst,
      trade: `BUY ${tradeType}`,
      strike: `${strike} ${strikesAway > 0 ? "[EST]" : ""}`,
      expiry: `${formatExpiryDate(nextExpiry)} ${dte <= 2 ? "[EST - Next Week]" : ""}`,
      entry_time: "2:30-3:10 PM",
      entry_price_range: `₹${premiumCalc.entryRange.low}–₹${premiumCalc.entryRange.high} [EST-PREMIUM]`,
      premium_calc: premiumCalc,
      iv_check: stock.iv ? `${stock.iv.toFixed(2)}%` : `${estimateIVFromVIX(vixValue).toFixed(2)}% [EST-IV]`,
      target_premium: "25-60% by next open",
      stop_loss: "40% of premium",
      exit_rule: "Exit first 30 min next session. Target hit or not.",
      gap_risk: gapRisk,
      gift_nifty_status: marketContext.giftNifty || "Flat",
      vix_mode: vixMode.name,
      liquidity_check: checkOvernightLiquidity(stock, premiumCalc),
      missing_data_flags: buildOvernightMissingDataFlags(stock, stock.iv, atrPercent),
      confidence: Math.round(scoring.score / 10),
      reason: buildOvernightReasonStrings(scoring, stockData, tradeType, marketContext),
      position_size_adjustment: positionMultiplier < 1 ? `Reduce by ${((1 - positionMultiplier) * 100).toFixed(0)}% (VIX adjustment)` : "Normal size",
      vix_warning: vixValue > 17 ? getVixRiskFlag(vixValue) : null
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
      vixMode: vixMode.name,
      maxCallsAllowed: maxCalls,
      positionMultiplier: positionMultiplier.toFixed(2)
    }
  };
}

/**
 * Build overnight stock data for operator engine
 */
function buildOvernightStockData(stock, marketContext) {
  const isBullish = stock.goldenCross || (stock.ema21above && stock.macdBull);
  
  return {
    // Price action
    price: stock.price,
    dayH: stock.dayH,
    dayL: stock.dayL,
    weekH: stock.weekH,
    weekL: stock.weekL,
    position52W: stock.w52H ? ((stock.price - stock.w52L) / (stock.w52H - stock.w52L)) * 100 : null,
    closedUpper30Percent: calculateClosePosition(stock),
    
    // Volume
    volume: stock.volume,
    avgVolume: stock.volume / (stock.volSpike ? 2.0 : 1),
    volumeRatio: stock.volSpike ? 2.5 : 1.2,
    
    // Technical
    emaAligned: stock.ema21above,
    macdConfirmed: stock.macdBull || stock.macdAbove,
    supertrendAligned: isBullish,
    rsi: stock.rsi,
    tradeType: isBullish ? "CE" : "PE",
    
    // Operator detection
    holdingSupport: stock.aboveVwap,
    marketWeak: marketContext.niftyBelowVWAP || false,
    brokeResistance: stock.goldenCross,
    coilDays: stock.consolidationDays || 0,
    cleanChart: isBullish && stock.techScore >= 5,
    
    // F&O specific
    isFO: stock.isFO || false,
    oiChangePercent: stock.oiChange || null,
    deliveryPercent: stock.deliveryPercent || null,
    pcr: stock.pcr || null,
    iv: stock.iv || null,
    oiBuildingCalls: (stock.oiChange || 0) > 15,
    ivRising: stock.ivRising || false,
    
    // Overnight specific
    blockDealToday: stock.blockDeal || false,
    fiiBoughtIndex: (marketContext.fiiFlow || 0) > 0,
    earningsTomorrow: stock.earningsSoon || false,
    macroEventTonight: marketContext.macroEvent || false,
    
    // Flags
    eventRisk: (stock.earningsSoon || marketContext.macroEvent) || false,
    fiiFlow: marketContext.fiiFlow || null,
    fiiBuying: (marketContext.fiiFlow || 0) > 0
  };
}

/**
 * Calculate where stock closed in today's range
 */
function calculateClosePosition(stock) {
  const range = stock.dayH - stock.dayL;
  if (range === 0) return 50;
  const position = ((stock.price - stock.dayL) / range) * 100;
  return position;
}

/**
 * Determine overnight trade direction
 */
function determineOvernightTradeType(stock, marketContext, scoring) {
  const isBullish = stock.goldenCross || (stock.ema21above && stock.macdBull);
  const isBearish = !stock.ema21above && stock.macdBear;
  const niftyBullish = !marketContext.niftyBelowVWAP;
  
  // Check for distribution pattern
  const hasDistribution = scoring.footprints.some(f => f.footprint === 5);
  const hasMarkup = scoring.footprints.some(f => f.footprint === 3);
  const hasFORally = scoring.footprints.some(f => f.footprint === 6);
  
  if (hasDistribution && isBearish) {
    return "PE";
  }
  
  if (hasMarkup || hasFORally) {
    return "CE";
  }
  
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
  
  if (stock.deliveryPercent > 55) {
    catalysts.push(`High delivery ${stock.deliveryPercent.toFixed(1)}% suggests accumulation`);
  }
  
  if (stock.oiChange > 15) {
    catalysts.push(`OI buildup +${stock.oiChange.toFixed(1)}% indicates fresh positions`);
  }
  
  if (marketContext.giftNifty && marketContext.giftNifty > 0) {
    catalysts.push(`Gift Nifty positive: +${marketContext.giftNifty} pts`);
  }
  
  if (stock.blockDeal) {
    catalysts.push(`Block deal buy side today`);
  }
  
  if (scoring.footprints.some(f => f.footprint === 6)) {
    catalysts.push(`F&O rally catch pattern — coiled for breakout`);
  }
  
  return catalysts.length > 0 ? catalysts.join("; ") : "Technical setup only — monitor closely";
}

/**
 * Assess gap risk
 */
function assessGapRisk(stock, marketContext) {
  let risk = "low";
  let reasons = [];
  
  if (marketContext.macroEvent) {
    risk = "high";
    reasons.push("Macro event tonight");
  }
  
  if (stock.earningsSoon) {
    risk = "high";
    reasons.push("Earnings tomorrow");
  }
  
  if (marketContext.giftNifty && Math.abs(marketContext.giftNifty) > 100) {
    risk = "medium";
    reasons.push(`Gift Nifty gap: ${marketContext.giftNifty > 0 ? "+" : ""}${marketContext.giftNifty}`);
  }
  
  if (stock.deliveryPercent < 40) {
    risk = "medium";
    reasons.push("Low delivery % — weak conviction");
  }
  
  const reasonStr = reasons.length > 0 ? reasons.join(", ") : "No major overnight risk";
  return `${risk} — ${reasonStr}`;
}

/**
 * Get strike interval
 */
function getStrikeInterval(cmp) {
  if (cmp < 100) return 5;
  if (cmp < 500) return 10;
  if (cmp < 2000) return 20;
  return 50;
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
function buildOvernightMissingDataFlags(stock, iv, atrPercent) {
  const flags = [];
  
  if (!iv) flags.push("[EST-IV] IV estimated from VIX");
  if (!stock.atrPercent) flags.push("[EST] ATR% derived from day range");
  if (!stock.deliveryPercent) flags.push("Delivery data unavailable");
  if (!stock.oiChange) flags.push("OI data unavailable");
  if (!stock.blockDeal) flags.push("Block deal data unavailable");
  
  return flags.length > 0 ? flags.join(", ") : "All data available";
}

/**
 * Build reason strings for overnight
 */
function buildOvernightReasonStrings(scoring, stockData, tradeType, marketContext) {
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
  reasons.push(`Technical: ${tech.score}/35 — ${stockData.closedUpper30Percent > 70 ? "Closed strong in upper range" : "Mixed close"}`);
  
  // Global check
  const globalStatus = marketContext.giftNifty > 0 ? "Positive" : marketContext.giftNifty < 0 ? "Negative" : "Flat";
  reasons.push(`Global: Gift Nifty ${globalStatus}, FII ${marketContext.fiiFlow > 0 ? "buying" : "selling"}`);
  
  return reasons;
}
