import { UpstreamError } from "../http.ts";
import { parseGrokPlan, parseGrokUsage, parseGrokUserId } from "../parse.ts";
import type { CliProxy } from "./cliproxy.ts";
import type { Observation } from "./types.ts";

export const GROK_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const GROK_CLIENT_VERSION = "1.0.3";

function grokHeaders(userId?: string): Record<string, string> {
  return {
    Authorization: "Bearer $TOKEN$",
    Accept: "application/json",
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-grok-client-version": GROK_CLIENT_VERSION,
    "x-grok-client-mode": "headless",
    ...(userId ? { "x-userid": userId } : {}),
  };
}

/** Identity first (`/user` gives the id billing needs), then credit usage and the plan from `/settings`; all as the CLIProxyAPI xai credential. */
export async function fetchGrok(cliproxy: CliProxy, authIndex: string): Promise<Observation> {
  const userId = parseGrokUserId(await cliproxy.get(authIndex, `${GROK_BASE_URL}/user`, grokHeaders()));
  if (!userId) throw new UpstreamError("identity unavailable");
  const windows = parseGrokUsage(await cliproxy.get(authIndex, `${GROK_BASE_URL}/billing?format=credits`, grokHeaders(userId)));
  if (!windows) throw new UpstreamError("malformed response");
  // The plan is a label, so a failed settings read leaves the last known one rather than failing the poll.
  const plan = parseGrokPlan(await cliproxy.get(authIndex, `${GROK_BASE_URL}/settings`, grokHeaders(userId)).catch(() => null));
  return { windows, ...(plan ? { plan } : {}) };
}
