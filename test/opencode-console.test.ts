import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.ts";
import type { Fetch } from "../src/http.ts";
import { parseDeviceCode, parseDeviceTokens, parseGoMeters, parseModelUsagePage, parseZenBalance } from "../src/parse.ts";
import { OpencodeWorkspace, ReauthRequired, TokenFile } from "../src/providers/opencode-console.ts";
import { createApp } from "../src/server.ts";

const fixture = (name: string) => Bun.file(new URL(`fixtures/${name}`, import.meta.url)).json();
const DAY = 24 * 3_600_000;
const T0 = Date.parse("2026-10-11T09:00:00Z");
const CONSOLE = "https://opencode.ai/console";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "limits-oc-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("Zen balance from availableMicroCents (1e8 = $1)", async () => {
  expect(parseZenBalance(await fixture("opencode-billing-status.json"))).toBeCloseTo(4.2007442);
  expect(parseZenBalance({ availableMicroCents: "-150000000" })).toBe(-1.5);
  expect(parseZenBalance({ _tag: "Forbidden" })).toBeUndefined();
  expect(parseZenBalance(null)).toBeUndefined();
});

test("Go meters: $ used/limit as percent, nullable at every level", async () => {
  expect(parseGoMeters(await fixture("opencode-go-status-active.json"))).toEqual([
    { label: "5h", usedPercent: 25, resetsAt: Date.parse("2026-10-11T13:00:00Z") },
    { label: "Week", usedPercent: 85, resetsAt: Date.parse("2026-10-13T00:00:00Z") },
    { label: "Month", usedPercent: 0, resetsAt: Date.parse("2026-11-01T00:00:00Z") },
  ]);
  expect(parseGoMeters(await fixture("opencode-go-status-ended.json"))).toEqual([]);
  expect(parseGoMeters(null)).toEqual([]);
  expect(parseGoMeters({ access: { meters: { fiveHour: { resetsAt: null, limitMicroCents: "0", usedMicroCents: "5" } } } })).toEqual([]);
});

test("per-model usage: Go vs Zen by provider, string bigints, junk rows skipped", async () => {
  const page = parseModelUsagePage(await fixture("opencode-usage-models.json"), "30d")!;
  expect(page.pageCount).toBe(1);
  expect(page.items).toEqual([
    {
      range: "30d", plan: "go", provider: "opencode-go", model: "kimi-k3", requests: 149, inputTokens: 1_086_509,
      outputTokens: 108_434, cacheReadTokens: 6_934_595, cacheWriteTokens: 0, costUsd: 6.9664155,
    },
    {
      range: "30d", plan: "zen", provider: "opencode", model: "muse-spark-1.3", requests: 12, inputTokens: 50_000,
      outputTokens: 4000, cacheReadTokens: 0, cacheWriteTokens: 120, costUsd: 0.25,
    },
    {
      range: "30d", plan: "anthropic", provider: "anthropic", model: "claude-opus", requests: 1, inputTokens: 0,
      outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0,
    },
  ]);
  expect(parseModelUsagePage({ _tag: "Unauthorized" }, "7d")).toBeNull();
});

test("device code and token responses", () => {
  expect(
    parseDeviceCode(
      {
        device_code: "dc", user_code: "ABCD-EFGH", verification_uri: "/console/device",
        verification_uri_complete: "/console/device?user_code=ABCD-EFGH&client_id=limits", expires_in: 600, interval: 5,
      },
      "https://opencode.ai",
    ),
  ).toEqual({
    deviceCode: "dc", userCode: "ABCD-EFGH", verificationUrl: "https://opencode.ai/console/device?user_code=ABCD-EFGH&client_id=limits",
    expiresInSeconds: 600, intervalSeconds: 5,
  });
  expect(
    parseDeviceTokens({ access_token: "st_a", refresh_token: "rt_a", token_type: "Bearer", expires_in: 2_592_000, org_id: "wrk_1" }, T0),
  ).toEqual({ accessToken: "st_a", refreshToken: "rt_a", expiresAt: T0 + 30 * DAY, orgId: "wrk_1" });
  expect(parseDeviceTokens({ error: "authorization_pending" }, T0)).toBeNull();
});

test("token file writes atomically with mode 0600 and leaves no temp files", () => {
  const file = new TokenFile(join(dir, "state", "opencode-main.json"));
  expect(file.read()).toBeNull();
  file.write({ accessToken: "st_a", refreshToken: "rt_a", expiresAt: T0 });
  file.write({ accessToken: "st_b", refreshToken: "rt_b", expiresAt: T0 + 1 });
  expect(file.read()).toEqual({ accessToken: "st_b", refreshToken: "rt_b", expiresAt: T0 + 1 });
  expect(statSync(file.path).mode & 0o777).toBe(0o600);
  expect(readdirSync(join(dir, "state"))).toEqual(["opencode-main.json"]);
});

interface Call {
  url: string;
  auth: string | null;
  form?: Record<string, string>;
}

