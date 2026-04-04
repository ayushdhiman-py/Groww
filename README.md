# ⚡ Ayush's Personal Scanner — EMA 21/50 + Multi-Signal Scoring

Nifty 50 + Bank Nifty scanner built on **SmartAPI (Angel One)**.  
Primary signal: **EMA 20 crossing above EMA 50 (Golden Cross)** across all timeframes.  
Additional signals: MACD, Volume spike, RSI, + placeholders for fundamental/news layers.

---

## Quick Start

```bash
npm install
```

Set your credentials (one of two ways):

**Option A — Environment variables (recommended):**
```bash
export SMARTAPI_KEY="your_api_key"
export SMARTAPI_CLIENT="your_angel_one_id"   # e.g. A123456
export SMARTAPI_PASSWORD="your_mpin"          # 4-digit MPIN
export SMARTAPI_TOTP="your_totp_secret"       # from QR scan (base32 string)
node scanner.mjs
```

**Option B — Edit scanner.mjs directly** (top of file, CREDENTIALS object):
```js
const CREDENTIALS = {
  apiKey:     "YOUR_API_KEY",
  clientCode: "YOUR_CLIENT_CODE",
  password:   "YOUR_MPIN",
  totpSecret: "YOUR_TOTP_SECRET",
};
```

Then run:
```bash
node scanner.mjs
# Open http://localhost:4000
# Click "Login with SmartAPI"
```

---

## Getting Your Credentials

| Field | Where to get it |
|---|---|
| API Key | smartapi.angelone.in → Create App → Market Feeds |
| Client Code | Your Angel One login ID (e.g. A123456) |
| Password | Your 4-digit MPIN |
| TOTP Secret | smartapi.angelbroking.com/enable-totp → scan QR → copy the base32 secret |

---

## Signal Scoring System

### Technical Signals (auto-computed from price data)
| # | Signal | Description |
|---|---|---|
| 1 | 🟣 Golden Cross | EMA 20 crosses above EMA 50 — PRIMARY signal |
| 2 | EMA 20 above 50 | EMA 20 currently above EMA 50 |
| 3 | MACD Bullish Cross | MACD fast crosses above signal line |
| 4 | MACD above signal | MACD currently above signal |
| 5 | Volume + Price rise | Volume spike (1.5x avg) with positive price change |
| 6 | RSI healthy | RSI between 45–75 (not oversold, not overbought) |

**Score: 5-6 = STRONG BUY · 3-4 = WATCHLIST · <3 = SKIP**

### Fundamental Signals (wire in separately — APIs below)
- FII buying increasing (1 week)
- DII buying increasing
- Mutual fund holdings increased
- Promoter increasing stake
- Bulk/block deals — institutional buyers
- Low debt + high ROE
- Revenue + profit growing YoY

### News/Sector Signals (wire in separately)
- Positive government policy for sector
- Big contract/order announced
- Sector tailwind (war, budget, global trend)
- China+1 beneficiary
- Export approval (especially pharma)

### Red Flags (auto-detected technically + fundamentals)
- Promoter pledging shares
- FII selling consistently
- Debt increasing QoQ
- Revenue falling 2 quarters in a row
- Promoter reducing stake

---

## Adding Fundamental Data (Future Integration)

The `buildScorecard()` function is already structured to accept `fundScore` and `newsScore`.  
Data sources to wire in:

| Data | API / Source |
|---|---|
| FII/DII flows | NSE India bulk data download (free) |
| Promoter holding | BSE shareholding pattern (quarterly) |
| Bulk/block deals | NSE bulk deals CSV (daily free download) |
| Revenue/profit | Screener.in API or Trendlyne API |
| News | NewsAPI.org or Google News RSS |

---

## SmartAPI Rate Limits
- Historical data: ~3 req/sec (handled automatically)
- Full scan of 59 stocks × 8 timeframes ≈ 3–5 minutes
- Auto re-scans every 3 minutes

## Timeframes Available
`1m · 3m · 5m · 10m · 15m · 30m · 1h · 1d`

## Notes
- Tokens expire at midnight — re-login daily (one click)
- Historical data API does **not** require static IP (only order placement does)
- No orders are placed by this scanner
