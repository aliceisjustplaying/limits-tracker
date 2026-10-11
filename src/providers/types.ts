import type { BalanceAnchor } from "../config.ts";
import type { AccountPlan, CapyBilling, CreditBalance, ModelUsage, UsageWindow } from "../parse.ts";

export type ProviderId = "claude" | "codex" | "grok" | "capy" | "opencode-go" | "openrouter" | "opencode";

export const PROVIDERS: ProviderId[] = ["claude", "codex", "grok", "capy", "opencode-go", "openrouter", "opencode"];

/** What one successful poll of an account returns. */
export interface Observation {
  windows: UsageWindow[];
  credits?: CreditBalance;
  balanceUsd?: number;
  /** Spend in the current period (Capy): what was billed to credits, and the total metered. */
  spend?: { creditsUsd: number; totalUsd: number; periodStart: number; periodEnd: number };
  /** The account works but has nothing to spend: a lapsed plan or an empty balance. Data is still recorded. */
  inactive?: string;
  /** Part of the poll failed but the rest is current (e.g. per-model usage unavailable). */
  notice?: string;
  /** The subscription behind the account, when the upstream names it. Replaces the previous one. */
  plan?: AccountPlan;
  /** Capy's billing page: plan, balance and credit sources. Replaces the previous one. */
  billing?: CapyBilling;
  /** Per-model usage; replaces the account's previous breakdown. */
  models?: ModelUsage[];
}

/** One tracked account. Adding a provider means producing these from config or discovery. */
export interface Account {
  id: string;
  provider: ProviderId;
  label: string;
  /** The account's email, shown under the label; null when neither the API nor config has one. */
  readonly email?: string | null;
  poll(): Promise<Observation>;
  /** Present when the balance is derived from a hand-entered anchor (Capy): the anchor in effect, or null. */
  balanceAnchor?: () => BalanceAnchor | null;
}

/** The credential is fine but the subscription or balance behind it isn't active. Not an error. */
export class InactiveError extends Error {
  constructor(
    message: string,
    readonly plan?: AccountPlan,
  ) {
    super(message);
  }
}
