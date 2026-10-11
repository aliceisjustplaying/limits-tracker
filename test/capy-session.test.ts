import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, parseConfig } from "../src/config.ts";
import { Store } from "../src/db.ts";
import type { Fetch } from "../src/http.ts";
import { parseCapyBilling } from "../src/parse.ts";
import { Poller } from "../src/poller.ts";
import { CAPY_SESSION_EXPIRED, fetchCapy } from "../src/providers/capy.ts";
import { discoverAccounts } from "../src/providers/index.ts";
import { buildSummary } from "../src/summary.ts";

const DAY = 24 * 3_600_000;
const NOW = Date.parse("2026-10-11T12:00:00Z");
const billingBody = await Bun.file(join(import.meta.dir, "fixtures/capy-billing.json")).json();
const SESSION = { clientCookie: "client_cookie_secret", sessionId: "sess_123", orgId: "org_456", clerkOrigin: "https://clerk.capy.ai" };

interface Call {
  url: string;
  method: string;
  headers: Headers;
}

/** Clerk mints `jwt_secret`; the app API wants it; the usage API bills a flat $/day. */
function capyApis(over: { mint?: () => Response; billing?: () => Response } = {}): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: Fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? "GET", headers });
    if (url === "https://clerk.capy.ai/v1/client/sessions/sess_123/tokens") {
      return over.mint?.() ?? Response.json({ object: "token", jwt: "jwt_secret" });
    }
    if (url === "https://api.capy.ai/app/orgs/org_456/billing") {
      if (headers.get("authorization") !== "Bearer jwt_secret") return Response.json({ _tag: "capy/Unauthorized" }, { status: 401 });
      return over.billing?.() ?? Response.json(billingBody);
    }
    const params = new URL(url).searchParams;
    const credits = Math.round(((Date.parse(params.get("to")!) - Date.parse(params.get("from")!)) / DAY) * 2.75 * 100) / 100;
    return Response.json({ totals: { llmDollars: credits, imageDollars: 0, vmDollars: 0, totalDollars: credits }, tokens: {}, members: [], models: [], images: [] });
  };
  return { fetch: fetchImpl, calls };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "limits-capy-session-"));
  writeFileSync(join(dir, "capy-key"), "capy_secret");
  writeFileSync(join(dir, "capy-session"), JSON.stringify(SESSION));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const config = (extra: object = {}) =>
  parseConfig({ capy: [{ id: "main", label: "Capy", keyFile: "capy-key", sessionFile: "capy-session", ...extra }] }, dir, { CREDENTIALS_DIRECTORY: dir });

test("the billing page parses to dollars (credits are thousandths), with the active plan and each grant", () => {
  expect(parseCapyBilling(billingBody)).toEqual({
    remainingUsd: 1090.79856,
    usedUsd: 29.20143,
    grantedUsd: 1120,
    unlimited: false,
    plan: { name: "Capy Lite", status: "active", canceledAt: Date.parse("2026-10-09T19:36:23.010Z"), renewsAt: Date.parse("2026-10-16T18:55:08.000Z") },
    sources: [
      { name: "Credit grant", kind: "grant", grantedUsd: 100, remainingUsd: 90.79856, resetsAt: null, expiresAt: null },
      { name: "Credit grant", kind: "grant", grantedUsd: 1000, remainingUsd: 1000, resetsAt: null, expiresAt: null },
    ],
  });
  expect(parseCapyBilling({ balance: { remainingCredits: "lots" } })).toBeNull();
  expect(parseCapyBilling(null)).toBeNull();
});

