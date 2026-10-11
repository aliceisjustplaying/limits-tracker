import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { type Fetch, UpstreamError, parseJson, readBoundedText, requestJson } from "../http.ts";
import {
  type DeviceTokens,
  type ModelUsage,
  type UsageRange,
  isRecord,
  parseDeviceCode,
  parseDeviceTokens,
  parseGoMeters,
  parseGoPlan,
  parseModelUsagePage,
  parseZenBalance,
} from "../parse.ts";
import type { Observation } from "./types.ts";

export const CONSOLE_ORIGIN = "https://opencode.ai";
const CONSOLE = `${CONSOLE_ORIGIN}/console`;
const CLIENT_ID = "limits";
const REFRESH_BEFORE_MS = 7 * 24 * 3_600_000;
const MODEL_RANGES: UsageRange[] = ["24h", "7d", "30d"];
const MAX_MODEL_PAGES = 10;

/** The device token pair, persisted atomically (temp file, fsync, rename, fsync dir) with mode 0600. */
export class TokenFile {
  constructor(readonly path: string) {}

  read(): DeviceTokens | null {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return null;
    }
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || typeof value.accessToken !== "string" || typeof value.refreshToken !== "string") return null;
    return value as unknown as DeviceTokens;
  }

  write(tokens: DeviceTokens): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    const fd = openSync(temp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(tokens));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.path);
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }
}

export class ReauthRequired extends UpstreamError {
  constructor() {
    super("device login needed");
  }
}

