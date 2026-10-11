import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, ConfigError, MIN_INTERVAL_MS, parseConfig } from "../src/config.ts";
import { Store } from "../src/db.ts";
import type { Fetch } from "../src/http.ts";
import { Poller } from "../src/poller.ts";
import { discoverAccounts } from "../src/providers/index.ts";
import { CLAUDE_PROFILE_URL, CLAUDE_USAGE_URL } from "../src/providers/claude.ts";
import { CODEX_USAGE_URL } from "../src/providers/codex.ts";
import { GROK_BASE_URL } from "../src/providers/grok.ts";
import { OPENCODE_GO_USAGE_URL, OPENROUTER_CREDITS_URL } from "../src/providers/static-keys.ts";
import { createApp } from "../src/server.ts";
import { OpencodeWorkspace, TokenFile } from "../src/providers/opencode-console.ts";
import { buildSummary } from "../src/summary.ts";

const fixture = (name: string) => Bun.file(new URL(`fixtures/${name}`, import.meta.url)).json();
const MIN = 60_000;
const T0 = Date.parse("2026-10-11T09:00:00Z");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "limits-test-"));
  writeFileSync(join(dir, "mgmt"), "mgmt-secret\n");
  writeFileSync(join(dir, "go-main"), "go-secret");
  writeFileSync(join(dir, "or-main"), "or-secret");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function baseConfig(): Config {
  return parseConfig(
    {
      cliproxy: { baseUrl: "http://cpa.test:8317/", managementKeyFile: "mgmt" },
      claude: { accounts: { "a@example.com": { label: "Claude A" }, "claude-b.json": { disabled: true } } },
      codex: { accounts: { "d@example.com": { label: "Codex D", chatgptAccountId: "acct-from-config" } } },
      opencodeGo: [{ id: "main", label: "Go main", keyFile: "go-main" }],
      openrouter: [{ id: "main", keyFile: "or-main" }],
      opencode: [{ id: "main", label: "Default" }],
      intervalMinutes: { claude: 1, codex: 3 },
    },
    dir,
    { CREDENTIALS_DIRECTORY: dir },
  );
}

const workspaces = (fetchImpl: Fetch) =>
  new Map([["main", new OpencodeWorkspace(new TokenFile(join(dir, "opencode-main.json")), undefined, fetchImpl)]]);

interface Call {
  url: string;
  init?: RequestInit;
}

/** A fake CLIProxyAPI plus the static-key upstreams. */
async function fakeUpstreams(overrides: Record<string, () => Response> = {}): Promise<{ fetch: Fetch; calls: Call[] }> {
  const calls: Call[] = [];
  const authFiles = await fixture("cliproxy-auth-files.json");
  const bodies: Record<string, unknown> = {
    [CLAUDE_USAGE_URL]: await fixture("claude-usage.json"),
    [CLAUDE_PROFILE_URL]: await fixture("claude-profile.json"),
    [CODEX_USAGE_URL]: await fixture("codex-usage.json"),
    [`${GROK_BASE_URL}/user`]: await fixture("grok-user.json"),
    [`${GROK_BASE_URL}/billing?format=credits`]: await fixture("grok-billing.json"),
    [`${GROK_BASE_URL}/settings`]: await fixture("grok-settings.json"),
  };
  const fetchImpl: Fetch = async (url, init) => {
    calls.push({ url, init });
    const override = overrides[url];
    if (override) return override();
    if (url === "http://cpa.test:8317/v0/management/auth-files") return Response.json(authFiles);
    if (url === "http://cpa.test:8317/v0/management/api-call") {
      const request = JSON.parse(String(init?.body));
      const key = `${request.url}#${request.auth_index}`;
      if (overrides[key]) return overrides[key]!();
      return Response.json({ status_code: 200, header: {}, body: JSON.stringify(bodies[request.url]) });
    }
    if (url === OPENCODE_GO_USAGE_URL) return Response.json(await fixture("opencode-go-usage.json"));
    if (url === OPENROUTER_CREDITS_URL) return Response.json(await fixture("openrouter-credits.json"));
    return new Response("not found", { status: 404 });
  };
  return { fetch: fetchImpl, calls };
}

