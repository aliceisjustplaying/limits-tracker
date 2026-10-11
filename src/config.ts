import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { isRecord } from "./parse.ts";
import { PROVIDERS, type ProviderId } from "./providers/types.ts";

const MINUTE = 60_000;

/** Floors no config can go below: Claude's usage endpoint rate-limits hard, OpenRouter's balance moves slowly. */
export const MIN_INTERVAL_MS: Record<ProviderId, number> = {
  claude: 5 * MINUTE,
  codex: 1 * MINUTE,
  grok: 5 * MINUTE,
  capy: 5 * MINUTE,
  "opencode-go": 1 * MINUTE,
  openrouter: 15 * MINUTE,
  opencode: 2 * MINUTE,
};

const DEFAULT_INTERVAL_MS: Record<ProviderId, number> = {
  claude: 5 * MINUTE,
  codex: 2 * MINUTE,
  grok: 5 * MINUTE,
  capy: 15 * MINUTE,
  "opencode-go": 2 * MINUTE,
  openrouter: 15 * MINUTE,
  opencode: 5 * MINUTE,
};

export interface DiscoveredAccountConfig {
  label?: string;
  disabled?: boolean;
  chatgptAccountId?: string;
}

/** A balance read off a billing page at a point in time; remaining = this minus spend since `asOf`. */
export interface BalanceAnchor {
  balanceUsd: number;
  /** Epoch ms. A config date like "2026-10-11" means midnight UTC at the start of that day. */
  asOf: number;
}

export interface CapyAccount extends KeyedAccount {
  anchor?: BalanceAnchor;
  /** A capy.ai web login; when present the real balance is read from the billing page's API. */
  session?: CapySession;
}

/** Alice's capy.ai browser login: the Clerk `__client` cookie and session it mints short-lived tokens from. */
export interface CapySession {
  clientCookie: string;
  sessionId: string;
  orgId: string;
  clerkOrigin: string;
}

function capySession(raw: string, path: string): CapySession {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ConfigError(`${path} must be a JSON file`);
  }
  const entry = object(value, path);
  const field = (name: keyof CapySession) => {
    const v = entry[name];
    if (typeof v !== "string" || !v) throw new ConfigError(`${path} needs ${name}`);
    return v;
  };
  const session = { clientCookie: field("clientCookie"), sessionId: field("sessionId"), orgId: field("orgId"), clerkOrigin: field("clerkOrigin") };
  if (!/^[A-Za-z0-9_-]+$/.test(session.sessionId) || !/^[A-Za-z0-9_-]+$/.test(session.orgId)) {
    throw new ConfigError(`${path} sessionId and orgId may only use letters, digits, - and _`);
  }
  let origin: URL;
  try {
    origin = new URL(session.clerkOrigin);
  } catch {
    throw new ConfigError(`${path} clerkOrigin must be a URL`);
  }
  if (origin.protocol !== "https:") throw new ConfigError(`${path} clerkOrigin must be https`);
  return { ...session, clerkOrigin: origin.origin };
}

export interface KeyedAccount {
  id: string;
  label: string;
  key: string;
  /** Shown under the label; these APIs don't expose the account's email. */
  email?: string;
}

export interface Config {
  hosts: string[];
  port: number;
  database: string;
  retentionDays: number;
  cliproxy?: { baseUrl: string; managementKey: string };
  claude: Record<string, DiscoveredAccountConfig>;
  codex: Record<string, DiscoveredAccountConfig>;
  grok: Record<string, DiscoveredAccountConfig>;
  opencodeGo: KeyedAccount[];
  openrouter: KeyedAccount[];
  capy: CapyAccount[];
  /** OpenCode console workspaces; the device token lives in `stateDirectory`. */
  opencode: { id: string; label: string; serviceKey?: string; email?: string }[];
  stateDirectory: string;
  intervalMs: Record<ProviderId, number>;
}

export class ConfigError extends Error {}

function str(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ConfigError(`${path} must be a non-empty string`);
  return value.trim();
}

function optionalStr(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : str(value, path);
}

function list(value: unknown, path: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigError(`${path} must be an array`);
  return value;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new ConfigError(`${path} must be an object`);
  return value;
}

/**
 * Secrets are referenced by file, never inlined. A relative path resolves against
 * $CREDENTIALS_DIRECTORY (systemd LoadCredential) when set, else the config file's directory.
 */
function readSecret(file: string, configDir: string, env: Record<string, string | undefined>): string {
  const base = env.CREDENTIALS_DIRECTORY || configDir;
  const path = isAbsolute(file) ? file : join(base, file);
  let value: string;
  try {
    value = readFileSync(path, "utf8").trim();
  } catch {
    throw new ConfigError(`cannot read secret file ${file}`);
  }
  if (!value) throw new ConfigError(`secret file ${file} is empty`);
  return value;
}

function discoveredAccounts(value: unknown, path: string): Record<string, DiscoveredAccountConfig> {
  const accounts: Record<string, DiscoveredAccountConfig> = {};
  for (const [key, raw] of Object.entries(object(value, path))) {
    const entry = object(raw, `${path}.${key}`);
    accounts[key] = {
      label: optionalStr(entry.label, `${path}.${key}.label`),
      disabled: entry.disabled === true,
      chatgptAccountId: optionalStr(entry.chatgptAccountId, `${path}.${key}.chatgptAccountId`),
    };
  }
  return accounts;
}

