
import axios from "axios";
import fs from "fs";

const TOKEN_FILE = ".groww_session.json";
const CANDLE_URL = "https://api.groww.in/v1/historical/candle/range";

if (!fs.existsSync(TOKEN_FILE)) {
    console.error("No token file found!");
    process.exit(1);
}

const session = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));

const tests = [
    { label: "NIFTY", sym: "NIFTY", exchange: "NSE" },
    { label: "NIFTY 50", sym: "NIFTY 50", exchange: "NSE" },
    { label: "BANKNIFTY", sym: "BANKNIFTY", exchange: "NSE" },
    { label: "NIFTY BANK", sym: "NIFTY BANK", exchange: "NSE" },
    { label: "FINNIFTY", sym: "FINNIFTY", exchange: "NSE" },
    { label: "NIFTY FIN SERVICE", sym: "NIFTY FIN SERVICE", exchange: "NSE" },
    { label: "MIDCPNIFTY", sym: "MIDCPNIFTY", exchange: "NSE" },
    { label: "NIFTY MID SELECT", sym: "NIFTY MID SELECT", exchange: "NSE" },
    { label: "NIFTYMIDSELECT", sym: "NIFTYMIDSELECT", exchange: "NSE" },
    { label: "SENSEX", sym: "SENSEX", exchange: "BSE" },
];

async function runTests() {
    console.log("Starting symbol diagnostics...\n");
    for (const t of tests) {
        process.stdout.write(`Testing [${t.exchange}] ${t.sym}... `);
        try {
            const params = {
                exchange: t.exchange,
                segment: "CASH",
                trading_symbol: t.sym,
                start_time: Date.now() - 2 * 86400000,
                end_time: Date.now(),
                interval_in_minutes: 1440
            };
            const headers = {
                "Authorization": `Bearer ${session.accessToken}`,
                "X-API-VERSION": "1.0",
                "Accept": "application/json",
            };
            const res = await axios.get(CANDLE_URL, { params, headers, timeout: 5000 });
            const candles = res.data?.payload?.candles || res.data?.candles || [];
            if (candles.length > 0) {
                console.log(`✅ SUCCESS (${candles.length} candles)`);
            } else {
                console.log("⚠️ EMPTY (Request succeeded but no data)");
            }
        } catch (e) {
            console.log(`❌ FAILED: ${e.response?.data?.message || e.message}`);
        }
    }
}

runTests();
