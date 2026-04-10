import { loadSession, ensureSession } from "./src/groww.mjs";
import { state, setIsAuthenticated } from "./src/scanner.mjs";
import { optionsCache } from "./src/options_feed.mjs";
import { theoreticalOptionChain } from "./src/indicators.mjs";
import { UNIVERSE } from "./src/universe.mjs";
import { TF_MAP } from "./src/config.mjs";
import { emptyState, isMarketOpen, scanAll } from "./src/scanner.mjs";

if (!loadSession()) { console.error("❌ No session"); process.exit(1); }
setIsAuthenticated(true);

// Just test theoretical chain with dummy data
const price = 1350;
const hv = 0.28;
const now = new Date();
const day = now.getDay();
const daysToThursday = ((4 - day + 7) % 7) || 7;

console.log(`Testing theoreticalOptionChain:`);
console.log(`  Price: ${price}, HV: ${hv}, Days to expiry: ${daysToThursday}`);

const chain = theoreticalOptionChain(price, hv, daysToThursday, "AXISBANK");
console.log(`\n  Calls returned: ${chain.calls.length}`);
console.log(`  Puts returned: ${chain.puts.length}`);

if (chain.calls.length > 0) {
    console.log(`\n  Sample call:`, JSON.stringify(chain.calls[0], null, 2));
}
if (chain.puts.length > 0) {
    console.log(`\n  Sample put:`, JSON.stringify(chain.puts[0], null, 2));
}

// Test the API response format
const response = {
    symbol: "AXISBANK",
    spot: price,
    hv: chain.hv,
    daysToExpiry: chain.daysToExpiry,
    topCalls: chain.calls,
    topPuts: chain.puts,
    callOptions: chain.calls,
    putOptions: chain.puts,
    strikes: {},
    theoretical: true,
    source: "theoretical",
    fetchedAt: new Date().toISOString(),
};

console.log(`\n  API response topCalls length: ${response.topCalls.length}`);
console.log(`  API response callOptions length: ${response.callOptions.length}`);
console.log(`\n  Full response (first 500 chars):`, JSON.stringify(response, null, 2).slice(0, 500));
