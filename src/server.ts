import { Hono } from "hono";
import type { Store } from "./db.ts";
import type { OpencodeWorkspace } from "./providers/opencode-console.ts";
import type { Account } from "./providers/types.ts";
import { isRecord } from "./parse.ts";
import { PAGE } from "./page.ts";
import type { Summary } from "./summary.ts";

const DAY = 24 * 3_600_000;
const MAX_HISTORY_ROWS = 20_000;

function parseTime(value: string | undefined, fallback: number): number | null {
  if (value === undefined || value === "") return fallback;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) return asNumber;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function createApp(deps: {
  store: Store;
  summary: () => Summary;
  workspaces?: Map<string, OpencodeWorkspace>;
  accounts?: () => Account[];
  pollNow?: (accountId: string) => Promise<unknown>;
  now?: () => number;
}): Hono {
  const app = new Hono();
  const now = () => deps.now?.() ?? Date.now();

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get("/api/summary", (c) => c.json(deps.summary()));

  // ?account=<id>&window=<label>&since=<ms|ISO>&until=<ms|ISO>&limit=<n>; defaults to the last 7 days.
  app.get("/api/history", (c) => {
    const until = parseTime(c.req.query("until"), now());
    const since = parseTime(c.req.query("since"), (until ?? now()) - 7 * DAY);
    const limit = Number(c.req.query("limit") ?? 5000);
    if (since === null || until === null) return c.json({ error: "since/until must be epoch ms or ISO 8601" }, 400);
    if (!Number.isInteger(limit) || limit <= 0) return c.json({ error: "limit must be a positive integer" }, 400);
    const snapshots = deps.store.history({
      accountId: c.req.query("account") || undefined,
      window: c.req.query("window") || undefined,
      since,
      until,
      limit: Math.min(limit, MAX_HISTORY_ROWS),
    });
    return c.json({ since, until, snapshots });
  });

  // Latest per-model breakdown (OpenCode): ?account=<id>&range=24h|7d|30d. plan is "go", "zen" or a BYOK provider.
  app.get("/api/models", (c) =>
    c.json({ models: deps.store.models({ accountId: c.req.query("account") || undefined, range: c.req.query("range") || undefined }) }),
  );

  // OpenCode device login. POST starts it (the custom header forces a CORS preflight, so other sites can't);
  // GET reports the code to approve and whether it went through.
  app.get("/api/opencode/:id/login", (c) => {
    const workspace = deps.workspaces?.get(c.req.param("id"));
    return workspace ? c.json(workspace.login) : c.json({ error: "unknown workspace" }, 404);
  });
  app.post("/api/opencode/:id/login", async (c) => {
    const workspace = deps.workspaces?.get(c.req.param("id"));
    if (!workspace) return c.json({ error: "unknown workspace" }, 404);
    if (c.req.header("x-limits-action") !== "login") return c.json({ error: "missing X-Limits-Action: login" }, 400);
    try {
      return c.json(await workspace.startLogin());
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "failed" }, 502);
    }
  });

  // Set the balance an account's remaining credits are derived from (Capy): {balanceUsd, asOf?}, where asOf
  // (epoch ms or ISO) defaults to now. Like the login POST, the custom header forces a CORS preflight.
  app.post("/api/accounts/:id/balance", async (c) => {
    if (c.req.header("x-limits-action") !== "balance") return c.json({ error: "missing X-Limits-Action: balance" }, 400);
    const accountId = c.req.param("id");
    const account = deps.accounts?.().find((a) => a.id === accountId);
    if (!account) return c.json({ error: "unknown account" }, 404);
    if (!account.balanceAnchor) return c.json({ error: "this account's balance can't be set" }, 400);
    const body: unknown = await c.req.json().catch(() => null);
    const balanceUsd = isRecord(body) ? body.balanceUsd : undefined;
    if (typeof balanceUsd !== "number" || !Number.isFinite(balanceUsd) || balanceUsd < 0 || balanceUsd > 1_000_000) {
      return c.json({ error: "balanceUsd must be a dollar amount" }, 400);
    }
    const rawAsOf = isRecord(body) ? body.asOf : undefined;
    const asOf = rawAsOf === undefined ? now() : parseTime(String(rawAsOf), now());
    if (asOf === null || asOf > now() + 60_000) return c.json({ error: "asOf must be a past time, epoch ms or ISO 8601" }, 400);
    deps.store.setAnchor(accountId, { balanceUsd, asOf }, now());
    await deps.pollNow?.(accountId);
    return c.json({ account: deps.summary().accounts.find((a) => a.id === accountId) ?? null });
  });

  app.get("/", (c) => c.html(PAGE));

  return app;
}
