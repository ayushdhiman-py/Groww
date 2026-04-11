// ─────────────────────────────────────────────────────────────────────────────
// intraday_scanner.mjs — Task 1: Top 10 Intraday F&O Calls
// Target: 20-50% premium gain same day
// Entry: 9:30-10:15 AM or 2:00-2:45 PM only
// Exit: Hard exit 3:00 PM
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
  getVixRiskFlag
} from "./vix_manager.mjs";

/**
 * Scan for intraday F&O opportunities
 * @param {Array} scannerData - Data from main scanner (all timeframes)
 * @param {number} vixValue - Current VIX value
 * @param {Object} marketContext - Nifty bias, VWAP, etc.
 * @returns {Array} Top 10 intraday calls ranked by score
 */
export function scanIntradayFO(scannerData, vixValue, marketContext = {}) {
  // Check if task is allowed
  if (!isTaskAllowed(1, vixValue)) {
    return {
      calls: [],
      discarded: scannerData.length,
      reason: `Task 1 disabled for VIX ${vixValue.toFixed(2)} (DEFENSIVE/DANGER mode)`,
      summary: { given: 0, discarded: scannerData.length }
    };
  }
  
  const vixMode = getVixMode(vixValue);
  const allowOTM = allowOTMOptions(vixValue);
  const positionMultiplier = getPositionSizeMultiplier(vixValue);
  
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
    const stockData = buildIntradayStockData(stock, marketContext);
    
    // Calculate score
    const scoring = calculateScore(stockData, vixValue);
    
    if (!scoring.qualifies) {
      lowScoreCount++;
      discardedCount++;
      continue;
    }
    
    // Determine trade direction (CE or PE)
    const tradeType = determineTradeType(stock, marketContext, scoring);
    
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
    
    // Build call object
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
      iv_check: stock.iv ? `${stock.iv.toFixed(2)}%` : `${estimateIVFromVIX(vixValue).toFixed(2)}% [EST-IV]`,
      entry_window: getOptimalEntryWindow(stock),
      target_premium: "20-50% gain",
      stop_loss: "30% of premium paid",
      exit_rule: "Hard exit 3:00 PM regardless of P&L",
      avoid_if: marketContext.niftyBelowVWAP ? "⚠️ Nifty below VWAP - HIGH RISK for CE" : "Nifty above VWAP",
      liquidity_check: checkLiquidity(stock, premiumCalc),
      missing_data_flags: buildMissingDataFlags(stock, stock.iv, atrPercent),
      confidence: Math.round(scoring.score / 10),
      reason: buildReasonStrings(scoring, stockData, tradeType),
      position_size_adjustment: positionMultiplier < 1 ? `Reduce by ${((1 - positionMultiplier) * 100).toFixed(0)}% (VIX adjustment)` : "Normal size",
      vix_warning: vixValue > 17 ? getVixRiskFlag(vixValue) : null
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
      vixMode: vixMode.name,
      positionMultiplier: positionMultiplier.toFixed(2)
    }
  };
}

/**
 * Build intraday stock data for operator engine
 */
function buildIntradayStockData(stock, marketContext) {
  const isCE = stock.signal === "BUY" || stock.goldenCross;
  
  return {
    // Price action
    price: stock.price,
    dayH: stock.dayH,
    dayL: stock.dayL,
    weekH: stock.weekH,
    weekL: stock.weekL,
    position52W: stock.w52H ? ((stock.price - stock.w52L) / (stock.w52H - stock.w52L)) * 100 : null,
    
    // Volume
    volume: stock.volume,
    avgVolume: stock.volume / (stock.volSpike ? 1.5 : 1),
    volumeRatio: stock.volSpike ? 2.0 : 1.0,
    
    // Technical
    emaAligned: stock.ema21above,
    macdConfirmed: stock.macdBull || stock.macdAbove,
    supertrendAligned: isCE,
    rsi: stock.rsi,
    tradeType: isCE ? "CE" : "PE",
    
    // Operator detection (simplified for now)
    dippedBelowSupport: false,
    snappedBack: false,
    brokeResistance: stock.goldenCross,
    holdingSupport: stock.aboveVwap,
    marketWeak: marketContext.niftyBelowVWAP || false,
    cleanChart: isCE && stock.techScore >= 4,
    
    // F&O specific
    isFO: stock.isFO || false,
    oiChangePercent: stock.oiChange || null,
    deliveryPercent: stock.deliveryPercent || null,
    pcr: stock.pcr || null,
    iv: stock.iv || null,
    
    // Flags
    eventRisk: false,
    fiiFlow: marketContext.fiiFlow || null,
    fiiBuying: (marketContext.fiiFlow || 0) > 0
  };
}

/**
 * Determine trade direction (CE or PE)
 */
function determineTradeType(stock, marketContext, scoring) {
  const isBullish = stock.goldenCross || (stock.ema21above && stock.macdBull);
  const isBearish = !stock.ema21above && stock.macdBear;
  const niftyBullish = !marketContext.niftyBelowVWAP;
  
  // Check for distribution pattern (Footprint 5)
  const hasDistribution = scoring.footprints.some(f => f.footprint === 5);
  const hasStopHunt = scoring.footprints.some(f => f.footprint === 2);
  
  if (hasDistribution && isBearish) {
    return "PE";
  }
  
  if (hasStopHunt) {
    return "CE"; // Stop hunt recovery is always bullish
  }
  
  if (isBullish && (niftyBullish || hasStopHunt)) {
    return "CE";
  }
  
  if (isBearish && !niftyBullish) {
    return "PE";
  }
  
  // Default: only trade if clear signal
  return null;
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
 * Get optimal entry window
 */
function getOptimalEntryWindow(stock) {
  // Avoid 12:00-1:30 PM (lunch chop zone)
  const hour = new Date().getHours();
  
  if (hour >= 9 && hour < 10) {
    return "9:30-10:15 AM (Morning session)";
  }
  if (hour >= 14 && hour < 15) {
    return "2:00-2:45 PM (Afternoon session)";
  }
  
  return "9:30-10:15 AM or 2:00-2:45 PM";
}

/**
 * Check liquidity
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
 * Build missing data flags
 */
function buildMissingDataFlags(stock, iv, atrPercent) {
  const flags = [];
  
  if (!iv) flags.push("[EST-IV] IV estimated from VIX");
  if (!stock.atrPercent) flags.push("[EST] ATR% derived from day range");
  if (!stock.deliveryPercent) flags.push("Delivery data unavailable");
  if (!stock.oiChange) flags.push("OI data unavailable");
  
  return flags.length > 0 ? flags.join(", ") : "All data available";
}

/**
 * Build reason strings
 */
function buildReasonStrings(scoring, stockData, tradeType) {
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
  reasons.push(`Technical: ${tech.score}/35 — ${tech.details.slice(0, 2).join(", ")}`);
  
  // Risk reason
  const risk = scoring.breakdown.risk;
  reasons.push(`Risk: ${risk.score}/25 — ${tradeType === "CE" ? "Bullish setup" : "Bearish setup"}`);
  
  return reasons;
}
