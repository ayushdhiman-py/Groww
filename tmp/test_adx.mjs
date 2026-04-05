import { adx } from '../src/indicators.mjs';

const candles = Array.from({length: 100}, (_, i) => ({
    high: 1500 + i,
    low: 1400 + i,
    close: 1450 + i,
    open: 1450 + i,
    ts: Date.now() - (100 - i) * 60000
}));

console.log('ADX Test:', adx(candles));
