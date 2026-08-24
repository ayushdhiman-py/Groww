// ─────────────────────────────────────────────────────────────────────────────
// vix_manager.mjs — VIX Mode Manager & Risk Controller
// VIX governs everything: position sizing, strategy selection, risk levels
// ─────────────────────────────────────────────────────────────────────────────

import { ema, rsi } from "./indicators.mjs";

// VIX state
let vixState = {
  value: null,
  mode: "UNKNOWN",
  lastUpdated: null,
  implication: ""
};

/**
 * VIX Modes and their implications
 */
const VIX_MODES = {
  GREEN: {
    name: "GREEN MODE",
    range: [0, 15],
    implication: "Full aggression. All tasks active. Buy naked CE/PE freely. Normal position size.",
    positionSizeMultiplier: 1.0,
    maxOvernightCalls: 10,
    intradayCapitalReduction: 0,
    allowOTM: true,
    allowNakedOptions: true,
    aggressionLevel: "HIGH"
  },
  STANDARD: {
    name: "STANDARD MODE",
    range: [15, 17],
    implication: "Normal activity. ATM options only, no OTM.",
    positionSizeMultiplier: 1.0,
    maxOvernightCalls: 10,
    intradayCapitalReduction: 0,
    allowOTM: false,
    allowNakedOptions: true,
    aggressionLevel: "HIGH"
  },
  CAUTION: {
    name: "CAUTION MODE",
    range: [17, 20],
    implication: "Debit spreads preferred. Reduce position size by 30%. ATM only. Flag CE as ELEVATED RISK.",
    positionSizeMultiplier: 0.7,
    maxOvernightCalls: 8,
    intradayCapitalReduction: 0,
    allowOTM: false,
    allowNakedOptions: true,
    aggressionLevel: "MEDIUM"
  },
  DEFENSIVE: {
    name: "DEFENSIVE MODE",
    range: [20, 25],
    implication: "Task 1: Reduce capital 50%. Task 2: Max 5 calls ATM. Task 3: Full. Flag all F&O with HIGH VIX WARNING.",
    positionSizeMultiplier: 0.5,
    maxOvernightCalls: 5,
    intradayCapitalReduction: 0.5,
    allowOTM: false,
    allowNakedOptions: true,
    aggressionLevel: "LOW"
  },
  DANGER: {
    name: "DANGER MODE",
    range: [25, 100],
    implication: "Task 1: Equity only. Task 2: SUSPENDED. Task 3: Full but RS>1.5 only. EXTREME RISK.",
    positionSizeMultiplier: 0,
    maxOvernightCalls: 0,
    intradayCapitalReduction: 1.0,
    allowOTM: false,
    allowNakedOptions: false,
    aggressionLevel: "CASH"
  }
};

/**
 * Get VIX mode from value
 */
export function getVixMode(vixValue) {
  // An unknown VIX must default to the MOST conservative mode, never the
  // least — `null < 15` is true in JS, which would otherwise silently hand
  // back GREEN (full aggression) for a VIX we don't actually know.
  if (vixValue == null || !Number.isFinite(vixValue)) return VIX_MODES.DANGER;
  if (vixValue < 15) return VIX_MODES.GREEN;
  if (vixValue < 17) return VIX_MODES.STANDARD;
  if (vixValue < 20) return VIX_MODES.CAUTION;
  if (vixValue < 25) return VIX_MODES.DEFENSIVE;
  return VIX_MODES.DANGER;
}

/**
 * Format VIX status line — MUST be first line of every response
 */
export function formatVixStatus(vixValue) {
  const mode = getVixMode(vixValue);
  const valueLabel = Number.isFinite(vixValue) ? vixValue.toFixed(2) : "UNAVAILABLE";
  return `VIX: ${valueLabel} — ${mode.name} — ${mode.implication}`;
}

/**
 * Get VIX status as a structured object for API responses
 */
export function getVixStatusLine(vixValue) {
  const mode = getVixMode(vixValue);
  const valueLabel = Number.isFinite(vixValue) ? vixValue.toFixed(2) : "UNAVAILABLE";
  return {
    value: Number.isFinite(vixValue) ? vixValue : null,
    mode: mode.name,
    implication: mode.implication,
    statusLine: `VIX: ${valueLabel} — ${mode.name} — ${mode.implication}`,
    positionSizeMultiplier: mode.positionSizeMultiplier,
    maxOvernightCalls: mode.maxOvernightCalls,
    allowOTM: mode.allowOTM,
    allowNakedOptions: mode.allowNakedOptions,
    aggressionLevel: mode.aggressionLevel,
    riskFlag: getVixRiskFlag(vixValue)
  };
}

/**
 * Fetch India VIX data from NSE
 * Uses NSE India API directly since Groww doesn't expose VIX candles
 */
