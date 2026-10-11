import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { Store } from "../src/db.ts";
import type { Fetch } from "../src/http.ts";
import { parseCapyUsage } from "../src/parse.ts";
import { projectSpend } from "../src/projection.ts";
import { CAPY_USAGE_URL, currentMonth, fetchCapy } from "../src/providers/capy.ts";
import { discoverAccounts } from "../src/providers/index.ts";
import { buildSummary } from "../src/summary.ts";

const fixture = (name: string) => Bun.file(new URL(`fixtures/${name}`, import.meta.url)).json();
const H = 3_600_000;
const DAY = 24 * H;
const NOW = Date.parse("2026-10-11T12:00:00Z");
const OCT = Date.parse("2026-10-01T00:00:00Z");
const NOV = Date.parse("2026-11-01T00:00:00Z");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "limits-capy-"));
  writeFileSync(join(dir, "capy-key"), "capy_secret\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("usage report: totals, and per-model rows split into credits vs connected", async () => {
  const usage = parseCapyUsage(await fixture("capy-usage.json"), "month")!;
  expect([usage.totalUsd, usage.llmUsd, usage.imageUsd, usage.vmUsd]).toEqual([38.5, 30, 0.5, 8]);
  expect(usage.models.map((m) => [m.model, m.plan, m.provider, m.costUsd, m.inputTokens])).toEqual([
    ["Review", "credits", "capy-credits", 0, 0],
    ["Claude Opus 5.5", "credits", "capy-credits", 30, 800_000],
    ["GPT-6 Sol", "connected", "capy-connected", 11.5, 400_000],
    ["Review", "connected", "capy-connected", 0, 0],
  ]);
  expect(parseCapyUsage({ _tag: "capy/Unauthorized" }, "month")).toBeNull();
  expect(parseCapyUsage({ totals: { totalDollars: "NaN" } }, "month")).toBeNull();
});

test("the period is the UTC calendar month", () => {
  expect(currentMonth(NOW)).toEqual({ start: OCT, end: NOV });
  expect(currentMonth(Date.parse("2026-12-31T23:59:59Z")).end).toBe(Date.parse("2027-01-01T00:00:00Z"));
});

test("fetch: month-to-date window, bearer key; totals are credits, connected models are added for the total", async () => {
  const calls: { url: string; auth: string | null }[] = [];
  const fetchImpl: Fetch = async (url, init) => {
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
    return Response.json(await fixture("capy-usage.json"));
  };
  const observation = await fetchCapy(fetchImpl, "capy_secret", null, NOW);
  expect(calls).toEqual([
    { url: `${CAPY_USAGE_URL}?from=2026-10-01T00%3A00%3A00.000Z&to=2026-10-11T12%3A00%3A00.000Z`, auth: "Bearer capy_secret" },
  ]);
  expect(observation.windows).toEqual([]);
  expect(observation.spend).toEqual({ creditsUsd: 38.5, totalUsd: 50, periodStart: OCT, periodEnd: NOV });
  expect(observation.models).toHaveLength(4);
  const store = new Store(":memory:");
  store.recordObservation({ id: "capy:a", provider: "capy", label: "Capy" }, observation, NOW);
  expect(store.models({ accountId: "capy:a" }).filter((m) => m.model === "Review")).toHaveLength(2);
});

test("fetch: a 401 surfaces as HTTP 401", async () => {
  const fetchImpl: Fetch = async () => Response.json({ _tag: "capy/Unauthorized" }, { status: 401 });
  await expect(fetchCapy(fetchImpl, "bad", null, NOW)).rejects.toThrow("HTTP 401");
});

test("config and discovery: one account per key file", async () => {
  const config = parseConfig({ capy: [{ id: "alice", label: "Capy", keyFile: "capy-key" }] }, dir, { CREDENTIALS_DIRECTORY: dir });
  expect(config.capy).toEqual([{ id: "alice", label: "Capy", key: "capy_secret" }]);
  expect(config.intervalMs.capy).toBe(15 * 60_000);
  const { accounts } = await discoverAccounts(config, new Map());
  expect(accounts.map((a) => [a.id, a.provider, a.label])).toEqual([["capy:alice", "capy", "Capy"]]);
});

test("spend projection: average before an hour of data, then the fitted slope to period end", () => {
  expect(projectSpend([{ observedAt: OCT + 10 * DAY, value: 20 }], OCT, NOV)).toEqual({ perDay: 2, projectedAtEnd: 62 });
  const fitted = projectSpend(
    [0, 1, 2].map((d) => ({ observedAt: OCT + (10 + d) * DAY, value: 20 + 5 * d })),
    OCT,
    NOV,
  )!;
  expect(fitted.perDay).toBeCloseTo(5);
  expect(fitted.projectedAtEnd).toBeCloseTo(30 + 5 * 19);
  expect(projectSpend([{ observedAt: OCT - DAY, value: 99 }], OCT, NOV)).toBeNull();
});

test("summary carries credits and total spend with projections; models land in /api/models storage", () => {
  const store = new Store(":memory:");
  const account = { id: "capy:alice", provider: "capy" as const, label: "Capy" };
  for (let d = 0; d < 3; d++) {
    store.recordObservation(
      account,
      { windows: [], spend: { creditsUsd: 10 + 4 * d, totalUsd: 15 + 6 * d, periodStart: OCT, periodEnd: NOV } },
      OCT + (5 + d) * DAY,
    );
  }
  const summary = buildSummary(store, [{ ...account, poll: async () => ({ windows: [] }) }], [], OCT + 7 * DAY);
  const spend = summary.accounts[0]!.spendUsd!;
  expect([spend.credits, spend.total, spend.periodEnd]).toEqual([18, 27, NOV]);
  expect(spend.projection.credits!.perDay).toBeCloseTo(4);
  expect(spend.projection.total!.projectedAtEnd).toBeCloseTo(27 + 6 * 24);
  expect(summary.accounts[0]!.windows).toEqual([]);
});

test("an existing database gains the spend_usd column", () => {
  const path = join(dir, "old.sqlite");
  const old = new Store(path);
  old.db.exec("ALTER TABLE snapshots DROP COLUMN spend_usd");
  old.close();
  const upgraded = new Store(path);
  expect(upgraded.db.query<{ name: string }, []>("PRAGMA table_info(snapshots)").all().map((c) => c.name)).toContain("spend_usd");
  upgraded.close();
});
