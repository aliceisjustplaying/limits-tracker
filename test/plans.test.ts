import { expect, test } from "bun:test";
import { Store } from "../src/db.ts";
import { GO_INACTIVE, parseClaudePlan, parseCodexPlan, parseGoPlan, parseGrokPlan } from "../src/parse.ts";
import { Poller } from "../src/poller.ts";
import { type Account, InactiveError } from "../src/providers/types.ts";
import { buildSummary } from "../src/summary.ts";

const fixture = (name: string) => Bun.file(`${import.meta.dir}/fixtures/${name}`).json();
const active = (name: string, renewsAt: number | null = null) => ({ name, status: "active", renewsAt, canceledAt: null });

test("Claude: the rate-limit tier names the Max multiplier, else the organization type; unknown is null", async () => {
  expect(parseClaudePlan(await fixture("claude-profile.json"))).toEqual(active("Max 20x"));
  expect(parseClaudePlan({ organization: { rate_limit_tier: "default_claude_max_5x" } })).toEqual(active("Max 5x"));
  expect(parseClaudePlan({ organization: { organization_type: "claude_pro", rate_limit_tier: "default_claude_ai" } })).toEqual(active("Pro"));
  expect(parseClaudePlan({ account: { has_claude_max: true } })).toEqual(active("Max"));
  expect(parseClaudePlan({ organization: { organization_type: "something_new" } })).toBeNull();
  expect(parseClaudePlan("nope")).toBeNull();
});

test("Codex, Grok and Go plans come from the upstream's own fields", async () => {
  expect(parseCodexPlan(await fixture("codex-usage.json"))).toEqual(active("Pro"));
  expect(parseCodexPlan({ plan_type: "team" })).toEqual(active("Team"));
  expect(parseCodexPlan({ plan_type: "free" }, "inactive")).toEqual({ ...active("Free"), status: "inactive" });
  expect(parseCodexPlan({})).toBeNull();
  expect(parseGrokPlan(await fixture("grok-settings.json"))).toEqual(active("SuperGrok"));
  expect(parseGrokPlan(await fixture("grok-user.json"))).toBeNull();
  expect(parseGrokPlan({ subscription_tier_display: "  " })).toBeNull();
  expect(parseGoPlan(await fixture("opencode-go-status-active.json"))).toEqual(active("Go", Date.parse("2026-11-01T00:00:00Z")));
  expect(parseGoPlan(await fixture("opencode-go-status-ended.json"))).toEqual(GO_INACTIVE);
  expect(parseGoPlan({ access: { endsAt: "2026-11-01T00:00:00Z", cancelAtPeriodEnd: true } })).toEqual(active("Go"));
  expect(parseGoPlan(undefined)).toBeNull();
});

test("summary: plans persist through polls without one, an inactive poll records its plan, unknown stays null", async () => {
  const store = new Store(":memory:");
  let goLapsed = false;
  let claudePlan = true;
  const accounts: Account[] = [
    {
      id: "claude:a",
      provider: "claude",
      label: "Claude",
      poll: async () => ({ windows: [], ...(claudePlan ? { plan: active("Max 20x") } : {}) }),
    },
    {
      id: "opencode-go:main",
      provider: "opencode-go",
      label: "Go",
      poll: async () => {
        if (goLapsed) throw new InactiveError("Go subscription inactive", GO_INACTIVE);
        return { windows: [], plan: active("Go") };
      },
    },
    { id: "openrouter:main", provider: "openrouter", label: "OR", poll: async () => ({ windows: [], balanceUsd: 3 }) },
  ];
  let now = 1_000;
  const poller = new Poller({
    store,
    discover: async () => ({ accounts, failed: [] }),
    intervalMs: { claude: 1, codex: 1, grok: 1, capy: 1, "opencode-go": 1, openrouter: 1, opencode: 1 },
    retentionMs: 1e9,
    now: () => now,
    log: () => {},
  });
  await poller.tick();
  claudePlan = false;
  goLapsed = true;
  now += 10;
  await poller.tick();
  const plans = Object.fromEntries(buildSummary(store, poller.accounts, [], now).accounts.map((a) => [a.id, a.plan]));
  expect(plans).toEqual({ "claude:a": active("Max 20x"), "opencode-go:main": GO_INACTIVE, "openrouter:main": null });
});

test("Grok: a failed /settings read drops only the plan, not the poll", async () => {
  const { fetchGrok } = await import("../src/providers/grok.ts");
  const cpa = {
    get: async (_index: string, url: string) => {
      if (url.endsWith("/user")) return { userId: "user-123" };
      if (url.endsWith("/settings")) throw new Error("HTTP 500");
      return fixture("grok-billing.json");
    },
  };
  const observation = await fetchGrok(cpa as never, "x1y2");
  expect(observation.windows).toHaveLength(1);
  expect(observation.plan).toBeUndefined();
});
