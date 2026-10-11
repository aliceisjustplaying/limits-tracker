import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, parseConfig } from "../src/config.ts";
import { Store } from "../src/db.ts";
import type { Fetch } from "../src/http.ts";
import { Poller } from "../src/poller.ts";
import { fetchCapy } from "../src/providers/capy.ts";
import { discoverAccounts } from "../src/providers/index.ts";
import { createApp } from "../src/server.ts";
import { buildSummary } from "../src/summary.ts";

const DAY = 24 * 3_600_000;
const NOW = Date.parse("2026-10-11T12:00:00Z");
const OCT = Date.parse("2026-10-01T00:00:00Z");

/** A fake usage API: credits billed between `from` and `to` at a flat $/day, plus one connected model. */
function usageApi(perDay: number): { fetch: Fetch; ranges: [string, string][] } {
  const ranges: [string, string][] = [];
  const fetchImpl: Fetch = async (url) => {
    const params = new URL(url).searchParams;
    const from = params.get("from")!;
    const to = params.get("to")!;
    ranges.push([from, to]);
    const credits = Math.round(((Date.parse(to) - Date.parse(from)) / DAY) * perDay * 100) / 100;
    return Response.json({
      from,
      to,
      totals: { llmDollars: credits, imageDollars: 0, vmDollars: 0, totalDollars: credits },
      tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      members: [],
      models: [{ model: "openai/gpt-6-sol", label: "GPT-6 Sol", dollars: 99, unbilled: true, tokens: {} }],
      images: [],
    });
  };
  return { fetch: fetchImpl, ranges };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "limits-capy-balance-"));
  writeFileSync(join(dir, "capy-key"), "capy_secret");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("remaining = anchor minus credits billed since the anchor, from a second usage call", async () => {
  const api = usageApi(4);
  const observation = await fetchCapy(api.fetch, "k", { balanceUsd: 100, asOf: NOW - 2.5 * DAY }, NOW);
  expect(api.ranges).toEqual([
    ["2026-10-01T00:00:00.000Z", "2026-10-11T12:00:00.000Z"],
    ["2026-10-09T00:00:00.000Z", "2026-10-11T12:00:00.000Z"],
  ]);
  expect(observation.balanceUsd).toBe(90);
  expect(observation.spend!.creditsUsd).toBe(42);
  expect(observation.inactive).toBeUndefined();
});

test("an anchor at the month start reuses the month call; a future anchor counts no spend", async () => {
  const api = usageApi(4);
  expect((await fetchCapy(api.fetch, "k", { balanceUsd: 100, asOf: OCT }, NOW)).balanceUsd).toBe(58);
  expect(api.ranges).toHaveLength(1);
  expect((await fetchCapy(api.fetch, "k", { balanceUsd: 100, asOf: NOW + DAY }, NOW)).balanceUsd).toBe(100);
});

test("no anchor means no balance; a used-up anchor is $0, never inactive", async () => {
  expect((await fetchCapy(usageApi(4).fetch, "k", null, NOW)).balanceUsd).toBeUndefined();
  const spent = await fetchCapy(usageApi(4).fetch, "k", { balanceUsd: 10, asOf: NOW - 5 * DAY }, NOW);
  expect(spent.balanceUsd).toBe(0);
  expect(spent.inactive).toBeUndefined();
});

test("config anchor: balanceUsd with balanceAsOf as a plain date (midnight UTC) or ISO time", () => {
  const parse = (extra: object) =>
    parseConfig({ capy: [{ id: "alice", keyFile: "capy-key", ...extra }] }, dir, { CREDENTIALS_DIRECTORY: dir }).capy[0];
  expect(parse({ balanceUsd: 100, balanceAsOf: "2026-10-09" })!.anchor).toEqual({ balanceUsd: 100, asOf: Date.parse("2026-10-09T00:00:00Z") });
  expect(parse({ balanceUsd: 5.5, balanceAsOf: "2026-10-09T14:30:00Z" })!.anchor!.balanceUsd).toBe(5.5);
  expect(parse({})!.anchor).toBeUndefined();
  expect(() => parse({ balanceUsd: 100 })).toThrow(ConfigError);
  expect(() => parse({ balanceUsd: "100", balanceAsOf: "2026-10-09" })).toThrow("balanceUsd must be a number");
  expect(() => parse({ balanceUsd: 100, balanceAsOf: "last tuesday" })).toThrow("balanceAsOf must be an ISO date");
});

