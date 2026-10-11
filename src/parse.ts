// Response parsers. The Claude, Codex and OpenCode Go parsers are ported from
// aliceisjustplaying/pi-usage (index.ts) with their behaviour unchanged.

type UnknownRecord = Record<string, unknown>;

export interface UsageWindow {
  label: string;
  usedPercent?: number;
  resetsAt?: number;
}

export type CreditBalance = number | "unlimited";

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

function resolveEpochTime(value: unknown): number | undefined {
  const epoch = finiteNumber(value);
  if (epoch === undefined || epoch < 0) return undefined;
  return epoch >= 1_000_000_000_000 ? epoch : epoch * 1000;
}

function parseResetTime(value: unknown): number | undefined {
  const epoch = resolveEpochTime(value);
  if (epoch !== undefined) return epoch;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function cleanLabel(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\p{Bidi_Control}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32)
    .trim();
  return cleaned || fallback;
}

function parseAnthropicBucket(value: unknown, label: string): UsageWindow | undefined {
  if (!isRecord(value)) return undefined;
  const usedPercent = finiteNumber(value.utilization);
  const resetsAt = parseResetTime(value.resets_at);
  if (usedPercent === undefined && resetsAt === undefined) return undefined;
  return { label, usedPercent, resetsAt };
}

function scopedModelName(scope: unknown): string | undefined {
  if (!isRecord(scope) || !isRecord(scope.model)) return undefined;
  const name = cleanLabel(scope.model.display_name);
  return name || undefined;
}

/** Claude `api/oauth/usage`: the current `limits[]` array with the legacy buckets as fallback. */
export function parseAnthropicUsage(payload: unknown): UsageWindow[] | null {
  if (!isRecord(payload)) return null;

  const generic: UsageWindow[] = [];
  let hasSession = false;
  let hasWeeklyAll = false;

  if (Array.isArray(payload.limits)) {
    for (const entry of payload.limits) {
      if (!isRecord(entry) || typeof entry.kind !== "string") continue;
      const usedPercent = finiteNumber(entry.percent);
      const resetsAt = parseResetTime(entry.resets_at);
      if (usedPercent === undefined && resetsAt === undefined) continue;

      let label: string | undefined;
      if (entry.kind === "session") {
        label = "5h";
        hasSession = true;
      } else if (entry.kind === "weekly_all") {
        label = "Week";
        hasWeeklyAll = true;
      } else if (entry.kind === "weekly_scoped") {
        label = scopedModelName(entry.scope);
      }
      if (label) generic.push({ label, usedPercent, resetsAt });
    }
  }

  const windows = [...generic];
  if (!hasSession) {
    const legacy = parseAnthropicBucket(payload.five_hour, "5h");
    if (legacy) windows.unshift(legacy);
  }
  if (!hasWeeklyAll) {
    const legacy = parseAnthropicBucket(payload.seven_day, "Week");
    if (legacy) {
      const insertion = windows[0]?.label === "5h" ? 1 : 0;
      windows.splice(insertion, 0, legacy);
    }
  }

  return windows.length > 0 ? windows : null;
}

function windowDurationLabel(value: unknown, fallback: string): string {
  const seconds = finiteNumber(value);
  if (seconds === undefined || seconds <= 0) return fallback;
  if (seconds >= 86_400) {
    const days = Math.max(1, Math.round(seconds / 86_400));
    return days === 7 ? "Week" : `${days}d`;
  }
  return `${Math.max(1, Math.round(seconds / 3600))}h`;
}

function parseCodexWindow(value: unknown, fallbackLabel: string, nowMs: number): UsageWindow | undefined {
  if (!isRecord(value)) return undefined;
  const usedPercent = finiteNumber(value.used_percent);
  let resetsAt = resolveEpochTime(value.reset_at);
  if (resetsAt === undefined) {
    const after = finiteNumber(value.reset_after_seconds);
    if (after !== undefined && after >= 0) resetsAt = nowMs + after * 1000;
  }
  if (usedPercent === undefined && resetsAt === undefined) return undefined;
  return {
    label: windowDurationLabel(value.limit_window_seconds, fallbackLabel),
    usedPercent,
    resetsAt,
  };
}