test("with a session: mint a Clerk token from the cookie, then read billing with it; usage still gives spend", async () => {
  const api = capyApis();
  const observation = await fetchCapy(api.fetch, "capy_secret", null, NOW, SESSION);
  const mint = api.calls.find((c) => c.url.includes("clerk"))!;
  expect(mint.method).toBe("POST");
  expect(mint.headers.get("cookie")).toBe("__client=client_cookie_secret");
  expect(mint.headers.get("origin")).toBe("https://capy.ai");
  expect(api.calls.find((c) => c.url.includes("/app/"))!.headers.get("authorization")).toBe("Bearer jwt_secret");
  expect(observation.balanceUsd).toBe(1090.79856);
  expect(observation.billing!.plan!.name).toBe("Capy Lite");
  expect(observation.spend!.creditsUsd).toBeCloseTo(10.5 * 2.75);
});

test("a revoked session (mint 401 or 404, billing 401) says to sign in again, and never echoes a credential", async () => {
  for (const over of [
    { mint: () => Response.json({ errors: [{ code: "signed_out" }] }, { status: 401 }) },
    { mint: () => Response.json({ errors: [{ code: "resource_not_found" }] }, { status: 404 }) },
    { billing: () => Response.json({ _tag: "capy/Unauthorized" }, { status: 401 }) },
  ]) {
    const error = await fetchCapy(capyApis(over).fetch, "capy_secret", null, NOW, SESSION).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(CAPY_SESSION_EXPIRED);
  }
  const outage = await fetchCapy(capyApis({ mint: () => new Response("down", { status: 503 }) }).fetch, "k", null, NOW, SESSION).catch((e: Error) => e);
  expect((outage as Error).message).toBe("HTTP 503");
  expect((outage as Error).message).not.toContain("client_cookie_secret");
});

test("sessionFile: a JSON credential, validated without echoing its contents", () => {
  expect(config().capy[0]!.session).toEqual(SESSION);
  const bad = (content: string) => {
    writeFileSync(join(dir, "capy-session"), content);
    try {
      config();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).not.toContain("client_cookie_secret");
      return (error as Error).message;
    }
    throw new Error("expected a ConfigError");
  };
  expect(bad("client_cookie_secret")).toBe("capy[0].sessionFile must be a JSON file");
  expect(bad(JSON.stringify({ ...SESSION, orgId: undefined }))).toBe("capy[0].sessionFile needs orgId");
  expect(bad(JSON.stringify({ ...SESSION, sessionId: "../x" }))).toContain("may only use letters");
  expect(bad(JSON.stringify({ ...SESSION, clerkOrigin: "http://clerk.capy.ai" }))).toBe("capy[0].sessionFile clerkOrigin must be https");
});

test("a session account isn't anchor-settable and summarizes billing with days left at the month's $/day", async () => {
  const store = new Store(":memory:");
  const api = capyApis();
  const cfg = config({ balanceUsd: 5, balanceAsOf: "2026-10-01" });
  const poller = new Poller({
    store,
    discover: () => discoverAccounts(cfg, new Map(), api.fetch, (id) => store.anchor(id)),
    intervalMs: { claude: DAY, codex: DAY, grok: DAY, capy: DAY, "opencode-go": DAY, openrouter: DAY, opencode: DAY },
    retentionMs: 30 * DAY,
    now: () => NOW,
    log: () => {},
  });
  await poller.tick();
  const account = buildSummary(store, poller.accounts, [], Date.now()).accounts[0]!;
  expect(account.status).toBe("ok");
  expect(account.balanceSettable).toBe(false);
  expect(account.balanceAnchor).toBeNull();
  expect(account.plan).toEqual({
    name: "Capy Lite",
    status: "active",
    canceledAt: Date.parse("2026-10-09T19:36:23.010Z"),
    renewsAt: Date.parse("2026-10-16T18:55:08.000Z"),
  });
  expect(account.billing!.sources.map((s) => s.remainingUsd)).toEqual([90.79856, 1000]);
  expect(account.balanceUsd!.balance).toBe(1090.79856);
  const perDay = account.spendUsd!.projection.credits!.perDay;
  expect(account.balanceUsd!.burn).toEqual({ perDay, daysLeft: 1090.79856 / perDay });
});