test("a UI-set anchor beats the config one unless the config was read later", async () => {
  const store = new Store(":memory:");
  const config = (asOf: string) =>
    parseConfig({ capy: [{ id: "alice", keyFile: "capy-key", balanceUsd: 100, balanceAsOf: asOf }] }, dir, { CREDENTIALS_DIRECTORY: dir });
  const anchorOf = async (asOf: string) => {
    const { accounts } = await discoverAccounts(config(asOf), new Map(), usageApi(0).fetch, (id) => store.anchor(id));
    return accounts[0]!.balanceAnchor!();
  };
  expect(await anchorOf("2026-10-05")).toEqual({ balanceUsd: 100, asOf: Date.parse("2026-10-05") });
  store.setAnchor("capy:alice", { balanceUsd: 60, asOf: Date.parse("2026-10-10T08:00:00Z") }, NOW);
  expect((await anchorOf("2026-10-05"))!.balanceUsd).toBe(60);
  expect((await anchorOf("2026-10-11"))!.balanceUsd).toBe(100);
});

test("POST /api/accounts/:id/balance stores the anchor, repolls and returns dollars and days left", async () => {
  const store = new Store(":memory:");
  const api = usageApi(4.15);
  const config = parseConfig({ capy: [{ id: "alice", label: "Capy", keyFile: "capy-key" }] }, dir, { CREDENTIALS_DIRECTORY: dir });
  const now = () => NOW;
  const poller = new Poller({
    store,
    discover: () => discoverAccounts(config, new Map(), api.fetch, (id) => store.anchor(id)),
    intervalMs: { claude: 1, codex: 1, grok: 1, capy: DAY, "opencode-go": 1, openrouter: 1, opencode: 1 },
    retentionMs: 30 * DAY,
    now,
    log: () => {},
  });
  await poller.tick();
  const app = createApp({
    store,
    now,
    accounts: () => poller.accounts,
    pollNow: (id) => poller.pollNow(id),
    summary: () => buildSummary(store, poller.accounts, poller.errors, NOW),
  });

  const before = ((await (await app.request("/api/summary")).json()) as { accounts: Record<string, unknown>[] }).accounts[0]!;
  expect(before).toMatchObject({ balanceSettable: true, balanceAnchor: null, balanceUsd: null });

  const post = (body: unknown, action = "balance") =>
    app.request("/api/accounts/capy:alice/balance", {
      method: "POST",
      headers: { "X-Limits-Action": action, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await post({ balanceUsd: 100 }, "nope")).status).toBe(400);
  expect((await post({ balanceUsd: -1 })).status).toBe(400);
  expect((await post({ balanceUsd: 100, asOf: NOW + DAY })).status).toBe(400);
  expect((await app.request("/api/accounts/capy:nobody/balance", { method: "POST", headers: { "X-Limits-Action": "balance" } })).status).toBe(404);

  const res = await post({ balanceUsd: 100, asOf: "2026-10-01" });
  expect(res.status).toBe(200);
  const { account } = (await res.json()) as { account: Record<string, any> };
  expect(account.balanceAnchor).toEqual({ balanceUsd: 100, asOf: OCT });
  expect(account.status).toBe("ok");
  // The provider reads the wall clock, so assert the relationships rather than exact dollars.
  expect(account.balanceUsd.balance).toBeCloseTo(100 - account.spendUsd.credits, 2);
  expect(account.balanceUsd.burn.perDay).toBeGreaterThan(0);
  expect(account.balanceUsd.burn.perDay).toBe(account.spendUsd.projection.credits.perDay);
  expect(account.balanceUsd.burn.daysLeft).toBeCloseTo(account.balanceUsd.balance / account.balanceUsd.burn.perDay);
  expect(store.anchor("capy:alice")).toEqual({ balanceUsd: 100, asOf: OCT });
});

test("accounts without a derived balance can't take an anchor", async () => {
  const store = new Store(":memory:");
  const app = createApp({
    store,
    accounts: () => [{ id: "openrouter:main", provider: "openrouter", label: "OR", poll: async () => ({ windows: [] }) }],
    summary: () => ({ generatedAt: NOW, accounts: [], errors: [] }),
  });
  const res = await app.request("/api/accounts/openrouter:main/balance", {
    method: "POST",
    headers: { "X-Limits-Action": "balance" },
    body: JSON.stringify({ balanceUsd: 5 }),
  });
  expect(res.status).toBe(400);
  expect(summaryFlag(buildSummary(store, [{ id: "openrouter:main", provider: "openrouter", label: "OR", poll: async () => ({ windows: [] }) }], [], NOW))).toBe(false);
});

const summaryFlag = (s: ReturnType<typeof buildSummary>) => s.accounts[0]!.balanceSettable;
