// Supertrend and small helper indicators

export function ema(values, period) {
    const out = [];
    const k = 2 / (period + 1);
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (i === 0) out.push(v);
        else out.push((v - out[i - 1]) * k + out[i - 1]);
    }
    return out;
}

export function macd(values, fast = 12, slow = 26, signal = 9) {
    const fastEma = ema(values, fast);
    const slowEma = ema(values, slow);
    const macdLine = values.map((_, i) => (fastEma[i] != null && slowEma[i] != null) ? (fastEma[i] - slowEma[i]) : null);
    const signalLine = ema(macdLine.map(v => v == null ? 0 : v), signal);
    return { macd: macdLine, signal: signalLine };
}

export function rsi(values, period = 14) {
    if (!values || values.length <= period) return null;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const diff = values[i] - values[i - 1];
        if (diff > 0) gains += diff; else losses -= diff;
    }
    let avgGain = gains / period, avgLoss = losses / period;
    for (let i = period + 1; i < values.length; i++) {
        const diff = values[i] - values[i - 1];
        avgGain = ((avgGain * (period - 1)) + (diff > 0 ? diff : 0)) / period;
        avgLoss = ((avgLoss * (period - 1)) + (diff < 0 ? -diff : 0)) / period;
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

export function atr(candles, period = 14) {
    if (!candles || candles.length <= period) return null;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const high = candles[i].high, low = candles[i].low, prevClose = candles[i - 1].close;
        trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }
    let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trs.length; i++) atr = ((atr * (period - 1)) + trs[i]) / period;
    return atr;
}

export function supertrend(candles, period = 10, multiplier = 3) {
    // candles: [{high, low, close, ts}]
    if (!candles || candles.length < period + 2) return null;
    const atrVals = [];
    for (let i = 0; i < candles.length; i++) {
        if (i === 0) atrVals.push(0); else {
            const high = candles[i].high, low = candles[i].low, prevClose = candles[i - 1].close;
            const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
            atrVals.push(tr);
        }
    }
    // Simple ATR smoothing
    let atr = atrVals.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
    const finalUpper = new Array(candles.length).fill(null);
    const finalLower = new Array(candles.length).fill(null);
    const trend = new Array(candles.length).fill(null);

    for (let i = period; i < candles.length; i++) {
        if (i > period) {
            const tr = atrVals[i];
            atr = ((atr * (period - 1)) + tr) / period;
        }
        const hl2 = (candles[i].high + candles[i].low) / 2;
        const basicUpper = hl2 + multiplier * atr;
        const basicLower = hl2 - multiplier * atr;
        finalUpper[i] = (i === period) ? basicUpper : Math.min(basicUpper, finalUpper[i - 1]);
        finalLower[i] = (i === period) ? basicLower : Math.max(basicLower, finalLower[i - 1]);

        if (candles[i].close <= finalUpper[i]) {
            trend[i] = 'DOWN';
        } else if (candles[i].close >= finalLower[i]) {
            trend[i] = 'UP';
        } else {
            trend[i] = trend[i - 1] || 'DOWN';
        }
    }

    return { trend: trend[candles.length - 1], finalUpper: finalUpper[candles.length - 1], finalLower: finalLower[candles.length - 1] };
}
