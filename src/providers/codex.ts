import { UpstreamError } from "../http.ts";
import { isRecord, parseCodexCredits, parseCodexPlan, parseCodexUsage } from "../parse.ts";
import type { CliProxy } from "./cliproxy.ts";
import { InactiveError, type Observation } from "./types.ts";

export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/**
 * `chatgptAccountId` selects the ChatGPT workspace. It comes from the auth file's
 * id_token claims (CLIProxyAPI exposes them in auth-files) or from config.
 */
export async function fetchCodex(
  cliproxy: CliProxy,
  authIndex: string,
  chatgptAccountId: string | undefined,
  nowMs = Date.now(),
): Promise<Observation> {
  const header: Record<string, string> = { Authorization: "Bearer $TOKEN$", Accept: "application/json" };
  if (chatgptAccountId) header["ChatGPT-Account-Id"] = chatgptAccountId;
  const payload = await cliproxy.get(authIndex, CODEX_USAGE_URL, header);
  const windows = parseCodexUsage(payload, nowMs);
  const credits = parseCodexCredits(payload);
  if (!windows && credits === undefined) {
    // A ChatGPT account with no Codex plan answers with its plan_type but no rate limits or credits.
    if (isRecord(payload) && typeof payload.plan_type === "string") {
      throw new InactiveError(`No active Codex plan (${payload.plan_type.slice(0, 32)})`, parseCodexPlan(payload, "inactive") ?? undefined);
    }
    throw new UpstreamError("malformed response");
  }
  const plan = parseCodexPlan(payload);
  return { windows: windows ?? [], ...(credits !== undefined ? { credits } : {}), ...(plan ? { plan } : {}) };
}
