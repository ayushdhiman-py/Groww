import { fetchCandles, fetchBulkLtp, fetchOptionChain } from "./src/groww.mjs";

async function run() {
    try {
        console.log("Fetching NIFTY candles...");
        const nse = await fetchCandles("NIFTY", "15m");
        console.log("NIFTY:", nse.slice(-1));

        console.log("Fetching RELIANCE candles...");
        const rel = await fetchCandles("RELIANCE", "15m");
        console.log("RELIANCE:", rel.slice(-1));

        console.log("Fetching LTP...");
        const ltp = await fetchBulkLtp(["NIFTY", "RELIANCE"]);
        console.log("LTP:", ltp);

        console.log("Fetching Option Chain NIFTY...");
        const opt = await fetchOptionChain("NIFTY");
        if (opt) {
            console.log("Option Chain NIFTY spot:", opt.spot_price);
            if(opt.options && opt.options.length > 0) {
               console.log("First option:", opt.options[0]);
            }
        }
    } catch(e) {
        console.error(e);
    }
}
run();