function fakeConsole(handlers: Record<string, (call: Call) => Response | Promise<Response>>): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: Fetch = async (url, init) => {
    const call: Call = { url, auth: new Headers(init?.headers).get("authorization") };
    if (init?.method === "POST") call.form = Object.fromEntries(new URLSearchParams(String(init.body)));
    calls.push(call);
    const path = url.replace(CONSOLE, "").replace(/\?.*$/, "");
    const handler = handlers[path];
    return handler ? handler(call) : new Response("{}", { status: 404 });
  };
  return { fetch: fetchImpl, calls };
}

async function apiHandlers() {
  const billing = await fixture("opencode-billing-status.json");
  const go = await fixture("opencode-go-status-active.json");
  const models = await fixture("opencode-usage-models.json");
  return {
    "/api/billing/status": () => Response.json(billing),
    "/api/go/status": () => Response.json(go),
    "/api/usage/models": () => Response.json(models),
    "/api/user": () => Response.json({ id: "usr_1", email: "zen@example.com", name: null, role: "admin" }),
  };
}

test("a fresh user token is used as-is for balance, Go meters and three model ranges", async () => {
  const tokens = new TokenFile(join(dir, "t.json"));
  tokens.write({ accessToken: "st_a", refreshToken: "rt_a", expiresAt: T0 + 20 * DAY });
  const upstream = fakeConsole(await apiHandlers());
  const workspace = new OpencodeWorkspace(tokens, undefined, upstream.fetch, () => T0);
  const observation = await workspace.fetchObservation();
  expect(observation.balanceUsd).toBeCloseTo(4.2007442);
  expect(observation.windows.map((w) => [w.label, w.usedPercent])).toEqual([["5h", 25], ["Week", 85], ["Month", 0]]);
  expect(new Set(observation.models!.map((m) => m.range))).toEqual(new Set(["24h", "7d", "30d"]));
  expect(upstream.calls.every((c) => c.auth === "Bearer st_a")).toBe(true);
  expect(upstream.calls.some((c) => c.url.includes("/auth/device"))).toBe(false);
  expect(workspace.email).toBe("zen@example.com");
});

test("near expiry: one refresh for concurrent callers, persisted before use, old refresh token never reused", async () => {
  const tokens = new TokenFile(join(dir, "t.json"));
  tokens.write({ accessToken: "st_old", refreshToken: "rt_old", expiresAt: T0 + 3 * DAY });
  let refreshes = 0;
  let persistedWhenUsed: string | undefined;
  const upstream = fakeConsole({
    ...(await apiHandlers()),
    "/auth/device/token": async (call) => {
      refreshes++;
      await Bun.sleep(5);
      if (call.form?.refresh_token !== "rt_old") return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: "st_new", refresh_token: "rt_new", token_type: "Bearer", expires_in: 2_592_000 });
    },
    "/api/billing/status": (call) => {
      persistedWhenUsed = tokens.read()?.refreshToken;
      return call.auth === "Bearer st_new" ? Response.json({ availableMicroCents: "100000000" }) : new Response("{}", { status: 401 });
    },
  });
  const workspace = new OpencodeWorkspace(tokens, undefined, upstream.fetch, () => T0);
  const [a, b] = await Promise.all([workspace.accessToken(), workspace.accessToken()]);
  expect([a, b]).toEqual(["st_new", "st_new"]);
  expect(refreshes).toBe(1);
  expect(upstream.calls[0]!.form).toEqual({ grant_type: "refresh_token", refresh_token: "rt_old", client_id: "limits" });
  expect(tokens.read()).toEqual({ accessToken: "st_new", refreshToken: "rt_new", expiresAt: T0 + 30 * DAY });

  expect((await workspace.fetchObservation()).balanceUsd).toBe(1);
  expect(persistedWhenUsed).toBe("rt_new");
  expect(refreshes).toBe(1);
});

test("invalid_grant or a 401 means a new device login is needed", async () => {
  const tokens = new TokenFile(join(dir, "t.json"));
  tokens.write({ accessToken: "st_old", refreshToken: "rt_old", expiresAt: T0 + DAY });
  const revoked = fakeConsole({ "/auth/device/token": () => Response.json({ _tag: "DeviceTokenError", error: "invalid_grant" }, { status: 400 }) });
  await expect(new OpencodeWorkspace(tokens, undefined, revoked.fetch, () => T0).fetchObservation()).rejects.toThrow(ReauthRequired);

  tokens.write({ accessToken: "st_dead", refreshToken: "rt", expiresAt: T0 + 20 * DAY });
  const unauthorized = fakeConsole({ "/api/billing/status": () => Response.json({ _tag: "Unauthorized" }, { status: 401 }) });
  await expect(new OpencodeWorkspace(tokens, undefined, unauthorized.fetch, () => T0).fetchObservation()).rejects.toThrow("device login needed");

  const none = new OpencodeWorkspace(new TokenFile(join(dir, "missing.json")), undefined, unauthorized.fetch, () => T0);
  await expect(none.fetchObservation()).rejects.toThrow("device login needed");
});

