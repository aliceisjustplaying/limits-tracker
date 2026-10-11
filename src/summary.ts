import { type AccountStatus, BALANCE_WINDOW, CREDITS_WINDOW, SPEND_ALL_WINDOW, SPEND_WINDOW, type Store } from "./db.ts";
import { currentMonth } from "./providers/capy.ts";
import { type Burn, type SpendProjection, type WindowProjection, burnRate, projectSpend, projectWindow } from "./projection.ts";
import type { Account, ProviderId } from "./providers/types.ts";
import type { AccountPlan, CapyBilling } from "./parse.ts";

const DAY = 24 * 3_600_000;
// Long enough to cover a whole weekly period; monthly windows fit on their last 8 days.
const WINDOW_LOOKBACK_MS = 8 * DAY;
const BURN_LOOKBACK_MS = 7 * DAY;

export interface WindowSummary {
  window: string;
  usedPercent: number | null;
  resetsAt: number | null;
  projection: WindowProjection | null;
}

export interface AccountSummary {
  id: string;
  provider: ProviderId;
  label: string;
  /** The account's email, from CLIProxyAPI, the OpenCode console or config; null when unknown. */
  email: string | null;
  status: AccountStatus | "pending";
  /** Why the last poll failed; set only when status is "error". */
  error: string | null;
  /** Why the account is inactive, or a partial-data note on an ok account. Not an error. */
  notice: string | null;
  lastAttemptAt: number | null;
  observedAt: number | null;
  windows: WindowSummary[];
  credits: { balance: number | null; unlimited: boolean; burn: Burn | null } | null;
  balanceUsd: { balance: number; burn: Burn | null } | null;
  /** Capy: spend so far this period, billed to credits and in total, with month-end projections. */
  /** Capy: the hand-entered balance the remaining credits are derived from; null until one is set. */
  balanceAnchor: { balanceUsd: number; asOf: number } | null;
  /** True when POST /api/accounts/:id/balance accepts a new anchor for this account. */
  balanceSettable: boolean;
  /** Capy with a web session: the billing page's plan, totals and credit sources, in dollars. */
  billing: CapyBilling | null;
  /** The subscription as the upstream names it (Claude "Max 20x", Codex "Pro", "SuperGrok", Go, "Capy Lite"); null when it doesn't say. */
  plan: AccountPlan | null;
  spendUsd: {
    credits: number;
    total: number;
    periodEnd: number | null;
    projection: { credits: SpendProjection | null; total: SpendProjection | null };
  } | null;
}

export interface Summary {
  generatedAt: number;
  accounts: AccountSummary[];
  errors: { providers: ProviderId[]; message: string }[];
}

export function summarizeAccount(
  store: Store,
  account: Pick<Account, "id" | "provider" | "label" | "email" | "balanceAnchor">,
  now: number,
): AccountSummary {
  const state = store.account(account.id);
  const rows = store.latest(account.id);
  const summary: AccountSummary = {
    id: account.id,
    provider: account.provider,
    label: account.label,
    email: account.email ?? null,
    status: state?.status ?? "pending",
    error: state?.error ?? null,
    notice: state?.notice ?? null,
    lastAttemptAt: state?.last_attempt_at ?? null,
    observedAt: rows[0]?.observed_at ?? null,
    windows: [],
    credits: null,
    balanceUsd: null,
    spendUsd: null,
    balanceAnchor: account.balanceAnchor?.() ?? null,
    balanceSettable: Boolean(account.balanceAnchor),
    billing: store.billing(account.id),
    plan: null,
  };
  summary.plan = summary.billing?.plan ? { ...summary.billing.plan } : store.plan(account.id);

  for (const row of rows) {
    if (row.window === CREDITS_WINDOW) {
      const series = store.series(account.id, CREDITS_WINDOW, now - BURN_LOOKBACK_MS);
      summary.credits = {
        balance: row.credits,
        unlimited: row.credits_unlimited === 1,
        burn: row.credits === null ? null : burnRate(series.flatMap((s) => (s.credits === null ? [] : [{ observedAt: s.observed_at, value: s.credits }]))),
      };
    } else if (row.window === SPEND_WINDOW || row.window === SPEND_ALL_WINDOW) {
      if (row.spend_usd === null) continue;
      const end = row.resets_at ?? currentMonth(row.observed_at).end;
      const start = currentMonth(end - 1).start;
      const series = store
        .series(account.id, row.window, start)
        .flatMap((s) => (s.spend_usd === null ? [] : [{ observedAt: s.observed_at, value: s.spend_usd }]));
      summary.spendUsd ??= { credits: 0, total: 0, periodEnd: row.resets_at, projection: { credits: null, total: null } };
      const key = row.window === SPEND_WINDOW ? "credits" : "total";
      summary.spendUsd[key] = row.spend_usd;
      summary.spendUsd.projection[key] = projectSpend(series, start, end);
    } else if (row.window === BALANCE_WINDOW && row.balance_usd !== null) {
      const series = store.series(account.id, BALANCE_WINDOW, now - BURN_LOOKBACK_MS);
      summary.balanceUsd = {
        balance: row.balance_usd,
        burn: burnRate(series.flatMap((s) => (s.balance_usd === null ? [] : [{ observedAt: s.observed_at, value: s.balance_usd }]))),
      };
    } else {
      const series = store.series(account.id, row.window, now - WINDOW_LOOKBACK_MS);
      const samples = series.flatMap((s) =>
        s.used_percent === null ? [] : [{ observedAt: s.observed_at, usedPercent: s.used_percent, resetsAt: s.resets_at }],
      );
      summary.windows.push({
        window: row.window,
        usedPercent: row.used_percent,
        resetsAt: row.resets_at,
        projection: row.used_percent === null ? null : projectWindow(samples),
      });
    }
  }
  // Capy's balance only moves when credits are billed, so the month's spend slope is its burn rate:
  // steadier than balance deltas, and not thrown off by an anchor reset or a top-up.
  const slope = summary.spendUsd?.projection.credits;
  if (summary.balanceUsd && account.provider === "capy" && slope) {
    summary.balanceUsd.burn = {
      perDay: slope.perDay,
      daysLeft: slope.perDay > 0 ? Math.max(0, summary.balanceUsd.balance) / slope.perDay : null,
    };
  }
  return summary;
}

export function buildSummary(store: Store, accounts: Account[], errors: Summary["errors"], now = Date.now()): Summary {
  return { generatedAt: now, accounts: accounts.map((account) => summarizeAccount(store, account, now)), errors };
}