async function postForm(fetchImpl: Fetch, path: string, form: Record<string, string>): Promise<{ status: number; payload: unknown }> {
  let response: Response;
  try {
    response = await fetchImpl(`${CONSOLE}/auth/device/${path}`, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new UpstreamError("request failed");
  }
  const text = await readBoundedText(response);
  return { status: response.status, payload: text ? parseJson(text) : null };
}

function oauthError(payload: unknown): string {
  return isRecord(payload) && typeof payload.error === "string" ? payload.error : "";
}

export type LoginState =
  | { status: "idle" }
  | { status: "pending"; userCode: string; verificationUrl: string; expiresAt: number }
  | { status: "done"; at: number }
  | { status: "error"; error: string };

/**
 * One OpenCode workspace: owns its device token. This object is the token's only refresher;
 * concurrent callers share one in-flight refresh, and the rotated pair is on disk before it's used.
 */
export class OpencodeWorkspace {
  login: LoginState = { status: "idle" };
  /** The logged-in user's email, from `api/user`; null until a user-token poll reads it. */
  email: string | null = null;
  private refreshing: Promise<string> | null = null;
  private loginRun = 0;

  constructor(
    readonly tokens: TokenFile,
    readonly serviceKey: string | undefined,
    private readonly fetchImpl: Fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
  ) {}

  /** A valid user access token, refreshing it when under 7 days remain; null when never logged in. */
  async accessToken(): Promise<string | null> {
    const current = this.tokens.read();
    if (!current) return null;
    if (current.expiresAt - this.now() > REFRESH_BEFORE_MS) return current.accessToken;
    this.refreshing ??= this.refresh(current).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refresh(current: DeviceTokens): Promise<string> {
    const { status, payload } = await postForm(this.fetchImpl, "token", {
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: CLIENT_ID,
    });
    if (status === 400 || status === 401) {
      if (oauthError(payload) === "invalid_grant" || status === 401) throw new ReauthRequired();
    }
    if (status < 200 || status >= 300) throw new UpstreamError(`token refresh HTTP ${status}`, status);
    const next = parseDeviceTokens(payload, this.now());
    if (!next) throw new UpstreamError("malformed token response");
    this.tokens.write(next);
    return next.accessToken;
  }

  /** Start an RFC 8628 device login; the approval is polled in the background. */
  async startLogin(): Promise<LoginState> {
    const { status, payload } = await postForm(this.fetchImpl, "code", { client_id: CLIENT_ID, supports_org_scope: "true" });
    const code = status >= 200 && status < 300 ? parseDeviceCode(payload, CONSOLE_ORIGIN) : null;
    if (!code) throw new UpstreamError(`device code HTTP ${status}`, status);
    const run = ++this.loginRun;
    const expiresAt = this.now() + code.expiresInSeconds * 1000;
    this.login = { status: "pending", userCode: code.userCode, verificationUrl: code.verificationUrl, expiresAt };
    void this.pollLogin(run, code.deviceCode, code.intervalSeconds * 1000, expiresAt);
    return this.login;
  }

  private async pollLogin(run: number, deviceCode: string, intervalMs: number, expiresAt: number): Promise<void> {
    let interval = intervalMs;
    while (run === this.loginRun) {
      await this.sleep(interval);
      if (run !== this.loginRun) return;
      if (this.now() >= expiresAt) {
        this.login = { status: "error", error: "code expired" };
        return;
      }
      try {
        const { status, payload } = await postForm(this.fetchImpl, "token", {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          client_id: CLIENT_ID,
        });
        const error = oauthError(payload);
        if (error === "authorization_pending") continue;
        if (error === "slow_down") {
          interval += 5000;
          continue;
        }
        const tokens = status >= 200 && status < 300 ? parseDeviceTokens(payload, this.now()) : null;
        if (!tokens) {
          this.login = { status: "error", error: error || `HTTP ${status}` };
          return;
        }
        if (run !== this.loginRun) return;
        this.tokens.write(tokens);
        this.login = { status: "done", at: this.now() };
        return;
      } catch {
        // Transient network failure: keep polling until the code expires.
      }
    }
  }

  async fetchObservation(): Promise<Observation> {
    const userToken = await this.accessToken();
    const bearer = userToken ?? this.serviceKey;
    if (!bearer) throw new ReauthRequired();
    const get = async (path: string) => {
      try {
        return await requestJson(this.fetchImpl, `${CONSOLE}/api/${path}`, {
          headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" },
        });
      } catch (error) {
        if (userToken && error instanceof UpstreamError && error.status === 401) throw new ReauthRequired();
        throw error;
      }
    };

    // The Zen balance is this account's headline; Go meters and per-model usage are extras, so their
    // failures become a notice instead of hiding the balance. Only a lost login fails the whole poll.
    const notices: string[] = [];
    const optional = async <T>(what: string, read: () => Promise<T>, quiet?: (error: unknown) => boolean): Promise<T | undefined> => {
      try {
        return await read();
      } catch (error) {
        if (error instanceof ReauthRequired) throw error;
        if (!quiet?.(error)) notices.push(`${what} unavailable (${error instanceof Error ? error.message : "failed"})`);
        return undefined;
      }
    };

    // `api/user` is the console SPA's own "me" call (UserSelf `{ id, email, name, role }`) and, like every
    // other /api route, takes the device token. `auth/session` belongs to the cookie login flow.
    if (userToken) {
      const user = await optional("Account email", () => get("user"), () => true);
      if (isRecord(user) && typeof user.email === "string" && user.email) this.email = user.email;
    }

    // Only a user token can read the Zen balance; go/status needs a user token or an `All` service key.
    const balanceUsd = userToken ? parseZenBalance(await get("billing/status")) : undefined;
    if (userToken && balanceUsd === undefined) throw new UpstreamError("malformed billing response");

    const goStatus = await optional(
      "Go meters",
      () => get("go/status"),
      (error) => !userToken && error instanceof UpstreamError && error.status === 403,
    );
    const windows = parseGoMeters(goStatus);
    const plan = parseGoPlan(goStatus);

    const readModels = async () => {
      const models: ModelUsage[] = [];
      for (const range of MODEL_RANGES) {
        for (let page = 1; page <= MAX_MODEL_PAGES; page++) {
          const parsed = parseModelUsagePage(
            await get(`usage/models?range=${range}&page=${page}&pageSize=100&includeLegacyKeys=true`),
            range,
          );
          if (!parsed) throw new UpstreamError("malformed usage response");
          models.push(...parsed.items);
          if (page >= parsed.pageCount) break;
        }
      }
      return models;
    };
    // With only a service key, per-model usage is all there is, so its failure is the poll's failure.
    const models = userToken ? await optional("Per-model usage", readModels) : await readModels();

    return {
      windows,
      ...(models ? { models } : {}),
      ...(plan ? { plan } : {}),
      ...(balanceUsd !== undefined ? { balanceUsd } : {}),
      ...(notices.length ? { notice: notices.join("; ") } : {}),
    };
  }
}
