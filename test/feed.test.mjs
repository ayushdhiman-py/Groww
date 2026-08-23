import { test } from "node:test";
import assert from "node:assert/strict";
import { _setMapsForTesting } from "../src/instruments.mjs";
import { parseFeedMessage } from "../src/feed.mjs";

// Fixture below is the exact shape captured from a live Upstox WebSocket
// connection (MarketDataStreamerV3, mode "ltpc") during verification.

test("parses a real-shaped feed message into symbol -> ltp", () => {
    _setMapsForTesting([
        { symbol: "NIFTY", instrumentKey: "NSE_INDEX|Nifty 50" },
        { symbol: "BANKNIFTY", instrumentKey: "NSE_INDEX|Nifty Bank" },
    ]);
    const raw = JSON.stringify({
        feeds: {
            "NSE_INDEX|Nifty Bank": { ltpc: { ltp: 57761.95, ltt: "1787308200000", cp: 57495.9 } },
            "NSE_INDEX|Nifty 50": { ltpc: { ltp: 24252, ltt: "1787308200000", cp: 24231.85 } },
        },
        currentTs: "1787499519079",
    });

    const updated = parseFeedMessage(raw);
    assert.equal(updated.get("BANKNIFTY"), 57761.95);
    assert.equal(updated.get("NIFTY"), 24252);
});

test("ignores market_info status messages (no feeds key)", () => {
    const raw = JSON.stringify({ type: "market_info", marketInfo: { segmentStatus: { NSE_EQ: "CLOSING_END" } } });
    assert.equal(parseFeedMessage(raw).size, 0);
});

test("skips feed entries whose instrument key doesn't resolve to a known symbol", () => {
    _setMapsForTesting([{ symbol: "NIFTY", instrumentKey: "NSE_INDEX|Nifty 50" }]);
    const raw = JSON.stringify({ feeds: { "NSE_INDEX|Some Other Index": { ltpc: { ltp: 100 } } } });
    assert.equal(parseFeedMessage(raw).size, 0);
});

test("handles malformed JSON without throwing", () => {
    assert.doesNotThrow(() => {
        const updated = parseFeedMessage("{not valid json");
        assert.equal(updated.size, 0);
    });
});

test("handles a feed entry missing ltpc/ltp gracefully", () => {
    _setMapsForTesting([{ symbol: "NIFTY", instrumentKey: "NSE_INDEX|Nifty 50" }]);
    const raw = JSON.stringify({ feeds: { "NSE_INDEX|Nifty 50": {} } });
    assert.equal(parseFeedMessage(raw).size, 0);
});

test("accepts Buffer payloads (as delivered by the WebSocket client)", () => {
    _setMapsForTesting([{ symbol: "NIFTY", instrumentKey: "NSE_INDEX|Nifty 50" }]);
    const raw = Buffer.from(JSON.stringify({ feeds: { "NSE_INDEX|Nifty 50": { ltpc: { ltp: 100 } } } }), "utf-8");
    assert.equal(parseFeedMessage(raw).get("NIFTY"), 100);
});