test("config reads secrets from CREDENTIALS_DIRECTORY and clamps intervals to provider floors", () => {
  const config = baseConfig();
  expect(config.cliproxy?.managementKey).toBe("mgmt-secret");
  expect(config.opencodeGo).toEqual([{ id: "main", label: "Go main", key: "go-secret" }]);
  expect(config.openrouter[0]?.label).toBe("main");
  expect(config.intervalMs.claude).toBe(MIN_INTERVAL_MS.claude);
  expect(config.intervalMs.codex).toBe(3 * MIN);
  expect(config.intervalMs.openrouter).toBe(15 * MIN);
  expect(config.hosts).toEqual(["127.0.0.1"]);
});

test("config errors name the file, not its contents", () => {
  expect(() => parseConfig({ opencodeGo: [{ id: "x", keyFile: "missing" }] }, dir, {})).toThrow(
    new ConfigError("cannot read secret file missing"),
  );
  expect(() => parseConfig({ intervalMinutes: { google: 5 } }, dir, {})).toThrow(ConfigError);
  expect(() => parseConfig({ opencodeGo: [{ id: "a", keyFile: "go-main" }, { id: "a", keyFile: "go-main" }] }, dir, {})).toThrow(
    "duplicate id",
  );
});

test("discovery maps CLIProxyAPI auth files to labelled Claude, Codex and Grok accounts", async () => {
  const upstream = await fakeUpstreams();
  const { accounts, failed } = await discoverAccounts(baseConfig(), workspaces(upstream.fetch), upstream.fetch);
  expect(failed).toEqual([]);
  expect(accounts.map((a) => [a.id, a.provider, a.label, a.email])).toEqual([
    ["claude:a@example.com", "claude", "Claude A", "a@example.com"],
    ["codex:c@example.com", "codex", "Codex", "c@example.com"],
    ["codex:d@example.com", "codex", "Codex D", "d@example.com"],
    ["grok:g@example.com", "grok", "SuperGrok", "g@example.com"],
    ["opencode-go:main", "opencode-go", "Go main", null],
    ["openrouter:main", "openrouter", "main", null],
    ["opencode:main", "opencode", "Default", null],
  ]);
  const authHeader = new Headers(upstream.calls[0]?.init?.headers).get("authorization");
  expect(authHeader).toBe("Bearer mgmt-secret");
});

test("Claude and Codex polls go through api-call with $TOKEN$ and the right account id", async () => {
  const upstream = await fakeUpstreams();
  const { accounts } = await discoverAccounts(baseConfig(), workspaces(upstream.fetch), upstream.fetch);
  const byId = Object.fromEntries(accounts.map((a) => [a.id, a]));

  const claude = await byId["claude:a@example.com"]!.poll();
  expect(claude.windows.map((w) => w.label)).toEqual(["5h", "Week", "Fable", "Future Model"]);

  const codexFromToken = await byId["codex:c@example.com"]!.poll();
  const codexFromConfig = await byId["codex:d@example.com"]!.poll();
  expect(codexFromToken.credits).toBe(61246.065);
  expect(codexFromConfig.windows.map((w) => w.label)).toEqual(["5h", "Week"]);

  const apiCalls = upstream.calls
    .filter((c) => c.url.endsWith("/api-call"))
    .map((c) => JSON.parse(String(c.init?.body)))
    .filter((b) => b.url !== CLAUDE_PROFILE_URL);
  expect(claude.plan).toEqual({ name: "Max 20x", status: "active", renewsAt: null, canceledAt: null });
  expect(codexFromToken.plan).toEqual({ name: "Pro", status: "active", renewsAt: null, canceledAt: null });
  expect(apiCalls[0]).toEqual({
    auth_index: "a1b2",
    method: "GET",
    url: CLAUDE_USAGE_URL,
    header: {
      Authorization: "Bearer $TOKEN$",
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "claude-code/2.1.285",
      Accept: "application/json",
    },
  });
  expect(apiCalls[1].header["ChatGPT-Account-Id"]).toBe("acct-from-token");
  expect(apiCalls[2].header["ChatGPT-Account-Id"]).toBe("acct-from-config");
});

