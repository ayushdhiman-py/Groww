#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// ai_dataset_builder.mjs — STANDALONE offline job. Builds a historical
// training/validation dataset for the AI tab's Layer 4 joint-probability
// model, using real Upstox historical candles (verified: ~4.6 years of clean
// 1m/5m/15m OHLCV+volume for already-listed Nifty 500 names, correctly
// bounded by real listing dates for newer ones).
//
// NOT run inside the live 5-min scan loop (spec requirement) — invoke this
// directly:
//   node src/ai_dataset_builder.mjs --from=2026-06-01 --to=2026-08-20 [--symbols=RELIANCE,SBIN] [--resume]
//
// TWO PHASES, independently resumable:
//   Phase 1 (FETCH, network-bound): downloads 1m/5m/15m candles for the
//     universe (+ NIFTY for RS/regime baseline, + INDIA VIX for regime) and
//     caches each raw series to disk under data/historical_raw_cache/ — a
//     file's mere existence IS its checkpoint; a crashed/interrupted run
//     just re-invokes the same command and already-cached symbols are
//     skipped, never re-fetched.
//   Phase 2 (FEATURES+LABELS, CPU-bound, no network): walks a synthetic
//     5-minute timestamp grid (derived from NIFTY's own 5m candle grid, so
//     it's exactly the market's real trading calendar, not a hand-rolled
//     one) and for each T runs the SAME layer0-layer5 functions
//     ai_scanner.mjs's live loop calls, against a historical as-of-T ctx
//     (see historical_data_layer.mjs) instead of the live cache. Checkpoints
//     at the trading-day level (data/historical_build_checkpoint.json) —
//     an interrupted Phase 2 resumes from the next unprocessed day.
//
// ZERO LOOKAHEAD: features for timestamp T only ever see candles whose
// CLOSE time is <= T (historical_data_layer.mjs enforces this structurally).
// The forward 20-minute OUTCOME is the one place this script deliberately
// reads candles AFTER T — that is not a leak, it is the label, computed via
// the EXACT SAME resolveForwardOutcome() the live sweep uses (spec
// requirement: no separate labeling strategy), and it is never fed back
// into any feature.
//
// Rows are written with source='historical' into the SAME ai_candidates/
// ai_outcomes tables the live scanner writes 'live' rows into, tagged with a
// data_version for this run — so runLayer6Validation() (already built,
// unmodified) can validate against the combined historical+live dataset
// with no code changes of its own.
// ─────────────────────────────────────────────────────────────────────────────
import fs from "fs";
import path from "path";
import { fetchCandles, login } from "./upstox.mjs";
import { SCREENER_UNIVERSE } from "./screener_universe.mjs";
import { getDb } from "./ai_scanner_db.mjs";
import { createHistoricalContext, historicalMarketRegime, historicalVix } from "./historical_data_layer.mjs";
import {
    layer0, layer1, layer2, layer3, layer4, sectorAggregateReturns, resolveForwardOutcome,
    DATA_TIER, TARGET_PCT, SL_PCT, HORIZON_MIN,
} from "./ai_scanner.mjs";
import { __dirname } from "./config.mjs";

const RAW_CACHE_DIR = path.join(__dirname, "..", "data", "historical_raw_cache");
const CHECKPOINT_FILE = path.join(__dirname, "..", "data", "historical_build_checkpoint.json");
const NIFTY = "NIFTY";
const VIX_SYMBOL = "INDIA VIX";
const TOP_N_PER_TICK = 10; // mirrors the live scanner's Layer 3 -> top ~10 cut exactly

