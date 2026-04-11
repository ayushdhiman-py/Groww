// ─────────────────────────────────────────────────────────────────────────────
// premium_calc.mjs — Option Premium Estimation (4-Step Formula)
// Uses Black-Scholes with adjustments for real-world trading
// Always tags output as [EST-PREMIUM]
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate ATR% from ATR value or derive from day range
 */
export function calculateATRPercent(atrValue, cmp) {
  if (atrValue && atrValue > 0) {
    return (atrValue / cmp) * 100;
  }
  return null; // Will need fallback
}

/**
 * Estimate stock IV from VIX when IV data is missing
 */
export function estimateStockIVFromVIX(vixValue) {
  if (vixValue < 13) return vixValue * 1.2;
  if (vixValue < 16) return vixValue * 1.4;
  if (vixValue < 20) return vixValue * 1.6;
  if (vixValue < 25) return vixValue * 1.8;
  return vixValue * 2.0;
}

/**
 * Get IV multiplier
 */
export function getIVMultiplier(ivValue) {
  return ivValue / 20;
}

/**
 * Get time multiplier based on days to expiry
 */
export function getTimeMultiplier(dte) {
  if (dte <= 2) return 0.6;
  if (dte <= 5) return 1.0;
  if (dte <= 10) return 1.4;
  return 1.8;
}

/**
 * Get moneyness multiplier
 */
export function getMoneynessMultiplier(strikesAway) {
  if (strikesAway === 0) return 1.0; // ATM
  if (strikesAway === 1) return 0.5; // OTM 1
  if (strikesAway === 2) return 0.25; // OTM 2
  if (strikesAway === -1) return 1.8; // ITM 1
  return 0.5; // Default to OTM 1
}

/**
 * Determine strike interval based on CMP
 */
export function getStrikeInterval(cmp) {
  if (cmp < 100) return 5;
  if (cmp < 500) return 10;
  if (cmp < 2000) return 20;
  return 50;
}

/**
 * Calculate ATM strike
 */
export function calculateATMStrike(cmp, symbol) {
  // Special indices
  const sym = symbol.toUpperCase();
  if (sym === "NIFTY" || sym === "FINNIFTY") return Math.round(cmp / 50) * 50;
  if (sym === "BANKNIFTY") return Math.round(cmp / 100) * 100;
  if (sym === "MIDCPNIFTY") return Math.round(cmp / 25) * 25;
  if (sym === "SENSEX") return Math.round(cmp / 100) * 100;
  
  // Stocks
  const interval = getStrikeInterval(cmp);
  return Math.round(cmp / interval) * interval;
}

/**
 * Calculate estimated option premium using 4-step formula
 * 
 * @param {number} cmp - Current Market Price
 * @param {number} atrPercent - ATR as percentage of CMP
 * @param {number} vixValue - India VIX value
 * @param {number} dte - Days to expiry
 * @param {number} strikesAway - How many strikes OTM/ITM (0=ATM, 1=OTM1, -1=ITM1)
 * @param {number} [ivValue=null] - Optional IV if available
 * @returns {Object} Premium calculation result
 */
export function calculateEstimatedPremium(
  cmp,
  atrPercent,
  vixValue,
  dte,
  strikesAway = 0,
  ivValue = null
) {
  const steps = [];
  
  // ── STEP 1: CALCULATE BASE PREMIUM ─────────────────────────────────────
  // Base Premium = CMP × ATR% × 0.035
  const atrDecimal = atrPercent / 100;
  const basePremium = cmp * atrDecimal * 0.035;
  
  steps.push({
    step: 1,
    name: "BASE PREMIUM",
    formula: `CMP × ATR% × 0.035`,
    calculation: `${cmp} × ${atrDecimal.toFixed(4)} × 0.035`,
    result: basePremium
  });
  
  // ── STEP 2: APPLY IV MULTIPLIER ────────────────────────────────────────
  let stockIV;
  if (ivValue && ivValue > 0) {
    stockIV = ivValue;
  } else {
    stockIV = estimateStockIVFromVIX(vixValue);
  }
  const ivMultiplier = getIVMultiplier(stockIV);
  
  steps.push({
    step: 2,
    name: "IV MULTIPLIER",
    formula: ivValue ? `IV / 20` : `Estimated Stock IV from VIX = VIX × multiplier`,
    calculation: ivValue ? `${ivValue} / 20 = ${ivMultiplier.toFixed(3)}` : 
      `VIX ${vixValue} → Stock IV ${stockIV.toFixed(2)}% → ${stockIV.toFixed(2)} / 20 = ${ivMultiplier.toFixed(3)}`,
    result: ivMultiplier
  });
  
  // ── STEP 3: APPLY TIME MULTIPLIER ──────────────────────────────────────
  const timeMultiplier = getTimeMultiplier(dte);
  let dteRange = "DTE > 10";
  if (dte <= 2) dteRange = "DTE 0-2";
  else if (dte <= 5) dteRange = "DTE 3-5";
  else if (dte <= 10) dteRange = "DTE 6-10";
  
  steps.push({
    step: 3,
    name: "TIME MULTIPLIER",
    formula: `Days to expiry determines time value`,
    calculation: `${dteRange} (${dte} days) → ${timeMultiplier}`,
    result: timeMultiplier
  });
  
  // ── STEP 4: APPLY MONEYNESS MULTIPLIER ─────────────────────────────────
  const moneynessMultiplier = getMoneynessMultiplier(strikesAway);
  let moneynessLabel = "ATM";
  if (strikesAway === 1) moneynessLabel = "OTM 1 strike";
  else if (strikesAway === 2) moneynessLabel = "OTM 2 strikes";
  else if (strikesAway === -1) moneynessLabel = "ITM 1 strike";
  
  steps.push({
    step: 4,
    name: "MONEYNESS MULTIPLIER",
    formula: `ATM=1.0, OTM1=0.5, OTM2=0.25, ITM1=1.8`,
    calculation: `${moneynessLabel} → ${moneynessMultiplier}`,
    result: moneynessMultiplier
  });
  
  // ── FINAL CALCULATION ──────────────────────────────────────────────────
  let estimatedPremium = basePremium * ivMultiplier * timeMultiplier * moneynessMultiplier;
  
  // ── REALITY CHECK — MINIMUM VIABLE PREMIUM ─────────────────────────────
  let floorApplied = false;
  if (estimatedPremium < 5) {
    estimatedPremium = Math.max(estimatedPremium, 5);
    floorApplied = true;
  } else if (estimatedPremium < 10 && cmp > 500) {
    estimatedPremium = Math.max(estimatedPremium, 10);
    floorApplied = true;
  }
  
  // Entry range: ±15%
  const entryLow = estimatedPremium * 0.85;
  const entryHigh = estimatedPremium * 1.15;
  
  // Sanity checks
  const sanityChecks = {
    premiumVsCMP: (estimatedPremium / cmp) * 100,
    isIlliquidRisk: estimatedPremium < 5 || (estimatedPremium / cmp) * 100 < 0.5,
    stopLossViable: estimatedPremium * 0.30 > 5,
    coversBrokerage: estimatedPremium > 10
  };
  
  return {
    estimatedPremium: +estimatedPremium.toFixed(2),
    entryRange: {
      low: +entryLow.toFixed(2),
      high: +entryHigh.toFixed(2)
    },
    steps,
    sanityChecks,
    floorApplied,
    tag: "[EST-PREMIUM]",
    note: floorApplied ? "Minimum viable premium floor applied (liquidity constraint)" : null
  };
}

