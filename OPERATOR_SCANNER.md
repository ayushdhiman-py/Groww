# 🧠 Operator Intelligence Scanner

> **Advanced trading system that detects operator footprints through data analysis**
> Scans Indian stock market for institutional trading patterns and generates actionable F&O and equity calls

## 📋 Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [VIX-Governed Risk Management](#vix-governed-risk-management)
- [8 Operator Footprints](#8-operator-footprints)
- [3 Scanning Tasks](#3-scanning-tasks)
- [Premium Estimation Formula](#premium-estimation-formula)
- [Scoring System](#scoring-system)
- [API Endpoints](#api-endpoints)
- [UI Access](#ui-access)
- [Usage Guide](#usage-guide)
- [Data Requirements](#data-requirements)
- [Integration with Main Scanner](#integration-with-main-scanner)

---

## Overview

The Operator Intelligence Scanner is a **comprehensive trading analysis system** that goes beyond traditional technical indicators. It detects **institutional operator intentions** through the footprints they leave in market data, even when they're trying to hide.

### Key Features

✅ **8 Operator Footprint Patterns** - Detects accumulation, distribution, stop hunts, squeezes, and more  
✅ **VIX-Governed Risk Management** - Automatically adjusts strategy based on market volatility  
✅ **3 Scanning Tasks** - Intraday F&O, Overnight F&O, Equity calls  
✅ **Premium Estimation** - 4-step formula to estimate option prices when live data unavailable  
✅ **100-Point Scoring System** - Ranks trades by conviction level  
✅ **Real-time UI** - Beautiful dark theme interface with live updates  
✅ **RESTful API** - Full programmatic access for algorithmic trading  

---

## Architecture

```
operator_scanner.mjs (Master Orchestrator)
├── vix_manager.mjs (VIX Mode Controller)
├── operator_engine.mjs (Footprint Detection & Scoring)
├── premium_calc.mjs (Option Premium Estimation)
├── intraday_scanner.mjs (Task 1)
├── overnight_scanner.mjs (Task 2)
└── equity_scanner.mjs (Task 3)
```

### Data Flow

1. **Main Scanner** (`scanner.mjs`) collects candle data, technical indicators
2. **Transform** (`operator_scanner.mjs:transformScannerData`) converts to operator format
3. **VIX Check** (`vix_manager.mjs`) determines active mode and restrictions
4. **Footprint Detection** (`operator_engine.mjs`) identifies operator patterns
5. **Scoring** (`operator_engine.mjs:calculateScore`) ranks each stock out of 100
6. **Premium Calculation** (`premium_calc.mjs`) estimates option entry prices
7. **Output** generates top 10 calls per task with full reasoning

---

## VIX-Governed Risk Management

**VIX governs EVERYTHING.** The system checks India VIX first and applies the correct mode before running any task.

### VIX Modes

| VIX Range | Mode | Implication |
|-----------|------|-------------|
| **< 15** | 🟢 GREEN MODE | Full aggression. All 3 tasks active. Buy naked CE/PE freely. Normal position size. |
| **15-17** | 🔵 STANDARD MODE | All 3 tasks active. ATM options only, no OTM. |
| **17-20** | 🟡 CAUTION MODE | Debit spreads preferred. Reduce position size by 30%. ATM only. Flag CE as ELEVATED RISK. |
| **20-25** | 🟠 DEFENSIVE MODE | Task 1: Reduce capital 50%. Task 2: Max 5 calls ATM. Task 3: Full activity. Flag all F&O with ⚠️ HIGH VIX WARNING. |
| **> 25** | 🔴 DANGER MODE | Task 1: Equity only. **Task 2: SUSPENDED**. Task 3: Full but RS>1.5 only. EXTREME RISK. |

### VIX Rules Applied

- **Position Sizing**: Automatically reduced in high VIX modes
- **OTM Restrictions**: Disabled above VIX 15
- **Task Suspension**: Overnight F&O suspended above VIX 25
- **Risk Flags**: Warnings added to every call when VIX > 17
- **Premium Adjustment**: IV estimation adapts to VIX level

---

## 8 Operator Footprints

The system detects these institutional trading patterns:

### 1. Silent Accumulation
**Signals**: Tight range <5% over 10 days + low volume + delivery% rising + OI building  
**Action**: Breakout imminent. Enter CE or equity before the move.

### 2. Stop Hunt Trap ⭐ (Highest Conviction)
**Signals**: Sharp dip below support/PDL/EMA50 on volume spike + price snaps back within 1-3 candles + OI drops after dip  
**Action**: Operator bought retail panic. Best CE entry. Enter aggressively within risk limits.

### 3. Markup Phase Rally
**Signals**: Volume explosion 2-3x with no news + breaking multi-week resistance + OI surging + delivery high  
**Action**: Operator pushing price. Buy CE or equity. Ride it. Don't wait for pullback.

### 4. Short Squeeze Incoming
**Signals**: High put OI + price not falling despite weak market + PCR < 0.6 + any positive trigger  
**Action**: Buy ATM CE. Squeeze will be violent. 20-50% premium fast.

### 5. Distribution Warning ⚠️
**Signals**: Near 52W high + high volume but price not moving + delivery falling + FII selling + media buzz  
**Action**: Avoid CE. If confirmed: buy PE for reversal. Operator is selling into your buy.

### 6. F&O Rally Catch
**Signals**: OI building rapidly >20% + IV rising but <35% + price coiling tight 3+ days  
**Action**: Buy ATM CE/PE in breakout direction. 30-100% option premium potential.

### 7. Sector Rotation
**Signals**: 3+ stocks in sector with volume spikes + another sector showing distribution  
**Action**: Buy sector leader CE or equity early before retail rotates.

### 8. Hidden Divergence (Advanced)
**Signals**: Price equal lows but RSI higher lows + OI falling on dips + volume declining  
**Action**: Bullish hidden divergence. Operator accumulating on dips. Strong entry on next green candle.

---

## 3 Scanning Tasks

### Task 1: Intraday F&O Calls

**Target**: 20-50% premium gain same day  
**Entry**: 9:30-10:15 AM or 2:00-2:45 PM only (NEVER 12:00-1:30 PM - lunch chop zone)  
**Exit**: Hard exit 3:00 PM regardless of P&L  
**Stop Loss**: 30% of premium paid  

**Checklist** (25+ checks per stock):
- Operator footprint detected?
- Volume spike in 30min chart > 3x avg?
- ORB triggered (broke first 15min high/low)?
- PDH/PDL broken and holding?
- Price vs VWAP aligned?
- 5min EMA 9 vs 21 aligned?
- MACD histogram direction?
- RSI in ideal zone (55-72 for CE, 28-45 for PE)?
- Supertrend aligned?
- ATR > 1.5%?
- OI rising in trade direction?
- PCR extreme?
- IV < 40%?
- F&O ban? → Skip immediately
- Clean chart overhead?

### Task 2: Overnight F&O Calls

**Target**: 25-60% premium by next day open  
**Entry**: 2:30-3:10 PM only  
**Exit**: First 30 minutes of next session. Hard. No exceptions.  
**Stop Loss**: 40% of premium  
**Score Threshold**: 70+ (higher than intraday)  

**Additional Checks**:
- Stock held key support all day even when Nifty weak?
- OI buildup > 15% in calls today?
- Delivery % today > 55%?
- Closed in upper 30% of today's candle?
- Block/bulk deal buy side today?
- FII bought index futures today?
- Gift Nifty status?
- No earnings tomorrow?
- No US Fed/CPI/global macro event tonight?
- Gap risk assessment

### Task 3: Equity Calls (Max 2 weeks hold)

**Target**: 20%+ on stock price within 10 trading days  
**Stop Loss**: 7% below entry. Hard stop. No averaging down.  
**Exit**: Target 2 OR day 10 — whichever comes first.  
**Always Active**: Even in VIX danger mode (but position sizing adjusts)  

**Checklist** (25+ checks):
- Delivery % > 65% on breakout day?
- Silent accumulation before breakout?
- FII or DII net buyers this week?
- Consolidation < 6% for 10+ days before breakout?
- Breakout volume > 2.5x avg?
- RS vs Nifty > 1.3 last 10 days?
- 52W position > 65%?
- Above 20, 50, 100, 200 DMA?
- Sector peers showing strength?
- F&O confirmation (if applicable): CE OI building + PCR falling

---

## Premium Estimation Formula

When live option premium data is unavailable, the system uses a **4-step estimation formula**:

### Step 1: Base Premium
```
Base Premium = CMP × ATR% × 0.035
```

### Step 2: IV Multiplier
```
If IV available: IV Multiplier = IV / 20
If IV missing: Estimate from VIX
  VIX < 13   → Stock IV = VIX × 1.2
  VIX 13-16  → Stock IV = VIX × 1.4
  VIX 16-20  → Stock IV = VIX × 1.6
  VIX 20-25  → Stock IV = VIX × 1.8
  VIX > 25   → Stock IV = VIX × 2.0
IV Multiplier = Estimated IV / 20
```

### Step 3: Time Multiplier
```
DTE 0-2  → 0.6  (heavy theta decay)
DTE 3-5  → 1.0  (base case)
DTE 6-10 → 1.4  (more time value)
DTE > 10 → 1.8  (rich premium)
```

### Step 4: Moneyness Multiplier
```
ATM (0 strikes away)  → 1.0
OTM 1 strike away     → 0.5
OTM 2 strikes away    → 0.25
ITM 1 strike          → 1.8
```

### Final Formula
```
Estimated Premium = Base Premium × IV Multiplier × Time Multiplier × Moneyness Multiplier
Entry Range = Estimated Premium × 0.85 to × 1.15
```

### Reality Checks
- Minimum viable premium: ₹5 (illiquid below this)
- For stocks > ₹500 CMP: minimum ₹10
- Tagged as `[EST-PREMIUM]` in output
- Always verify on broker terminal before entry

---

## Scoring System

Every stock is scored out of **100 points**:

### Operator Signals (40 points)
- Clear footprint identified (1-8): **+15**
- OI moving in trade direction: **+10**
- Delivery % confirms smart money: **+8**
- FII/DII/Block deal confirmation: **+7**

### Technical Signals (35 points)
- EMA trend aligned: **+8**
- MACD confirmed: **+7**
- Volume spike confirmed: **+8**
- Supertrend aligned: **+7**
- RSI in ideal zone: **+5**

### Risk/Timing (25 points)
- Clean chart, no resistance overhead: **+10**
- VIX in safe zone: **+8**
- No event risk: **+7**

### Score Bands

| Score | Band | Emoji | Action |
|-------|------|-------|--------|
| **85-100** | ALPHA | 🔥 | Maximum conviction. Full position. |
| **70-84** | STRONG | ⭐ | High conviction. Standard position. |
| **55-69** | VALID | ✅ | Good setup. Reduced position. |
| **40-54** | WEAK | ⚠️ | Include with caution. Half size. |
| **< 40** | DISCARD | ❌ | Do not list. |

### Special Picks
- **⭐ STAR PICK**: Stock appears in Task 1 + Task 2
- **🔥 ALPHA PICK**: Stock appears in all 3 tasks (highest conviction)

---

## API Endpoints

All endpoints require authentication (same session as main scanner).

### Run Full Scan
```http
POST /api/operator/scan
Content-Type: application/json

{
  "marketContext": {
    "niftyBelowVWAP": false,
    "giftNifty": 50,
    "fiiFlow": 500,
    "diiFlow": 300
  }
}

Response:
{
  "ok": true,
  "timestamp": "2026-04-11T...",
  "vix": { "value": 14.5, "mode": "GREEN MODE", ... },
  "task1": { "calls": [...], "summary": {...} },
  "task2": { "calls": [...], "summary": {...} },
  "task3": { "calls": [...], "summary": {...} },
  "starPicks": ["RELIANCE", "TCS"],
  "alphaPicks": ["HDFCBANK"],
  "marketSummary": {...}
}
```

### Get Cached State
```http
GET /api/operator/state
```

### Get Individual Tasks
```http
GET /api/operator/intraday
GET /api/operator/overnight
GET /api/operator/equity
GET /api/operator/market-summary
```

---

## UI Access

### Operator Scanner Dashboard
Access at: **http://localhost:4000/operator**

Features:
- Real-time VIX display
- 3 tabs for each task
- Color-coded CE/PE cards
- Operator footprint details
- Entry/exit rules
- Risk warnings
- Market summary block
- STAR/ALPHA pick highlighting

### Main Scanner Integration
Access at: **http://localhost:4000**

The operator scanner works alongside your existing scanner. No conflicts.

---

## Usage Guide

### Quick Start

1. **Start the server**:
   ```bash
   npm start
   ```

2. **Login via main UI** (http://localhost:4000)

3. **Access operator scanner** at http://localhost:4000/operator

4. **Click "Run Full Operator Scan"** or wait for auto-scan

### Reading the Output

#### Example Intraday Call
```json
{
  "rank": 1,
  "score": 87,
  "score_band": "🔥 ALPHA",
  "stock": "RELIANCE",
  "operator_footprint": "#3: MARKUP PHASE RALLY — Operator pushing price...",
  "trade": "BUY CE",
  "strike": "2450",
  "expiry": "16-APR-2026",
  "entry_price_range": "₹18.50–₹25.10 [EST-PREMIUM]",
  "entry_window": "9:30-10:15 AM",
  "target_premium": "20-50% gain",
  "stop_loss": "30% of premium paid",
  "exit_rule": "Hard exit 3:00 PM regardless of P&L",
  "confidence": 9,
  "reason": [
    "Operator: MARKUP PHASE RALLY (conviction: 75%)",
    "Technical: 28/35 — Volume spike, MACD confirmed",
    "Risk: 22/25 — Bullish setup"
  ]
}
```

### Trading Rules

**NEVER**:
- Enter between 12:00-1:30 PM (lunch chop zone)
- Hold Task 1 calls past 3:00 PM
- Ignore stop losses
- Trade F&O banned stocks
- Buy CE in primary downtrend (unless stop hunt recovery)

**ALWAYS**:
- Check VIX mode first
- Verify [EST-PREMIUM] values on broker terminal
- Follow exit rules strictly
- Reduce position size in high VIX modes
- Flag liquidity risks

---

## Data Requirements

### Minimum Required Data (from main scanner)
- Current Market Price (CMP)
- Day High/Low
- Volume
- EMA 21/50
- MACD
- RSI
- VWAP
- 52W High/Low

### Enhanced Data (for better accuracy)
- Option chain data (OI, IV, PCR)
- Delivery percentage
- FII/DII flow data
- Block/bulk deals
- Earnings calendar
- Sector peer movement
- Gift Nifty value

### Data Gap Handling

When data is missing:
- **Strike**: Estimated from CMP → tagged `[EST]`
- **Premium**: Calculated via 4-step formula → tagged `[EST-PREMIUM]`
- **IV**: Estimated from VIX → tagged `[EST-IV]`
- **OI**: Skipped if unavailable → noted in output
- **Delivery %**: Skipped if unavailable → noted in output

**NEVER fabricate data. Always tag estimates.**

---

## Integration with Main Scanner

The operator scanner integrates seamlessly with your existing scanner:

### Data Transform
```javascript
import { transformScannerData } from "./src/operator_scanner.mjs";

const operatorData = transformScannerData(mainScannerState, optionsCache);
```

### Running Scans Together
Both scanners run independently:
- **Main scanner**: Technical indicators, golden cross, BUY/SELL signals
- **Operator scanner**: Footprint detection, scoring, trade calls

### Shared Resources
- Session authentication
- Rate limiting
- Option chain cache
- Universe of stocks

---

## Files Created

```
src/
├── vix_manager.mjs          # VIX mode controller
├── premium_calc.mjs         # Option premium estimation
├── operator_engine.mjs      # Footprint detection & scoring
├── intraday_scanner.mjs     # Task 1 implementation
├── overnight_scanner.mjs    # Task 2 implementation
├── equity_scanner.mjs       # Task 3 implementation
└── operator_scanner.mjs     # Master orchestrator

public/
└── operator.html            # Dedicated UI dashboard

scanner_testing.mjs          # Updated with API endpoints
```

---

## Important Warnings

⚠️ **This is NOT financial advice.** This is a tool to help you make better decisions.

⚠️ **Always verify** [EST-PREMIUM] values on your broker terminal before entering trades.

⚠️ **Past patterns don't guarantee future results.** Operators change tactics.

⚠️ **Risk management is your responsibility.** Never trade more than you can afford to lose.

⚠️ **VIX > 25 means DANGER.** Task 2 (overnight) is suspended. Respect this.

---

## Troubleshooting

### "No calls generated"
- Check VIX mode - high VIX restricts tasks
- Verify main scanner has recent data
- Check if stocks meet score threshold (40+ for intraday, 70+ for overnight)

### "VIX showing default value"
- NSE API might be unreachable
- System falls back to estimated VIX from Nifty options
- Still functional, just less accurate

### "Premium estimates seem off"
- Verify ATR% calculation
- Check days to expiry
- Remember these are estimates - verify on broker terminal

### "API returns 401"
- Login to main scanner first
- Session must be active

---

## Performance Notes

- **Scan time**: ~30-60 seconds for all 3 tasks (depends on universe size)
- **Rate limiting**: Respects Groww API limits (8 req/sec, 250/min)
- **Caching**: VIX state cached, option chain uses existing cache
- **Memory**: Efficient - transforms only necessary data

---

## Future Enhancements

- [ ] Real-time FII/DII flow integration
- [ ] Earnings calendar integration
- [ ] Block/bulk deal detection
- [ ] Backtesting module for footprint patterns
- [ ] WebSocket for live updates
- [ ] Telegram/Slack alerts for STAR/ALPHA picks
- [ ] Paper trading integration

---

## Support

For questions or issues:
1. Check this README first
2. Verify API logs in console
3. Check VIX state and mode
4. Review data availability from main scanner

---

**Built for serious traders who want an edge.** 🚀

*Last updated: April 11, 2026*
