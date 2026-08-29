export function ema(values, period) {
    if (values.length < period) return new Array(values.length).fill(null);
    const k = 2 / (period + 1);
    let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const out = new Array(period - 1).fill(null);
    out.push(e);
    for (let i = period; i < values.length; i++) { e = values[i] * k + e * (1 - k); out.push(e); }
    return out;
}

/**
 * Bollinger Band width at every bar, as a % of the middle band (SMA) — the
 * standard normalized squeeze/expansion measure (comparable across stocks
 * of different price levels, unlike raw band width). Returns an array
 * parallel to `values`; the first `period - 1` entries are null (not enough
 * history yet for that bar's SMA/stdev).
 */
export function bollingerBandWidthPct(values, period = 20, mult = 2) {
    const out = new Array(values.length).fill(null);
    for (let i = period - 1; i < values.length; i++) {
        const window = values.slice(i - period + 1, i + 1);
        const mean = window.reduce((a, b) => a + b, 0) / period;
        const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
        const sd = Math.sqrt(variance);
        if (mean !== 0) out[i] = ((mult * sd * 2) / mean) * 100;
    }
    return out;
}

export function macd(closes, fast = 12, slow = 26, sig = 9) {
    const ef = ema(closes, fast), es = ema(closes, slow);
    const ml = ef.map((v, i) => v !== null && es[i] !== null ? v - es[i] : null);
    const valid = ml.filter(v => v !== null);
    const sl = ema(valid, sig);
    // Correct padding for signal line to match macd line length
    const slFull = new Array(ml.length - sl.length).fill(null).concat(sl);
    return { macd: ml, signal: slFull };
}

export function rsi(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let g = 0, l = 0;
    for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
    let ag = g / period, al = l / period;
    for (let i = period + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        ag = (ag * (period - 1) + Math.max(d, 0)) / period;
        al = (al * (period - 1) + Math.max(-d, 0)) / period;
    }
    return al === 0 ? 100 : +(100 - 100 / (1 + ag / al)).toFixed(2);
}

/**
 * Average True Range (Wilder's smoothing) from OHLC candles.
 * Used to size a "realistic" intraday move — NOT the same thing as
 * historicalVolatility() below (that is an annualised log-return stdev used
 * for option pricing; this is a same-scale-as-price move-capacity measure).
 */
export function atr(candles, period = 14) {
    if (!candles || candles.length < period + 1) return null;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const c = candles[i], p = candles[i - 1];
        trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    }
    if (trs.length < period) return null;
    let a = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
    return Number.isFinite(a) ? a : null;
}

/**
 * Slope of an EMA series over `lookback` bars, expressed as %-change per bar
 * relative to the series' own current level (so it's comparable across
 * stocks at very different price levels). Returns null if not enough data.
 */
export function emaSlopePct(emaArr, lookback = 5) {
    const valid = emaArr.filter(v => v !== null && Number.isFinite(v));
    if (valid.length < lookback + 1) return null;
    const cur = valid[valid.length - 1];
    const prior = valid[valid.length - 1 - lookback];
    if (!prior) return null;
    return ((cur - prior) / prior) * 100 / lookback;
}

/**
 * Running (cumulative) VWAP at every bar. Pass ONLY the current session's
 * candles (e.g. today's 5m candles) — VWAP is defined to reset each session,
 * and this function does not know where a "day" boundary is. Returns an
 * array parallel to `candles`; index i uses only candles[0..i], so this is
 * safe to use in a no-look-ahead context.
 */
export function vwapSeries(candles) {
    if (!candles || candles.length === 0) return [];
    const out = [];
    let tpvSum = 0, volSum = 0;
    for (const c of candles) {
        const tp = (c.high + c.low + c.close) / 3;
        tpvSum += tp * c.volume;
        volSum += c.volume;
        out.push(volSum === 0 ? null : +(tpvSum / volSum).toFixed(2));
    }
    return out;
}

/**
 * VWAP calculation
 */
export function vwap(candles) {
    if (!candles || candles.length === 0) return null;
    let tpvSum = 0, volSum = 0;
    for (const c of candles) {
        const tp = (c.high + c.low + c.close) / 3;
        tpvSum += tp * c.volume;
        volSum += c.volume;
    }
    return volSum === 0 ? null : +(tpvSum / volSum).toFixed(2);
}


// ── Black-Scholes Option Pricer ───────────────────────────────────────────────

/** Standard normal CDF approximation (Abramowitz & Stegun) */
function normCDF(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989422820 * Math.exp(-x * x / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
    return x > 0 ? 1 - p : p;
}

/** Standard normal PDF */
function normPDF(x) { return Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI); }

/**
 * Black-Scholes option greeks for a single strike.
 * @param {number} S  - Spot price
 * @param {number} K  - Strike price
 * @param {number} T  - Time to expiry in YEARS (e.g. 7/365)
 * @param {number} r  - Risk-free rate (annualised, e.g. 0.07 for 7%)
 * @param {number} iv - Implied / Historical volatility (annualised, e.g. 0.25 for 25%)
 * @returns {{ call, put }} — each with { price, delta, gamma, theta, vega, iv }
 */