function parseArgs() {
    const args = {};
    for (const a of process.argv.slice(2)) {
        const m = a.match(/^--([^=]+)=(.*)$/);
        if (m) args[m[1]] = m[2];
        else if (a.startsWith("--")) args[a.slice(2)] = true;
    }
    if (!args.from || !args.to) {
        console.error("Usage: node src/ai_dataset_builder.mjs --from=YYYY-MM-DD --to=YYYY-MM-DD [--symbols=A,B,C] [--resume]");
        process.exit(1);
    }
    return {
        from: new Date(args.from + "T00:00:00Z"),
        to: new Date(args.to + "T23:59:59Z"),
        symbols: args.symbols ? args.symbols.split(",").map(s => s.trim().toUpperCase()) : SCREENER_UNIVERSE,
        resume: !!args.resume,
        fromStr: args.from, toStr: args.to,
    };
}

function loadCheckpoint() {
    try {
        return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8"));
    } catch (e) {
        return { runConfig: null, completedDays: [] };
    }
}
function saveCheckpoint(cp) {
    fs.mkdirSync(path.dirname(CHECKPOINT_FILE), { recursive: true });
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp, null, 2));
}

function rawCachePath(symbol, tf) {
    return path.join(RAW_CACHE_DIR, `${symbol.replace(/[^A-Za-z0-9_-]/g, "_")}_${tf}.json`);
}

// ── PHASE 1 — fetch + cache ──────────────────────────────────────────────────
async function fetchAndCache(symbol, tf, from, to) {
    const file = rawCachePath(symbol, tf);
    if (fs.existsSync(file)) {
        try {
            const cached = JSON.parse(fs.readFileSync(file, "utf8"));
            if (cached.from === from.toISOString() && cached.to === to.toISOString()) return cached.candles.length;
        } catch (e) { /* corrupt cache file — refetch */ }
    }
    let candles;
    try {
        candles = await fetchCandles(symbol, tf, { from, to }, { priority: false });
    } catch (e) {
        console.error(`  [FETCH FAILED] ${symbol} ${tf}: ${e.message}`);
        return 0;
    }
    fs.mkdirSync(RAW_CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ from: from.toISOString(), to: to.toISOString(), candles }));
    return candles.length;
}

async function runFetchPhase(symbols, from, to) {
    console.log(`\n=== PHASE 1: FETCH (${symbols.length} symbols + NIFTY + ${VIX_SYMBOL}) ===`);
    const allSymbols = [...new Set([...symbols, NIFTY])];
    let totalCandles = 0, failedSymbols = [];

    for (let i = 0; i < allSymbols.length; i++) {
        const symbol = allSymbols[i];
        let ok = true;
        for (const tf of ["1m", "5m", "15m"]) {
            const n = await fetchAndCache(symbol, tf, from, to);
            if (n === 0) ok = false;
            totalCandles += n;
        }
        if (!ok) failedSymbols.push(symbol);
        if ((i + 1) % 10 === 0 || i === allSymbols.length - 1) {
            console.log(`  fetched ${i + 1}/${allSymbols.length} symbols (${totalCandles.toLocaleString()} candles so far)`);
        }
    }

    const vixCandles = await fetchAndCache(VIX_SYMBOL, "1d", from, to);
    totalCandles += vixCandles;
    console.log(`  ${VIX_SYMBOL}: ${vixCandles} daily candles`);

    if (failedSymbols.length) console.warn(`  WARNING: ${failedSymbols.length} symbol(s) failed to fully fetch: ${failedSymbols.join(", ")}`);
    console.log(`Phase 1 complete: ${totalCandles.toLocaleString()} total candles cached.`);
    return { totalCandles, failedSymbols };
}

// ── PHASE 2 — features + labels ──────────────────────────────────────────────
function loadSeries(symbol, tf) {
    const file = rawCachePath(symbol, tf);
    if (!fs.existsSync(file)) return [];
    try {
        return JSON.parse(fs.readFileSync(file, "utf8")).candles || [];
    } catch (e) {
        return [];
    }
}

