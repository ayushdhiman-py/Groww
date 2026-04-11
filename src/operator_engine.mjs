// ─────────────────────────────────────────────────────────────────────────────
// operator_engine.mjs — Operator Intelligence & Footprint Detection Engine
// Detects operator intentions through data footprints
// Scoring system for ranking trades
// ─────────────────────────────────────────────────────────────────────────────

/**
 * OPERATOR FOOTPRINT DETECTION
 * 
 * 8 footprint patterns that reveal operator intentions:
 * 1. Silent Accumulation
 * 2. Stop Hunt Trap (Highest conviction)
 * 3. Markup Phase Rally
 * 4. Short Squeeze Incoming
 * 5. Distribution Warning
 * 6. F&O Rally Catch
 * 7. Sector Rotation
 * 8. Hidden Divergence
 */

/**
 * Detect Footprint 1: Silent Accumulation
 * Signals: Tight range <5% over 10 days + low volume + delivery% rising + OI building
 */
export function detectSilentAccumulation(stockData) {
  const signals = [];
  let conviction = 0;

  // Tight price range
  if (stockData.priceRange10d != null && stockData.priceRange10d < 5) {
    signals.push(`Tight range: ${stockData.priceRange10d.toFixed(2)}% over 10 days`);
    conviction += 25;
  }

  // Low volume
  if (stockData.volumeRatio != null && stockData.volumeRatio < 0.8) {
    signals.push(`Low volume: ${stockData.volumeRatio.toFixed(2)}x avg`);
    conviction += 20;
  }

  // Delivery % rising (if available)
  if (stockData.deliveryPercent != null && stockData.deliveryPercent > 50) {
    signals.push(`Delivery %: ${stockData.deliveryPercent.toFixed(1)}% (accumulation signal)`);
    conviction += 25;
  }

  // OI in calls building (for F&O stocks)
  if (stockData.oiChangePercent != null && stockData.oiChangePercent > 10) {
    signals.push(`OI building: +${stockData.oiChangePercent.toFixed(1)}%`);
    conviction += 30;
  }
  
  if (conviction >= 50) {
    return {
      footprint: 1,
      name: "SILENT ACCUMULATION",
      signals,
      conviction,
      action: "Breakout imminent. CE or equity before the move.",
      detected: conviction >= 50
    };
  }
  
  return null;
}

/**
 * Detect Footprint 2: Stop Hunt Trap (HIGHEST CONVICTION)
 * Signals: Sharp dip below support + snap back + OI drops after dip + retail panic
 */
export function detectStopHuntTrap(stockData) {
  const signals = [];
  let conviction = 0;
  
  // Sharp dip below support/PDL/EMA50
  if (stockData.dippedBelowSupport && stockData.snappedBack) {
    signals.push(`Dipped below support, snapped back within ${stockData.snapBackCandles || 1}-3 candles`);
    conviction += 40;
  }
  
  // Volume spike on dip
  if (stockData.dipVolume && stockData.dipVolume > stockData.avgVolume * 2) {
    signals.push(`Volume spike on dip: ${(stockData.dipVolume / stockData.avgVolume).toFixed(1)}x avg`);
    conviction += 20;
  }
  
  // OI in puts dropped after dip
  if (stockData.oiDropAfterDip) {
    signals.push(`OI dropped after dip (operator bought panic)`);
    conviction += 25;
  }
  
  // Price recovered
  if (stockData.recoveryPercent && stockData.recoveryPercent > 1) {
    signals.push(`Recovered ${stockData.recoveryPercent.toFixed(2)}% from low`);
    conviction += 15;
  }
  
  if (conviction >= 50) {
    return {
      footprint: 2,
      name: "STOP HUNT TRAP ⭐",
      signals,
      conviction,
      action: "Operator bought retail panic. Best CE entry. Enter aggressively within risk limits.",
      detected: conviction >= 50,
      highestConviction: conviction >= 70
    };
  }
  
  return null;
}

/**
 * Detect Footprint 3: Markup Phase Rally
 * Signals: Volume explosion 2-3x + breaking resistance + OI surging + delivery high
 */