function bsGreeks(S, K, T, r, iv) {
    if (T <= 0 || iv <= 0) return null;
    const sqrtT = Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r + iv * iv / 2) * T) / (iv * sqrtT);
    const d2 = d1 - iv * sqrtT;

    const Nd1 = normCDF(d1), Nd2 = normCDF(d2);
    const nd1 = normPDF(d1);
    const disc = Math.exp(-r * T);

    const callPrice = S * Nd1 - K * disc * Nd2;
    const putPrice = K * disc * normCDF(-d2) - S * normCDF(-d1);
    const gamma = nd1 / (S * iv * sqrtT);
    const vega = S * nd1 * sqrtT / 100; // per 1% move in IV
    const callTheta = (-(S * nd1 * iv) / (2 * sqrtT) - r * K * disc * Nd2) / 365;
    const putTheta = (-(S * nd1 * iv) / (2 * sqrtT) + r * K * disc * normCDF(-d2)) / 365;

    return {
        call: { price: +callPrice.toFixed(2), delta: +Nd1.toFixed(4), gamma: +gamma.toFixed(6), theta: +callTheta.toFixed(4), vega: +vega.toFixed(4), iv: +(iv * 100).toFixed(2) },
        put: { price: +putPrice.toFixed(2), delta: +(Nd1 - 1).toFixed(4), gamma: +gamma.toFixed(6), theta: +putTheta.toFixed(4), vega: +vega.toFixed(4), iv: +(iv * 100).toFixed(2) },
    };
}

/**
 * Historical Volatility from close prices (annualised std-dev of log returns).
 * Always returns { value, estimated } — never a bare number — so a caller
 * with genuinely insufficient history can tell a real computed HV apart
 * from the 25% placeholder, instead of both looking like the same real
 * number. (buildSignal(), the only live caller, guards cls.length >= 55
 * before calling this, so `estimated:true` is unreachable from the live
 * scanner today — this exists for any other/future caller.)
 */
export function historicalVolatility(closes, lookback = 20) {
    if (closes.length < lookback + 1) return { value: 0.25, estimated: true };
    const recent = closes.slice(-lookback - 1);
    const returns = [];
    for (let i = 1; i < recent.length; i++) returns.push(Math.log(recent[i] / recent[i - 1]));
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
    return { value: Math.sqrt(variance * 252), estimated: false }; // annualise
}

/**
 * Generate a theoretical option chain around a spot price.
 * Returns top 5 calls and top 5 puts by profit score, sorted.
 * @param {number} spot  - Last traded price
 * @param {number} hv    - Historical Vol (from historicalVolatility())
 * @param {number} daysToExpiry - Days to next expiry
 * @param {string} symbol - Symbol (to determine strike interval)
 */
export function theoreticalOptionChain(spot, hv, daysToExpiry = 7, symbol = "") {
    const r = 0.07; // India risk-free rate ~7%
    const T = Math.max(0.001, daysToExpiry) / 365;
    const sym = (symbol || "").toUpperCase();

    // ── Accurate Strike Intervals ─────────────────────────────────────────────
    let strikeInterval = 50;
    if (sym === "NIFTY") {
        strikeInterval = 50;
    } else if (sym === "BANKNIFTY") {
        strikeInterval = 100;
    } else if (sym === "FINNIFTY") {
        strikeInterval = 50;
    } else if (sym === "MIDCPNIFTY") {
        strikeInterval = 25;
    } else {
        // Dynamic stock intervals based on NSE price tiers
        if (spot < 100) strikeInterval = 2.5;
        else if (spot < 250) strikeInterval = 5;
        else if (spot < 500) strikeInterval = 10;
        else if (spot < 1000) strikeInterval = 20;
        else if (spot < 2500) strikeInterval = 50;
        else if (spot < 5000) strikeInterval = 100;
        else strikeInterval = 250;
    }

    // ATM strike (nearest interval)
    const atm = Math.round(spot / strikeInterval) * strikeInterval;

    // Generate 12 strikes: 5 ITM, ATM, 6 OTM
    const strikes = [];
    for (let i = -5; i <= 6; i++) strikes.push(atm + i * strikeInterval);

    const chain = [];
    for (const K of strikes) {
        if (K <= 0) continue;
        const g = bsGreeks(spot, K, T, r, hv);
        if (!g) continue;
        const moneyness = K < spot * 0.985 ? "ITM" : K > spot * 1.015 ? "OTM" : "ATM";
        chain.push({
            strikePrice: K,
            moneyness,
            ltp: g.call.price,
            greeks: g.call,
            // null, not 0 — this is a Black-Scholes-modeled chain with no
            // real OI data at all; 0 would read as "confirmed zero open
            // interest," which is a different (and false) claim.
            openInterest: null,
            oiChange: null,
            type: "CE",
        });
        chain.push({
            strikePrice: K,
            moneyness,
            ltp: g.put.price,
            greeks: g.put,
            openInterest: null,
            oiChange: null,
            type: "PE",
        });
    }

    // Score and sort: high delta + high gamma - high theta decay
    const scoreOption = (o) =>
        (Math.abs(o.greeks.delta) * 100) + (o.greeks.gamma * 500) - (Math.abs(o.greeks.theta) * 0.5);

    const calls = chain.filter(o => o.type === "CE").map(o => ({ ...o, score: scoreOption(o) })).sort((a, b) => b.score - a.score).slice(0, 5);
    const puts = chain.filter(o => o.type === "PE").map(o => ({ ...o, score: scoreOption(o) })).sort((a, b) => b.score - a.score).slice(0, 5);

    return { calls, puts, theoretical: true, hv: +(hv * 100).toFixed(1), daysToExpiry };
}