test("two Codex accounts with no config are separate entries titled Codex with their emails, each polled as itself", async () => {
  const upstream = await fakeUpstreams();
  const config = { ...baseConfig(), codex: {} };
  const { accounts } = await discoverAccounts(config, workspaces(upstream.fetch), upstream.fetch);
  const codex = accounts.filter((a) => a.provider === "codex");
  expect(codex.map((a) => [a.id, a.label, a.email])).toEqual([
    ["codex:c@example.com", "Codex", "c@example.com"],
    ["codex:d@example.com", "Codex", "d@example.com"],
  ]);
  for (const account of codex) await account.poll();
  const sent = upstream.calls
    .filter((c) => c.url.endsWith("/api-call"))
    .map((c) => JSON.parse(String(c.init?.body)))
    .map((b) => [b.auth_index, b.header["ChatGPT-Account-Id"]]);
  expect(sent).toEqual([
    ["e5f6", "acct-from-token"],
    ["g7h8", undefined],
  ]);
});

test("Grok goes identity-first through api-call with pi-usage's headers, then reports credit %, period end and the plan from /settings", async () => {
  const upstream = await fakeUpstreams();
  const { accounts } = await discoverAccounts(baseConfig(), workspaces(upstream.fetch), upstream.fetch);
  const grok = accounts.find((a) => a.id === "grok:g@example.com")!;
  expect(await grok.poll()).toEqual({
    windows: [{ label: "Week", usedPercent: 42.5, resetsAt: Date.parse("2026-08-17T12:51:17Z") }],
    plan: { name: "SuperGrok", status: "active", renewsAt: null, canceledAt: null },
  });
  const sent = upstream.calls.filter((c) => c.url.endsWith("/api-call")).map((c) => JSON.parse(String(c.init?.body)));
  const base = {
    Authorization: "Bearer $TOKEN$",
    Accept: "application/json",
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-grok-client-version": "1.0.3",
    "x-grok-client-mode": "headless",
  };
  expect(sent).toEqual([
    { auth_index: "x1y2", method: "GET", url: `${GROK_BASE_URL}/user`, header: base },
    { auth_index: "x1y2", method: "GET", url: `${GROK_BASE_URL}/billing?format=credits`, header: { ...base, "x-userid": "user-123" } },
    { auth_index: "x1y2", method: "GET", url: `${GROK_BASE_URL}/settings`, header: { ...base, "x-userid": "user-123" } },
  ]);
});

test("Grok without a usable user id never calls billing", async () => {
  const upstream = await fakeUpstreams({
    [`${GROK_BASE_URL}/user#x1y2`]: () => Response.json({ status_code: 200, header: {}, body: JSON.stringify({ userId: "a\r\nb" }) }),
  });
  const { accounts } = await discoverAccounts(baseConfig(), workspaces(upstream.fetch), upstream.fetch);
  await expect(accounts.find((a) => a.provider === "grok")!.poll()).rejects.toThrow("identity unavailable");
  expect(upstream.calls.some((c) => String(c.init?.body ?? "").includes("billing"))).toBe(false);
});