export function detectMarkupRally(stockData) {
  const signals = [];
  let conviction = 0;
  
  // Volume explosion
  if (stockData.volumeRatio != null && stockData.volumeRatio >= 2) {
    signals.push(`Volume explosion: ${stockData.volumeRatio.toFixed(1)}x avg`);
    conviction += 25;
  }

  // Breaking multi-week resistance
  if (stockData.brokeResistance) {
    signals.push(`Broke multi-week resistance cleanly`);
    conviction += 30;
  }

  // OI in calls surging
  if (stockData.oiChangePercent != null && stockData.oiChangePercent > 15) {
    signals.push(`OI surging: +${stockData.oiChangePercent.toFixed(1)}%`);
    conviction += 25;
  }

  // Delivery % high on breakout
  if (stockData.deliveryPercent != null && stockData.deliveryPercent > 55) {
    signals.push(`High delivery on breakout: ${stockData.deliveryPercent.toFixed(1)}%`);
    conviction += 20;
  }
  
  // Sector peers moving
  if (stockData.sectorPeersMoving) {
    signals.push(`Sector peers also moving`);
    conviction += 10;
  }
  
  if (conviction >= 50) {
    return {
      footprint: 3,
      name: "MARKUP PHASE RALLY",
      signals,
      conviction,
      action: "Operator pushing price. Buy CE or equity. Ride it. Don't wait for pullback.",
      detected: conviction >= 50
    };
  }
  
  return null;
}

/**
 * Detect Footprint 4: Short Squeeze Incoming
 * Signals: High put OI + price not falling + PCR < 0.6 + any positive trigger
 */
export function detectShortSqueeze(stockData) {
  const signals = [];
  let conviction = 0;
  
  // High put OI
  if (stockData.putOI != null && stockData.putOI > stockData.callOI * 1.5) {
    signals.push(`High put OI: ${stockData.putOI} vs call OI ${stockData.callOI}`);
    conviction += 25;
  }
  
  // Price holding support despite weak market
  if (stockData.holdingSupport && stockData.marketWeak) {
    signals.push(`Holding support stubbornly despite weak market`);
    conviction += 30;
  }
  
  // PCR < 0.6
  if (stockData.pcr != null && stockData.pcr < 0.6) {
    signals.push(`PCR extreme: ${stockData.pcr.toFixed(2)}`);
    conviction += 25;
  }
  
  // Any positive trigger
  if (stockData.positiveTrigger) {
    signals.push(`Positive trigger: ${stockData.positiveTrigger}`);
    conviction += 20;
  }
  
  if (conviction >= 50) {
    return {
      footprint: 4,
      name: "SHORT SQUEEZE INCOMING",
      signals,
      conviction,
      action: "Buy ATM CE. Squeeze will be violent. 20-50% premium fast.",
      detected: conviction >= 50
    };
  }
  
  return null;
}

/**
 * Detect Footprint 5: Distribution Warning
 * Signals: Near 52W high + high volume but price not moving + delivery falling + FII selling
 */
export function detectDistribution(stockData) {
  const signals = [];
  let conviction = 0;
  
  // Near 52W high
  if (stockData.position52W != null && stockData.position52W > 85) {
    signals.push(`Near 52W high: ${stockData.position52W.toFixed(1)}% of range`);
    conviction += 20;
  }

  // High volume but price not moving
  if (stockData.volumeRatio != null && stockData.volumeRatio > 1.5 && stockData.priceStagnant) {
    signals.push(`High volume ${stockData.volumeRatio.toFixed(1)}x but price stagnant`);
    conviction += 30;
  }

  // Delivery % falling
  if (stockData.deliveryPercent != null && stockData.deliveryPercent < 35) {
    signals.push(`Falling delivery %: ${stockData.deliveryPercent.toFixed(1)}%`);
    conviction += 25;
  }

  // FII selling
  if (stockData.fiiFlow != null && stockData.fiiFlow < 0) {
    signals.push(`FII selling: ₹${Math.abs(stockData.fiiFlow).toFixed(0)} Cr net`);
    conviction += 25;
  }
  
  // Stock all over media
  if (stockData.mediaBuzz) {
    signals.push(`High media buzz (retail attention)`);
    conviction += 10;
  }
  
  if (conviction >= 50) {
    return {
      footprint: 5,
      name: "DISTRIBUTION WARNING ⚠️",
      signals,
      conviction,
      action: "Avoid CE. If confirmed: buy PE for reversal. Operator is selling into your buy.",
      detected: conviction >= 50
    };
  }
  
  return null;
}

/**
 * Detect Footprint 6: F&O Rally Catch
 * Signals: OI building rapidly + IV rising but <35% + price coiling tight 3+ days
 */
