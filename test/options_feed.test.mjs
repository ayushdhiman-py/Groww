import { test } from "node:test";
import assert from "node:assert/strict";
import { optionsCache, getOptionsCacheWithFreshness } from "../src/options_feed.mjs";

test("getOptionsCacheWithFreshness is UNAVAILABLE for a symbol never polled", () => {
    const result = getOptionsCacheWithFreshness("NEVER_POLLED_SYMBOL");
    assert.equal(result.data, null);
    assert.equal(result.source, "UNAVAILABLE");
});

test("getOptionsCacheWithFreshness returns source:'cache' for a recently-polled entry", () => {
    optionsCache.set("FRESHSYM", { spot: 100, topCalls: [], topPuts: [], updatedAt: new Date().toISOString() });
    const result = getOptionsCacheWithFreshness("FRESHSYM");
    assert.equal(result.stale, false);
    assert.equal(result.source, "cache");
    assert.ok(result.data);
});

test("getOptionsCacheWithFreshness flags source:'cache-stale' for an entry the poller has stopped refreshing", () => {
    // Far older than any plausible round-robin sweep of the universe.
    const ancientTs = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    optionsCache.set("STALESYM", { spot: 100, topCalls: [], topPuts: [], updatedAt: ancientTs });
    const result = getOptionsCacheWithFreshness("STALESYM");
    assert.equal(result.stale, true);
    assert.equal(result.source, "cache-stale");
    // The data is still returned (a stale real snapshot beats nothing), but
    // ONLY under the stale label — never presented as plain "cache".
    assert.ok(result.data);
});
