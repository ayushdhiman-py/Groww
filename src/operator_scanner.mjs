// ─────────────────────────────────────────────────────────────────────────────
// operator_scanner.mjs — Master Operator Intelligence Scanner
// Orchestrates all 3 tasks: Intraday F&O, Overnight F&O, Equity
// Provides unified API for frontend consumption
// ─────────────────────────────────────────────────────────────────────────────

import { scanIntradayFO } from "./intraday_scanner.mjs";
import { scanOvernightFO } from "./overnight_scanner.mjs";
import { scanEquityCalls } from "./equity_scanner.mjs";
import { fetchIndiaVix, getVixState, getVixMode, formatVixStatus } from "./vix_manager.mjs";
import { fetchAllMarketData, getFIIDIIFlow, getGiftNifty, getEarningsCalendar } from "./data_fetcher.mjs";
import { optionsCache } from "./options_feed.mjs";
import { UNIVERSE, getSector } from "./universe.mjs";

/** Real per-symbol delivery % (from data_fetcher.mjs's NSE delivery report) -> equity_scanner's fundamentalDataMap shape. */
function buildFundamentalDataMap(deliveryMap) {
  const map = {};
  for (const [symbol, pct] of deliveryMap || []) map[symbol] = { deliveryPct: pct };
  return map;
}

/**
 * Real per-symbol F&O/OI data (from options_feed.mjs's live-polled cache) ->
 * equity_scanner's foDataMap shape. `optionsCache.has(symbol)` is itself the
 * real "is this stock F&O-eligible" signal — fetchOptionChain() only caches
 * an entry when Upstox actually returned strikes for it. `pcrFalling` is
 * left unset (not fabricated): no PCR history is tracked anywhere, only OI
 * deltas, so there's no honest basis to compute a trend.
 */
