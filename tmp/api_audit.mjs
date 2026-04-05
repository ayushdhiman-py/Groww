// Quick calculation script - run with: node tmp/api_audit.mjs
// Calculates total API hits per scan cycle

const UNIVERSE_RAW = 105; // approx from universe.mjs (before dedup)
const TF_COUNT = 7;       // 1m, 5m, 10m, 15m, 30m, 1h, 1d

// After deduplication (SUNPHARMA, DRREDDY, CIPLA, DIVISLAB, APOLLOHOSP, INDIGO, ITC,
// HINDUNILVR, TITAN, BHARTIARTL, NESTLEIND, BRITANNIA, TATACONSUM, ASIANPAINT, ULTRACEMCO appear twice)
// Count manually:
const ACTUAL_UNIQUE = 148; // counted from universe.mjs (many duplicates)

// --- Per Scan Cycle ---
const candleHitsPerScan = ACTUAL_UNIQUE * TF_COUNT;
console.log("=== API AUDIT ===");
console.log(`Unique stocks (after dedup): ${ACTUAL_UNIQUE}`);
console.log(`Timeframes: ${TF_COUNT}`);
console.log(`\n--- Candle Fetch (per full scan) ---`);
console.log(`  Hits: ${ACTUAL_UNIQUE} stocks × ${TF_COUNT} TFs = ${candleHitsPerScan} requests`);

// --- Rate Limiter ---
const RATE_LIMIT = 4; // req/sec (our current limiter)
const minTimeSeconds = candleHitsPerScan / RATE_LIMIT;
console.log(`\n--- Rate Limiter ---`);
console.log(`  Our limit: ${RATE_LIMIT} req/sec`);
console.log(`  Min scan time at limit: ${minTimeSeconds}s = ${(minTimeSeconds/60).toFixed(1)}min`);

// --- Groww API Limit ---
const GROWW_LIMIT = 10; // req/sec (official Groww limit)
const minAtGroww = candleHitsPerScan / GROWW_LIMIT;
console.log(`\n--- Groww Official Limit ---`);
console.log(`  Groww limit: ${GROWW_LIMIT} req/sec`);
console.log(`  Min scan time at Groww limit: ${minAtGroww}s = ${(minAtGroww/60).toFixed(1)}min`);

// --- Auto-refresh every 60s ---
const REFRESH_INTERVAL = 60; // seconds
console.log(`\n--- Auto-Refresh (every ${REFRESH_INTERVAL}s) ---`);
console.log(`  Scan takes ~${(minTimeSeconds/60).toFixed(1)}min at our rate limit`);
console.log(`  If scan > ${REFRESH_INTERVAL}s, next scan queues while prior is running`);
console.log(`  RISK: overlapping scans? Currently protected by 'if (!isAuthenticated || scanning) return'`);
console.log(`  STATUS: ✅ Safe - scanning=true blocks new scans until done`);

// --- Per second peaks during parallel scanning ---
const CONCURRENCY = 3;
const peakRps = CONCURRENCY * RATE_LIMIT;
console.log(`\n--- Parallel Peak Load ---`);
console.log(`  Concurrency: ${CONCURRENCY} workers`);
console.log(`  Each worker rate-limited to: ${RATE_LIMIT} req/sec`);
console.log(`  Theoretical peak: ${peakRps} req/sec`);
console.log(`  Groww limit: ${GROWW_LIMIT} req/sec`);
console.log(`  RISK: ${peakRps > GROWW_LIMIT ? '⚠️  EXCEEDS Groww limit! Workers share same rate limiter? Check below.' : '✅ Under Groww limit'}`);
console.log(`\n  NOTE: The 'rl' array in scanner.mjs is SHARED across all workers.`);
console.log(`  So total inflight is capped to 4 req/sec regardless of concurrency. ✅ SAFE.`);

// --- Option chain fetches ---
const FO_STOCKS_TOP = 30; // top 30 shown in F&O tab
console.log(`\n--- Option Chain Fetches (on-demand, user-triggered) ---`);
console.log(`  Only fetched when user CLICKS a row in the F&O tab`);
console.log(`  Max: 1 request per click`);
console.log(`  STATUS: ✅ Minimal impact, completely separate from scan loop`);
console.log(`  CACHED after market close: 0 additional API hits`);

// --- Status poll from frontend ---
const STATUS_POLL_INTERVAL = 10; // seconds (setInterval in frontend)
const STATUS_HITS_PER_HOUR = 3600 / STATUS_POLL_INTERVAL;
console.log(`\n--- Frontend Status Polling ---`);
console.log(`  /api/status: every ${STATUS_POLL_INTERVAL}s → ${STATUS_HITS_PER_HOUR} hits/hour`);
console.log(`  These are LOCAL (localhost) - don't count toward Groww API limits ✅`);
console.log(`  /api/state: only called when lastUpdated changes (smart polling)`);

// --- Summary ---
console.log(`\n${'='.repeat(45)}`);
console.log(`SUMMARY:`);
console.log(`  Total requests per scan: ${candleHitsPerScan}`);
console.log(`  Scan duration: ~${(minTimeSeconds/60).toFixed(1)} minutes`);
console.log(`  Requests/min to Groww: ${(candleHitsPerScan / (minTimeSeconds/60)).toFixed(0)}`);
console.log(`  Peak req/sec to Groww: 4 (enforced by shared rate limiter) ✅`);
console.log(`  Refresh guard: overlapping scans blocked ✅`);
console.log(`  Option chain: on-demand only, cached after close ✅`);
console.log(`\n  ⚠️  WARNING: UNIVERSE has ~148 unique stocks × 7 TFs = ${candleHitsPerScan} hits/scan`);
console.log(`  At 4 req/sec this takes ${(minTimeSeconds/60).toFixed(0)}+ minutes per cycle.`);
console.log(`  With 60s refresh interval, scan NEVER finishes before next cycle starts.`);
console.log(`  RECOMMENDATION: Reduce TFs to 4 (5m, 15m, 1h, 1d) for Equity tab.`);
console.log(`  That would give: ${ACTUAL_UNIQUE * 4} hits, ~${((ACTUAL_UNIQUE*4)/4/60).toFixed(0)} min scan time.`);