test("static-key providers send their own key; an unconnected OpenCode workspace asks for a login", async () => {
  const upstream = await fakeUpstreams();
  const { accounts } = await discoverAccounts(baseConfig(), workspaces(upstream.fetch), upstream.fetch);
  const byId = Object.fromEntries(accounts.map((a) => [a.id, a]));
  expect((await byId["opencode-go:main"]!.poll()).windows).toHaveLength(3);
  expect(await byId["openrouter:main"]!.poll()).toEqual({ windows: [], balanceUsd: 107.876543 });
  const headers = (url: string) => new Headers(upstream.calls.find((c) => c.url === url)?.init?.headers);
  expect(headers(OPENCODE_GO_USAGE_URL).get("authorization")).toBe("Bearer go-secret");
  expect(headers(OPENROUTER_CREDITS_URL).get("authorization")).toBe("Bearer or-secret");
  await expect(byId["opencode:main"]!.poll()).rejects.toThrow("device login needed");
});

test("upstream and cliproxy errors surface as short messages", async () => {
  const upstream = await fakeUpstreams({
    [`${CLAUDE_USAGE_URL}#a1b2`]: () => Response.json({ status_code: 429, header: {}, body: "{\"error\":\"rate_limited\"}" }),
    [`${CODEX_USAGE_URL}#e5f6`]: () => Response.json({ error: "auth token not found" }, { status: 400 }),
  });
  const { accounts } = await discoverAccounts(baseConfig(), workspaces(upstream.fetch), upstream.fetch);
  const byId = Object.fromEntries(accounts.map((a) => [a.id, a]));
  await expect(byId["claude:a@example.com"]!.poll()).rejects.toThrow("HTTP 429");
  await expect(byId["codex:c@example.com"]!.poll()).rejects.toThrow("cliproxy HTTP 400: auth token not found");
});

test("poller respects per-provider intervals across restarts and keeps accounts when discovery fails", async () => {
  const store = new Store(":memory:");
  const config = baseConfig();
  let now = T0;
  let cliproxyDown = false;
  const upstream = await fakeUpstreams({
    "http://cpa.test:8317/v0/management/auth-files": () =>
      cliproxyDown ? new Response("bad gateway", { status: 502 }) : new Response(JSON.stringify(authFilesFixture)),
  });
  const authFilesFixture = await fixture("cliproxy-auth-files.json");
  const makePoller = () =>
    new Poller({
      store,
      discover: () => discoverAccounts(config, workspaces(upstream.fetch), upstream.fetch),
      intervalMs: config.intervalMs,
      retentionMs: 30 * 24 * 60 * MIN,
      now: () => now,
    });
  const polls = (url: string) =>
    upstream.calls.filter((c) => c.url.endsWith("/api-call") && JSON.parse(String(c.init?.body)).url === url).length;

  const poller = makePoller();
  await poller.tick();
  expect([polls(CLAUDE_USAGE_URL), polls(CODEX_USAGE_URL)]).toEqual([1, 2]);

  now = T0 + 2 * MIN;
  await makePoller().tick();
  expect([polls(CLAUDE_USAGE_URL), polls(CODEX_USAGE_URL)]).toEqual([1, 2]);

  now = T0 + 3 * MIN;
  await poller.tick();
  expect([polls(CLAUDE_USAGE_URL), polls(CODEX_USAGE_URL)]).toEqual([1, 4]);

  now = T0 + 5 * MIN;
  cliproxyDown = true;
  await poller.tick();
  expect(poller.errors).toEqual([{ providers: ["claude", "codex", "grok"], message: "HTTP 502" }]);
  expect(poller.accounts.map((a) => a.id)).toContain("claude:a@example.com");
  expect([polls(CLAUDE_USAGE_URL), polls(CODEX_USAGE_URL)]).toEqual([2, 4]);
  expect(store.account("opencode:main")?.error).toBe("device login needed");

  const coldStart = makePoller();
  await coldStart.tick();
  expect(coldStart.accounts.some((a) => a.provider === "claude")).toBe(false);
  expect(coldStart.errors).toHaveLength(1);
});

