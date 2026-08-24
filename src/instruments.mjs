// ─────────────────────────────────────────────────────────────────────────────
// instruments.mjs — Upstox Instrument Key Resolver
// ─────────────────────────────────────────────────────────────────────────────
// Groww accepted plain trading symbols (e.g. "RELIANCE", "NIFTY"). Upstox
// requires a fully-qualified instrument_key (e.g. "NSE_EQ|INE002A01018",
// "NSE_INDEX|Nifty Bank"). This module downloads Upstox's official instrument
// master file once (cached to disk, refreshed daily) and builds a lookup keyed
// by `trading_symbol` — verified against a live download that Upstox's own
// trading_symbol for indices matches our labels directly (Nifty 50 -> "NIFTY",
// Nifty Bank -> "BANKNIFTY", Nifty Fin Service -> "FINNIFTY",
// NIFTY MID SELECT -> "MIDCPNIFTY", BSE SENSEX -> "SENSEX").
// ─────────────────────────────────────────────────────────────────────────────
import https from "https";
import zlib from "zlib";
import fs from "fs";
import path from "path";
import { __dirname, INSTRUMENT_MASTER_URL } from "./config.mjs";

const CACHE_FILE = path.join(__dirname, "..", ".upstox_instruments_cache.json");
const CACHE_TTL_MS = 24 * 3600 * 1000; // instrument master refreshes ~daily on Upstox's side

// Segments we resolve plain symbols against, and the instrument_key -> symbol
// reverse map used to interpret bulk LTP/feed responses.
const RESOLVABLE_SEGMENTS = new Set(["NSE_EQ", "NSE_INDEX", "BSE_INDEX"]);

let symbolToKey = new Map();   // SYMBOL (upper) -> instrument_key
let keyToSymbol = new Map();   // instrument_key -> SYMBOL (as used by our UNIVERSE)
let loaded = false;
let loadingPromise = null;
let masterStale = false; // true once we're serving a fallback that failed to refresh

// Our UNIVERSE symbol -> Upstox trading_symbol, only where they differ.
// Several of these reflect completed corporate actions where Upstox's
// instrument master now uses a new trading_symbol; we keep the old, familiar
// label in UNIVERSE and alias it here so scans/UI don't need to change.
const SYMBOL_ALIASES = {
    "PRISMJOHN": "PRSMJOHNSN",
    "ZOMATO": "ETERNAL",       // Zomato Ltd renamed to Eternal Ltd (2024)
    "GMRINFRA": "GMRAIRPORT",  // GMR Infrastructure renamed GMR Airports Ltd (2024)
    "ADANIGAS": "ATGL",        // Adani Total Gas Ltd trades under ATGL
    "LTIM": "LTM",             // LTIMindtree's current Upstox trading_symbol is LTM
    // Tata Motors demerged (2025) into two listings. TMPV ("Tata Motors Passenger
    // Vehicles") retained the original ISIN/listing; TMCV ("Tata Motors Commercial
    // Vehicles") is the newly listed entity. We track the continuing listing.
    "TATAMOTORS": "TMPV",
};

function downloadInstrumentMaster() {
    return new Promise((resolve, reject) => {
        // assets.upstox.com sits behind CloudFront, which 403s requests with
        // no User-Agent header at all (Node sends none by default) — verified
        // live: curl (which sets one) succeeds, plain https.get() does not.
        const options = {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            },
        };
        https.get(INSTRUMENT_MASTER_URL, options, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`Instrument master download failed: HTTP ${res.statusCode}`));
            }
            const gunzip = zlib.createGunzip();
            const chunks = [];
            res.pipe(gunzip);
            gunzip.on("data", (c) => chunks.push(c));
            gunzip.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
            gunzip.on("error", reject);
            res.on("error", reject);
        }).on("error", reject);
    });
}

function buildMaps(instruments) {
    const s2k = new Map();
    const k2s = new Map();
    for (const inst of instruments) {
        if (!inst || !inst.instrument_key || !inst.trading_symbol) continue;
        if (!RESOLVABLE_SEGMENTS.has(inst.segment)) continue;
        const sym = inst.trading_symbol.toUpperCase();
        s2k.set(sym, inst.instrument_key);
        k2s.set(inst.instrument_key, sym);
    }
    return { s2k, k2s };
}