// Loads a symbol/tf's cached file (full 3-month blob) but immediately
// filters down to [fromMs, toMs] before returning — the full parsed array
// is a short-lived local that GC reclaims right after filtering, so peak
// memory only ever holds ONE symbol's full file at a time, never all 500 at
// once. This is what actually bounds Phase 2's memory (see buildSeriesMap).
function loadSeriesWindowed(symbol, tf, fromMs, toMs) {
    const full = loadSeries(symbol, tf);
    return full.filter(c => c.ts >= fromMs && c.ts <= toMs);
}

// Builds the in-memory candle map for ONE chunk of the requested date range
// only — never the full multi-month history for all symbols at once, which
// is what OOM'd (~2GB+ for 500 symbols x 3 timeframes x 3 months held
// simultaneously on a machine with ~7GB total RAM). `windowFromMs`/
// `windowToMs` should already include the lookback/lookahead buffers (see
// runFeaturePhase) — this function just applies them per symbol/tf.
function buildSeriesMap(symbols, windowFromMs, windowToMs) {
    const map = new Map();
    for (const symbol of [...symbols, NIFTY]) {
        for (const tf of ["1m", "5m", "15m"]) {
            map.set(`${symbol}|${tf}`, loadSeriesWindowed(symbol, tf, windowFromMs, windowToMs));
        }
    }
    // VIX is a single daily-candle series for the whole run (~90 rows even
    // across 3 months) — negligible memory, no need to window it per chunk.
    map.set(`${VIX_SYMBOL}|1d`, loadSeries(VIX_SYMBOL, "1d"));
    return map;
}

// Synthetic scan-tick grid = NIFTY's own 5m candle CLOSE times — the real
// market calendar (holidays/half-days naturally absent), not a hand-rolled
// one, and guaranteed to line up with what "5m candle" even means.
function buildTimestampGrid(niftySeries, from, to) {
    const fromMs = from.getTime(), toMs = to.getTime();
    return niftySeries
        .map(c => c.ts + 5 * 60_000)
        .filter(t => t >= fromMs && t <= toMs);
}