function buildFoDataMap() {
  const map = {};
  for (const [symbol, data] of optionsCache) {
    map[symbol] = {
      isFoStock: true,
      oiChangePercent: data.oiChange ?? null,
      pcr: data.pcr ?? null,
      ceOiBuilding: data.callOIDelta != null && data.callOIDelta > 0,
    };
  }
  return map;
}

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

    // Fetch all market data in parallel (VIX, F&O bans, delivery, earnings, FII/DII, Gift Nifty)
    const marketData = await fetchAllMarketData();

    // Fetch VIX first (governs everything)
    let vixState;
    if (marketData.vix) {
      const vixValue = marketData.vix.value;
      const mode = getVixMode(vixValue);
      vixState = {
        value: vixValue,
        mode: mode.name,
        lastUpdated: new Date().toISOString(),
        implication: mode.implication,
        source: marketData.vix.source || "multi-source"
      };
    } else {
      // Fallback to vix_manager estimation
      vixState = await fetchIndiaVix();
    }
    const vixValue = vixState.value;

    console.log(`[OperatorScanner] VIX: ${Number.isFinite(vixValue) ? vixValue.toFixed(2) : "UNAVAILABLE"} — ${vixState.mode} (source: ${vixState.source || "fallback"})`);

    // Build enriched market context. `??` (not `||`) below — a genuine 0 net
    // flow or 0-point Gift Nifty must not be conflated with "unavailable."
    const enrichedContext = {
      ...marketContext,
      foBanList: marketData.foBanList || new Set(),
      deliveryMap: marketData.deliveryMap || new Map(),
      earnings: marketData.earnings || [],
      fiiFlow: marketData.fiiDii?.fii ?? null,
      diiFlow: marketData.fiiDii?.dii ?? null,
      giftNifty: marketData.giftNifty ?? null,
      dataQuality: marketData.dataQuality || null,
      vixState
    };

    operatorState.vixState = vixState;
    operatorState.marketData = marketData;
    operatorState.marketContext = enrichedContext;
    operatorState.lastScan = new Date().toISOString();

    // Enrich scanner data with market data
    const enrichedData = enrichScannerData(scannerData, marketData);

    // Task 1: Intraday F&O
    console.log("[OperatorScanner] Task 1: Scanning intraday F&O...");
    operatorState.task1 = scanIntradayFO(enrichedData, vixValue, enrichedContext);
    console.log(`[OperatorScanner] Task 1 complete: ${operatorState.task1.calls.length} calls`);

    // Task 2: Overnight F&O
    console.log("[OperatorScanner] Task 2: Scanning overnight F&O...");
    operatorState.task2 = scanOvernightFO(enrichedData, vixValue, enrichedContext);
    console.log(`[OperatorScanner] Task 2 complete: ${operatorState.task2.calls.length} calls`);

    // Task 3: Equity
    console.log("[OperatorScanner] Task 3: Scanning equity calls...");
    // scanEquityCalls takes a single options object, not positional args —
    // the previous call passed (scannerData, vixValue, enrichedContext)
    // positionally, so `vixValue` was silently discarded and every equity
    // call was scored against a hardcoded default VIX of 14 regardless of
    // the real market VIX (or its unavailability). Also wire through the
    // per-symbol data that genuinely exists (delivery % from the NSE report,
    // F&O/OI data from the live options poller) — previously these maps
    // were never populated at all (not even by the broken call), so every
    // equity call silently scored as if delivery/F&O data were completely
    // unavailable for every stock, even when real data existed.
    const equityResults = await scanEquityCalls({
      vixValue,
      fundamentalDataMap: buildFundamentalDataMap(marketData.deliveryMap),
      foDataMap: buildFoDataMap(),
    });
    // Normalize: scanEquityCalls returns a plain array, wrap it
    operatorState.task3 = {
      calls: Array.isArray(equityResults) ? equityResults : [],
      summary: {
        given: Array.isArray(equityResults) ? equityResults.length : 0,
        discarded: Array.isArray(equityResults) ? 0 : equityResults?.discarded || 0
      }
    };
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
  const t1Calls = operatorState.task1?.calls || [];
  const t2Calls = operatorState.task2?.calls || [];
  const t3Calls = operatorState.task3?.calls || [];

  const task1Stocks = new Set(t1Calls.map(c => c.stock));
  const task2Stocks = new Set(t2Calls.map(c => c.stock));
  const task3Stocks = new Set(t3Calls.map(c => c.stock));

  // Star picks: in Task 1 + Task 2
  const starPicks = [...task1Stocks].filter(s => task2Stocks.has(s));

  // Alpha picks: in all 3 tasks
  const alphaPicks = starPicks.filter(s => task3Stocks.has(s));

  // Flag them in the results
  for (const call of t1Calls) {
    if (alphaPicks.includes(call.stock)) {
      call.pick_type = "🔥 ALPHA PICK";
    } else if (starPicks.includes(call.stock)) {
      call.pick_type = "⭐ STAR PICK";
    }
  }

  for (const call of t2Calls) {
    if (alphaPicks.includes(call.stock)) {
      call.pick_type = "🔥 ALPHA PICK";
    } else if (starPicks.includes(call.stock)) {
      call.pick_type = "⭐ STAR PICK";
    }
  }

  for (const call of t3Calls) {
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
  const marketData = operatorState.marketData || {};
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

  // Get FII/DII flow from enriched context — `??` preserves a genuine
  // unavailable (null) distinctly from a real 0 net flow; `??` chains
  // rather than `||` so a real 0 from the first source isn't overridden by
  // marketData's own value.
  const fiiFlow = context.fiiFlow ?? marketData.fiiDii?.fii ?? null;
  const diiFlow = context.diiFlow ?? marketData.fiiDii?.dii ?? null;
  const giftNifty = context.giftNifty ?? marketData.giftNifty ?? null;

  // Never hide an upstream data failure behind a fake fallback — surface
  // exactly which sources are degraded this cycle so a human can see it,
  // since intraday_scanner.mjs/overnight_scanner.mjs cannot safely turn "F&O
  // ban status unknown" into an automatic block without disabling the whole
  // scanner over one degraded low-priority source.
  const dq = marketData.dataQuality || {};
  const dataQualityWarnings = [];
  if (dq.foBanList && !dq.foBanList.available) dataQualityWarnings.push("F&O ban list unavailable this cycle — Task 1/2 calls below are NOT verified against exchange bans, check manually before trading");
  else if (dq.foBanList?.stale) dataQualityWarnings.push(`F&O ban list is stale (${Math.round(dq.foBanList.ageMs / 60000)}min old) — may not reflect today's bans`);
  if (dq.fiiDii && !dq.fiiDii.available) dataQualityWarnings.push("FII/DII flow unavailable this cycle");
  if (dq.deliveryMap && !dq.deliveryMap.available) dataQualityWarnings.push("Delivery % data unavailable this cycle");
  if (dq.earnings && !dq.earnings.available) dataQualityWarnings.push("Earnings calendar unavailable this cycle");
  if (vixState?.value == null) dataQualityWarnings.push("VIX unavailable this cycle — all tasks running in maximum-caution (DANGER mode) risk sizing");

  return {
    vix: vixState?.value ?? null,
    vix_mode: vixState?.mode || "UNKNOWN",
    vix_status_line: formatVixStatus(vixState?.value ?? null),
    nifty_bias: context.niftyBias || "NEUTRAL",
    nifty_vwap: context.niftyBelowVWAP ? "Below" : "Above",
    operator_activity: context.operatorActivity || "Analyzing",
    fii_today: fiiFlow == null ? "N/A" : (fiiFlow > 0 ? "Buying" : "Selling"),
    fii_amount: fiiFlow == null ? "unavailable" : `₹${Math.abs(fiiFlow).toFixed(0)} Cr net`,
    dii_today: diiFlow == null ? "N/A" : (diiFlow > 0 ? "Buying" : "Selling"),
    dii_amount: diiFlow == null ? "unavailable" : `₹${Math.abs(diiFlow).toFixed(0)} Cr net`,
    gift_nifty: giftNifty,
    data_quality_warnings: dataQualityWarnings,
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
    aggression_level: getAggressionLevel(vixState?.value)
  };
}

