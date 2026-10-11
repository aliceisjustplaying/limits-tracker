import { UpstreamError } from "../http.ts";
import { parseAnthropicUsage, parseClaudePlan } from "../parse.ts";
import type { CliProxy } from "./cliproxy.ts";
import type { Observation } from "./types.ts";

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
// The usage endpoint puts requests without a Claude Code User-Agent in a much stricter 429 bucket.
const CLAUDE_CODE_USER_AGENT = "claude-code/2.1.285";

export async function fetchClaude(cliproxy: CliProxy, authIndex: string): Promise<Observation> {
  const headers = {
    Authorization: "Bearer $TOKEN$",
    "anthropic-beta": "oauth-2025-04-20",
    "User-Agent": CLAUDE_CODE_USER_AGENT,
    Accept: "application/json",
  };
  const windows = parseAnthropicUsage(await cliproxy.get(authIndex, CLAUDE_USAGE_URL, headers));
  if (!windows) throw new UpstreamError("malformed response");
  // The plan is a label, so a failed profile read leaves the last known one rather than failing the poll.
  const plan = parseClaudePlan(await cliproxy.get(authIndex, CLAUDE_PROFILE_URL, headers).catch(() => null));
  return { windows, ...(plan ? { plan } : {}) };
}