test("service key only: no balance, Go 403 tolerated, models still read", async () => {
  const upstream = fakeConsole({
    ...(await apiHandlers()),
    "/api/go/status": () => Response.json({ _tag: "Forbidden" }, { status: 403 }),
  });
  const workspace = new OpencodeWorkspace(new TokenFile(join(dir, "missing.json")), "oc_sk_test", upstream.fetch, () => T0);
  const observation = await workspace.fetchObservation();
  expect(observation.balanceUsd).toBeUndefined();
  expect(observation.windows).toEqual([]);
  expect(observation.models).toHaveLength(9);
  expect(upstream.calls.some((c) => c.url.includes("billing"))).toBe(false);
  expect(upstream.calls.every((c) => c.auth === "Bearer oc_sk_test")).toBe(true);
});

test("model usage pages until pageCount", async () => {
  const tokens = new TokenFile(join(dir, "t.json"));
  tokens.write({ accessToken: "st_a", refreshToken: "rt_a", expiresAt: T0 + 20 * DAY });
  const base = await apiHandlers();
  const upstream = fakeConsole({
    ...base,
    "/api/usage/models": (call) => {
      const page = Number(new URL(call.url).searchParams.get("page"));
      return Response.json({
        items: [{ model: `m${page}`, provider: "opencode-go", totalCostMicroCents: "100000000" }],
        pageInfo: { page, pageSize: 100, total: 2, pageCount: 2 },
      });
    },
  });
  const observation = await new OpencodeWorkspace(tokens, undefined, upstream.fetch, () => T0).fetchObservation();
  expect(observation.models!.filter((m) => m.range === "7d").map((m) => m.model)).toEqual(["m1", "m2"]);
});

test("device login: pending, slow_down, then tokens persisted; API endpoints guard the POST", async () => {
  let polls = 0;
  const upstream = fakeConsole({
    "/auth/device/code": () =>
      Response.json({
        device_code: "dc_1", user_code: "ABCD-EFGH", verification_uri: "/console/device",
        verification_uri_complete: "/console/device?user_code=ABCD-EFGH&client_id=limits", expires_in: 600, interval: 5,
      }),
    "/auth/device/token": (call) => {
      expect(call.form).toEqual({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: "dc_1", client_id: "limits" });
      polls++;
      if (polls === 1) return Response.json({ error: "authorization_pending" }, { status: 400 });
      if (polls === 2) return Response.json({ error: "slow_down" }, { status: 400 });
      return Response.json({ access_token: "st_a", refresh_token: "rt_a", token_type: "Bearer", expires_in: 2_592_000, org_id: "wrk_1" });
    },
  });
  const sleeps: number[] = [];
  const tokens = new TokenFile(join(dir, "t.json"));
  const workspace = new OpencodeWorkspace(tokens, undefined, upstream.fetch, () => T0, async (ms) => {
    sleeps.push(ms);
  });
  const app = createApp({
    store: new Store(":memory:"),
    summary: () => ({ generatedAt: T0, accounts: [], errors: [] }),
    workspaces: new Map([["main", workspace]]),
  });

  expect((await app.request("/api/opencode/main/login", { method: "POST" })).status).toBe(400);
  expect((await app.request("/api/opencode/nope/login", { method: "POST", headers: { "X-Limits-Action": "login" } })).status).toBe(404);

  const started = await (await app.request("/api/opencode/main/login", { method: "POST", headers: { "X-Limits-Action": "login" } })).json();
  expect(started).toEqual({
    status: "pending", userCode: "ABCD-EFGH",
    verificationUrl: "https://opencode.ai/console/device?user_code=ABCD-EFGH&client_id=limits", expiresAt: T0 + 600_000,
  });
  for (let i = 0; i < 20 && workspace.login.status === "pending"; i++) await Bun.sleep(1);
  expect(await (await app.request("/api/opencode/main/login")).json()).toEqual({ status: "done", at: T0 });
  expect(sleeps).toEqual([5000, 5000, 10_000]);
  expect(tokens.read()).toEqual({ accessToken: "st_a", refreshToken: "rt_a", expiresAt: T0 + 30 * DAY, orgId: "wrk_1" });
});

test("per-model rows replace the previous breakdown and are served by /api/models", async () => {
  const store = new Store(":memory:");
  const account = { id: "opencode:main", provider: "opencode" as const, label: "Default" };
  const page = parseModelUsagePage(await fixture("opencode-usage-models.json"), "30d")!;
  store.recordObservation(account, { windows: [], models: [{ ...page.items[0]!, model: "stale" }] }, T0);
  store.recordObservation(account, { windows: [], balanceUsd: 4.2, models: page.items }, T0 + 60_000);
  const app = createApp({ store, summary: () => ({ generatedAt: T0, accounts: [], errors: [] }) });
  const body = (await (await app.request("/api/models?account=opencode:main&range=30d")).json()) as {
    models: { model: string; plan: string; cost_usd: number }[];
  };
  expect(body.models.map((m) => [m.model, m.plan, m.cost_usd])).toEqual([
    ["kimi-k3", "go", 6.9664155],
    ["muse-spark-1.3", "zen", 0.25],
    ["claude-opus", "anthropic", 0],
  ]);
});
