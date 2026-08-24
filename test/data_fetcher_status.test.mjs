import { test } from "node:test";
import assert from "node:assert/strict";
import {
    getFOBanListStatus, getDeliveryDataStatus, getEarningsCalendarStatus,
    getFiiDiiStatus, getGiftNiftyStatus, getMarketDataStatus,
} from "../src/data_fetcher.mjs";

test("a source that has never succeeded reports available:false, not a silently-empty confirmed result", () => {
    // Fresh process state (no fetch attempted yet in this test file) — every
    // status must say "unknown," never imply "confirmed empty/zero."
    for (const status of [
        getFOBanListStatus(), getDeliveryDataStatus(), getEarningsCalendarStatus(),
        getFiiDiiStatus(), getGiftNiftyStatus(),
    ]) {
        assert.equal(status.available, false);
        assert.equal(status.stale, true);
        assert.equal(status.ageMs, null);
    }
});

test("getMarketDataStatus aggregates all five sources", () => {
    const status = getMarketDataStatus();
    assert.ok("foBanList" in status);
    assert.ok("deliveryMap" in status);
    assert.ok("earnings" in status);
    assert.ok("fiiDii" in status);
    assert.ok("giftNifty" in status);
});
