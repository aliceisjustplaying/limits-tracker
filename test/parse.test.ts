import { expect, test } from "bun:test";
import {
  parseAnthropicUsage,
  parseApiCallResponse,
  parseAuthFiles,
  parseCodexCredits,
  parseCodexUsage,
  parseGrokUsage,
  parseGrokUserId,
  parseOpenCodeGoUsage,
  parseOpenRouterBalance,
} from "../src/parse.ts";

const fixture = (name: string) => Bun.file(new URL(`fixtures/${name}`, import.meta.url)).json();

test("Claude: current limits array including scoped models", async () => {
  expect(parseAnthropicUsage(await fixture("claude-usage.json"))).toEqual([
    { label: "5h", usedPercent: 10, resetsAt: Date.parse("2026-01-01T01:00:00Z") },
    { label: "Week", usedPercent: 77, resetsAt: Date.parse("2026-01-07T00:00:00Z") },
    { label: "Fable", usedPercent: 100, resetsAt: Date.parse("2026-01-05T00:00:00Z") },
    { label: "Future Model", usedPercent: 5, resetsAt: 1_767_484_800_000 },
  ]);
});

test("Claude: legacy five_hour / seven_day buckets", async () => {
  expect(parseAnthropicUsage(await fixture("claude-usage-legacy.json"))).toEqual([
    { label: "5h", usedPercent: 24.6, resetsAt: Date.parse("2026-01-01T01:00:00Z") },
    { label: "Week", usedPercent: 71, resetsAt: Date.parse("2026-01-07T00:00:00Z") },
  ]);
});

test("Claude: generic windows win, a missing one falls back to legacy", () => {
  expect(
    parseAnthropicUsage({ five_hour: { utilization: 99 }, seven_day: { utilization: 22 }, limits: [{ kind: "session", percent: 12 }] }),
  ).toEqual([
    { label: "5h", usedPercent: 12, resetsAt: undefined },
    { label: "Week", usedPercent: 22, resetsAt: undefined },
  ]);
});

test("Claude: malformed, partial and hostile labels", () => {
  expect(parseAnthropicUsage(null)).toBeNull();
  expect(parseAnthropicUsage({ limits: [{ kind: "weekly_scoped", percent: 50 }] })).toBeNull();
  expect(parseAnthropicUsage({ five_hour: { resets_at: "2026-01-01T00:00:00Z" } })).toEqual([
    { label: "5h", usedPercent: undefined, resetsAt: Date.parse("2026-01-01T00:00:00Z") },
  ]);
  expect(
    parseAnthropicUsage({
      limits: [{ kind: "weekly_scoped", percent: 2, scope: { model: { display_name: "\u001b[31mFa\u202Eble\u001b[0m\nquota" } } }],
    }),
  ).toEqual([{ label: "Fable quota", usedPercent: 2, resetsAt: undefined }]);
});

test("Codex: shared windows only, labelled by duration", async () => {
  expect(parseCodexUsage(await fixture("codex-usage.json"), 1_700_000_000_000)).toEqual([
    { label: "5h", usedPercent: 31, resetsAt: 1_700_000_100_000 },
    { label: "Week", usedPercent: 62, resetsAt: 1_700_200_000_000 },
  ]);
});

test("Codex: reset_after_seconds and malformed payloads", () => {
  const now = 1_700_000_000_000;
  expect(
    parseCodexUsage({ rate_limit: { primary_window: { used_percent: 4, limit_window_seconds: 18_000, reset_after_seconds: 60 } } }, now),
  ).toEqual([{ label: "5h", usedPercent: 4, resetsAt: now + 60_000 }]);
  expect(parseCodexUsage({ rate_limit: { primary_window: { used_percent: "nope" } } })).toBeNull();
  expect(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 0 } } })).toEqual([
    { label: "Primary", usedPercent: 0, resetsAt: undefined },
  ]);
  expect(parseCodexUsage({ additional_rate_limits: [] })).toBeNull();
});

test("Codex: credits (has_credits, unlimited, balance)", async () => {
  expect(parseCodexCredits(await fixture("codex-usage.json"))).toBe(61246.065);
  expect(parseCodexCredits({ credits: { has_credits: true, unlimited: true, balance: "0" } })).toBe("unlimited");
  expect(parseCodexCredits({ credits: { has_credits: false, unlimited: false, balance: "0" } })).toBeUndefined();
  expect(parseCodexCredits({ credits: { has_credits: true, unlimited: false, balance: "-1" } })).toBeUndefined();
  expect(parseCodexCredits({ credits: null })).toBeUndefined();
  expect(parseCodexCredits({})).toBeUndefined();
});