/**
 * Format premium calculation for display
 */
export function formatPremiumCalculation(calc) {
  let output = "Premium Calculation [EST-PREMIUM]:\n";
  output += "─".repeat(50) + "\n";
  
  for (const step of calc.steps) {
    output += `Step ${step.step} — ${step.name}\n`;
    output += `  Formula: ${step.formula}\n`;
    output += `  Working: ${step.calculation}\n`;
    output += `  Result: ${step.result.toFixed(4)}\n\n`;
  }
  
  output += "─".repeat(50) + "\n";
  output += `Estimated Premium: ₹${calc.estimatedPremium}\n`;
  output += `Entry Range: ₹${calc.entryRange.low} – ₹${calc.entryRange.high}\n`;
  
  if (calc.floorApplied) {
    output += `⚠️ Floor applied: ${calc.note}\n`;
  }
  
  output += `\nSanity Checks:\n`;
  output += `  Premium vs CMP: ${calc.sanityChecks.premiumVsCMP.toFixed(3)}%\n`;
  output += `  Illiquid risk: ${calc.sanityChecks.isIlliquidRisk ? "⚠️ YES" : "✅ NO"}\n`;
  output += `  Stop loss viable: ${calc.sanityChecks.stopLossViable ? "✅ YES" : "⚠️ MARGINAL"}\n`;
  output += `  Covers brokerage: ${calc.sanityChecks.coversBrokerage ? "✅ YES" : "⚠️ MARGINAL"}\n`;
  output += `\n⚠️ Verify on broker terminal before entry.`;
  
  return output;
}

/**
 * Get strike price for option type
 */
export function getOptionStrike(atmStrike, optionType, strikesAway = 0) {
  if (optionType === "CE") {
    return atmStrike + (strikesAway * getStrikeInterval(atmStrike));
  } else {
    return atmStrike - (strikesAway * getStrikeInterval(atmStrike));
  }
}

/**
 * Determine optimal expiry
 * Rule: If within 2 days of expiry, use NEXT week (avoid theta decay)
 */
export function getOptimalExpiry(daysToNearestExpiry) {
  if (daysToNearestExpiry <= 2) {
    return daysToNearestExpiry + 7; // Next week
  }
  return daysToNearestExpiry;
}

/**
 * Calculate days to expiry from date
 */
export function calculateDTE(expiryDate) {
  const now = new Date();
  const expiry = new Date(expiryDate);
  const diffTime = expiry - now;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return Math.max(0, diffDays);
}

/**
 * Get next Thursday (standard equity expiry)
 */
export function getNextThursday() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 4=Thu
  const daysToAdd = ((4 - day + 7) % 7) || 7;
  
  // If today is Thursday but post-market, go to next Thursday
  if (daysToAdd === 0 && now.getHours() >= 16) {
    return new Date(now.getTime() + 7 * 86400000);
  }
  
  return new Date(now.getTime() + daysToAdd * 86400000);
}

/**
 * Format expiry date for display
 */
export function formatExpiryDate(date) {
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", 
                  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const d = date.getDate().toString().padStart(2, "0");
  const m = months[date.getMonth()];
  const y = date.getFullYear();
  return `${d}-${m}-${y}`;
}
