import type { BalanceAnchor, Config, DiscoveredAccountConfig } from "../config.ts";
import type { Fetch } from "../http.ts";
import type { AuthFile } from "../parse.ts";
import { fetchCapy } from "./capy.ts";
import { fetchClaude } from "./claude.ts";
import { CliProxy } from "./cliproxy.ts";
import { fetchCodex } from "./codex.ts";
import { fetchGrok } from "./grok.ts";
import type { OpencodeWorkspace } from "./opencode-console.ts";
import { fetchOpenCodeGo, fetchOpenRouter } from "./static-keys.ts";
import type { Account, ProviderId } from "./types.ts";

export interface Discovery {
  accounts: Account[];
  /** Providers whose account list could not be refreshed; the caller keeps their previous accounts. */
  failed: { providers: ProviderId[]; message: string }[];
}

/** Default titles for CLIProxyAPI accounts; the email goes underneath instead. */
const CPA_TITLES = { claude: "Claude", codex: "Codex", grok: "SuperGrok" } as const;

function overrides(file: AuthFile, configured: Record<string, DiscoveredAccountConfig>): DiscoveredAccountConfig {
  return (file.email && configured[file.email]) || configured[file.name] || {};
}

/**
 * Claude, Codex and Grok (xai) accounts come from CLIProxyAPI's auth files; everything else from config.
 * OpenCode workspaces are long-lived (each owns its token refresh), so the caller passes them in.
 */
export async function discoverAccounts(
  config: Config,
  workspaces: Map<string, OpencodeWorkspace>,
  fetchImpl: Fetch = fetch,
  storedAnchor: (accountId: string) => BalanceAnchor | null = () => null,
): Promise<Discovery> {
  const accounts: Account[] = [];
  const failed: Discovery["failed"] = [];

  if (config.cliproxy) {
    const cliproxy = new CliProxy(config.cliproxy.baseUrl, config.cliproxy.managementKey, fetchImpl);
    try {
      for (const file of await cliproxy.authFiles()) {
        if (file.disabled) continue;
        const key = file.email ?? file.name;
        if (file.provider === "claude") {
          const extra = overrides(file, config.claude);
          if (extra.disabled) continue;
          accounts.push({
            id: `claude:${key}`,
            provider: "claude",
            label: extra.label ?? CPA_TITLES.claude,
            email: file.email ?? null,
            poll: () => fetchClaude(cliproxy, file.authIndex),
          });
        } else if (file.provider === "codex") {
          const extra = overrides(file, config.codex);
          if (extra.disabled) continue;
          const accountId = file.chatgptAccountId ?? extra.chatgptAccountId;
          accounts.push({
            id: `codex:${key}`,
            provider: "codex",
            label: extra.label ?? CPA_TITLES.codex,
            email: file.email ?? null,
            poll: () => fetchCodex(cliproxy, file.authIndex, accountId),
          });
        } else if (file.provider === "xai") {
          const extra = overrides(file, config.grok);
          if (extra.disabled) continue;
          accounts.push({
            id: `grok:${key}`,
            provider: "grok",
            label: extra.label ?? CPA_TITLES.grok,
            email: file.email ?? null,
            poll: () => fetchGrok(cliproxy, file.authIndex),
          });
        }
      }
    } catch (error) {
      failed.push({ providers: ["claude", "codex", "grok"], message: error instanceof Error ? error.message : "failed" });
    }
  }

  for (const { id, label, key, email } of config.opencodeGo) {
    accounts.push({ id: `opencode-go:${id}`, provider: "opencode-go", label, email: email ?? null, poll: () => fetchOpenCodeGo(fetchImpl, key) });
  }
  for (const { id, label, key, email } of config.openrouter) {
    accounts.push({ id: `openrouter:${id}`, provider: "openrouter", label, email: email ?? null, poll: () => fetchOpenRouter(fetchImpl, key) });
  }
  for (const { id, label, key, email, anchor, session } of config.capy) {
    const accountId = `capy:${id}`;
    // The UI-set anchor wins unless the config one was read later (e.g. after a top-up written into nixfiles).
    const balanceAnchor = () => {
      const stored = storedAnchor(accountId);
      if (!stored) return anchor ?? null;
      return anchor && anchor.asOf > stored.asOf ? anchor : stored;
    };
    // With a web session the billing page has the real balance, so there's no anchor to set.
    accounts.push({
      id: accountId,
      provider: "capy",
      label,
      email: email ?? null,
      poll: () => (session ? fetchCapy(fetchImpl, key, null, Date.now(), session) : fetchCapy(fetchImpl, key, balanceAnchor())),
      ...(session ? {} : { balanceAnchor }),
    });
  }
  for (const { id, label, email } of config.opencode) {
    const workspace = workspaces.get(id);
    if (!workspace) continue;
    accounts.push({
      id: `opencode:${id}`,
      provider: "opencode",
      label,
      // The console reports the logged-in user's email; config fills in for service-key-only workspaces.
      get email() {
        return workspace.email ?? email ?? null;
      },
      poll: () => workspace.fetchObservation(),
    });
  }

  return { accounts, failed };
}
