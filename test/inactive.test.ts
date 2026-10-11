import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.ts";
import type { Fetch } from "../src/http.ts";
import { Poller } from "../src/poller.ts";
import { CliProxy } from "../src/providers/cliproxy.ts";
import { fetchCodex } from "../src/providers/codex.ts";
import { OpencodeWorkspace, TokenFile } from "../src/providers/opencode-console.ts";
import { OPENCODE_GO_USAGE_URL, fetchOpenCodeGo, fetchOpenRouter } from "../src/providers/static-keys.ts";
import { type Account, InactiveError } from "../src/providers/types.ts";
import { createApp } from "../src/server.ts";
import { buildSummary } from "../src/summary.ts";

const fixture = (name: string) => Bun.file(new URL(`fixtures/${name}`, import.meta.url)).json();
const DAY = 24 * 3_600_000;
const T0 = Date.parse("2026-10-11T09:00:00Z");
const CONSOLE = "https://opencode.ai/console";
// The body opencode.ai returns for a key whose workspace has no active Go plan (LIMI-7 capture).
const GO_ENTITLEMENT_403 = { type: "error", error: { type: "EntitlementError", message: "OpenCode Go subscription required." } };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "limits-inactive-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const respond = (body: unknown, status = 200): Fetch => async () => Response.json(body, { status });

test("OpenCode Go: the no-subscription 403 is inactive, not an error", async () => {
  const lapsed = fetchOpenCodeGo(respond(GO_ENTITLEMENT_403, 403), "key");
  await expect(lapsed).rejects.toBeInstanceOf(InactiveError);
  await expect(lapsed).rejects.toThrow("Go subscription inactive");
});

test("OpenCode Go: an entitlement body on another status is inactive too; a 401 stays an error", async () => {
  await expect(fetchOpenCodeGo(respond(GO_ENTITLEMENT_403, 402), "key")).rejects.toBeInstanceOf(InactiveError);
  const badKey = fetchOpenCodeGo(respond({ type: "error", error: { type: "AuthError" } }, 401), "key");
  await expect(badKey).rejects.toThrow("HTTP 401");
  await expect(badKey).rejects.not.toBeInstanceOf(InactiveError);
});

test("OpenRouter: zero credits is just a $0 balance, never inactive", async () => {
  expect(await fetchOpenRouter(respond({ data: { total_credits: 10, total_usage: 10 } }), "key")).toEqual({
    windows: [],
    balanceUsd: 0,
  });
  expect(await fetchOpenRouter(respond({ data: { total_credits: 10, total_usage: 10.12451 } }), "key")).toEqual({
    windows: [],
    balanceUsd: -0.12451,
  });
});

test("reopening the store clears balance rows an older build marked inactive, but not lapsed subscriptions", () => {
  const path = join(dir, "stale.sqlite");
  const old = new Store(path);
  old.recordInactive({ id: "openrouter:main", provider: "openrouter", label: "OpenRouter" }, "No OpenRouter credits", 1);
  old.recordInactive({ id: "opencode:default", provider: "opencode", label: "Zen" }, "Zen balance empty", 1);
  old.recordInactive({ id: "opencode-go:main", provider: "opencode-go", label: "Go" }, "Go subscription inactive", 1);
  const reopened = new Store(path);
  expect(reopened.account("openrouter:main")).toMatchObject({ status: "ok", notice: null });
  expect(reopened.account("opencode:default")).toMatchObject({ status: "ok", notice: null });
  expect(reopened.account("opencode-go:main")).toMatchObject({ status: "inactive", notice: "Go subscription inactive" });
});

test("Codex: a ChatGPT account with no plan is inactive; garbage stays an error", async () => {
  const cpa = (body: unknown) =>
    new CliProxy("http://cpa.test", "mgmt", respond({ status_code: 200, header: {}, body: JSON.stringify(body) }));
  await expect(fetchCodex(cpa({ plan_type: "free", rate_limit: null, credits: null }), "a1", undefined)).rejects.toThrow(
    new InactiveError("No active Codex plan (free)"),
  );
  await expect(fetchCodex(cpa({ nope: true }), "a1", undefined)).rejects.toThrow("malformed response");
});

function consoleFetch(handlers: Record<string, () => Response | Promise<Response>>): Fetch {
  return async (url) => {
    const handler = handlers[url.replace(CONSOLE, "").replace(/\?.*$/, "")];
    return handler ? handler() : new Response("{}", { status: 404 });
  };
}

async function connectedWorkspace(handlers: Record<string, () => Response | Promise<Response>>): Promise<OpencodeWorkspace> {
  const tokens = new TokenFile(join(dir, "t.json"));
  tokens.write({ accessToken: "st_a", refreshToken: "rt_a", expiresAt: T0 + 20 * DAY });
  return new OpencodeWorkspace(tokens, undefined, consoleFetch(handlers), () => T0);
}