/**
 * Get aggression level from VIX. An unknown VIX must map to the MOST
 * conservative ("CASH") level, never "MEDIUM" — a bare `vixValue < 15`
 * would otherwise treat `null`/`undefined` as if VIX were near zero.
 */
function getAggressionLevel(vixValue) {
  if (vixValue == null || !Number.isFinite(vixValue)) return "CASH";
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
 * Enrich scanner data with market data (F&O bans, delivery %, earnings)
 */
function enrichScannerData(scannerData, marketData) {
  const { foBanList, deliveryMap, earnings } = marketData;

  // Build earnings lookup for next 2 days
  const earningsSoonSet = new Set();
  const today = new Date();
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() + 2);

  for (const e of earnings) {
    const earnDate = new Date(e.date);
    if (earnDate >= today && earnDate <= cutoff) {
      earningsSoonSet.add(e.symbol);
    }
  }

  return scannerData.map(stock => {
    const symbolUpper = stock.symbol?.toUpperCase() || '';
    return {
      ...stock,
      isFOBanned: foBanList?.has(symbolUpper) || false,
      deliveryPercent: deliveryMap?.get(symbolUpper) || null,
      earningsSoon: earningsSoonSet.has(symbolUpper),
      fiiFlow: marketData.fiiDii?.fii || null,
      diiFlow: marketData.fiiDii?.dii || null,
    };
  });
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

    // Parse options data for OI, IV, PCR from enriched cache
    let oiChange = null;
    let iv = null;
    let pcr = null;
    let deliveryPercent = null;
    let oiRising = false;
    let totalCallOI = null;
    let totalPutOI = null;

    if (optionsData) {
      oiChange = optionsData.oiChange || null;
      iv = optionsData.iv || null;
      pcr = optionsData.pcr || null;
      totalCallOI = optionsData.totalCallOI || null;
      totalPutOI = optionsData.totalPutOI || null;
      oiRising = oiChange !== null && oiChange > 10;
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

      // F&O specific (enriched with OI delta tracking)
      isFO,
      isFOBanned: false, // Will be set by enrichScannerData
      options: optionsData,
      oiChange,
      oiChangePercent: oiChange,
      deliveryPercent,
      iv,
      pcr,
      earningsSoon: false, // Will be set by enrichScannerData
      blockDeal: hasBlockDeal,
      bulkDeal: hasBulkDeal,
      consolidationDays: 0,
      atrPercent: null,
      oiRising,
      ivRising: iv !== null && iv > 15 && iv < 35,
      totalCallOI,
      totalPutOI,

      // Price action for footprint detection
      priceRange10d: null,
      volumeRatio: stock.volumeRatio || null,
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
      putOI: totalPutOI,
      callOI: totalCallOI
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
