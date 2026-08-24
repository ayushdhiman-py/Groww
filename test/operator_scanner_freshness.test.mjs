import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { optionsCache } from "../src/options_feed.mjs";
import { buildFoDataMap, transformScannerData } from "../src/operator_scanner.mjs";

afterEach(() => {
    optionsCache.delete("FRESHTEST");
    optionsCache.delete("STALETEST");
});

test("buildFoDataMap reports real OI/PCR for a symbol whose option polling is genuinely current", () => {
    optionsCache.set("FRESHTEST", {
        updatedAt: new Date().toISOString(),
        oiChange: 12.5, pcr: 1.3, callOIDelta: 500,
    });
    const map = buildFoDataMap();
    assert.equal(map.FRESHTEST.isFoStock, true);
    assert.equal(map.FRESHTEST.oiChangePercent, 12.5);
    assert.equal(map.FRESHTEST.pcr, 1.3);
    assert.equal(map.FRESHTEST.ceOiBuilding, true);
    assert.equal(map.FRESHTEST.oiDataStale, false);
});

test("buildFoDataMap nulls out OI/PCR (never serves a stale number as current) once a symbol's option polling has stalled", () => {
    optionsCache.set("STALETEST", {
        updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h old — well past OPTIONS_STALE_AFTER_MS
        oiChange: 12.5, pcr: 1.3, callOIDelta: 500,
    });
    const map = buildFoDataMap();
    assert.equal(map.STALETEST.isFoStock, true, "still structurally F&O-eligible");
    assert.equal(map.STALETEST.oiChangePercent, null, "stale OI change must not read as a real current number");
    assert.equal(map.STALETEST.pcr, null);
    assert.equal(map.STALETEST.ceOiBuilding, false);
    assert.equal(map.STALETEST.oiDataStale, true);
});

test("transformScannerData attaches null options/OI (not a stale snapshot) for a symbol whose option polling has stalled", () => {
    optionsCache.set("STALETEST", {
        updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        oiChange: 40, iv: 55, pcr: 0.9, totalCallOI: 1000, totalPutOI: 900,
    });
    const mainScannerState = { data: { "1d_ALL": [{ symbol: "STALETEST", sector: "IT", price: 100 }] } };
    const [row] = transformScannerData(mainScannerState);
    assert.equal(row.options, null);
    assert.equal(row.optionsDataStale, true);
    assert.equal(row.oiChange, null);
    assert.equal(row.oiChangePercent, null);
    assert.equal(row.iv, null);
    assert.equal(row.pcr, null);
});

test("transformScannerData attaches real options/OI for a symbol whose option polling is current", () => {
    optionsCache.set("FRESHTEST", {
        updatedAt: new Date().toISOString(),
        oiChange: 40, iv: 55, pcr: 0.9, totalCallOI: 1000, totalPutOI: 900,
    });
    const mainScannerState = { data: { "1d_ALL": [{ symbol: "FRESHTEST", sector: "IT", price: 100 }] } };
    const [row] = transformScannerData(mainScannerState);
    assert.ok(row.options);
    assert.equal(row.optionsDataStale, false);
    assert.equal(row.oiChange, 40);
    assert.equal(row.oiChangePercent, 40);
    assert.equal(row.iv, 55);
    assert.equal(row.pcr, 0.9);
});
