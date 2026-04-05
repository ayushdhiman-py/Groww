import { fetchOptionChain } from "./src/groww.mjs";

async function run() {
    try {
        const opt = await fetchOptionChain("NIFTY");
        if (opt && opt.strikes) {
            console.log("underlying ltp:", opt.underlying_ltp);
            console.log("Total strikes:", opt.strikes.length);
            console.log("First strike data:", JSON.stringify(opt.strikes[0], null, 2));
        }

    } catch(e) {
        console.error(e);
    }
}
run();