/** Codex `wham/usage` shared windows; feature-specific meters (`additional_rate_limits`) are ignored. */
export function parseCodexUsage(payload: unknown, nowMs = Date.now()): UsageWindow[] | null {
  if (!isRecord(payload) || !isRecord(payload.rate_limit)) return null;
  const windows = [
    parseCodexWindow(payload.rate_limit.primary_window, "Primary", nowMs),
    parseCodexWindow(payload.rate_limit.secondary_window, "Secondary", nowMs),
  ].filter((window): window is UsageWindow => window !== undefined);
  return windows.length > 0 ? windows : null;
}

/** Codex credit balance: a number, "unlimited", or undefined when the account has none. */
export function parseCodexCredits(payload: unknown): CreditBalance | undefined {
  if (!isRecord(payload) || !isRecord(payload.credits)) return undefined;
  const credits = payload.credits;
  if (credits.unlimited === true) return "unlimited";
  const balance = finiteNumber(credits.balance);
  if (balance === undefined || balance < 0) return undefined;
  if (credits.has_credits === false && balance === 0) return undefined;
  return balance;
}

function parseOpenCodeGoWindow(value: unknown, label: string): UsageWindow | undefined {
  if (!isRecord(value)) return undefined;
  const usedPercent = finiteNumber(value.percent);
  const resetsAt = parseResetTime(value.resetsAt);
  if (usedPercent === undefined && resetsAt === undefined) return undefined;
  return { label, usedPercent, resetsAt };
}

/** OpenCode Go `/zen/go/v1/usage`: rolling (5h), weekly and monthly windows. */
export function parseOpenCodeGoUsage(payload: unknown): UsageWindow[] | null {
  if (!isRecord(payload) || !isRecord(payload.usage)) return null;
  const usage = payload.usage;
  const windows = [
    parseOpenCodeGoWindow(usage.rolling, "5h"),
    parseOpenCodeGoWindow(usage.weekly, "Week"),
    parseOpenCodeGoWindow(usage.monthly, "Month"),
  ].filter((window): window is UsageWindow => window !== undefined);
  return windows.length > 0 ? windows : null;
}

function centsValue(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const cents = value.val === undefined ? 0 : finiteNumber(value.val);
  return cents !== undefined && cents >= 0 ? cents : undefined;
}

/** Grok `/v1/billing?format=credits`: weekly credit usage with the legacy monthly fallback (ported from pi-usage). */
export function parseGrokUsage(payload: unknown): UsageWindow[] | null {
  if (!isRecord(payload) || !isRecord(payload.config)) return null;
  const config = payload.config;
  const period = isRecord(config.currentPeriod) ? config.currentPeriod : undefined;
  const periodType = typeof period?.type === "string" ? period.type.toUpperCase() : "";
  const hasLegacyAmounts = config.used !== undefined || config.monthlyLimit !== undefined;
  const label = periodType.includes("MONTHLY") || (!period && hasLegacyAmounts) ? "Month" : "Week";
  const resetsAt = parseResetTime(period?.end ?? config.billingPeriodEnd);

  const percentWasOmitted = config.creditUsagePercent === undefined;
  let usedPercent = finiteNumber(config.creditUsagePercent);
  if (usedPercent !== undefined && (usedPercent < 0 || usedPercent > 100)) usedPercent = undefined;
  if (usedPercent === undefined && percentWasOmitted) {
    const used = centsValue(config.used);
    const limit = centsValue(config.monthlyLimit);
    if (used !== undefined && limit !== undefined && limit > 0) {
      usedPercent = Math.min(100, (used / limit) * 100);
    } else if (period && resetsAt !== undefined) {
      // Proto3 omits zero-valued scalars at the beginning of a fresh period.
      usedPercent = 0;
    }
  }

  return usedPercent !== undefined || resetsAt !== undefined ? [{ label, usedPercent, resetsAt }] : null;
}

