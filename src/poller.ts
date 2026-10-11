import type { Store } from "./db.ts";
import type { Discovery } from "./providers/index.ts";
import { type Account, InactiveError, type ProviderId } from "./providers/types.ts";

const DISCOVERY_INTERVAL_MS = 5 * 60_000;
const PRUNE_INTERVAL_MS = 3_600_000;
const TICK_MS = 15_000;

export interface PollerOptions {
  store: Store;
  discover: () => Promise<Discovery>;
  intervalMs: Record<ProviderId, number>;
  retentionMs: number;
  now?: () => number;
  log?: (message: string) => void;
}

/**
 * Polls each account no more often than its provider's interval. The last attempt time
 * lives in SQLite, so a restart doesn't re-poll Claude inside its floor.
 */
export class Poller {
  accounts: Account[] = [];
  errors: Discovery["failed"] = [];
  private discoveredAt = -Infinity;
  private prunedAt = -Infinity;
  private readonly inFlight = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: PollerOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async refreshAccounts(): Promise<void> {
    const { accounts, failed } = await this.options.discover();
    const failedProviders = new Set(failed.flatMap((f) => f.providers));
    const kept = this.accounts.filter((a) => failedProviders.has(a.provider));
    this.accounts = [...accounts, ...kept];
    this.errors = failed;
    for (const f of failed) this.options.log?.(`discovery failed for ${f.providers.join(", ")}: ${f.message}`);
  }

  isDue(account: Account, now: number): boolean {
    const last = this.options.store.account(account.id)?.last_attempt_at;
    return last === null || last === undefined || now - last >= this.options.intervalMs[account.provider];
  }

  private async pollAccount(account: Account): Promise<void> {
    this.inFlight.add(account.id);
    const startedAt = this.now();
    try {
      const observation = await account.poll();
      this.options.store.recordObservation(account, observation, startedAt);
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed";
      if (error instanceof InactiveError) {
        this.options.store.recordInactive(account, message, startedAt, error.plan);
        return;
      }
      this.options.store.recordFailure(account, message, startedAt);
      this.options.log?.(`${account.id}: ${message}`);
    } finally {
      this.inFlight.delete(account.id);
    }
  }

  /** Poll one account right away, ignoring its interval (after a balance is set, say). */
  async pollNow(accountId: string): Promise<boolean> {
    const account = this.accounts.find((a) => a.id === accountId);
    if (!account) return false;
    if (!this.inFlight.has(account.id)) await this.pollAccount(account);
    return true;
  }

  async tick(): Promise<void> {
    const now = this.now();
    if (now - this.discoveredAt >= DISCOVERY_INTERVAL_MS) {
      this.discoveredAt = now;
      await this.refreshAccounts();
    }
    if (now - this.prunedAt >= PRUNE_INTERVAL_MS) {
      this.prunedAt = now;
      this.options.store.prune(now - this.options.retentionMs);
    }
    const due = this.accounts.filter((a) => !this.inFlight.has(a.id) && this.isDue(a, now));
    await Promise.all(due.map((a) => this.pollAccount(a)));
  }

  start(): void {
    const run = () => this.tick().catch((error) => this.options.log?.(`tick failed: ${error instanceof Error ? error.message : error}`));
    void run();
    this.timer = setInterval(run, TICK_MS);
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