/**
 * Load (or refresh) the instrument master. Safe to call multiple times;
 * concurrent calls share one in-flight download.
 */
export async function loadInstrumentMaster(forceRefresh = false) {
    if (loaded && !forceRefresh) return;
    if (loadingPromise) return loadingPromise;

    loadingPromise = (async () => {
        let raw = null;

        if (!forceRefresh && fs.existsSync(CACHE_FILE)) {
            try {
                const stat = fs.statSync(CACHE_FILE);
                if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
                    raw = fs.readFileSync(CACHE_FILE, "utf8");
                }
            } catch (_) { /* fall through to re-download */ }
        }

        if (!raw) {
            try {
                raw = await downloadInstrumentMaster();
                fs.writeFileSync(CACHE_FILE, raw);
                masterStale = false;
                console.log("[Instruments] ✅ Downloaded fresh Upstox instrument master");
            } catch (e) {
                console.error("[Instruments] Download failed:", e.message);
                if (fs.existsSync(CACHE_FILE)) {
                    console.warn("[Instruments] Falling back to stale cached instrument master");
                    raw = fs.readFileSync(CACHE_FILE, "utf8");
                    // A corporate action / rename / new listing since this
                    // cache was written could now silently fail to resolve —
                    // this flag is the only signal callers get of that risk.
                    masterStale = true;
                } else {
                    throw new Error(`Unable to load Upstox instrument master and no cache available: ${e.message}`);
                }
            }
        }

        const instruments = JSON.parse(raw);
        const { s2k, k2s } = buildMaps(instruments);
        symbolToKey = s2k;
        keyToSymbol = k2s;
        loaded = true;
        console.log(`[Instruments] Loaded ${s2k.size} resolvable NSE/BSE equities + indices`);
    })();

    try {
        await loadingPromise;
    } finally {
        loadingPromise = null;
    }
}

export function isInstrumentMasterLoaded() {
    return loaded;
}

/** True if we're currently serving a fallback master that failed to refresh. */
export function isInstrumentMasterStale() {
    return masterStale;
}

/**
 * Resolve one of our plain symbols (from universe.mjs) to an Upstox
 * instrument_key. Returns null if unresolvable (caller should skip the
 * symbol rather than guess).
 */
export function resolveInstrumentKey(symbol) {
    if (!loaded) return null;
    const aliased = SYMBOL_ALIASES[symbol] || symbol;
    return symbolToKey.get(aliased.toUpperCase()) || null;
}

/**
 * Resolve many symbols at once. Returns { instrumentKeyBySymbol, unresolved }.
 */
export function resolveInstrumentKeys(symbols) {
    const instrumentKeyBySymbol = new Map();
    const unresolved = [];
    for (const symbol of symbols) {
        const key = resolveInstrumentKey(symbol);
        if (key) instrumentKeyBySymbol.set(symbol, key);
        else unresolved.push(symbol);
    }
    return { instrumentKeyBySymbol, unresolved };
}

/**
 * Reverse lookup: Upstox instrument_key -> our plain symbol. Used to interpret
 * LTP/feed responses, which key their data by instrument_token, not by a
 * string we can reconstruct ourselves (Upstox uses "SEGMENT:Name" for LTP
 * response keys, which does not round-trip to our symbols).
 */
export function symbolForInstrumentKey(instrumentKey) {
    return keyToSymbol.get(instrumentKey) || null;
}

/**
 * Test-only seam: inject maps directly so unit tests can exercise
 * resolveInstrumentKey/symbolForInstrumentKey without a network download.
 */
export function _setMapsForTesting(entries) {
    const s2k = new Map();
    const k2s = new Map();
    for (const { symbol, instrumentKey } of entries) {
        s2k.set(symbol.toUpperCase(), instrumentKey);
        k2s.set(instrumentKey, symbol.toUpperCase());
    }
    symbolToKey = s2k;
    keyToSymbol = k2s;
    loaded = true;
}