/** Grok `/v1/user`: the user id, accepted only if it's safe to send back as a header. */
export function parseGrokUserId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const userId = payload.userId;
  return typeof userId === "string" && userId.length > 0 && userId.length <= 256 && /^[\x21-\x7e]+$/.test(userId)
    ? userId
    : undefined;
}

export interface CapyUsage {
  /** Billed to Capy credits (llm + image + vm). Verified live: `totals` exclude `unbilled` models. */
  totalUsd: number;
  llmUsd: number;
  imageUsd: number;
  vmUsd: number;
  models: ModelUsage[];
}

/**
 * Capy `GET /api/v1/usage?from&to`: windowed spend for the key's organization. Per-model rows carry
 * `unbilled` (ran on a connected subscription or key, not Capy credits), mapped to plan "connected" vs "credits".
 */
export function parseCapyUsage(payload: unknown, range: UsageRange): CapyUsage | null {
  if (!isRecord(payload) || !isRecord(payload.totals)) return null;
  const totals = payload.totals;
  const totalUsd = finiteNumber(totals.totalDollars);
  if (totalUsd === undefined) return null;
  const count = (value: unknown) => finiteNumber(value) ?? 0;
  const models: ModelUsage[] = [];
  for (const item of Array.isArray(payload.models) ? payload.models : []) {
    if (!isRecord(item) || typeof item.model !== "string") continue;
    const tokens = isRecord(item.tokens) ? item.tokens : {};
    const plan = item.unbilled === true ? "connected" : "credits";
    models.push({
      range,
      plan,
      // The same model can appear once per billing route, so the route is part of the row's identity.
      provider: `capy-${plan}`,
      model: cleanLabel(item.label, "") || item.model.slice(0, 128),
      requests: 0,
      inputTokens: count(tokens.inputTokens),
      outputTokens: count(tokens.outputTokens),
      cacheReadTokens: count(tokens.cacheReadTokens),
      cacheWriteTokens: count(tokens.cacheWriteTokens),
      costUsd: count(item.dollars),
    });
  }
  return { totalUsd, llmUsd: count(totals.llmDollars), imageUsd: count(totals.imageDollars), vmUsd: count(totals.vmDollars), models };
}

/** OpenRouter `/api/v1/credits`: balance is total_credits − total_usage, in USD. */
export function parseOpenRouterBalance(payload: unknown): number | undefined {
  if (!isRecord(payload) || !isRecord(payload.data)) return undefined;
  const total = finiteNumber(payload.data.total_credits);
  const used = finiteNumber(payload.data.total_usage);
  if (total === undefined || used === undefined) return undefined;
  return Math.round((total - used) * 1e6) / 1e6;
}

export interface AuthFile {
  authIndex: string;
  name: string;
  provider: string;
  email?: string;
  disabled: boolean;
  chatgptAccountId?: string;
}

/** CLIProxyAPI `GET /v0/management/auth-files`. */
export function parseAuthFiles(payload: unknown): AuthFile[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.files)) return null;
  const files: AuthFile[] = [];
  for (const entry of payload.files) {
    if (!isRecord(entry)) continue;
    const authIndex =
      typeof entry.auth_index === "string" ? entry.auth_index.trim() : finiteNumber(entry.auth_index)?.toString();
    const provider = typeof entry.provider === "string" ? entry.provider.trim().toLowerCase() : "";
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!authIndex || !provider) continue;
    const email = typeof entry.email === "string" && entry.email.trim() ? entry.email.trim() : undefined;
    const idToken = isRecord(entry.id_token) ? entry.id_token : undefined;
    const chatgptAccountId =
      typeof idToken?.chatgpt_account_id === "string" && idToken.chatgpt_account_id.trim()
        ? idToken.chatgpt_account_id.trim()
        : undefined;
    files.push({
      authIndex,
      name: name || authIndex,
      provider,
      email,
      disabled: entry.disabled === true || entry.status === "disabled",
      chatgptAccountId,
    });
  }
  return files;
}

