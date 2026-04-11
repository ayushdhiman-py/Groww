// ─────────────────────────────────────────────────────────────────────────────
// operator_scanner.mjs — Master Operator Intelligence Scanner
// Orchestrates all 3 tasks: Intraday F&O, Overnight F&O, Equity
// Provides unified API for frontend consumption
// ─────────────────────────────────────────────────────────────────────────────

import { scanIntradayFO } from "./intraday_scanner.mjs";
import { scanOvernightFO } from "./overnight_scanner.mjs";
import { scanEquityCalls } from "./equity_scanner.mjs";
import { fetchIndiaVix, getVixState, formatVixStatus } from "./vix_manager.mjs";
import { UNIVERSE, getSector } from "./universe.mjs";

// Scanner state
let operatorState = {
  lastScan: null,
  vixState: null,
  marketContext: null,
  task1: { calls: [], summary: {} },
  task2: { calls: [], summary: {} },
  task3: { calls: [], summary: {} },
  scanning: false,
  errors: []
};

/**
 * Main scan function - runs all 3 tasks
 */
export async function runOperatorScan(scannerData, marketContext = {}) {
  operatorState.scanning = true;
  operatorState.errors = [];
  
  try {
    console.log("[OperatorScanner] Starting full operator scan...");
    
    // Fetch VIX first (governs everything)
    const vixState = await fetchIndiaVix();
    const vixValue = vixState.value;
    
    console.log(`[OperatorScanner] VIX: ${vixValue.toFixed(2)} — ${vixState.mode}`);
    
    operatorState.vixState = vixState;
    operatorState.marketContext = marketContext;
    operatorState.lastScan = new Date().toISOString();
    
    // Task 1: Intraday F&O
    console.log("[OperatorScanner] Task 1: Scanning intraday F&O...");
    operatorState.task1 = scanIntradayFO(scannerData, vixValue, marketContext);
    console.log(`[OperatorScanner] Task 1 complete: ${operatorState.task1.calls.length} calls`);
    
    // Task 2: Overnight F&O
    console.log("[OperatorScanner] Task 2: Scanning overnight F&O...");
    operatorState.task2 = scanOvernightFO(scannerData, vixValue, marketContext);
    console.log(`[OperatorScanner] Task 2 complete: ${operatorState.task2.calls.length} calls`);
    
    // Task 3: Equity
    console.log("[OperatorScanner] Task 3: Scanning equity calls...");
    operatorState.task3 = await scanEquityCalls(scannerData, vixValue, marketContext);
    console.log(`[OperatorScanner] Task 3 complete: ${operatorState.task3.calls.length} calls`);
    
    // Identify star picks and alpha picks
    identifyStarAndAlphaPicks();
    
    console.log("[OperatorScanner] Full scan complete ✓");
    
    return getOperatorState();
    
  } catch (error) {
    console.error("[OperatorScanner] Scan error:", error.message);
    operatorState.errors.push(error.message);
    return getOperatorState();
  } finally {
    operatorState.scanning = false;
  }
}

/**
 * Identify STAR PICKS (Task 1 + Task 2) and ALPHA PICKS (all 3 tasks)
 */
function identifyStarAndAlphaPicks() {
  const task1Stocks = new Set(operatorState.task1.calls.map(c => c.stock));
  const task2Stocks = new Set(operatorState.task2.calls.map(c => c.stock));
  const task3Stocks = new Set(operatorState.task3.calls.map(c => c.stock));
  
  // Star picks: in Task 1 + Task 2
  const starPicks = [...task1Stocks].filter(s => task2Stocks.has(s));
  
  // Alpha picks: in all 3 tasks
  const alphaPicks = starPicks.filter(s => task3Stocks.has(s));
  
  // Flag them in the results
  for (const call of operatorState.task1.calls) {
    if (alphaPicks.includes(call.stock)) {
      call.pick_type = "🔥 ALPHA PICK";
    } else if (starPicks.includes(call.stock)) {
      call.pick_type = "⭐ STAR PICK";
    }
  }
  
  for (const call of operatorState.task2.calls) {
    if (alphaPicks.includes(call.stock)) {
      call.pick_type = "🔥 ALPHA PICK";
    } else if (starPicks.includes(call.stock)) {
      call.pick_type = "⭐ STAR PICK";
    }
  }
  
  for (const call of operatorState.task3.calls) {
    if (alphaPicks.includes(call.stock)) {
      call.pick_type = "🔥 ALPHA PICK";
    } else if (starPicks.includes(call.stock)) {
      call.pick_type = "⭐ STAR PICK";
    }
  }
  
  operatorState.starPicks = starPicks;
  operatorState.alphaPicks = alphaPicks;
}

