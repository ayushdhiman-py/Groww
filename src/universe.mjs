import { SCREENER_UNIVERSE } from "./screener_universe.mjs";

// ── Indices ────────────────────────────────────────────────────────────────
// Not "shares" — kept alongside the stock list because market_regime.mjs,
// the index cards, and chart lookups all need NIFTY/BANKNIFTY/etc. data.
const INDICES = ["NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX", "MIDCPNIFTY"];

// The scan universe is exactly the indices plus the current Nifty 500
// (screener_universe.mjs — the single authoritative, Upstox-verified list).
// Previously this was a hand-curated 241-name watchlist plus a bolted-on
// "remaining constituents" block, which had drifted: it still carried ~24
// stale/renamed tickers no longer in the real Nifty 500 (e.g. ZOMATO/
// TATAMOTORS pre-rename names, delisted/removed constituents) alongside
// their correct replacements. Sourcing directly from screener_universe.mjs
// means there is one list to keep current when NSE reconstitutes the index,
// not two.
export const UNIVERSE = [...INDICES, ...SCREENER_UNIVERSE];

// Deduplicate (safety net — removes any accidental duplicates at runtime)
const _seen = new Set();
for (let i = UNIVERSE.length - 1; i >= 0; i--) {
    if (_seen.has(UNIVERSE[i])) UNIVERSE.splice(i, 1);
    else _seen.add(UNIVERSE[i]);
}

export const SECTOR = {
    INDEX: [
        "NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX", "MIDCPNIFTY"
    ],

    BANKING: [
        "AUBANK", "BANDHANBNK", "ICICIBANK", "HDFCBANK", "SBIN",
        "KOTAKBANK", "AXISBANK", "PNB", "BANKBARODA", "UNIONBANK",
        "CANBK", "INDUSINDBK", "IDFCFIRSTB", "FEDERALBNK", "BANKINDIA", "KARURVYSYA"
    ],

    FINANCE: [
        "BAJFINANCE", "BAJAJFINSV", "SBILIFE", "HDFCLIFE", "SHRIRAMFIN",
        "M&MFIN", "LTF", "PFC", "RECLTD", "IRFC",
        "NUVAMA", "CHOLAFIN", "JIOFIN", "POONAWALLA",
        "SBICARD", "HDFCAMC", "MOTILALOFS", "ANGELONE", "HUDCO", "CRISIL",
        "CDSL", "CAMS"
    ],

    INSURANCE: [
        "STARHEALTH", "NIACL", "GODIGIT"
    ],

    DEFENCE: [
        "BEL", "HAL", "GRSE", "COCHINSHIP", "BDL",
        "SOLARINDS", "MAZDOCK", "BHEL", "BEML", "ASTRAMICRO"
    ],

    AUTO: [
        "EICHERMOT", "HYUNDAI", "BAJAJ-AUTO", "M&M", "MARUTI",
        "TATAMOTORS", "HEROMOTOCO", "MOTHERSON", "TVSMOTOR",
        "EXIDEIND", "ESCORTS", "ENDURANCE", "UNOMINDA", "BOSCHLTD",
        "SCHAEFFLER", "TIINDIA"
    ],

    ENERGY: [
        "RELIANCE", "ONGC", "BPCL", "NTPC", "POWERGRID", "COALINDIA",
        "IOC", "GAIL", "PETRONET", "SJVN", "WAAREEENER",
        "TATAPOWER", "ADANIPOWER", "ADANIGREEN", "ADANIENSOL",
        "JSWENERGY", "IREDA", "NHPC", "NLCINDIA", "SUZLON",
        "IGL", "MGL", "ADANIGAS", "HINDPETRO"
    ],

    METAL: [
        "HINDALCO", "VEDL", "HINDZINC", "TATASTEEL", "JSWSTEEL",
        "SAIL", "NATIONALUM", "HINDCOPPER", "NMDC", "MOIL", "GMDCLTD",
        "GRAPHITE", "APLAPOLLO"
    ],

    CEMENT: [
        "AMBUJACEM", "JSWCEMENT", "ULTRACEMCO", "SHREECEM", "JKCEMENT",
        "RAMCOCEM", "ORIENTCEM", "INDIACEM", "HEIDELBERG", "PRISMJOHN",
        "DALBHARAT", "GRASIM"
    ],

    INFRA: [
        "LT", "ADANIPORTS", "ADANIENT", "PGINVIT",
        "RVNL", "IRCON", "RITES", "NBCC", "GMRINFRA", "ENGINERSIN",
        "GESHIP", "IRCTC", "CONCOR"
    ],

    PHARMA: [
        "SUNPHARMA", "DRREDDY", "CIPLA", "DIVISLAB",
        "ASTERDM", "TORNTPHARM", "LUPIN", "BIOCON", "ZYDUSLIFE",
        "GLENMARK", "SANOFI", "ABBOTINDIA", "ALKEM", "AUROPHARMA",
        "MANKIND", "IPCALAB", "LAURUSLABS", "NATCOPHARM", "GRANULES", "CONCORDBIO"
    ],

    HEALTHCARE: [
        "APOLLOHOSP", "MAXHEALTH", "MEDANTA", "FORTIS", "RAINBOW",
        "LALPATHLAB", "METROPOLIS", "THYROCARE"
    ],

    IT: [
        "INFY", "TCS", "HCLTECH", "TECHM", "WIPRO",
        "LTIM", "PERSISTENT", "MPHASIS", "LTTS",
        "COFORGE", "TATAELXSI", "KPITTECH", "TANLA"
    ],

    TELECOM: [
        "BHARTIARTL", "IDEA", "TTML", "RAILTEL", "INDUSTOWER", "STLTECH", "HFCL", "TATACOMM"
    ],

    FMCG: [
        "HINDUNILVR", "ITC", "BRITANNIA", "NESTLEIND", "TATACONSUM",
        "DABUR", "GODREJCP", "MARICO", "BALRAMCHIN", "COLPAL",
        "EIDPARRY", "DHAMPURSUG", "TRIVENI"
    ],

    QSR: [
        "JUBLFOOD", "WESTLIFE", "SAPPHIRE", "PVRINOX"
    ],

    CHEMICALS: [
        "PIDILITIND", "DEEPAKNTR", "ASTRAL", "ATUL", "SRF",
        "ALKYLAMINE", "NAVINFLUOR", "AARTIIND", "FLUOROCHEM", "GALAXYSURF",
        "FINEORG", "TATACHEM", "GNFC", "CHAMBLFERT", "COROMANDEL"
    ],

    PAINTS: [
        "BERGEPAINT", "ASIANPAINT"
    ],

    CAPITAL_GOODS: [
        "SIEMENS", "ABB", "CUMMINSIND", "POLYCAB", "DIXON",
        "VOLTAS", "CROMPTON"
    ],

    REAL_ESTATE: [
        "DLF", "GODREJPROP", "OBEROIRLTY", "LODHA", "PRESTIGE"
    ],

    CONSUMER: [
        "TITAN", "TRENT", "DMART", "KALYANKJIL", "PAGEIND", "KKCL", "CASTROLIND"
    ],

    CONSUMER_TECH: [
        "ZOMATO", "PAYTM", "NYKAA", "SWIGGY"
    ],

    LOGISTICS: [
        "INDIGO", "CONCOR", "GESHIP", "IRCTC"
    ]
};

export const getSector = s => Object.keys(SECTOR).find(k => SECTOR[k].includes(s)) || "OTHER";