export interface ApiCallResult {
  statusCode: number;
  body: string;
}

/** CLIProxyAPI `POST /v0/management/api-call` envelope: `{status_code, header, body}`. */
export function parseApiCallResponse(payload: unknown): ApiCallResult | null {
  if (!isRecord(payload)) return null;
  const statusCode = finiteNumber(payload.status_code);
  if (statusCode === undefined || typeof payload.body !== "string") return null;
  return { statusCode, body: payload.body };
}

const MICROCENTS_PER_USD = 1e8;

function microCentsToUsd(value: unknown): number | undefined {
  const microCents = finiteNumber(value);
  return microCents === undefined ? undefined : microCents / MICROCENTS_PER_USD;
}

/** OpenCode console `GET /api/billing/status`: Zen balance from `availableMicroCents` (string bigint, 1e8 = $1). */
export function parseZenBalance(payload: unknown): number | undefined {
  if (!isRecord(payload)) return undefined;
  return microCentsToUsd(payload.availableMicroCents ?? payload.balanceMicroCents);
}

function parseGoMeter(value: unknown, label: string): UsageWindow | undefined {
  if (!isRecord(value)) return undefined;
  const used = finiteNumber(value.usedMicroCents);
  const limit = finiteNumber(value.limitMicroCents);
  const usedPercent = used !== undefined && limit !== undefined && limit > 0 ? (used / limit) * 100 : undefined;
  const resetsAt = parseResetTime(value.resetsAt);
  if (usedPercent === undefined && resetsAt === undefined) return undefined;
  return { label, usedPercent, resetsAt };
}

/**
 * OpenCode console `GET /api/go/status`. `null` (never had Go) or `access: null` (sub ended) means no meters.
 * The meters block comes from the console bundle and hasn't been seen live, so every level is optional.
 */
export function parseGoMeters(payload: unknown): UsageWindow[] {
  if (!isRecord(payload) || !isRecord(payload.access) || !isRecord(payload.access.meters)) return [];
  const meters = payload.access.meters;
  return [
    parseGoMeter(meters.fiveHour, "5h"),
    parseGoMeter(meters.week, "Week"),
    parseGoMeter(meters.month, "Month"),
  ].filter((window): window is UsageWindow => window !== undefined);
}

export type UsageRange = "24h" | "7d" | "30d" | "month";

