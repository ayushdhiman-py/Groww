# 📊 Ayush's Groww Scanner

> Real-time Indian stock market scanner with EMA 20/50 Golden Cross, MACD, RSI, and multi-signal analysis

[![Deploy to Render](https://img.shields.io/badge/Deploy%20to-Render-46E3B7?style=for-the-badge&logo=render)](https://render.com)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js)](https://nodejs.org)
[![Groww API](https://img.shields.io/badge/API-Groww-00D4AA?style=for-the-badge)](https://groww.in)

## ✨ Features

- 🎯 **242+ Stocks** scanned in real-time
- 📈 **Technical Indicators**: EMA 21/50, MACD, RSI, VWAP, Historical Volatility
- 🔔 **Signal Detection**: Golden Cross, Death Cross, BUY/SELL signals
- 📊 **Multiple Timeframes**: 1m, 5m, 10m, 15m, 30m, 1h, 1d
- 🎨 **Beautiful UI**: Dark theme with live price updates
- ⚡ **Live Feed**: Real-time LTP polling during market hours
- 📱 **Responsive**: Works on desktop and mobile
- 🆓 **F&O Data**: Option chain analysis for derivatives

## 🚀 Quick Start

### Local Development

```bash
# Install dependencies
npm install

# Set environment variables (Windows)
set GROWW_API_KEY=your_api_key
set GROWW_API_SECRET=your_api_secret

# Or (PowerShell)
$env:GROWW_API_KEY="your_api_key"
$env:GROWW_API_SECRET="your_api_secret"

# Or (Linux/Mac)
export GROWW_API_KEY=your_api_key
export GROWW_API_SECRET=your_api_secret

# Start server
npm start

# Visit http://localhost:4000
```

### One-Click Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render.svg)](https://render.com/deploy?repo=https://github.com/YOUR_USERNAME/groww-scanner)

See [DEPLOYMENT.md](./DEPLOYMENT.md) for complete deployment instructions.

## 📁 Project Structure

```
groww-scanner/
├── src/
│   ├── scanner.mjs          # Main scanning logic
│   ├── feed.mjs             # Live price polling
│   ├── groww.mjs            # Groww API client
│   ├── config.mjs           # Configuration
│   ├── indicators.mjs       # Technical indicators
│   ├── universe.mjs         # Stock universe (242 symbols)
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
- ✅ Session tokens stored securely (`.groww_session.json`)
- ✅ `.gitignore` configured to exclude secrets

## 📊 API Rate Limits

Groww API limits (handled automatically):
- **10 requests/second** (hard cap)
- **300 requests/minute** (live data group)
- Scanner uses intelligent rate limiting with backoff

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
- **API**: Groww (SmartAPI)
- **Deployment**: Render, Oracle Cloud, or any Node.js host

## 📝 Market Hours

Scanner operates during **Indian market hours** (IST):
- **Open**: 9:15 AM IST
- **Close**: 3:30 PM IST
- **Days**: Monday - Friday (excluding holidays)

Outside market hours, the scanner shows the last known signals.

## 🐛 Troubleshooting

### "No session" error
- Login via the web UI
- Session persists for 23 hours

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
2. **Set up** Groww API credentials
3. **Deploy** using instructions in [DEPLOYMENT.md](./DEPLOYMENT.md)
4. **Start trading smarter!** 📈

Happy Trading! 🎉
