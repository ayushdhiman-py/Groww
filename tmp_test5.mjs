import { fetchOptionChain } from "./src/groww.mjs";

async function run() {
    try {
        const opt = await fetchOptionChain("NIFTY");
        if (opt) {
            console.log(JSON.stringify(opt).slice(0, 500));
        }

    } catch(e) {
        console.error(e);
    }
}
run();