function tradingDayKey(ts) {
    return new Date(ts).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

let insertCandidateStmt = null, insertOutcomeStmt = null;
function logHistoricalRow(db, candidate, l4, outcome, tradeDate, dataVersion) {
    if (!insertCandidateStmt) {
        insertCandidateStmt = db.prepare(`INSERT INTO ai_candidates (
            source, data_version, scanned_at, trade_date, symbol, sector, market_cap_category, data_tier, direction,
            entry_price, entry_price_ts, entry_price_source, target_pct, sl_pct, target_price, sl_price,
            setup_score, regime_bias, index_regime, vix_value, movement_capacity_score,
            structure_alignment_json, vwap_state_json, compression_state, breakout_quality, momentum_accel,
            fakeout_score, order_flow_json, order_flow_is_proxy, catalyst_status, liquidity_impact_cost_pct,
            spread_pct, execution_quality, model_version_at_scan, rank_score, breakdown_json, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    }
    if (!insertOutcomeStmt) {
        insertOutcomeStmt = db.prepare(`INSERT INTO ai_outcomes (
            candidate_id, resolved_at, resolution, time_to_resolution_sec, mfe_pct, mae_pct,
            final_price, final_price_pct, path_source_tf, ambiguous_same_candle
        ) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    }

    const targetPrice = candidate.direction === "LONG" ? candidate.price * (1 + TARGET_PCT / 100) : candidate.price * (1 - TARGET_PCT / 100);
    const slPrice = candidate.direction === "LONG" ? candidate.price * (1 - SL_PCT / 100) : candidate.price * (1 + SL_PCT / 100);

    const info = insertCandidateStmt.run(
        "historical", dataVersion, candidate.scannedAt, tradeDate, candidate.symbol, candidate.sector, candidate.marketCapCategory, DATA_TIER, candidate.direction,
        candidate.price, candidate.priceTs, candidate.priceSource, TARGET_PCT, SL_PCT, targetPrice, slPrice,
        candidate.setupScore, candidate.regimeBias, candidate.indexRegime ?? null, candidate.vixValue ?? null, candidate.movementCapacityScore,
        JSON.stringify(candidate.structureAlignment), JSON.stringify({ above: candidate.vwapAbove, rising: candidate.vwapRising }),
        candidate.compressionState, candidate.breakoutQuality, candidate.momentumAccel,
        candidate.fakeoutScore, JSON.stringify({ buySellRatio: null }), 0, // historical order-flow: NULL/not-proxy — no historical order-book exists (spec requirement 7)
        candidate.catalystStatus, candidate.impactCostPct, candidate.spreadPct,
        l4.executionQuality ?? null, l4.modelVersion ?? null, l4.rankScore ?? null, JSON.stringify(candidate.reasons || []), Date.now()
    );

    if (outcome) {
        insertOutcomeStmt.run(
            info.lastInsertRowid, Date.now(), outcome.resolution, outcome.timeToResolutionSec, outcome.mfe, outcome.mae,
            outcome.finalPrice, outcome.finalPricePct, "1m", outcome.ambiguous
        );
    }
    return info.lastInsertRowid;
}

// How many trading days' worth of candles (for ALL symbols) Phase 2 holds
// in memory at once. 500 symbols x 3 timeframes x a full ~3-month range was
// what OOM'd (~2GB+ needed, only ~7GB total/~2GB free RAM on this machine).
// A 5-trading-day chunk (+ buffers below) keeps peak memory to roughly
// 1/10th of a 3-month run, independent of how wide --from/--to is.
const PHASE2_CHUNK_TRADING_DAYS = 5;
// Extra context loaded around each chunk, in real time (not trading days):
// every bounded-lookback feature in ai_scanner.mjs (VWAP, momentum, swing
// high/low, compression) looks back at most ~30 5m candles (~2.5 hours,
// see layer3/structureAlignment) — always within the SAME session, since
// VWAP resets daily. 3 calendar days of lookback is a generous safety
// margin, not a tight fit to that number.
const LOOKBACK_BUFFER_MS = 3 * 24 * 60 * 60 * 1000;
// The 20-minute forward outcome window for a tick near the chunk's last day
// needs candles up to T+20min, which can roll past midnight into the next
// calendar day — 1 full day of lookahead comfortably covers that.
const LOOKAHEAD_BUFFER_MS = 1 * 24 * 60 * 60 * 1000;

async function runFeaturePhase(symbols, from, to, dataVersion) {
    console.log(`\n=== PHASE 2: FEATURES + LABELS ===`);

    // Building the real trading-day calendar only needs NIFTY's own 5m
    // series (one symbol) for the FULL requested range — negligible memory
    // regardless of how wide the range is, so this alone is loaded
    // unwindowed. The 500-symbol universe is loaded per-CHUNK below, never
    // all at once for the full range.
    const niftySeriesFull = loadSeries(NIFTY, "5m");
    if (!niftySeriesFull.length) {
        console.error("No NIFTY 5m data cached — run Phase 1 first.");
        return { examplesGenerated: 0 };
    }

    const grid = buildTimestampGrid(niftySeriesFull, from, to);
    const dayGroups = new Map();
    for (const t of grid) {
        const day = tradingDayKey(t);
        if (!dayGroups.has(day)) dayGroups.set(day, []);
        dayGroups.get(day).push(t);
    }
    const days = [...dayGroups.keys()].sort();

    const checkpoint = loadCheckpoint();
    const sameRun = checkpoint.runConfig && checkpoint.runConfig.from === from.toISOString() && checkpoint.runConfig.to === to.toISOString();
    const completedDays = new Set(sameRun ? checkpoint.completedDays : []);
    if (!sameRun) { checkpoint.runConfig = { from: from.toISOString(), to: to.toISOString() }; checkpoint.completedDays = []; }

    const db = getDb();
    let examplesGenerated = 0, ticksProcessed = 0;

    for (let chunkStart = 0; chunkStart < days.length; chunkStart += PHASE2_CHUNK_TRADING_DAYS) {
        const chunkDays = days.slice(chunkStart, chunkStart + PHASE2_CHUNK_TRADING_DAYS);
        if (chunkDays.every(d => completedDays.has(d))) continue; // whole chunk already done (resume case)

        const chunkTicks = chunkDays.flatMap(d => dayGroups.get(d));
        const windowFromMs = Math.min(...chunkTicks) - LOOKBACK_BUFFER_MS;
        const windowToMs = Math.max(...chunkTicks) + LOOKAHEAD_BUFFER_MS;

        console.log(`  chunk ${chunkDays[0]}..${chunkDays[chunkDays.length - 1]}: loading candles...`);
        const seriesMap = buildSeriesMap(symbols, windowFromMs, windowToMs);
        const histCtx = createHistoricalContext(seriesMap);

        for (const day of chunkDays) {
            if (completedDays.has(day)) continue;
            const dayTicks = dayGroups.get(day);

            for (const T of dayTicks) {
                histCtx.setAsOf(T);
                ticksProcessed++;

                // Layer 0 — every symbol, as-of-T.
                const gates = new Map();
                for (const symbol of symbols) gates.set(symbol, layer0(symbol, histCtx.ctx));
                const niftyGate = layer0(NIFTY, histCtx.ctx);
                const niftyCloses = niftyGate?.pass ? niftyGate.candles.map(c => c.close).filter(Number.isFinite) : null;

                // Layer 1
                const l1Survivors = [];
                for (const [symbol, gate] of gates) {
                    if (!gate.pass) continue;
                    const result = layer1(gate, niftyCloses);
                    if (result.status === "FLAGGED") l1Survivors.push(result);
                }

                // Layer 2 — NO historical bid/ask/quote data exists (spec
                // requirement 7) — gate.quote stays undefined/null for every
                // historical symbol, so impactCostPct/spreadPct fall through to
                // the SAME conservative "no quote data" defaults layer2 already
                // uses live when a quote is genuinely missing. Never fabricated.
                const sectorReturns = sectorAggregateReturns(gates);
                const marketRegime = { ...historicalMarketRegime(histCtx, NIFTY), vixValue: historicalVix(histCtx), vixMode: null };
                const l2Survivors = [];
                for (const flag of l1Survivors) {
                    const gate = gates.get(flag.symbol);
                    const l2 = layer2(flag.symbol, gate, sectorReturns, marketRegime);
                    if (!l2.eliminated) l2Survivors.push(l2);
                }

                // Layer 3 — same ensemble, capped at the same top ~10.
                const l3Scored = l2Survivors.map(l2 => layer3(l2, histCtx.ctx));
                l3Scored.sort((a, b) => b.setupScore - a.setupScore);
                const top = l3Scored.slice(0, TOP_N_PER_TICK);

                for (const candidate of top) {
                    candidate.scannedAt = T;
                    const l4 = layer4(candidate, null); // no validated model exists yet during data collection — BLOCKED, same as live

                    // Forward outcome — the ONE place this reads candles AFTER T,
                    // by design (the label, not a feature). Same resolveForwardOutcome()
                    // the live sweep uses — no separate labeling strategy invented.
                    const full1m = histCtx.getFullSeries(candidate.symbol, "1m");
                    const windowCandles = full1m.filter(c => c.ts >= T && c.ts <= T + HORIZON_MIN * 60_000);
                    const outcome = windowCandles.length ? resolveForwardOutcome(candidate.direction, candidate.price, T, windowCandles) : null;
                    // Only keep rows whose 20-min window is FULLY covered by
                    // cached data (either resolved before the end, or the
                    // window genuinely elapsed) — a truncated window (ran off
                    // the end of what was fetched) would silently mislabel a
                    // real TARGET/SL hit as "NEITHER," which is worse than just
                    // skipping the row.
                    if (!outcome || (outcome.resolution === "NEITHER" && !outcome.enoughWindow)) continue;

                    logHistoricalRow(db, candidate, l4, outcome, day, dataVersion);
                    examplesGenerated++;
                }
            }

            completedDays.add(day);
            checkpoint.completedDays = [...completedDays];
            saveCheckpoint(checkpoint);
            if (days.indexOf(day) % 5 === 0 || day === days[days.length - 1]) {
                console.log(`  day ${day} done (${completedDays.size}/${days.length} days, ${examplesGenerated.toLocaleString()} examples so far)`);
            }
        }
        // seriesMap/histCtx fall out of scope here — GC reclaims this
        // chunk's candles before the next chunk's buildSeriesMap() loads.
    }

    console.log(`Phase 2 complete: ${ticksProcessed.toLocaleString()} scan-ticks processed, ${examplesGenerated.toLocaleString()} training examples generated.`);
    return { examplesGenerated, ticksProcessed, days: days.length };
}

// ── REPORT ───────────────────────────────────────────────────────────────────
function printReport(dataVersion, fetchResult, featureResult, from, to) {
    const db = getDb();
    const symbolCount = db.prepare("SELECT COUNT(DISTINCT symbol) as n FROM ai_candidates WHERE data_version = ?").get(dataVersion).n;
    const candidateCount = db.prepare("SELECT COUNT(*) as n FROM ai_candidates WHERE data_version = ?").get(dataVersion).n;
    const outcomeRows = db.prepare(`
        SELECT o.resolution, COUNT(*) as n FROM ai_outcomes o
        JOIN ai_candidates c ON c.id = o.candidate_id
        WHERE c.data_version = ? GROUP BY o.resolution
    `).all(dataVersion);
    const dateRange = db.prepare("SELECT MIN(trade_date) as minD, MAX(trade_date) as maxD FROM ai_candidates WHERE data_version = ?").get(dataVersion);

    console.log(`\n${"=".repeat(70)}\nDATASET BUILD REPORT (data_version=${dataVersion})\n${"=".repeat(70)}`);
    console.log(`Requested range: ${from.toISOString().slice(0, 10)} .. ${to.toISOString().slice(0, 10)}`);
    console.log(`Actual data range: ${dateRange.minD} .. ${dateRange.maxD}`);
    console.log(`Symbols processed: ${symbolCount}`);
    console.log(`Total candles fetched: ${fetchResult.totalCandles.toLocaleString()}`);
    if (fetchResult.failedSymbols.length) console.log(`Symbols that failed to fetch: ${fetchResult.failedSymbols.join(", ")}`);
    console.log(`Scan-ticks processed: ${featureResult.ticksProcessed?.toLocaleString() ?? "n/a (resumed, already complete)"}`);
    console.log(`Training examples generated this run: ${featureResult.examplesGenerated.toLocaleString()}`);
    console.log(`Total candidates stored for this data_version: ${candidateCount.toLocaleString()}`);
    console.log(`Outcome distribution:`);
    for (const row of outcomeRows) console.log(`  ${row.resolution}: ${row.n.toLocaleString()}`);
    return { symbolCount, candidateCount, outcomeRows, dateRange };
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
    const { from, to, symbols, fromStr, toStr } = parseArgs();
    const dataVersion = `hist_${fromStr}_${toStr}`;

    console.log(`AI dataset builder — data_version=${dataVersion}, ${symbols.length} symbols, ${fromStr} to ${toStr}`);
    await login();

    const fetchResult = await runFetchPhase(symbols, from, to);
    const featureResult = await runFeaturePhase(symbols, from, to, dataVersion);
    printReport(dataVersion, fetchResult, featureResult, from, to);

    console.log(`\nRun Layer 6 validation now with: node -e "import('./src/ai_scanner.mjs').then(m=>m.runLayer6Validation())"`);
    console.log(`Or promote a resulting CANDIDATE version with validateModelVersion(versionId) once you've reviewed its metrics.`);
}

main().catch(e => { console.error("Dataset builder failed:", e); process.exit(1); });
