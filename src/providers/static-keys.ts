import { type Fetch, UpstreamError, requestJson } from "../http.ts";
import { GO_INACTIVE, parseOpenCodeGoUsage, parseOpenRouterBalance } from "../parse.ts";
import { InactiveError, type Observation } from "./types.ts";

export const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
export const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";

/** One Go API key per workspace (percent only; the console provider has $ meters and per-model usage). */
export async function fetchOpenCodeGo(fetchImpl: Fetch, key: string): Promise<Observation> {
  let payload: unknown;
  try {
    payload = await requestJson(fetchImpl, OPENCODE_GO_USAGE_URL, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
  } catch (error) {
    // Without an active Go plan the endpoint answers 403
    // {"type":"error","error":{"type":"EntitlementError","message":"OpenCode Go subscription required."}}.
    // A bad key is a 401, so a 403 (or a body naming the entitlement) means the key works but the plan has lapsed.
    if (error instanceof UpstreamError && (error.status === 403 || /EntitlementError|subscription required/i.test(error.body ?? ""))) {
      throw new InactiveError("Go subscription inactive", GO_INACTIVE);
    }
    throw error;
  }
  const windows = parseOpenCodeGoUsage(payload);
  if (!windows) throw new UpstreamError("malformed response");
  return { windows, plan: { name: "Go", status: "active", renewsAt: null, canceledAt: null } };
}

/** Needs an OpenRouter management key: `/credits` is account-wide. */
export async function fetchOpenRouter(fetchImpl: Fetch, key: string): Promise<Observation> {
  const payload = await requestJson(fetchImpl, OPENROUTER_CREDITS_URL, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  const balanceUsd = parseOpenRouterBalance(payload);
  if (balanceUsd === undefined) throw new UpstreamError("malformed response");
  return { windows: [], balanceUsd };
}
