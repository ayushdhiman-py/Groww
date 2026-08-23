# 📊 Ayush's Scanner

> Real-time Indian stock market scanner with EMA 20/50 Golden Cross, MACD, RSI, and multi-signal analysis

[![Deploy to Render](https://img.shields.io/badge/Deploy%20to-Render-46E3B7?style=for-the-badge&logo=render)](https://render.com)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js)](https://nodejs.org)
[![Upstox API](https://img.shields.io/badge/API-Upstox-00D4AA?style=for-the-badge)](https://upstox.com)

## ✨ Features

- 🎯 **241+ Stocks** scanned in real-time
- 📈 **Technical Indicators**: EMA 21/50, MACD, RSI, VWAP, Historical Volatility
- 🔔 **Signal Detection**: Golden Cross, Death Cross, BUY/SELL signals
- 📊 **Multiple Timeframes**: 1m, 5m, 10m, 15m, 30m, 1h, 1d
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
│   ├── indicators.mjs       # Technical indicators
│   ├── universe.mjs         # Stock universe (241 symbols)
│   └── options_feed.mjs     # Options data feed
├── public/
│   └── index.html           # Frontend UI (single-file app)
├── scanner_testing.mjs      # Express server entry point
├── render.yaml              # Render deployment config
├── DEPLOYMENT.md            # Deployment guide
└── ENV_VARIABLES.md         # Environment variables docs
```

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
| `3` | F&O tab |
| `4` | BUY signals tab |
| `5` | SELL signals tab |
| `7` | Sectors tab |
| `8` | Portfolio tab |

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