export function detectFORallyCatch(stockData) {
  const signals = [];
  let conviction = 0;
  
  // OI building rapidly
  if (stockData.oiChangePercent != null && stockData.oiChangePercent > 20) {
    signals.push(`OI building rapidly: +${stockData.oiChangePercent.toFixed(1)}%`);
    conviction += 30;
  }

  // IV rising but still < 35%
  if (stockData.iv != null && stockData.iv > 15 && stockData.iv < 35) {
    signals.push(`IV rising: ${stockData.iv.toFixed(1)}% (sweet spot)`);
    conviction += 25;
  }

  // Price coiling tight 3+ days
  if (stockData.coilDays != null && stockData.coilDays >= 3) {
    signals.push(`Price coiling tight: ${stockData.coilDays} days`);
    conviction += 25;
  }
  
  // Any breakout from coil
  if (stockData.breakoutFromCoil) {
    signals.push(`Breakout from coil detected`);
    conviction += 20;
  }
  
  if (conviction >= 50) {
    return {
      footprint: 6,
      name: "F&O RALLY CATCH",
      signals,
      conviction,
      action: "Buy ATM CE/PE in breakout direction. 30-100% option premium potential.",
      detected: conviction >= 50
    };
  }
  
  return null;
}

/**
 * Detect Footprint 7: Sector Rotation
 * Signals: 3+ stocks in sector showing volume spikes same day + another sector distributing
 */
export function detectSectorRotation(stockData) {
  const signals = [];
  let conviction = 0;
  
  // 3+ stocks in sector with volume spikes
  if (stockData.sectorVolumeSpikes != null && stockData.sectorVolumeSpikes >= 3) {
    signals.push(`${stockData.sectorVolumeSpikes} stocks in sector with volume spikes`);
    conviction += 40;
  }
  
  // Another sector showing distribution
  if (stockData.otherSectorDistribution) {
    signals.push(`Rotation from ${stockData.otherSectorDistribution} to ${stockData.sector}`);
    conviction += 30;
  }
  
  // Sector leader
  if (stockData.isSectorLeader) {
    signals.push(`Sector leader: ${stockData.stock}`);
    conviction += 30;
  }
  
  if (conviction >= 50) {
    return {
      footprint: 7,
      name: "SECTOR ROTATION",
      signals,
      conviction,
      action: "Buy sector leader CE or equity early before retail rotates.",
      detected: conviction >= 50
    };
  }
  
  return null;
}

/**
 * Detect Footprint 8: Hidden Divergence (Advanced)
 * Signals: Price equal lows but RSI higher lows + OI falling on dips + volume declining
 */
export function detectHiddenDivergence(stockData) {
  const signals = [];
  let conviction = 0;
  
  // Price making equal lows but RSI making higher lows
  if (stockData.rsiBullishDivergence) {
    signals.push(`RSI bullish divergence (higher lows on equal price lows)`);
    conviction += 35;
  }
  
  // OI falling on dips (shorts not confident)
  if (stockData.oiFallingOnDips) {
    signals.push(`OI falling on dips (shorts not confident)`);
    conviction += 25;
  }
  
  // Volume declining on each dip
  if (stockData.volumeDecliningOnDips) {
    signals.push(`Volume declining on dips`);
    conviction += 20;
  }
  
  // Next green candle entry
  if (stockData.nextGreenCandle) {
    signals.push(`Entry on next green candle`);
    conviction += 20;
  }
  
  if (conviction >= 50) {
    return {
      footprint: 8,
      name: "HIDDEN DIVERGENCE",
      signals,
      conviction,
      action: "Bullish hidden divergence. Operator accumulating on dips. Strong CE or equity entry.",
      detected: conviction >= 50
    };
  }
  
  return null;
}

/**
 * Detect all operator footprints for a stock
 * Returns array of detected footprints
 */