function keyedAccounts(
  value: unknown,
  path: string,
  configDir: string,
  env: Record<string, string | undefined>,
): KeyedAccount[] {
  const seen = new Set<string>();
  return list(value, path).map((raw, index) => {
    const entry = object(raw, `${path}[${index}]`);
    const id = str(entry.id, `${path}[${index}].id`);
    if (seen.has(id)) throw new ConfigError(`${path} has duplicate id ${id}`);
    seen.add(id);
    const email = optionalStr(entry.email, `${path}[${index}].email`);
    return {
      id,
      label: optionalStr(entry.label, `${path}[${index}].label`) ?? id,
      key: readSecret(str(entry.keyFile, `${path}[${index}].keyFile`), configDir, env),
      ...(email ? { email } : {}),
    };
  });
}

export function parseConfig(
  raw: unknown,
  configDir: string,
  env: Record<string, string | undefined> = process.env,
): Config {
  const root = object(raw, "config");
  const listen = object(root.listen, "listen");
  const hosts = list(listen.hosts ?? ["127.0.0.1"], "listen.hosts").map((host, i) => str(host, `listen.hosts[${i}]`));
  const port = listen.port ?? 8790;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError("listen.port must be a TCP port");
  }

  let cliproxy: Config["cliproxy"];
  if (root.cliproxy !== undefined) {
    const section = object(root.cliproxy, "cliproxy");
    cliproxy = {
      baseUrl: str(section.baseUrl, "cliproxy.baseUrl"),
      managementKey: readSecret(str(section.managementKeyFile, "cliproxy.managementKeyFile"), configDir, env),
    };
  }

  const minutes = object(root.intervalMinutes, "intervalMinutes");
  const intervalMs = { ...DEFAULT_INTERVAL_MS };
  for (const [provider, value] of Object.entries(minutes)) {
    if (!PROVIDERS.includes(provider as ProviderId)) throw new ConfigError(`intervalMinutes.${provider} is unknown`);
    if (typeof value !== "number" || !(value > 0)) throw new ConfigError(`intervalMinutes.${provider} must be > 0`);
    const id = provider as ProviderId;
    intervalMs[id] = Math.max(MIN_INTERVAL_MS[id], value * MINUTE);
  }

  const retentionDays = root.retentionDays ?? 120;
  if (typeof retentionDays !== "number" || !(retentionDays > 0)) throw new ConfigError("retentionDays must be > 0");

  const database = optionalStr(root.database, "database") ?? join(configDir, "limits.sqlite");
  return {
    hosts,
    port,
    database,
    retentionDays,
    cliproxy,
    claude: discoveredAccounts(object(root.claude, "claude").accounts, "claude.accounts"),
    codex: discoveredAccounts(object(root.codex, "codex").accounts, "codex.accounts"),
    grok: discoveredAccounts(object(root.grok, "grok").accounts, "grok.accounts"),
    opencodeGo: keyedAccounts(root.opencodeGo, "opencodeGo", configDir, env),
    openrouter: keyedAccounts(root.openrouter, "openrouter", configDir, env),
    capy: keyedAccounts(root.capy, "capy", configDir, env).map((keyed, index): CapyAccount => {
      let account: CapyAccount = keyed;
      const entry = object(list(root.capy, "capy")[index], `capy[${index}]`);
      const path = `capy[${index}]`;
      const sessionFile = optionalStr(entry.sessionFile, `${path}.sessionFile`);
      if (sessionFile) account = { ...account, session: capySession(readSecret(sessionFile, configDir, env), `${path}.sessionFile`) };
      if (entry.balanceUsd === undefined && entry.balanceAsOf === undefined) return account;
      const balanceUsd = entry.balanceUsd;
      if (typeof balanceUsd !== "number" || !Number.isFinite(balanceUsd)) throw new ConfigError(`${path}.balanceUsd must be a number`);
      const asOf = Date.parse(str(entry.balanceAsOf, `${path}.balanceAsOf`));
      if (!Number.isFinite(asOf)) throw new ConfigError(`${path}.balanceAsOf must be an ISO date`);
      return { ...account, anchor: { balanceUsd, asOf } };
    }),
    opencode: list(root.opencode, "opencode").map((raw, index) => {
      const path = `opencode[${index}]`;
      const entry = object(raw, path);
      const id = str(entry.id, `${path}.id`);
      if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new ConfigError(`${path}.id may only use letters, digits, - and _`);
      const keyFile = optionalStr(entry.serviceKeyFile, `${path}.serviceKeyFile`);
      const email = optionalStr(entry.email, `${path}.email`);
      return {
        id,
        label: optionalStr(entry.label, `${path}.label`) ?? id,
        ...(keyFile ? { serviceKey: readSecret(keyFile, configDir, env) } : {}),
        ...(email ? { email } : {}),
      };
    }),
    stateDirectory: dirname(database),
    intervalMs,
  };
}

export function loadConfig(path: string, env: Record<string, string | undefined> = process.env): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new ConfigError(`cannot read config ${path}`);
  }
  return parseConfig(raw, dirname(path), env);
}
