// ─────────────────────────────────────────────────────────────────────────────
// notifications.mjs — Cooldown/debounce for Critical-trade alerts.
// Prevents the same alert type re-firing every ~30s scan cycle while a
// condition persists; each trade tracks its own last-fired time per type.
// ─────────────────────────────────────────────────────────────────────────────

const COOLDOWN_MS = {
    "MOMENTUM WEAKENING": 5 * 60 * 1000,
    "PROFIT PROTECTION": 5 * 60 * 1000,
    "EXHAUSTION": 10 * 60 * 1000,
    "PROFIT GIVEBACK": 5 * 60 * 1000,
    "STRONG EXIT WARNING": 3 * 60 * 1000,
    "THESIS INVALIDATED": 3 * 60 * 1000,
    "BETTER OPPORTUNITY": 10 * 60 * 1000,
    "MOMENTUM RECOVERED": 5 * 60 * 1000,
};

export function shouldNotify(trade, type, nowMs = Date.now()) {
    const last = trade.lastNotifiedAt?.[type];
    const cooldown = COOLDOWN_MS[type] ?? 5 * 60 * 1000;
    return !last || (nowMs - last) >= cooldown;
}

function recordNotification(trade, type, message, severity) {
    const now = Date.now();
    if (!trade.notifications) trade.notifications = [];
    if (!trade.lastNotifiedAt) trade.lastNotifiedAt = {};
    trade.notifications.unshift({ id: `${type}-${now}`, type, message, severity, ts: new Date(now).toISOString() });
    trade.notifications = trade.notifications.slice(0, 30);
    trade.lastNotifiedAt[type] = now;
}

/** Returns true (and records) if this notification actually fired, false if it was suppressed by cooldown. */
export function maybeNotify(trade, type, message, severity = "info", nowMs = Date.now()) {
    if (!shouldNotify(trade, type, nowMs)) return false;
    recordNotification(trade, type, message, severity);
    return true;
}
