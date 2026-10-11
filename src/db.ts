import { Database } from "bun:sqlite";
import type { BalanceAnchor } from "./config.ts";
import type { AccountPlan, CapyBilling, ModelUsage } from "./parse.ts";
import type { Observation, ProviderId } from "./providers/types.ts";

export const CREDITS_WINDOW = "credits";
export const BALANCE_WINDOW = "balance";
/** Spend so far in the current period: billed to credits, and everything metered. */
export const SPEND_WINDOW = "spend";
export const SPEND_ALL_WINDOW = "spend-all";

/** ok: current data. inactive: lapsed subscription, not a fault (balances never are). error: the poll failed. */
export type AccountStatus = "ok" | "inactive" | "error";

export type AccountRow = {
  id: string;
  provider: ProviderId;
  label: string;
  status: AccountStatus;
  error: string | null;
  notice: string | null;
  last_attempt_at: number | null;
  last_ok_at: number | null;
};

export type ModelUsageRow = {
  account_id: string;
  range: string;
  plan: string;
  provider: string;
  model: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  observed_at: number;
};

export type SnapshotRow = {
  account_id: string;
  window: string;
  used_percent: number | null;
  resets_at: number | null;
  credits: number | null;
  credits_unlimited: number;
  balance_usd: number | null;
  spend_usd: number | null;
  observed_at: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  notice TEXT,
  last_attempt_at INTEGER,
  last_ok_at INTEGER
);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL,
  "window" TEXT NOT NULL,
  used_percent REAL,
  resets_at INTEGER,
  credits REAL,
  credits_unlimited INTEGER NOT NULL DEFAULT 0,
  balance_usd REAL,
  spend_usd REAL,
  observed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshots_account_window_time ON snapshots (account_id, "window", observed_at);
