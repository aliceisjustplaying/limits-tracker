import type { BalanceAnchor, CapySession } from "../config.ts";
import { type Fetch, UpstreamError, requestJson } from "../http.ts";
import { type CapyBilling, isRecord, parseCapyBilling, parseCapyUsage } from "../parse.ts";
import type { Observation } from "./types.ts";

export const CAPY_USAGE_URL = "https://api.capy.ai/api/v1/usage";
/** The web app's own API; it takes a Clerk session token, not an org API key. */
export const CAPY_APP_API = "https://api.capy.ai/app";
export const CAPY_SESSION_EXPIRED = "Capy session expired, sign in again";

/**
 * The billing page's data, read with your capy.ai web login: mint a 60-second Clerk token from the long-lived
 * `__client` cookie, then fetch `/app/orgs/:orgId/billing`. Neither the cookie nor the token is ever logged;
 * failures carry only a status.
 */
export async function fetchCapyBilling(fetchImpl: Fetch, session: CapySession): Promise<CapyBilling> {
  const expired = (error: unknown) => error instanceof UpstreamError && (error.status === 401 || error.status === 404);
  let minted: unknown;
  try {
    minted = await requestJson(fetchImpl, `${session.clerkOrigin}/v1/client/sessions/${session.sessionId}/tokens`, {
      method: "POST",
      headers: { Cookie: `__client=${session.clientCookie}`, Origin: "https://capy.ai", Accept: "application/json" },
    });
  } catch (error) {
    throw expired(error) ? new UpstreamError(CAPY_SESSION_EXPIRED) : error;
  }
  const jwt = isRecord(minted) && typeof minted.jwt === "string" ? minted.jwt : undefined;
  if (!jwt) throw new UpstreamError("malformed Clerk token response");
  let body: unknown;
  try {
    body = await requestJson(fetchImpl, `${CAPY_APP_API}/orgs/${session.orgId}/billing`, {
      headers: { Authorization: `Bearer ${jwt}`, Accept: "application/json" },
    });
  } catch (error) {
    throw error instanceof UpstreamError && error.status === 401 ? new UpstreamError(CAPY_SESSION_EXPIRED) : error;
  }
  const billing = parseCapyBilling(body);
  if (!billing) throw new UpstreamError("malformed billing response");
  return billing;
}

/** The UTC calendar month containing `now`: the window month-to-date spend and its $/day are measured over. */
export function currentMonth(now: number): { start: number; end: number } {
  const date = new Date(now);
  return {
    start: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
    end: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
  };
}

async function usage(fetchImpl: Fetch, key: string, from: number, to: number) {
  const url = `${CAPY_USAGE_URL}?from=${encodeURIComponent(new Date(from).toISOString())}&to=${encodeURIComponent(new Date(to).toISOString())}`;
  const parsed = parseCapyUsage(
    await requestJson(fetchImpl, url, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } }),
    "month",
  );
  if (!parsed) throw new UpstreamError("malformed response");
  return parsed;
}

/**
 * Month-to-date spend for the key's organization. `totals` is what was billed to Capy credits; models that
 * ran on a connected subscription or key (`unbilled`) are outside it, so "total" adds them back.
 *
 * With a web `session`, the balance, plan and credit sources come from the billing page's API. Without one,
 * the public API has no balance route, so the credits left are derived: the balance you read off
 * Settings → Billing (`anchor`) minus what was billed to credits since she read it.
 */
export async function fetchCapy(
  fetchImpl: Fetch,
  key: string,
  anchor: BalanceAnchor | null = null,
  now = Date.now(),
  session?: CapySession,
): Promise<Observation> {
  const { start, end } = currentMonth(now);
  const month = await usage(fetchImpl, key, start, now);
  const connectedUsd = month.models.filter((m) => m.plan === "connected").reduce((sum, m) => sum + m.costUsd, 0);
  const observation: Observation = {
    windows: [],
    spend: { creditsUsd: month.totalUsd, totalUsd: month.totalUsd + connectedUsd, periodStart: start, periodEnd: end },
    models: month.models,
  };
  if (session) {
    const billing = await fetchCapyBilling(fetchImpl, session);
    return { ...observation, billing, ...(billing.unlimited ? {} : { balanceUsd: billing.remainingUsd }) };
  }
  if (!anchor) return observation;

  const spentSince = anchor.asOf >= now ? 0 : anchor.asOf === start ? month.totalUsd : (await usage(fetchImpl, key, anchor.asOf, now)).totalUsd;
  const balanceUsd = Math.round((anchor.balanceUsd - spentSince) * 100) / 100;
  return { ...observation, balanceUsd: Math.max(0, balanceUsd) };
}
