// ─────────────────────────────────────────────────────────────────────────────
// market_cap.mjs — static market-cap-category lookup for the learning layer.
//
// universe.mjs has no existing cap tagging, and guessing at real-world
// classifications (which drift over time as companies grow/shrink/list new
// shares) risks being silently wrong forever — worse than admitting we don't
// know. Every symbol defaults to "UNKNOWN" until explicitly categorized
// here; nothing downstream requires this to be populated (learning_capture.mjs
// stores whatever this returns, "UNKNOWN" included, and the daily stats
// rollup simply won't have a meaningful market-cap-segmented view until this
// is filled in). Edit CATEGORY_BY_SYMBOL directly to add real
// classifications as you verify them.
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORY_BY_SYMBOL = {
    // Intentionally empty at ship time — see file header. Add entries like:
    //   RELIANCE: "LARGE",
};

export function getMarketCapCategory(symbol) {
    return CATEGORY_BY_SYMBOL[symbol] || "UNKNOWN";
}