/**
 * Get current operator state
 */
export function getOperatorState() {
  return {
    ...operatorState,
    vixStatusLine: operatorState.vixState 
      ? formatVixStatus(operatorState.vixState.value)
      : "VIX: N/A"
  };
}

/**
 * Build market summary for UI
 */
export function buildMarketSummary() {
  const vixState = operatorState.vixState;
  const context = operatorState.marketContext || {};
  const t1 = operatorState.task1;
  const t2 = operatorState.task2;
  const t3 = operatorState.task3;

  // Count EST values used across all tasks
  let estCount = 0;
  let liquidityWarnings = 0;
  let foBanSkipped = 0;

  for (const call of [...(t1.calls || []), ...(t2.calls || []), ...(t3.calls || [])]) {
    if (call.missing_data_flags && call.missing_data_flags.includes("[EST")) estCount++;
    if (call.liquidity_check && call.liquidity_check.includes("ILLIQUID")) liquidityWarnings++;
  }

  // Count F&O bans from summaries
  foBanSkipped = (t1.summary?.foBan || 0) + (t2.summary?.foBan || 0);

  // Calculate discarded counts properly
  const t1Discarded = t1.summary?.discarded || 0;
  const t2Discarded = t2.summary?.discarded || 0;
  const t3Discarded = t3.summary?.discarded || 0;
  const t1ScoreBelow40 = t1.summary?.scoreBelow40 || 0;
  const t2ScoreBelow70 = t2.summary?.scoreBelow70 || 0;

  return {
    vix: vixState?.value || null,
    vix_mode: vixState?.mode || "UNKNOWN",
    vix_status_line: formatVixStatus(vixState?.value || 14.5),
    nifty_bias: context.niftyBias || "NEUTRAL",
    nifty_vwap: context.niftyBelowVWAP ? "Below" : "Above",
    operator_activity: context.operatorActivity || "Analyzing",
    fii_today: context.fiiFlow > 0 ? "Buying" : "Selling",
    fii_amount: `₹${Math.abs(context.fiiFlow || 0).toFixed(0)} Cr net`,
    dii_today: context.diiFlow > 0 ? "Buying" : "Selling",
    dii_amount: `₹${Math.abs(context.diiFlow || 0).toFixed(0)} Cr net`,
    gift_nifty: context.giftNifty || 0,
    sector_rotating_into: context.sectorRotation?.into || "N/A",
    sector_rotating_out: context.sectorRotation?.outOf || "N/A",
    key_level: context.keyLevel || "Watch Nifty VWAP",
    star_picks: operatorState.starPicks || [],
    alpha_picks: operatorState.alphaPicks || [],
    task1_count: t1.calls?.length || 0,
    task2_count: t2.calls?.length || 0,
    task3_count: t3.calls?.length || 0,
    task1_discarded: t1Discarded,
    task2_discarded: t2Discarded,
    task3_discarded: t3Discarded,
    task1_fo_ban: t1.summary?.foBan || 0,
    task2_fo_ban: t2.summary?.foBan || 0,
    task1_score_below_40: t1ScoreBelow40,
    task2_score_below_70: t2ScoreBelow70,
    est_values_used: estCount,
    liquidity_warnings: liquidityWarnings,
    fo_ban_stocks_skipped: foBanSkipped,
    aggression_level: vixState ? getAggressionLevel(vixState.value) : "MEDIUM"
  };
}

/**
 * Get aggression level from VIX
 */
function getAggressionLevel(vixValue) {
  if (vixValue < 15) return "HIGH";
  if (vixValue < 20) return "MEDIUM";
  if (vixValue < 25) return "LOW";
  return "CASH";
}

/**
 * Format complete market summary block for display
 * Matches the exact END BLOCK spec format
 */
