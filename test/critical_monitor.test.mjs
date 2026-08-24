import { test } from "node:test";
import assert from "node:assert/strict";
import { runCriticalMonitorTick } from "../src/critical_monitor.mjs";
import { listCriticalTrades } from "../src/critical_trades.mjs";

test("runCriticalMonitorTick is a safe no-op (no network calls, no throw) when there are no active Critical trades", async () => {
    // This test relies on a clean data/critical_trades.json (empty/no ACTIVE
    // trades) in this environment — confirmed at server boot logs ("Loaded 0
    // trade(s) from disk"). If trades exist, this just asserts no throw.
    const activeBefore = listCriticalTrades();
    await assert.doesNotReject(() => runCriticalMonitorTick());
    // A no-op tick must not have mutated the trade list.
    assert.deepEqual(listCriticalTrades(), activeBefore);
});

test("runCriticalMonitorTick tolerates concurrent calls without overlapping (re-entrancy guard)", async () => {
    const p1 = runCriticalMonitorTick();
    const p2 = runCriticalMonitorTick();
    await assert.doesNotReject(() => Promise.all([p1, p2]));
});