export async function fetchIndiaVix() {
  try {
    // Try to fetch VIX from NSE India public API with proper browser headers
    const response = await fetch('https://www1.nseindia.com/api/vix', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www1.nseindia.com/',
        'Cache-Control': 'no-cache',
      },
      signal: AbortSignal.timeout(10000)
    });

    if (response.ok) {
      const data = await response.json();
      const vixValue = parseFloat(data.indiaVIX || data.VIX || data.value);

      if (!isNaN(vixValue) && vixValue > 0) {
        const mode = getVixMode(vixValue);
        vixState = {
          value: vixValue,
          mode: mode.name,
          lastUpdated: new Date().toISOString(),
          implication: mode.implication,
          source: "NSE direct"
        };
        return vixState;
      }
    }
  } catch (e) {
    // NSE blocks automated access - fallback is used
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[VIX] NSE fetch failed: ${e.message}. Using fallback.`);
    }
  }

  // Fallback: Use estimated VIX from market data
  return await estimateVIX();
}

/**
 * Estimate VIX from Nifty options implied volatility
 * Fallback when direct VIX fetch fails
 */
async function estimateVIX() {
  try {
    // Fetch Nifty option chain and average the ATM IV
    const { fetchOptionChain } = await import("./upstox.mjs");
    const optionData = await fetchOptionChain("NIFTY");
    
    if (optionData && optionData.strikes) {
      const atmStrike = Math.round(optionData.underlyingValue / 50) * 50;
      let ivSum = 0, ivCount = 0;
      
      for (const [strike, options] of Object.entries(optionData.strikes)) {
        const strikeNum = parseFloat(strike);
        if (Math.abs(strikeNum - atmStrike) <= 100) { // ATM ± 2 strikes
          if (options.CE && options.CE.impliedVolatility) {
            ivSum += options.CE.impliedVolatility;
            ivCount++;
          }
          if (options.PE && options.PE.impliedVolatility) {
            ivSum += options.PE.impliedVolatility;
            ivCount++;
          }
        }
      }
      
      if (ivCount > 0) {
        const avgIV = ivSum / ivCount;
        const mode = getVixMode(avgIV);
        vixState = {
          value: avgIV,
          mode: mode.name,
          lastUpdated: new Date().toISOString(),
          implication: mode.implication
        };
        return vixState;
      }
    }
  } catch (e) {
    console.log(`[VIX] Estimation failed: ${e.message}`);
  }

  // All sources failed — do NOT substitute a hardcoded "default" VIX. A
  // fabricated 14.5 previously masked total VIX-fetch failure as a real
  // calm-market reading, and VIX governs position sizing/risk mode
  // downstream, so an unknown VIX must never look like a known low one.
  // Callers must treat value:null as "assume the worst" (DANGER mode), not
  // "assume calm."
  vixState = {
    value: null,
    mode: "UNKNOWN",
    lastUpdated: new Date().toISOString(),
    implication: "VIX unavailable — all sources (NSE direct, option-IV estimate) failed this cycle. Treat as maximum risk until a real reading returns.",
    source: "unavailable",
  };
  return vixState;
}

/**
 * Get current VIX state
 */
export function getVixState() {
  return vixState;
}

/**
 * Check if task is allowed based on VIX mode
 */
export function isTaskAllowed(taskNumber, vixValue) {
  // An unknown VIX ("null <= 25" is true in JS) must NOT silently allow F&O
  // tasks that are supposed to be VIX-gated — treat unknown as DANGER.
  if (vixValue == null || !Number.isFinite(vixValue)) {
    return taskNumber === 3; // only equity (not VIX-gated) stays allowed
  }
  if (taskNumber === 1) {
    // Intraday F&O
    return vixValue <= 25; // Allowed up to VIX 25 (defensive mode)
  }
  if (taskNumber === 2) {
    // Overnight F&O
    return vixValue <= 25; // Suspended in danger mode
  }
  if (taskNumber === 3) {
    // Equity
    return true; // Always allowed
  }
  return false;
}

/**
 * Get position size multiplier for VIX mode
 */
export function getPositionSizeMultiplier(vixValue) {
  return getVixMode(vixValue).positionSizeMultiplier;
}

/**
 * Get max overnight calls for VIX mode
 */
export function getMaxOvernightCalls(vixValue) {
  return getVixMode(vixValue).maxOvernightCalls;
}

/**
 * Check if OTM options are allowed
 */
export function allowOTMOptions(vixValue) {
  return getVixMode(vixValue).allowOTM;
}

/**
 * Check if naked options are allowed
 */
export function allowNakedOptions(vixValue) {
  return getVixMode(vixValue).allowNakedOptions;
}

/**
 * Get risk flag message for VIX mode
 */
export function getVixRiskFlag(vixValue) {
  // "null > 25" is false in JS, which would otherwise fall through to
  // "✅ Normal risk" for a VIX we don't actually know — the opposite of safe.
  if (vixValue == null || !Number.isFinite(vixValue)) return "❓ VIX UNAVAILABLE — treat as maximum risk";
  if (vixValue > 25) return "🔴 EXTREME RISK - VIX DANGER";
  if (vixValue > 20) return "⚠️ HIGH VIX WARNING";
  if (vixValue > 17) return "⚡ ELEVATED RISK";
  return "✅ Normal risk";
}

/**
 * Get aggression level description
 */
export function getAggressionLevel(vixValue) {
  return getVixMode(vixValue).aggressionLevel;
}

/**
 * Apply VIX-based capital adjustment
 */
export function adjustCapitalForVix(baseCapital, vixValue) {
  const mode = getVixMode(vixValue);
  const reduction = mode.intradayCapitalReduction;
  return baseCapital * (1 - reduction);
}

// Export VIX modes for reference
export { VIX_MODES };