export function formatMarketSummaryBlock() {
  const summary = buildMarketSummary();
  const today = new Date().toLocaleDateString('en-IN', { 
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });

  const foBanTotal = (summary.task1_fo_ban || 0) + (summary.task2_fo_ban || 0);
  const t1ScoreBelow40 = summary.task1_score_below_40 || 0;
  const t2ScoreBelow70 = summary.task2_score_below_70 || 0;

  return `──────────────────────────────────────────────────
🧠 MARKET OPERATOR READ — ${today.toUpperCase()}
──────────────────────────────────────────────────
${summary.vix_status_line}
Nifty Bias: ${summary.nifty_bias}
Nifty vs VWAP: ${summary.nifty_vwap}
Operator Activity: ${summary.operator_activity}
FII Today: ${summary.fii_today} — ${summary.fii_amount}
DII Today: ${summary.dii_today} — ${summary.dii_amount}
Gift Nifty: ${summary.gift_nifty > 0 ? '+' : ''}${summary.gift_nifty} points
Sector Rotating INTO: ${summary.sector_rotating_into}
Sector Rotating OUT OF: ${summary.sector_rotating_out}
Key Level to Watch: ${summary.key_level}

⭐ STAR PICKS: ${summary.star_picks.length > 0 ? summary.star_picks.join(', ') : 'None'}
🔥 ALPHA PICKS: ${summary.alpha_picks.length > 0 ? summary.alpha_picks.join(', ') : 'None'}

Task 1 calls given: ${summary.task1_count} | Discarded: ${summary.task1_discarded} (F&O ban: ${summary.task1_fo_ban || 0}, Score<40: ${t1ScoreBelow40})
Task 2 calls given: ${summary.task2_count} | Discarded: ${summary.task2_discarded} (F&O ban: ${summary.task2_fo_ban || 0}, Score<70: ${t2ScoreBelow70})
Task 3 calls given: ${summary.task3_count} | Discarded: ${summary.task3_discarded}
EST values used: ${summary.est_values_used} fields estimated across all tasks
Liquidity warnings: ${summary.liquidity_warnings} options flagged illiquid
F&O ban stocks skipped: ${foBanTotal}

Today's aggression level: ${summary.aggression_level} (VIX ${summary.vix !== null ? summary.vix.toFixed(2) : 'N/A'})

⚠️ Verify all [EST-PREMIUM] values on your broker terminal before placing any trade. Numbers are estimates only.
──────────────────────────────────────────────────`.trim();
}

/**
 * Transform scanner data from main scanner to operator scanner format
 * Enriches with options cache, FII/DII, block deals data
 */