test("summary and API: projections, credits, balance burn and history", async () => {
  const store = new Store(":memory:");
  const H = 3_600_000;
  const reset = T0 + 5 * H;
  const claude = { id: "claude:a", provider: "claude" as const, label: "Claude A" };
  const codex = { id: "codex:c", provider: "codex" as const, label: "Codex C" };
  const router = { id: "openrouter:main", provider: "openrouter" as const, label: "OpenRouter" };
  for (let h = 0; h <= 2; h++) {
    store.recordObservation(claude, { windows: [{ label: "5h", usedPercent: 20 + 20 * h, resetsAt: reset }] }, T0 + h * H);
    store.recordObservation(router, { windows: [], balanceUsd: 100 - 6 * h }, T0 + h * H);
  }
  store.recordObservation(codex, { windows: [{ label: "5h", usedPercent: 1 }], credits: "unlimited" }, T0);
  store.recordFailure(codex, "HTTP 429", T0 + H);

  const accounts = [claude, codex, router, { id: "opencode:main", provider: "opencode" as const, label: "Default" }].map((a) => ({
    ...a,
    poll: async () => ({ windows: [] }),
  }));
  const summary = () => buildSummary(store, accounts, [], T0 + 2 * H);
  const app = createApp({ store, summary, now: () => T0 + 2 * H });

  const body = (await (await app.request("/api/summary")).json()) as ReturnType<typeof summary>;
  const [a, c, r, z] = body.accounts;
  expect(a!.windows).toEqual([
    {
      window: "5h",
      usedPercent: 60,
      resetsAt: reset,
      projection: { percentPerHour: 20, projectedAtReset: 100, hitsLimitAt: T0 + 4 * H, samples: 3 },
    },
  ]);
  expect(c!.status).toBe("error");
  expect(c!.error).toBe("HTTP 429");
  expect(c!.observedAt).toBe(T0);
  expect(c!.credits).toEqual({ balance: null, unlimited: true, burn: null });
  expect(r!.balanceUsd!.balance).toBe(88);
  expect(r!.balanceUsd!.burn!.perDay).toBeCloseTo(144);
  expect(z!.status).toBe("pending");

  const history = (await (await app.request(`/api/history?account=claude:a&since=${T0 + H}`)).json()) as {
    snapshots: { used_percent: number; window: string }[];
  };
  expect(history.snapshots.map((s) => [s.window, s.used_percent])).toEqual([
    ["5h", 40],
    ["5h", 60],
  ]);
  expect((await app.request("/api/history?since=yesterday-ish")).status).toBe(400);
  expect((await app.request("/")).headers.get("content-type")).toContain("text/html");
  expect(await (await app.request("/healthz")).json()).toEqual({ ok: true });
});

test("emails for key-only accounts come from config; a console login's email beats the configured one", async () => {
  const upstream = await fakeUpstreams();
  const config = parseConfig(
    {
      opencodeGo: [{ id: "main", keyFile: "go-main", email: "go@example.com" }],
      openrouter: [{ id: "main", keyFile: "or-main" }],
      opencode: [{ id: "main", label: "Default", email: "configured@example.com" }],
    },
    dir,
    { CREDENTIALS_DIRECTORY: dir },
  );
  const ws = workspaces(upstream.fetch);
  const { accounts } = await discoverAccounts(config, ws, upstream.fetch);
  expect(accounts.map((a) => [a.id, a.email])).toEqual([
    ["opencode-go:main", "go@example.com"],
    ["openrouter:main", null],
    ["opencode:main", "configured@example.com"],
  ]);
  ws.get("main")!.email = "login@example.com";
  expect(accounts[2]!.email).toBe("login@example.com");
  expect(buildSummary(new Store(":memory:"), accounts, [], Date.now()).accounts.map((a) => a.email)).toEqual([
    "go@example.com",
    null,
    "login@example.com",
  ]);
  expect(() => parseConfig({ capy: [{ id: "x", keyFile: "go-main", email: 5 }] }, dir, { CREDENTIALS_DIRECTORY: dir })).toThrow(ConfigError);
});