test("Zen balance survives Go meters and per-model failures, with a notice", async () => {
  const workspace = await connectedWorkspace({
    "/api/billing/status": () => Response.json({ availableMicroCents: "420074420" }),
    "/api/go/status": () => Response.json({ _tag: "Internal" }, { status: 500 }),
    "/api/usage/models": () => Response.json({ _tag: "Internal" }, { status: 503 }),
  });
  const observation = await workspace.fetchObservation();
  expect(observation.balanceUsd).toBeCloseTo(4.2007442);
  expect(observation.windows).toEqual([]);
  expect(observation.models).toBeUndefined();
  expect(observation.notice).toBe("Go meters unavailable (HTTP 500); Per-model usage unavailable (HTTP 503)");
  expect(observation.inactive).toBeUndefined();
});

test("Zen: a lapsed Go plan on the same workspace doesn't touch the balance", async () => {
  const workspace = await connectedWorkspace({
    "/api/billing/status": () => Response.json({ availableMicroCents: "420074420" }),
    "/api/go/status": async () => Response.json(await fixture("opencode-go-status-ended.json")),
    "/api/usage/models": async () => Response.json(await fixture("opencode-usage-models.json")),
  });
  const observation = await workspace.fetchObservation();
  expect(observation.balanceUsd).toBeCloseTo(4.2007442);
  expect(observation.notice).toBeUndefined();
  expect(observation.models!.length).toBeGreaterThan(0);
});

test("Zen: an empty balance is just $0, never inactive; a 401 still asks for a login", async () => {
  const empty = await connectedWorkspace({
    "/api/billing/status": () => Response.json({ availableMicroCents: "0" }),
    "/api/go/status": () => Response.json(null),
    "/api/usage/models": () => Response.json({ items: [], pageInfo: { pageCount: 1 } }),
  });
  const observation = await empty.fetchObservation();
  expect(observation.balanceUsd).toBe(0);
  expect(observation.inactive).toBeUndefined();

  const loggedOut = await connectedWorkspace({
    "/api/billing/status": () => Response.json({ availableMicroCents: "1" }),
    "/api/go/status": () => Response.json({ _tag: "Unauthorized" }, { status: 401 }),
  });
  await expect(loggedOut.fetchObservation()).rejects.toThrow("device login needed");
});

test("poller + summary: Go inactive and Zen ok side by side, last Go windows kept, API exposes status and notice", async () => {
  const store = new Store(":memory:");
  let goLapsed = false;
  const go: Account = {
    id: "opencode-go:main",
    provider: "opencode-go",
    label: "Go",
    poll: () =>
      fetchOpenCodeGo(
        async (url) => {
          expect(url).toBe(OPENCODE_GO_USAGE_URL);
          return goLapsed ? Response.json(GO_ENTITLEMENT_403, { status: 403 }) : Response.json(await fixture("opencode-go-usage.json"));
        },
        "key",
      ),
  };
  const zen: Account = {
    id: "opencode:default",
    provider: "opencode",
    label: "Zen",
    poll: async () => ({ windows: [], balanceUsd: 4.2 }),
  };
  let now = T0;
  const poller = new Poller({
    store,
    discover: async () => ({ accounts: [go, zen], failed: [] }),
    intervalMs: { claude: 1, codex: 1, grok: 1, capy: 1, "opencode-go": 1, openrouter: 1, opencode: 1 },
    retentionMs: 30 * DAY,
    now: () => now,
    log: () => {},
  });
  await poller.tick();
  goLapsed = true;
  now += 60_000;
  await poller.tick();

  const app = createApp({ store, summary: () => buildSummary(store, poller.accounts, poller.errors, now) });
  const body = (await (await app.request("/api/summary")).json()) as { accounts: Record<string, unknown>[] };
  const [goSummary, zenSummary] = body.accounts;
  expect(goSummary).toMatchObject({
    status: "inactive",
    error: null,
    notice: "Go subscription inactive",
    observedAt: T0,
    lastAttemptAt: T0 + 60_000,
  });
  expect((goSummary!.windows as unknown[]).length).toBe(3);
  expect(zenSummary).toMatchObject({ status: "ok", error: null, notice: null, balanceUsd: { balance: 4.2 } });
});

test("an existing database gains the accounts.notice column", () => {
  const path = join(dir, "old.sqlite");
  const old = new Store(path);
  old.db.exec("ALTER TABLE accounts DROP COLUMN notice");
  old.close();
  const upgraded = new Store(path);
  expect(upgraded.db.query<{ name: string }, []>("PRAGMA table_info(accounts)").all().map((c) => c.name)).toContain("notice");
  upgraded.close();
});