test("OpenCode Go: rolling, weekly and monthly", async () => {
  expect(parseOpenCodeGoUsage(await fixture("opencode-go-usage.json"))).toEqual([
    { label: "5h", usedPercent: 3, resetsAt: Date.parse("2026-09-20T05:35:53.613Z") },
    { label: "Week", usedPercent: 100, resetsAt: Date.parse("2026-09-21T00:00:00.000Z") },
    { label: "Month", usedPercent: 0, resetsAt: undefined },
  ]);
  expect(parseOpenCodeGoUsage({ usage: {} })).toBeNull();
  expect(parseOpenCodeGoUsage({ error: { type: "AuthError" } })).toBeNull();
});

test("OpenRouter: balance is total_credits minus total_usage", async () => {
  expect(parseOpenRouterBalance(await fixture("openrouter-credits.json"))).toBe(107.876543);
  expect(parseOpenRouterBalance({ data: { total_credits: "10", total_usage: 2.5 } })).toBe(7.5);
  expect(parseOpenRouterBalance({ data: { total_credits: 10 } })).toBeUndefined();
  expect(parseOpenRouterBalance({ error: { code: 401 } })).toBeUndefined();
});

test("CLIProxyAPI auth-files: provider, email, disabled and Codex account id", async () => {
  expect(parseAuthFiles(await fixture("cliproxy-auth-files.json"))).toEqual([
    { authIndex: "a1b2", name: "claude-a.json", provider: "claude", email: "a@example.com", disabled: false, chatgptAccountId: undefined },
    { authIndex: "c3d4", name: "claude-b.json", provider: "claude", email: "b@example.com", disabled: false, chatgptAccountId: undefined },
    { authIndex: "dead", name: "claude-off.json", provider: "claude", email: "off@example.com", disabled: true, chatgptAccountId: undefined },
    { authIndex: "e5f6", name: "codex-a.json", provider: "codex", email: "c@example.com", disabled: false, chatgptAccountId: "acct-from-token" },
    { authIndex: "g7h8", name: "codex-b.json", provider: "codex", email: "d@example.com", disabled: false, chatgptAccountId: undefined },
    { authIndex: "x1y2", name: "xai-a.json", provider: "xai", email: "g@example.com", disabled: false, chatgptAccountId: undefined },
    { authIndex: "i9j0", name: "gemini.json", provider: "gemini", email: "e@example.com", disabled: false, chatgptAccountId: undefined },
  ]);
  expect(parseAuthFiles({ error: "unauthorized" })).toBeNull();
});

test("CLIProxyAPI api-call envelope", () => {
  expect(parseApiCallResponse({ status_code: 429, header: {}, body: "{}" })).toEqual({ statusCode: 429, body: "{}" });
  expect(parseApiCallResponse({ status_code: 200 })).toBeNull();
  expect(parseApiCallResponse("nope")).toBeNull();
});

test("Grok: weekly credit percent and period end", async () => {
  expect(parseGrokUsage(await fixture("grok-billing.json"))).toEqual([
    { label: "Week", usedPercent: 42.5, resetsAt: Date.parse("2026-08-17T12:51:17Z") },
  ]);
});

test("Grok: fresh period, out-of-range percent, legacy monthly fallback, malformed", () => {
  const end = "2026-08-17T12:51:17Z";
  const weekly = { type: "USAGE_PERIOD_TYPE_WEEKLY", end };
  expect(parseGrokUsage({ config: { currentPeriod: weekly } })).toEqual([{ label: "Week", usedPercent: 0, resetsAt: Date.parse(end) }]);
  expect(parseGrokUsage({ config: { creditUsagePercent: 101, currentPeriod: weekly } })).toEqual([
    { label: "Week", usedPercent: undefined, resetsAt: Date.parse(end) },
  ]);
  expect(
    parseGrokUsage({ config: { used: { val: 250 }, monthlyLimit: { val: 1000 }, billingPeriodEnd: "2026-09-01T00:00:00Z" } }),
  ).toEqual([{ label: "Month", usedPercent: 25, resetsAt: Date.parse("2026-09-01T00:00:00Z") }]);
  expect(parseGrokUsage(null)).toBeNull();
  expect(parseGrokUsage({ config: null })).toBeNull();
  expect(parseGrokUsage({ config: { creditUsagePercent: 101 } })).toBeNull();
});

test("Grok: only bounded header-safe user ids", async () => {
  expect(parseGrokUserId(await fixture("grok-user.json"))).toBe("user-123");
  expect(parseGrokUserId({ userId: "user\r\nx-userid: attacker" })).toBeUndefined();
  expect(parseGrokUserId({ userId: "x".repeat(257) })).toBeUndefined();
  expect(parseGrokUserId({})).toBeUndefined();
});