export function transformScannerData(mainScannerState, optionsCache = {}) {
  const transformed = [];

  // Get data from 1d timeframe (most reliable for daily analysis)
  const allStocks = mainScannerState.data?.["1d_ALL"] || [];

  // Build block/bulk deal lookup
  const blockDealSymbols = new Set();
  const bulkDealSymbols = new Set();

  for (const stock of allStocks) {
    const isFO = isFOStock(stock.symbol);
    const optionsData = optionsCache.get(stock.symbol) || stock.options || null;

    // Parse options data for OI, IV, PCR
    let oiChange = null;
    let iv = null;
    let pcr = null;
    let deliveryPercent = null;

    if (optionsData) {
      oiChange = optionsData.oiChange || null;
      iv = optionsData.iv || null;
      pcr = optionsData.pcr || null;
    }

    // Check for block/bulk deals
    const hasBlockDeal = blockDealSymbols.has(stock.symbol);
    const hasBulkDeal = bulkDealSymbols.has(stock.symbol);

    transformed.push({
      // Basic data
      symbol: stock.symbol,
      sector: stock.sector || getSector(stock.symbol),
      price: stock.price,
      dayH: stock.dayH,
      dayL: stock.dayL,
      weekH: stock.weekH,
      weekL: stock.weekL,
      w52H: stock.w52H,
      w52L: stock.w52L,

      // Technical
      ema21: stock.ema21,
      ema50: stock.ema50,
      ema21above: stock.ema21above,
      macdBull: stock.macdBull,
      macdBear: stock.macdBear,
      macdAbove: stock.macdAbove,
      rsi: stock.rsi,
      vwap: stock.vwap,
      aboveVwap: stock.aboveVwap,
      supertrend: stock.supertrend,
      goldenCross: stock.goldenCross,
      deathCross: stock.deathCross,
      signal: stock.signal,
      techScore: stock.techScore,

      // Volume
      volume: stock.volume,
      volSpike: stock.volSpike,

      // F&O specific
      isFO,
      isFOBanned: false, // Would need F&O ban list
      options: optionsData,
      oiChange,
      oiChangePercent: oiChange,
      deliveryPercent,
      iv,
      pcr,
      earningsSoon: false, // Would need earnings calendar
      blockDeal: hasBlockDeal,
      bulkDeal: hasBulkDeal,
      consolidationDays: 0, // Would need more analysis
      atrPercent: null,
      oiRising: oiChange !== null && oiChange > 10,
      ivRising: iv !== null && iv > 15 && iv < 35,

      // Price action for footprint detection
      priceRange10d: null,
      volumeRatio: null,
      position52W: stock.w52H && stock.w52L
        ? ((stock.price - stock.w52L) / (stock.w52H - stock.w52L)) * 100
        : null,

      // Operator detection placeholders (enriched by individual scanners)
      dippedBelowSupport: false,
      snappedBack: false,
      recoveryPercent: null,
      brokeResistance: stock.goldenCross,
      holdingSupport: stock.aboveVwap,
      marketWeak: false,
      positiveTrigger: null,
      priceStagnant: false,
      coilDays: null,
      breakoutFromCoil: false,
      sectorVolumeSpikes: null,
      otherSectorDistribution: null,
      isSectorLeader: false,
      rsiBullishDivergence: false,
      oiFallingOnDips: false,
      volumeDecliningOnDips: false,
      nextGreenCandle: false,
      oiTradeDirection: oiChange,
      emaAligned: stock.ema21above,
      macdConfirmed: stock.macdBull || stock.macdAbove,
      supertrendAligned: stock.supertrend === "BUY",
      tradeType: stock.signal === "BUY" ? "CE" : "PE",
      cleanChart: stock.techScore >= 4,
      eventRisk: false,
      fiiFlow: null,
      fiiBuying: false,
      blockDealBuy: hasBlockDeal,
      putOI: null,
      callOI: null
    });
  }

  return transformed;
}

/**
 * Check if stock is in F&O segment
 */
function isFOStock(symbol) {
  // F&O stock list (common ones)
  const foStocks = new Set([
    "NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX", "MIDCPNIFTY",
    "ADANIENT", "ADANIPORTS", "APOLLOHOSP", "ASIANPAINT", "AXISBANK",
    "BAJAJ-AUTO", "BAJFINANCE", "BAJAJFINSV", "BHARTIARTL", "BPCL",
    "BRITANNIA", "CIPLA", "COALINDIA", "DIVISLAB", "DRREDDY",
    "EICHERMOT", "GRASIM", "HCLTECH", "HDFCBANK", "HDFCLIFE",
    "HEROMOTOCO", "HINDALCO", "HINDUNILVR", "ICICIBANK", "INFY",
    "ITC", "INDUSINDBK", "JSWSTEEL", "KOTAKBANK", "LT", "M&M",
    "MARUTI", "NESTLEIND", "NTPC", "ONGC", "POWERGRID", "RELIANCE",
    "SBILIFE", "SBIN", "SHRIRAMFIN", "SUNPHARMA", "TCS", "TATACONSUM",
    "TATAMOTORS", "TATASTEEL", "TECHM", "TITAN", "ULTRACEMCO", "WIPRO",
    "BANKBARODA", "PNB", "CANBK", "UNIONBANK", "AUBANK", "FEDERALBNK",
    "BEL", "HAL", "GRSE", "COCHINSHIP", "BDL", "ZOMATO", "PAYTM",
    "NYKAA", "SWIGGY", "DLF", "GODREJPROP", "OBEROIRLTY", "LODHA",
    "PRESTIGE", "SIEMENS", "ABB", "CUMMINSIND", "POLYCAB", "DIXON"
  ]);
  
  return foStocks.has(symbol);
}

// Export individual scanners for direct access
export { scanIntradayFO } from "./intraday_scanner.mjs";
export { scanOvernightFO } from "./overnight_scanner.mjs";
export { scanEquityCalls } from "./equity_scanner.mjs";
