import assert from "node:assert/strict";
import test from "node:test";

import {
  DASHBOARD_SESSION_HEADER,
  DASHBOARD_SESSION_STORAGE_KEY,
  bootstrapDashboardSessionToken,
  dashboardAuthenticatedHeaders
} from "../frontend/src/dashboardSession.js";

const SESSION_TOKEN = "a".repeat(64);

test("dashboard session bootstrap consumes the launch fragment and keeps the token tab-scoped", () => {
  const values = new Map<string, string>();
  const replaced: string[] = [];
  const token = bootstrapDashboardSessionToken(
    { hash: `#session=${SESSION_TOKEN}`, pathname: "/dashboard", search: "?view=graph" },
    storage(values),
    (url) => replaced.push(url)
  );

  assert.equal(token, SESSION_TOKEN);
  assert.equal(values.get(DASHBOARD_SESSION_STORAGE_KEY), SESSION_TOKEN);
  assert.deepEqual(replaced, ["/dashboard?view=graph"]);

  const refreshed = bootstrapDashboardSessionToken(
    { hash: "", pathname: "/dashboard", search: "?view=graph" },
    storage(values),
    (url) => replaced.push(url)
  );
  assert.equal(refreshed, SESSION_TOKEN);
  assert.deepEqual(replaced, ["/dashboard?view=graph"]);
});

test("dashboard session bootstrap rejects malformed launch and stored credentials", () => {
  const values = new Map<string, string>([[DASHBOARD_SESSION_STORAGE_KEY, SESSION_TOKEN]]);
  const replaced: string[] = [];
  assert.equal(
    bootstrapDashboardSessionToken(
      { hash: "#session=not-a-token", pathname: "/dashboard", search: "" },
      storage(values),
      (url) => replaced.push(url)
    ),
    null
  );
  assert.equal(values.has(DASHBOARD_SESSION_STORAGE_KEY), false);
  assert.deepEqual(replaced, ["/dashboard"]);

  values.set(DASHBOARD_SESSION_STORAGE_KEY, "also-invalid");
  assert.equal(
    bootstrapDashboardSessionToken({ hash: "", pathname: "/dashboard", search: "" }, storage(values), () =>
      assert.fail("a fragment-free refresh must not rewrite browser history")
    ),
    null
  );
  assert.equal(values.has(DASHBOARD_SESSION_STORAGE_KEY), false);
});

test("dashboard authenticated headers reject invalid tokens and never put credentials in URLs", () => {
  const headers = dashboardAuthenticatedHeaders(SESSION_TOKEN, { accept: "application/json" });
  assert.equal(headers.get(DASHBOARD_SESSION_HEADER), SESSION_TOKEN);
  assert.equal(headers.get("accept"), "application/json");
  assert.throws(() => dashboardAuthenticatedHeaders("invalid"), /session token is invalid/u);
});

function storage(values: Map<string, string>): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => {
      values.delete(key);
    }
  };
}