export interface ModelUsage {
  range: UsageRange;
  /** "go" for Go-plan traffic, "zen" for Zen credits, else the BYOK provider id. */
  plan: string;
  provider: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

/** OpenCode console `GET /api/usage/models`: one page of `items[]` plus `pageInfo.pageCount`. */
export function parseModelUsagePage(payload: unknown, range: UsageRange): { items: ModelUsage[]; pageCount: number } | null {
  if (!isRecord(payload) || !Array.isArray(payload.items)) return null;
  const count = (value: unknown) => finiteNumber(value) ?? 0;
  const items: ModelUsage[] = [];
  for (const item of payload.items) {
    if (!isRecord(item) || typeof item.model !== "string" || typeof item.provider !== "string") continue;
    const provider = item.provider.slice(0, 64);
    items.push({
      range,
      plan: provider === "opencode-go" ? "go" : provider === "opencode" ? "zen" : provider,
      provider,
      model: item.model.slice(0, 128),
      requests: count(item.totalRequests),
      inputTokens: count(item.totalInputTokens),
      outputTokens: count(item.totalOutputTokens),
      cacheReadTokens: count(item.totalCacheReadTokens),
      cacheWriteTokens: count(item.totalCacheWrite5mTokens) + count(item.totalCacheWrite1hTokens),
      costUsd: microCentsToUsd(item.totalCostMicroCents) ?? 0,
    });
  }
  const pageCount = isRecord(payload.pageInfo) ? (finiteNumber(payload.pageInfo.pageCount) ?? 1) : 1;
  return { items, pageCount };
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

/** OpenCode console `POST /auth/device/code`. */
export function parseDeviceCode(payload: unknown, origin: string): DeviceCode | null {
  if (!isRecord(payload)) return null;
  const { device_code, user_code } = payload;
  const uri = payload.verification_uri_complete ?? payload.verification_uri;
  if (typeof device_code !== "string" || typeof user_code !== "string" || typeof uri !== "string") return null;
  return {
    deviceCode: device_code,
    userCode: user_code,
    verificationUrl: new URL(uri, origin).toString(),
    expiresInSeconds: finiteNumber(payload.expires_in) ?? 600,
    intervalSeconds: Math.max(1, finiteNumber(payload.interval) ?? 5),
  };
}

export interface DeviceTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  orgId?: string;
}

/** OpenCode console `POST /auth/device/token` success body (device_code and refresh_token grants). */
export function parseDeviceTokens(payload: unknown, nowMs: number): DeviceTokens | null {
  if (!isRecord(payload)) return null;
  const { access_token, refresh_token } = payload;
  const expiresIn = finiteNumber(payload.expires_in);
  if (typeof access_token !== "string" || !access_token || typeof refresh_token !== "string" || !refresh_token) return null;
  if (expiresIn === undefined || expiresIn <= 0) return null;
  return {
    accessToken: access_token,
    refreshToken: refresh_token,
    expiresAt: nowMs + expiresIn * 1000,
    ...(typeof payload.org_id === "string" ? { orgId: payload.org_id } : {}),
  };
}

/** A credit source on the billing page: the plan's monthly grant, a one-off grant or purchased credits. */
export interface CapyCreditSource {
  name: string;
  kind: string;
  grantedUsd: number;
  remainingUsd: number;
  resetsAt: number | null;
  expiresAt: number | null;
}

/** Capy's billing page (`/app/orgs/:orgId/billing`), in dollars. */
export interface CapyBilling {
  remainingUsd: number;
  usedUsd: number;
  grantedUsd: number;
  unlimited: boolean;
  plan: { name: string; status: string; canceledAt: number | null; renewsAt: number | null } | null;
  sources: CapyCreditSource[];
}

/** One credit is a thousandth of a dollar. */
const creditsToUsd = (credits: number) => Math.round(credits * 1000) / 1_000_000;

function isoTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

export function parseCapyBilling(payload: unknown): CapyBilling | null {
  if (!isRecord(payload) || !isRecord(payload.balance)) return null;
  const balance = payload.balance;
  const remaining = finiteNumber(balance.remainingCredits);
  const used = finiteNumber(balance.usedCredits);
  const granted = finiteNumber(balance.grantedCredits);
  if (remaining === undefined || used === undefined || granted === undefined) return null;
  const plans = Array.isArray(payload.plans) ? payload.plans.filter(isRecord) : [];
  const plan = plans.find((p) => p.status === "active") ?? plans[0];
  return {
    remainingUsd: creditsToUsd(remaining),
    usedUsd: creditsToUsd(used),
    grantedUsd: creditsToUsd(granted),
    unlimited: balance.unlimited === true,
    plan: plan
      ? {
          name: typeof plan.name === "string" ? plan.name : String(plan.planId ?? "plan"),
          status: typeof plan.status === "string" ? plan.status : "unknown",
          canceledAt: isoTime(plan.canceledAt),
          renewsAt: isoTime(plan.currentPeriodEnd),
        }
      : null,
    sources: (Array.isArray(balance.sources) ? balance.sources : []).filter(isRecord).flatMap((s) => {
      const sourceGranted = finiteNumber(s.grantedCredits);
      const sourceRemaining = finiteNumber(s.remainingCredits);
      if (sourceGranted === undefined || sourceRemaining === undefined) return [];
      return [
        {
          name: typeof s.name === "string" ? s.name : "Credits",
          kind: typeof s.kind === "string" ? s.kind : "grant",
          grantedUsd: creditsToUsd(sourceGranted),
          remainingUsd: creditsToUsd(sourceRemaining),
          resetsAt: isoTime(s.resetsAt),
          expiresAt: isoTime(s.expiresAt),
        },
      ];
    }),
  };
}

/** The subscription behind an account, as the upstream names it. Null fields are ones it doesn't report. */
export interface AccountPlan {
  name: string;
  /** "active" or "inactive" (or the upstream's own status word, e.g. Capy's). */
  status: string;
  renewsAt: number | null;
  canceledAt: number | null;
}

const activePlan = (name: string, renewsAt: number | null = null): AccountPlan => ({ name, status: "active", renewsAt, canceledAt: null });

/**
 * Claude's OAuth profile (`/api/oauth/profile`): `organization.rate_limit_tier` names the Max multiplier
 * (`default_claude_max_20x`), `organization_type` the plan (`claude_max`, `claude_pro`). Unknown values give null.
 */
export function parseClaudePlan(payload: unknown): AccountPlan | null {
  if (!isRecord(payload)) return null;
  const org = isRecord(payload.organization) ? payload.organization : {};
  const account = isRecord(payload.account) ? payload.account : {};
  const tier = typeof org.rate_limit_tier === "string" ? org.rate_limit_tier : "";
  const multiplier = /max_(\d+)x/.exec(tier);
  if (multiplier) return activePlan(`Max ${multiplier[1]}x`);
  const named: Record<string, string> = { claude_max: "Max", claude_pro: "Pro", claude_team: "Team", claude_enterprise: "Enterprise" };
  if (typeof org.organization_type === "string" && named[org.organization_type]) return activePlan(named[org.organization_type]!);
  if (account.has_claude_max === true) return activePlan("Max");
  if (account.has_claude_pro === true) return activePlan("Pro");
  return null;
}

/** ChatGPT's `plan_type` ("plus", "pro", "team"), capitalized. */
export function parseCodexPlan(payload: unknown, status = "active"): AccountPlan | null {
  if (!isRecord(payload) || typeof payload.plan_type !== "string" || !/^[a-z0-9_]{1,32}$/i.test(payload.plan_type)) return null;
  const name = payload.plan_type.charAt(0).toUpperCase() + payload.plan_type.slice(1).replace(/_/g, " ");
  return { ...activePlan(name), status };
}

/** Grok's `/settings` names the tier for display (`subscription_tier_display`, e.g. "SuperGrok"). */
export function parseGrokPlan(payload: unknown): AccountPlan | null {
  if (!isRecord(payload) || typeof payload.subscription_tier_display !== "string") return null;
  const name = payload.subscription_tier_display.trim().slice(0, 64);
  return name ? activePlan(name) : null;
}

/** The console's `go/status`: `access` while subscribed (renewing at `endsAt` unless canceling), null once it ended. */
export function parseGoPlan(payload: unknown): AccountPlan | null {
  if (!isRecord(payload)) return null;
  if (isRecord(payload.access)) {
    const endsAt = typeof payload.access.endsAt === "string" ? Date.parse(payload.access.endsAt) : Number.NaN;
    const renewsAt = payload.access.cancelAtPeriodEnd === true || !Number.isFinite(endsAt) ? null : endsAt;
    return activePlan("Go", renewsAt);
  }
  return payload.access === null && payload.product === "go" ? GO_INACTIVE : null;
}

export const GO_INACTIVE: AccountPlan = { name: "Go", status: "inactive", renewsAt: null, canceledAt: null };
