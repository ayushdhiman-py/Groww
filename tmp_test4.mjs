import { fetchOptionChain } from "./src/groww.mjs";

async function run() {
    try {
        const opt = await fetchOptionChain("NIFTY");
        if (opt) {
            console.log("Keys:", Object.keys(opt));
            console.log("opt.optionChains.length", opt.optionChains?.length);
        }

    } catch(e) {
        console.error(e);
    }
}
run();