export function detectAllFootprints(stockData) {
  const footprints = [];
  
  const detectors = [
    detectSilentAccumulation,
    detectStopHuntTrap,
    detectMarkupRally,
    detectShortSqueeze,
    detectDistribution,
    detectFORallyCatch,
    detectSectorRotation,
    detectHiddenDivergence
  ];
  
  for (const detector of detectors) {
    const result = detector(stockData);
    if (result && result.detected) {
      footprints.push(result);
    }
  }
  
  // Sort by conviction (highest first)
  return footprints.sort((a, b) => b.conviction - a.conviction);
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORING ENGINE — Score out of 100
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Score operator signals (40 points max)
 */
function scoreOperatorSignals(footprints, stockData) {
  let score = 0;
  const details = [];
  
  if (footprints.length > 0) {
    const primary = footprints[0];
    score += 15;
    details.push(`Clear footprint #${primary.footprint} identified: ${primary.name} (+15)`);
  }
  
  // OI moving in trade direction
  if (stockData.oiTradeDirection && stockData.oiTradeDirection > 10) {
    score += 10;
    details.push(`OI moving in trade direction: +${stockData.oiTradeDirection.toFixed(1)}% (+10)`);
  }
  
  // Delivery % confirms smart money
  if (stockData.deliveryPercent != null && stockData.deliveryPercent > 55) {
    score += 8;
    details.push(`Delivery % confirms smart money: ${stockData.deliveryPercent.toFixed(1)}% (+8)`);
  }
  
  // FII/DII/Block deal confirmation
  if (stockData.fiiBuying || stockData.blockDealBuy) {
    score += 7;
    details.push(`FII/Block deal confirmation (+7)`);
  }
  
  return { score: Math.min(score, 40), details };
}

/**
 * Score technical signals (35 points max)
 */
function scoreTechnicalSignals(stockData) {
  let score = 0;
  const details = [];
  
  // EMA trend aligned
  if (stockData.emaAligned) {
    score += 8;
    details.push(`EMA trend aligned (+8)`);
  }
  
  // MACD confirmed
  if (stockData.macdConfirmed) {
    score += 7;
    details.push(`MACD confirmed (+7)`);
  }
  
  // Volume spike confirmed
  if (stockData.volumeRatio != null && stockData.volumeRatio > 1.5) {
    score += 8;
    details.push(`Volume spike: ${stockData.volumeRatio.toFixed(1)}x (+8)`);
  }

  // Supertrend aligned
  if (stockData.supertrendAligned) {
    score += 7;
    details.push(`Supertrend aligned (+7)`);
  }

  // RSI in ideal zone
  if (stockData.rsi != null) {
    if ((stockData.tradeType === "CE" && stockData.rsi >= 55 && stockData.rsi <= 72) ||
        (stockData.tradeType === "PE" && stockData.rsi >= 28 && stockData.rsi <= 45)) {
      score += 5;
      details.push(`RSI in ideal zone: ${stockData.rsi.toFixed(1)} (+5)`);
    }
  }
  
  return { score: Math.min(score, 35), details };
}

/**
 * Score risk/timing (25 points max)
 */
function scoreRiskTiming(stockData, vixValue) {
  let score = 0;
  const details = [];
  
  // Clean chart, no resistance overhead
  if (stockData.cleanChart) {
    score += 10;
    details.push(`Clean chart, no resistance overhead (+10)`);
  }
  
  // VIX in safe zone
  if (vixValue != null && vixValue < 20) {
    score += 8;
    details.push(`VIX in safe zone: ${vixValue.toFixed(2)} (+8)`);
  }
  
  // No event risk
  if (!stockData.eventRisk) {
    score += 7;
    details.push(`No event risk (+7)`);
  }
  
  return { score: Math.min(score, 25), details };
}

/**
 * Get score band label and emoji
 */
export function getScoreBand(score) {
  if (score >= 85) return { label: "ALPHA", emoji: "🔥", desc: "Maximum conviction. Full position." };
  if (score >= 70) return { label: "STRONG", emoji: "⭐", desc: "High conviction. Standard position." };
  if (score >= 55) return { label: "VALID", emoji: "✅", desc: "Good setup. Reduced position." };
  if (score >= 40) return { label: "WEAK", emoji: "⚠️", desc: "Include with caution flag. Half size." };
  return { label: "DISCARD", emoji: "❌", desc: "Do not list." };
}

/**
 * Calculate full score for a stock
 */
export function calculateScore(stockData, vixValue) {
  const footprints = detectAllFootprints(stockData);
  
  const operatorScore = scoreOperatorSignals(footprints, stockData);
  const technicalScore = scoreTechnicalSignals(stockData);
  const riskScore = scoreRiskTiming(stockData, vixValue);
  
  const totalScore = operatorScore.score + technicalScore.score + riskScore.score;
  const band = getScoreBand(totalScore);
  
  return {
    score: totalScore,
    band,
    footprints,
    breakdown: {
      operator: operatorScore,
      technical: technicalScore,
      risk: riskScore
    },
    qualifies: totalScore >= 40
  };
}

/**
 * Format score for display
 */
export function formatScore(score, band) {
  return `${band.emoji} ${score}/100 — ${band.label}`;
}