CREATE INDEX IF NOT EXISTS snapshots_time ON snapshots (observed_at);
CREATE TABLE IF NOT EXISTS account_plans (
  account_id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  observed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS capy_billing (
  account_id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  observed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS balance_anchors (
  account_id TEXT PRIMARY KEY,
  balance_usd REAL NOT NULL,
  as_of INTEGER NOT NULL,
  set_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS model_usage (
  account_id TEXT NOT NULL,
  range TEXT NOT NULL,
  plan TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  requests INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, range, provider, model)
);
`;

const SNAPSHOT_COLUMNS = `account_id, "window" AS window, used_percent, resets_at, credits, credits_unlimited, balance_usd, spend_usd, observed_at`;

export class Store {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(snapshots)").all();
    if (!columns.some((c) => c.name === "spend_usd")) this.db.exec("ALTER TABLE snapshots ADD COLUMN spend_usd REAL");
    const accountColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(accounts)").all();
    if (!accountColumns.some((c) => c.name === "notice")) this.db.exec("ALTER TABLE accounts ADD COLUMN notice TEXT");
    // Balances are never inactive; clear rows limits#4 marked so, rather than waiting for their next poll.
    this.db.exec(
      "UPDATE accounts SET status = 'ok', notice = NULL WHERE status = 'inactive' AND provider IN ('openrouter', 'opencode', 'capy')",
    );
  }

  account(id: string): AccountRow | null {
    return this.db.query<AccountRow, [string]>("SELECT * FROM accounts WHERE id = ?").get(id);
  }

  private upsertAccount(row: AccountRow): void {
    this.db
      .query(
        `INSERT INTO accounts (id, provider, label, status, error, notice, last_attempt_at, last_ok_at)
         VALUES ($id, $provider, $label, $status, $error, $notice, $last_attempt_at, $last_ok_at)
         ON CONFLICT (id) DO UPDATE SET provider = excluded.provider, label = excluded.label,
           status = excluded.status, error = excluded.error, notice = excluded.notice,
           last_attempt_at = excluded.last_attempt_at, last_ok_at = excluded.last_ok_at`,
      )
      .run(row);
  }

  recordObservation(account: { id: string; provider: ProviderId; label: string }, observation: Observation, at: number): void {
    const insert = this.db.query(
      `INSERT INTO snapshots (account_id, "window", used_percent, resets_at, credits, credits_unlimited, balance_usd, spend_usd, observed_at)
       VALUES ($account_id, $window, $used_percent, $resets_at, $credits, $credits_unlimited, $balance_usd, $spend_usd, $observed_at)`,
    );
    const row = (window: string, values: Partial<SnapshotRow>): SnapshotRow => ({
      account_id: account.id,
      window,
      used_percent: null,
      resets_at: null,
      credits: null,
      credits_unlimited: 0,
      balance_usd: null,
      spend_usd: null,
      observed_at: at,
      ...values,
    });
    this.db.transaction(() => {
      for (const window of observation.windows) {
        insert.run(row(window.label, { used_percent: window.usedPercent ?? null, resets_at: window.resetsAt ?? null }));
      }
      if (observation.credits !== undefined) {
        insert.run(
          row(CREDITS_WINDOW, observation.credits === "unlimited" ? { credits_unlimited: 1 } : { credits: observation.credits }),
        );
      }
      if (observation.balanceUsd !== undefined) insert.run(row(BALANCE_WINDOW, { balance_usd: observation.balanceUsd }));
      if (observation.spend) {
        const { creditsUsd, totalUsd, periodEnd } = observation.spend;
        insert.run(row(SPEND_WINDOW, { spend_usd: creditsUsd, resets_at: periodEnd }));
        insert.run(row(SPEND_ALL_WINDOW, { spend_usd: totalUsd, resets_at: periodEnd }));
      }
      if (observation.models) this.replaceModels(account.id, observation.models, at);
      if (observation.plan) this.setPlan(account.id, observation.plan, at);
      if (observation.billing) {
        this.db
          .query("INSERT INTO capy_billing (account_id, body, observed_at) VALUES (?1, ?2, ?3) ON CONFLICT (account_id) DO UPDATE SET body = ?2, observed_at = ?3")
          .run(account.id, JSON.stringify(observation.billing), at);
      }
      this.upsertAccount({
        ...account,
        status: observation.inactive ? "inactive" : "ok",
        error: null,
        notice: observation.inactive ?? observation.notice ?? null,
        last_attempt_at: at,
        last_ok_at: at,
      });
    })();
  }

  recordFailure(account: { id: string; provider: ProviderId; label: string }, error: string, at: number): void {
    const previous = this.account(account.id);
    this.upsertAccount({ ...account, status: "error", error, notice: null, last_attempt_at: at, last_ok_at: previous?.last_ok_at ?? null });
  }

  /** Lapsed with no fresh data (e.g. a 403 for no subscription): keep the last good windows, mark inactive. */
  recordInactive(account: { id: string; provider: ProviderId; label: string }, notice: string, at: number, plan?: AccountPlan): void {
    const previous = this.account(account.id);
    if (plan) this.setPlan(account.id, plan, at);
    this.upsertAccount({ ...account, status: "inactive", error: null, notice, last_attempt_at: at, last_ok_at: previous?.last_ok_at ?? null });
  }

  /** Rows written by the account's most recent successful poll. */
  latest(accountId: string): SnapshotRow[] {
    return this.db
      .query<SnapshotRow, [string, string]>(
        `SELECT ${SNAPSHOT_COLUMNS} FROM snapshots
         WHERE account_id = ? AND observed_at = (SELECT MAX(observed_at) FROM snapshots WHERE account_id = ?)
         ORDER BY id`,
      )
      .all(accountId, accountId);
  }

  series(accountId: string, window: string, since: number): SnapshotRow[] {
    return this.db
      .query<SnapshotRow, [string, string, number]>(
        `SELECT ${SNAPSHOT_COLUMNS} FROM snapshots
         WHERE account_id = ? AND "window" = ? AND observed_at >= ? ORDER BY observed_at`,
      )
      .all(accountId, window, since);
  }

  history(filter: { accountId?: string; window?: string; since: number; until: number; limit: number }): SnapshotRow[] {
    return this.db
      .query<SnapshotRow, [string | null, string | null, number, number, number]>(
        `SELECT ${SNAPSHOT_COLUMNS} FROM snapshots
         WHERE (?1 IS NULL OR account_id = ?1) AND (?2 IS NULL OR "window" = ?2)
           AND observed_at >= ?3 AND observed_at <= ?4
         ORDER BY observed_at, id LIMIT ?5`,
      )
      .all(filter.accountId ?? null, filter.window ?? null, filter.since, filter.until, filter.limit);
  }

  private replaceModels(accountId: string, models: ModelUsage[], at: number): void {
    this.db.query("DELETE FROM model_usage WHERE account_id = ?").run(accountId);
    const insert = this.db.query(
      `INSERT OR REPLACE INTO model_usage (account_id, range, plan, provider, model, requests, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_usd, observed_at)
       VALUES ($account_id, $range, $plan, $provider, $model, $requests, $input_tokens, $output_tokens,
         $cache_read_tokens, $cache_write_tokens, $cost_usd, $observed_at)`,
    );
    for (const m of models) {
      insert.run({
        account_id: accountId,
        range: m.range,
        plan: m.plan,
        provider: m.provider,
        model: m.model,
        requests: m.requests,
        input_tokens: m.inputTokens,
        output_tokens: m.outputTokens,
        cache_read_tokens: m.cacheReadTokens,
        cache_write_tokens: m.cacheWriteTokens,
        cost_usd: m.costUsd,
        observed_at: at,
      });
    }
  }

  /** The latest per-model breakdown, most expensive first. */
  models(filter: { accountId?: string; range?: string }): ModelUsageRow[] {
    return this.db
      .query<ModelUsageRow, [string | null, string | null]>(
        `SELECT * FROM model_usage WHERE (?1 IS NULL OR account_id = ?1) AND (?2 IS NULL OR range = ?2)
         ORDER BY account_id, range, cost_usd DESC, model`,
      )
      .all(filter.accountId ?? null, filter.range ?? null);
  }

  private setPlan(accountId: string, plan: AccountPlan, at: number): void {
    this.db
      .query("INSERT INTO account_plans (account_id, body, observed_at) VALUES (?1, ?2, ?3) ON CONFLICT (account_id) DO UPDATE SET body = ?2, observed_at = ?3")
      .run(accountId, JSON.stringify(plan), at);
  }

  /** The last plan an upstream reported for the account. */
  plan(accountId: string): AccountPlan | null {
    const row = this.db.query<{ body: string }, [string]>("SELECT body FROM account_plans WHERE account_id = ?").get(accountId);
    return row ? (JSON.parse(row.body) as AccountPlan) : null;
  }

  /** The latest Capy billing page read, kept through failed polls like the other last-good data. */
  billing(accountId: string): CapyBilling | null {
    const row = this.db.query<{ body: string }, [string]>("SELECT body FROM capy_billing WHERE account_id = ?").get(accountId);
    return row ? (JSON.parse(row.body) as CapyBilling) : null;
  }

  /** A balance set from the UI; it outlives restarts and rebuilds, so a top-up needs no config change. */
  setAnchor(accountId: string, anchor: BalanceAnchor, at: number): void {
    this.db
      .query(
        `INSERT INTO balance_anchors (account_id, balance_usd, as_of, set_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (account_id) DO UPDATE SET balance_usd = ?2, as_of = ?3, set_at = ?4`,
      )
      .run(accountId, anchor.balanceUsd, anchor.asOf, at);
  }

  anchor(accountId: string): BalanceAnchor | null {
    const row = this.db
      .query<{ balance_usd: number; as_of: number }, [string]>("SELECT balance_usd, as_of FROM balance_anchors WHERE account_id = ?")
      .get(accountId);
    return row ? { balanceUsd: row.balance_usd, asOf: row.as_of } : null;
  }

  prune(before: number): void {
    this.db.query("DELETE FROM snapshots WHERE observed_at < ?").run(before);
  }

  close(): void {
    this.db.close();
  }
}
