export function ema(values, period) {
    if (values.length < period) return new Array(values.length).fill(null);
    const k = 2 / (period + 1);
    let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const out = new Array(period - 1).fill(null);
    out.push(e);
    for (let i = period; i < values.length; i++) { e = values[i] * k + e * (1 - k); out.push(e); }
    return out;
}

export function macd(closes, fast = 12, slow = 26, sig = 9) {
    const ef = ema(closes, fast), es = ema(closes, slow);
    const ml = ef.map((v, i) => v !== null && es[i] !== null ? v - es[i] : null);
    const valid = ml.filter(v => v !== null);
    const sl = ema(valid, sig);
    const pad = ml.length - valid.length + sig - 1;
    const slFull = new Array(pad).fill(null).concat(sl.filter(v => v !== null));
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
