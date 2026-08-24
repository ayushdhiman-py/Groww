# 📊 Ayush's Scanner

> Real-time Indian stock market scanner with EMA 20/50 Golden Cross, MACD, RSI, and multi-signal analysis

[![Deploy to Render](https://img.shields.io/badge/Deploy%20to-Render-46E3B7?style=for-the-badge&logo=render)](https://render.com)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js)](https://nodejs.org)
[![Upstox API](https://img.shields.io/badge/API-Upstox-00D4AA?style=for-the-badge)](https://upstox.com)

## ✨ Features

- 🎯 **241+ Stocks** scanned in real-time
- 📈 **Technical Indicators**: EMA 9/21/50, MACD, RSI, VWAP (+ session VWAP slope), ATR, Historical Volatility
- 🔔 **Signal Detection**: Golden Cross, Death Cross, BUY/SELL signals
- 📊 **Multiple Timeframes**: 1m, 5m, 10m, 15m, 30m, 1h, 1d
- 🧭 **Intraday Opportunities**: server-computed Opportunity Score (0–100), Entry Attractiveness, and an ATR/structure-bounded Upside Potential estimate — see below
- 🎯 **Critical Trades**: mark a position Critical after entering it; a Trade Health engine continuously monitors it and warns on deterioration, profit giveback, and traps
- 🌡️ **Market Regime**: BULLISH / BEARISH / SIDEWAYS classification with a NO TRADE flag when conditions are unfavorable
- 🧪 **Backtesting**: `npm run backtest` replays the exact live scoring/health logic against real historical Upstox candles, with no look-ahead
- 🎨 **Beautiful UI**: Dark theme with live price updates
- ⚡ **Live Feed**: Real-time LTP streaming via Upstox WebSocket during market hours
- 📱 **Responsive**: Works on desktop and mobile
- 🆓 **F&O Data**: Option chain analysis for derivatives

## 🚀 Quick Start

### Local Development

```bash
# Install dependencies
npm install

# Set environment variables (Windows)
set UPSTOX_ACCESS_TOKEN=your_upstox_analytics_token

# Or (PowerShell)
$env:UPSTOX_ACCESS_TOKEN="your_upstox_analytics_token"

# Or (Linux/Mac)
export UPSTOX_ACCESS_TOKEN=your_upstox_analytics_token

# Start server
npm start

# Visit http://localhost:4000
```

### One-Click Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render.svg)](https://render.com/deploy?repo=https://github.com/ayushdhiman-py/Groww)

See [DEPLOYMENT.md](./DEPLOYMENT.md) for complete deployment instructions.

## 📁 Project Structure

```
Groww/
├── src/
│   ├── scanner.mjs          # Main scanning logic
│   ├── feed.mjs             # Live LTP feed (Upstox WebSocket)
│   ├── upstox.mjs           # Upstox API client
│   ├── instruments.mjs      # Upstox instrument master / symbol resolver
│   ├── config.mjs           # Configuration
│   ├── indicators.mjs       # Technical indicators (EMA/MACD/RSI/VWAP/ATR)
│   ├── price_action.mjs     # Swing structure, breakout/retest/rejection detection
│   ├── sector_history.mjs   # Rolling per-sector snapshots for real sector momentum
│   ├── entry_score.mjs      # Opportunity Score, Entry Attractiveness, Upside Potential
│   ├── market_regime.mjs    # BULLISH/BEARISH/SIDEWAYS regime classification
│   ├── critical_trades.mjs  # MARK CRITICAL persistence + per-scan orchestrator
│   ├── trade_health.mjs     # Trade Health engine, exit priorities, trap detection
│   ├── notifications.mjs    # Debounced Critical-trade alerts
│   ├── capital_rotation.mjs # "Better opportunity" suggestions for weakening trades
│   ├── backtest.mjs         # Offline historical replay/backtester (see below)
│   ├── universe.mjs         # Stock universe (241 symbols)
│   └── options_feed.mjs     # Options data feed
├── public/
│   └── index.html           # Frontend UI (single-file app)
├── data/                    # Critical trades store (gitignored, runtime only)
├── scanner_testing.mjs      # Express server entry point
├── render.yaml              # Render deployment config
├── DEPLOYMENT.md            # Deployment guide
└── ENV_VARIABLES.md         # Environment variables docs
```

## 🧭 Intraday Decision Support

The **Intraday** tab ranks stocks with a server-side scoring engine (`src/entry_score.mjs`) instead of a simple two-timeframe filter:

- **Opportunity Score (0–100)** — "how strong is the stock?" Weighted, non-double-counted buckets: price action/structure (incl. previous-day high breakout/rejection), opening strength, session VWAP (incl. reclaim detection), opening-range breakout (5m/15m/30m), volume, relative strength (vs NIFTY snapshot + trend, vs sector strength + momentum), and EMA/MACD/RSI as a small confirmation allowance only. Gated (not just added to) by liquidity and ATR, and discounted post-score by real bid/ask spread (fetched for the shortlist only, via Upstox's full-quote endpoint) when it's wider than typical. Bands: 90–100 VERY STRONG, 80–89 STRONG, 70–79 WATCH, <70 IGNORE.
- **Entry Attractiveness (0–100)** — a *separate* "is NOW a good entry?" score. Peaks in the 0–2.5% move-from-open zone and decays the more of the stock's typical daily range (ATR%) is already used up — deliberately discourages chasing a stock that already made its move.
- **Upside Potential** — an Estimated Upside Zone, Remaining Upside %, and a LOW/MEDIUM/HIGH Confidence label, derived from ATR, price structure, and real resistance levels (previous-day high, 52-week high) — never just "price + 5%", and never presented as guaranteed.

### Critical Trades

After entering a position, hit **Mark Critical** on its Intraday row (stores symbol, entry price, quantity, entry time, optional stop/target — persisted to `data/critical_trades.json`). Every ~30s scan cycle, the **Trade Health Engine** (`src/trade_health.mjs`) re-scores it 0–100 using a *different* priority order than entry (price action > VWAP > volume > relative strength > EMA/MACD/RSI, which only confirm and never trigger an exit alone):

| Score | State |
|---|---|
| 90–100 | STRONG HOLD |
| 80–89 | HOLD |
| 70–79 | MOMENTUM WEAKENING |
| 60–69 | PROFIT PROTECTION |
| 50–59 | STRONG EXIT WARNING |
| <50 | THESIS INVALIDATED |

It also tracks peak profit for giveback detection, classifies trap risk (breakout without volume, failed ORB retest, rejection wicks, deteriorating volume/RS while price rises — observable behaviour, not a claim about who's behind it), keeps rolling minute-by-minute history, and surfaces `BETTER OPPORTUNITY AVAILABLE` suggestions from the same scan's Intraday Opportunities list — it never places, closes, or resizes a trade automatically. Notifications (Momentum Weakening, Profit Protection, Exhaustion, Profit Giveback, Strong Exit Warning, Thesis Invalidated, Better Opportunity, Momentum Recovered) are debounced per trade and require confirmation across two consecutive checks before a strong warning fires — one bad tick never triggers one on its own.

### Market Regime

`GET /api/regime` (and the banner on the Intraday tab) classifies the tape BULLISH / BEARISH / SIDEWAYS from NIFTY's own trend vs. its session VWAP plus breadth across the scanned universe, and raises the Opportunity Score bar (or shows **NO TRADE**) when conditions are unfavorable, instead of using a fixed entry bar all the time.

### Backtesting

```bash
npm run backtest -- --symbols=RELIANCE,TCS --devFrom=2026-06-01 --devTo=2026-07-15 --valFrom=2026-07-16 --valTo=2026-08-20
```

Replays real historical Upstox candles bar-by-bar, feeding only `candles.slice(0, i+1)` (never a future bar) into the *same* scoring/health functions the live app uses. Reports win rate, expectancy, profit factor, average/median return, max drawdown, false-positive rate, MFE/MAE, and profit giveback — broken out by entry score band and by separate dev/validation periods. It also reports a **Trade Health calibration**: every evaluated bar of every simulated open trade is bucketed by its health score (90–100 / 80–89 / 70–79 / 60–69 / 50–59 / <50) and matched against the actual return from that bar's price to that day's real close, checking whether a lower health score really did predict a worse outcome (`healthCalibrationMonotonic`) rather than just looking plausible. Bucket counts are usually small (quality setups are rare by design) — treat it as a directional check, not a precision instrument, until a bucket's count is in the dozens+.

A 15-symbol, dev+validation run was actually done (2026-07-27–08-14 dev, 08-17–08-21 validation): the dev period was NOT monotonic (bands 90 down to 60 were flat at ~0.11% forward return with no differentiation, and the <50 "THESIS INVALIDATED" band showed the *highest* forward return of any band, backwards from theory, on only 10 samples); the validation period WAS monotonic and sensible, but its worst bands had only 13 and 0 samples. **The thresholds were left unchanged** — the two periods disagree and the decision-critical low bands have nowhere near enough samples to justify moving numbers for a system trading real money. The Opportunity Score's VERY STRONG (90+) band had zero observations in both periods — genuinely unvalidated, not just rare. Re-run with more symbols/longer windows before trusting this further.

Runtime is network/rate-limit-bound (each symbol needs a few historical-candle requests), not compute-bound — scope `--symbols` down for a quick check; omitting it defaults to the full universe and a long run. See the caveats it prints (no cross-sectional sector breadth for small symbol sets, fixed end-of-day exit, systematic exit rule rather than a human reading live notifications).

## 🎯 Trading Signals

### BUY Signal Conditions
- Golden Cross (EMA 21 crosses above EMA 50)
- EMA 21 above EMA 50 + MACD bullish crossover
- Volume spike with price increase
- RSI in healthy range (45-75)
- Price above VWAP

### SELL Signal Conditions
- Death Cross (EMA 21 crosses below EMA 50)
- EMA 21 below EMA 50 + MACD bearish crossover
- Volume collapse
- RSI overbought (>80) or oversold (<25)

### Rating System
- **STRONG BUY**: 5+ technical checks pass
- **MODERATE**: 3-4 checks pass
- **SKIP**: <3 checks pass

## 🌐 Live Deployment

### Free Hosting Options

| Platform | Cost | Always On | Setup Time |
|----------|------|-----------|------------|
| **Oracle Cloud VM** | $0 | ✅ Yes | 15 min |
| **Render + UptimeRobot** | $0 | ✅ Yes | 10 min |
| **Render Free** | $0 | ❌ Sleeps | 5 min |

**Recommended**: Oracle Cloud Always-Free VM (4 cores, 24GB RAM, never sleeps)

See [DEPLOYMENT.md](./DEPLOYMENT.md) for step-by-step instructions.

## 🔐 Security

- ⚠️ **NEVER** commit API keys to git
- ✅ Use environment variables for sensitive data
- ✅ `.gitignore` configured to exclude secrets and the local `.env` file

## 📊 API Rate Limits

Upstox API limits (handled automatically by a shared, conservative rate limiter):
- Requests are throttled well under Upstox's published per-second/per-minute caps
- Live prices flow over a WebSocket feed rather than REST polling, minimizing REST call volume
- Automatic backoff on 429 (rate-limited) responses

## ⌨️ Keyboard Shortcuts

When using the web interface:

| Key | Action |
|-----|--------|
| `R` | Refresh scan |
| `/` | Focus search |
| `Esc` | Close modal |
| `1` | Golden Cross tab |
| `2` | All Stocks tab |
| `3` | Intraday tab |
| `4` | Top F&O tab |
| `5` | BUY signals tab |
| `6` | SELL signals tab |
| `7` | Sectors tab |
| `8` | Portfolio tab |
| `9` | Screeners tab |
| `c` | Critical trades tab |

## 🛠 Tech Stack

- **Backend**: Node.js, Express, Axios
- **Frontend**: Vanilla JS, Chart.js, Custom CSS
- **API**: Upstox (Analytics Token, no daily login required)
- **Deployment**: Render, Oracle Cloud, or any Node.js host

## 📝 Market Hours

Scanner operates during **Indian market hours** (IST):
- **Open**: 9:15 AM IST
- **Close**: 3:30 PM IST
- **Days**: Monday - Friday (excluding holidays)

Outside market hours, the scanner shows the last known signals rather than continuing to re-scan, to avoid burning API calls on data that can't change while the market is shut.

## 🐛 Troubleshooting

### "Upstox authentication failed" on startup
- Verify `UPSTOX_ACCESS_TOKEN` is set correctly (Upstox Developer Apps → Analytics tab → Generate Token)
- The token is long-lived (~1 year) but does expire eventually — regenerate it if rejected

### Rate limit errors
- Wait 1-2 minutes (auto-handled)
- Check if multiple instances are running

### App crashes on deploy
- Verify environment variables are set
- Check logs in your hosting platform

## 📄 License

Private - For personal use only

## 👤 Author

**Ayush**  
Built with ❤️ for Indian stock market traders

---

## 🚀 Deploy Now

1. **Fork/Clone** this repository
2. **Generate** an Upstox Analytics Token
3. **Deploy** using instructions in [DEPLOYMENT.md](./DEPLOYMENT.md)
4. **Start trading smarter!** 📈

Happy Trading! 🎉
