import axios from "axios";

// Cache dividend data to avoid repeated API calls
const dividendCache = new Map();
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

// NSE session cookies
let nseCookies = {};
let cookiesExpiry = 0;

/**
 * Get NSE session cookies by visiting homepage
 */
async function getNSECookies() {
    if (Date.now() < cookiesExpiry) return nseCookies;
    
    try {
        const res = await axios.get("https://www.nseindia.com/", {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
            timeout: 10000,
        });
        
        const setCookie = res.headers["set-cookie"];
        if (setCookie) {
            const cookieStr = Array.isArray(setCookie) ? setCookie.join("; ") : setCookie;
            nseCookies = { Cookie: cookieStr };
            cookiesExpiry = Date.now() + (30 * 60 * 1000); // 30 min
            return nseCookies;
        }
    } catch (e) {
        console.warn("[Dividend] Failed to get NSE cookies:", e.message);
    }
    return {};
}

/**
 * Fetch dividend information for a stock
 * Uses NSE API with proper session handling
 */
export async function fetchDividend(symbol) {
    // Check cache first
    const cached = dividendCache.get(symbol);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
        return cached.data;
    }

    try {
        // Get fresh cookies
        const cookies = await getNSECookies();
        if (Object.keys(cookies).length === 0) {
            dividendCache.set(symbol, { data: null, timestamp: Date.now() });
            return null;
        }

        // Fetch from NSE corporate actions
        const result = await fetchFromNSE(symbol, cookies);
        if (result) {
            dividendCache.set(symbol, { data: result, timestamp: Date.now() });
            return result;
        }

        // Failed, cache null and return
        dividendCache.set(symbol, { data: null, timestamp: Date.now() });
        return null;

    } catch (e) {
        // All methods failed
        console.warn(`[Dividend] Failed to fetch for ${symbol}:`, e.message);
        dividendCache.set(symbol, { data: null, timestamp: Date.now() });
        return null;
    }
}

/**
 * Fetch dividend data from NSE corporate actions API
 */
async function fetchFromNSE(symbol, cookies) {
    try {
        const url = `https://www.nseindia.com/api/corporates-equity?symbol=${encodeURIComponent(symbol)}`;

        const headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "application/json",
            "Referer": `https://www.nseindia.com/get-quotes/equity?symbol=${symbol}`,
            ...cookies,
        };

        const res = await axios.get(url, { headers, timeout: 10000 });
        const data = res.data;

        if (!data) return null;

        // Extract dividend from corporate actions
        const actions = data.corporateActions || data.actions || [];
        const dividends = actions.filter(a =>
            a && (a.type === 'Dividend' ||
                  (a.purpose && a.purpose.toLowerCase().includes('dividend')) ||
                  (a.text && a.text.toLowerCase().includes('dividend')))
        );

        if (dividends.length === 0) return null;

        // Get latest dividend
        const latest = dividends[0];
        const amount = extractDividendAmount(latest);

        if (!amount || amount === 0) return null;

        return {
            annualAmount: amount,
            exDate: latest.exDate || latest.ex_dt || latest.ex_date || null,
            recordDate: latest.recordDate || latest.rec_dt || null,
            paymentDate: latest.paymentDate || latest.pay_dt || null,
            frequency: detectFrequency(latest.purpose || latest.text || ''),
            yield: null,
        };

    } catch (e) {
        return null;
    }
}

/**
 * Extract dividend amount from corporate action
 */
function extractDividendAmount(action) {
    if (!action) return 0;

    // Try different field names
    const amount = action.amount || action.dividendAmount || action.div_amt ||
                   action.value || action.rate;

    if (amount) {
        const num = parseFloat(amount.toString().replace(/[₹Rs.,]/g, ''));
        return isNaN(num) ? 0 : num;
    }

    // Try to extract from text
    const text = action.purpose || action.text || '';
    const match = text.match(/dividend.*?(\d+\.?\d*)/i);
    if (match) {
        return parseFloat(match[1]);
    }

    return 0;
}

/**
 * Detect dividend frequency
 */
function detectFrequency(purpose) {
    if (!purpose) return 'annual';
    const lower = purpose.toLowerCase();
    if (lower.includes('quarterly') || lower.includes('qtrly')) return 'quarterly';
    if (lower.includes('semi') || lower.includes('half yearly')) return 'semi-annual';
    return 'annual';
}

/**
 * Calculate dividend yield percentage
 */
export function calculateDividendYield(annualDividend, currentPrice) {
    if (!annualDividend || !currentPrice || currentPrice === 0) return 0;
    return ((annualDividend / currentPrice) * 100);
}

/**
 * Format dividend display text
 */
export function formatDividendInfo(dividend, price) {
    if (!dividend || !dividend.annualAmount) return null;

    const yieldPct = calculateDividendYield(dividend.annualAmount, price);
    const frequency = dividend.frequency || "annual";

    // Calculate per-month, per-quarter, per-year amounts
    const perYear = dividend.annualAmount;
    const perQuarter = frequency === "quarterly" ? (perYear / 4) : null;
    const perMonth = perYear / 12;

    let displayText = `₹${perYear.toFixed(2)}/yr`;
    if (perQuarter && perQuarter > 0) {
        displayText = `₹${perQuarter.toFixed(2)}/qtr`;
    }

    return {
        yield: yieldPct,
        displayText,
        annualAmount: perYear,
        frequency,
        exDate: dividend.exDate,
        colorClass: yieldPct > 2 ? "high-yield" : yieldPct > 1 ? "med-yield" : "low-yield"
    };
}
