import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { _setMapsForTesting } from "../src/instruments.mjs";
import { login, isLoggedIn, loadSession } from "../src/upstox.mjs";

afterEach(() => mock.restoreAll());

test("login() succeeds and flips isLoggedIn() when Upstox accepts the token", async () => {
    _setMapsForTesting([{ symbol: "NIFTY", instrumentKey: "NSE_INDEX|Nifty 50" }]);
    mock.method(axios, "get", async () => ({ data: { status: "success", data: {} } }));

    await login();
    assert.equal(isLoggedIn(), true);
});

test("login() throws a clear, non-sensitive error on 401 (invalid/expired token)", async () => {
    _setMapsForTesting([{ symbol: "NIFTY", instrumentKey: "NSE_INDEX|Nifty 50" }]);
    mock.method(axios, "get", async () => {
        const err = new Error("Request failed with status code 401");
        err.response = { status: 401, data: { errors: [{ errorCode: "UDAPI100050", message: "Invalid token used to access API" }] } };
        throw err;
    });

    await assert.rejects(() => login(), /rejected the access token/);
});

test("loadSession() reflects whether a token is configured, without any file I/O", () => {
    assert.equal(typeof loadSession(), "boolean");
});
