import { fetchCandles, fetchBulkLtp, fetchOptionChain } from "./src/groww.mjs";

async function run() {
    try {
        console.log("Fetching Option Chain NIFTY...");
        const opt = await fetchOptionChain("NIFTY");
        if (opt) {
            console.log("Keys in NIFTY opt:", Object.keys(opt));
            if (opt.optionChains) {
                console.log("optionChains length:", opt.optionChains.length);
            }
            if (opt.optionChain) {
                console.log("optionChain length:", opt.optionChain.length);
            }
            console.log("Sample of opt.optionChain/s:", (opt.optionChains || opt.optionChain)?.slice(0,1));
        }

    } catch(e) {
        console.error(e);
    }
}
run();
