import { startTrialMinuteWorker } from "./trial_worker.mjs";

export function activateMarketData() {
    // existing activation logic (websocket boot etc.)

    try {
        // Start trial worker conservatively — only on authenticated mode in real server
        startTrialMinuteWorker({ intervalMs: 60_000, limit: 250 });
        console.log('[MarketData] Trial minute worker started');
    } catch (e) {
        console.warn('[MarketData] Failed to start Trial worker:', e?.message || e);
    }
}
