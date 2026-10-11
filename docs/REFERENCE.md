# limits: full reference

A small service that polls usage limits and balances for every AI subscription and API account, keeps the history in SQLite, and serves the current state with projections as JSON (plus a minimal page). It runs next to CLIProxyAPI; `today` reads it over loopback.

Bun + TypeScript + Hono + `bun:sqlite`. The only runtime dependency is `hono`.

## Providers

| Provider | Source | Accounts | Default / minimum poll |
|---|---|---|---|
| Claude | `api.anthropic.com/api/oauth/usage` through CLIProxyAPI `POST /v0/management/api-call` (`$TOKEN$`) | Every `claude` auth file in CLIProxyAPI | 5 min / 5 min |
| Codex | `chatgpt.com/backend-api/wham/usage` through the same route; also parses credits | Every `codex` auth file, one entry per account | 2 min / 1 min |
| Grok | `cli-chat-proxy.grok.com/v1/user`, then `/v1/billing?format=credits` (with the returned `x-userid`), through the same route: credit usage % and period end | Every `xai` auth file | 5 min / 5 min |
| OpenCode workspace | OpenCode console API with a device-flow user token: Zen balance (`/console/api/billing/status`), Go $ meters (`/console/api/go/status`), per-model usage for 24h/7d/30d (`/console/api/usage/models`) | One device login per workspace, from config | 5 min / 2 min |
| OpenCode Go (key) | `opencode.ai/zen/go/v1/usage` with a static Go key: percent only | One key per workspace, from config | 2 min / 1 min |
| Capy | `api.capy.ai/api/v1/usage?from&to` with an org API key (Bearer): month-to-date spend. The API has no balance, plan grant or limit, so dollars left are derived from a balance you set (see below) | One key per org, from config | 15 min / 5 min |
| OpenRouter | `openrouter.ai/api/v1/credits` with a management key; balance = `total_credits − total_usage` | One key per account, from config | 15 min / 15 min |

limits never holds or refreshes a Claude, Codex or Grok OAuth token: CLIProxyAPI owns them and substitutes `$TOKEN$` itself. limits only holds the CLIProxyAPI management key. New Claude, Codex or Grok accounts are added in CLIProxyAPI and picked up within five minutes.

**Codex `ChatGPT-Account-Id`.** CLIProxyAPI's `auth-files` listing includes the decoded `id_token` claims for Codex files, including `chatgpt_account_id`, and limits sends that as the header. If an auth file lacks it, set `codex.accounts.<email>.chatgptAccountId` in config. With neither, the header is omitted.

The response parsers in `src/parse.ts` are ported from [pi-usage](https://github.com/aliceisjustplaying/pi-usage).

## OpenCode device login

Each `opencode` workspace needs one device login (RFC 8628). Click **Connect OpenCode** on the page, or:

```sh
curl -s -X POST -H 'X-Limits-Action: login' http://127.0.0.1:8790/api/opencode/<id>/login
# -> {"status":"pending","userCode":"ABCD-EFGH","verificationUrl":"https://opencode.ai/console/device?user_code=…"}
```

Open the URL while signed in to opencode.ai, pick the workspace and authorize. limits polls in the background (`GET /api/opencode/<id>/login` shows progress) and stores the token pair in `opencode-<id>.json` in the database's directory, with mode 0600.

The token lasts 30 days, and its refresh token rotates. Reusing an old refresh token revokes the whole session, so **limits must be the only holder**: don't copy the file anywhere, and don't log the same workspace in from a second limits instance. The service refreshes once fewer than 7 days remain. It shares a single in-flight refresh between callers, and it writes the new pair to disk (temp file, fsync, rename) before using it. If the refresh is rejected (`invalid_grant`) or the token gets a 401, the account shows `device login needed` until you connect it again.

The optional `serviceKeyFile` (an `oc_sk_…` key) is a usage-only fallback for when no device token exists. A `Read only` key reads per-model usage. Go meters need an `All` key, and a 403 is skipped. No service key can read the Zen balance.

## Running

```sh
bun install
cp config.example.json config.local.json   # edit; secret files are referenced, never inlined
LIMITS_CONFIG=config.local.json bun run start
bun test
bun run typecheck
```

## Config

`LIMITS_CONFIG` points at a JSON file (see `config.example.json`). It contains no secrets: each secret is a `*File` path. A relative path resolves against `$CREDENTIALS_DIRECTORY` when set (systemd `LoadCredential`), otherwise against the config file's directory, so sops-nix secrets can be handed in with `LoadCredential=name:/run/secrets/...`.

- `listen.hosts` (default `["127.0.0.1"]`) and `listen.port` (default 8790). One listener per host, e.g. loopback plus the Tailscale address. There is no auth, so never bind a public address.
- `cliproxy.baseUrl`, `cliproxy.managementKeyFile`: enables Claude, Codex and Grok.
- `claude.accounts` / `codex.accounts` / `grok.accounts`: optional per-account settings keyed by the auth file's email (or file name): `label`, `disabled`, and for Codex `chatgptAccountId`. Unlisted accounts are tracked as separate entries titled Claude, Codex or SuperGrok; the auth file's email is reported as `email`.
- `opencode`: OpenCode console workspaces, `{ id, label, serviceKeyFile?, email? }` (see above). The email comes from the device login via `GET /console/api/user`; `email` covers service-key-only workspaces. `id` names the token file, so only letters, digits, `-` and `_` are allowed.
- `opencodeGo`, `openrouter`, `capy`: lists of `{ id, label, keyFile, email? }`. Any may be empty. Their APIs don't expose the account's email, so `email` (optional) is what the summary reports.
- `capy` entries may carry `sessionFile`: a JSON credential `{ clientCookie, sessionId, orgId, clerkOrigin }` from your capy.ai web login (see **Capy balance**). Without it, they may carry `balanceUsd` and `balanceAsOf` (an ISO date or time; a plain date is midnight UTC): the credit balance shown on Settings → Billing at that moment. Both or neither.
- `intervalMinutes`: per-provider overrides, clamped to the minimums above.
- `retentionDays` (default 120): older snapshots are pruned hourly.

## API

`GET /api/summary` returns every account's latest state:

```jsonc
{
  "generatedAt": 1791708094858,
  "errors": [{ "providers": ["claude", "codex"], "message": "HTTP 502" }], // account discovery failures
  "accounts": [{
    "id": "claude:alice@example.com", "provider": "claude", "label": "Claude (personal)",
    "status": "ok",                       // ok | inactive | error | pending (not polled yet)
    "error": null,                        // why the poll failed (status "error" only)
    "notice": null,                       // why it is inactive, or a partial-data note on an ok account
    "lastAttemptAt": 1791708092925, "observedAt": 1791708092925,
    "windows": [{
      "window": "5h", "usedPercent": 62, "resetsAt": 1791715294858,
      "projection": { "percentPerHour": 24, "projectedAtReset": 100, "hitsLimitAt": 1791712594858, "samples": 6 }
    }],
    "credits": null,                      // Codex: { balance, unlimited, burn: { perDay, daysLeft } }
    "balanceUsd": null,                   // OpenRouter, OpenCode Zen, anchored Capy: { balance, burn: { perDay, daysLeft } }
    "email": "a@example.com",           // CLIProxyAPI auth file, OpenCode console login (`api/user`) or config `email`; null when unknown
    "balanceAnchor": null,                // Capy: { balanceUsd, asOf } the balance is derived from, or null until set
    "plan": null,                        // { name, status, renewsAt, canceledAt } as the upstream names it: Claude "Max 20x" (OAuth profile), Codex "Pro" (plan_type), "SuperGrok" (/settings subscription_tier_display), "Go" active/inactive, "Capy Lite" (session billing); null when it doesn't say
    "billing": null,                     // Capy with a session: { remainingUsd, usedUsd, grantedUsd, unlimited, plan: { name, status, canceledAt, renewsAt }, sources: [{ name, kind, grantedUsd, remainingUsd, resetsAt, expiresAt }] }
    "balanceSettable": false,             // true where POST /api/accounts/<id>/balance applies (Capy)
    "spendUsd": null                      // Capy: { credits, total, periodEnd, projection: { credits, total: { perDay, projectedAtEnd } } }
  }]
}
```

Times are epoch milliseconds. On an error the last good windows stay in place, with `status` and `error` set.

**Inactive is not an error.** `status: "inactive"` means the credential works but the subscription behind it has lapsed. Show it neutrally (a plain "inactive" pill); `notice` holds the reason. Any data the poll returned is still recorded; otherwise the last good windows stay. It's set when:

- OpenCode Go returns 403. A bad key is a 401, and the no-plan body is `EntitlementError: OpenCode Go subscription required.`
- Codex answers with a `plan_type` but no rate limits or credits.

Claude has no equivalent mapping yet, because nothing shows what its usage endpoint returns for a lapsed plan. Balances (OpenRouter, Zen, Capy) are never inactive: an empty one is just `balanceUsd.balance: 0` with status `ok` (a derived Capy balance is floored at $0).

Each account is polled independently, so a lapsed Go key never hides the Zen balance. Within an OpenCode console workspace, the Zen balance is the headline. If Go meters or per-model usage fail, the account stays `ok` with a `notice`, and the previous per-model breakdown is kept.

`GET /api/history?account=<id>&window=<label>&since=<ms|ISO>&until=<ms|ISO>&limit=<n>` returns raw snapshots (default: the last 7 days, 5,000 rows, max 20,000). Window labels are `5h`, `Week`, `Month`, Claude's model-scoped weeklies (e.g. `Fable`), plus `credits` and `balance`.

`GET /api/models?account=<id>&range=24h|7d|30d` returns the latest per-model breakdown for OpenCode workspaces, most expensive first: `{account_id, range, plan, provider, model, requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, observed_at}`. `plan` is `go` for Go-plan traffic (`provider: "opencode-go"`), `zen` for Zen credits (`provider: "opencode"`), or the BYOK provider. Ranges start at UTC midnight, following the console's definition. Each poll replaces the previous breakdown.

`POST /api/accounts/<id>/balance` with header `X-Limits-Action: balance` and body `{ "balanceUsd": 58.5, "asOf": "2026-10-11T09:00:00Z" }` (`asOf` optional, defaults to now, never in the future) stores a Capy balance anchor in SQLite, repolls the account and returns `{ account }` in the summary shape. 404 for an unknown account, 400 for one without a derived balance or a bad body. The page's "set balance" / "edit" link calls it.

`POST|GET /api/opencode/<id>/login` (above), `GET /healthz` and `GET /` (the page) round it out.

## Projections

- **Windows:** a least-squares line through `used_percent` for the current reset period. The period is found by walking back from the latest sample while the reset time stays within 15 minutes and usage never rises going backwards (a drop means a reset). It needs 10 minutes of data. `hitsLimitAt` is reported only when 100% lands before `resetsAt`; `projectedAtReset` is where the line ends up at the reset, capped at 100.
- **Money and credits:** spend per day over the last 7 days, counting only decreases so top-ups don't read as negative spend, and `daysLeft` = balance ÷ spend per day. It needs an hour of data.

**Capy spend.** The API's `totals` are what was billed to Capy credits (LLM, image and machine time). Models that ran on a connected subscription or key come back with `unbilled: true` and are *not* included in `totals`. limits reports `credits` = `totals.totalDollars` and `total` = credits plus unbilled model dollars, both for the UTC calendar month, because the API doesn't expose the plan's renewal date. Spend per day is the fitted slope over the month's snapshots (the month-to-date average during the first hour), extended to the month end. Per-model rows go to `/api/models` with `plan` set to `credits` or `connected`.

**Capy balance.** The public API can't report what's left. With a `sessionFile`, limits reads the billing page's own API instead: each poll mints a 60-second Clerk token (`POST <clerkOrigin>/v1/client/sessions/<sessionId>/tokens` with the `__client` cookie), then reads `GET https://api.capy.ai/app/orgs/<orgId>/billing` with it. Credits there are thousandths of a dollar. That gives the balance, used and granted totals, each credit source, and the plan's name and renewal date (`billing`). A 401/404 from the mint, or a 401 from billing, reports `Capy session expired, sign in again`; take a fresh `__client` cookie from a capy.ai login. Neither the cookie nor the token is ever logged. Without a session, limits derives it: remaining = an anchor balance − credits billed since the anchor's time (a second usage call, unless the anchor is the month start). Set the anchor from the page after reading Settings → Billing, or in config for a fresh install; after a top-up, set it again. The newer of the stored and config anchors wins, so a config edit with a later `balanceAsOf` overrides an older UI value. Either way, `burn.perDay` is the month's credits slope from `/api/v1/usage`, and `daysLeft` is remaining ÷ that. A session account takes no anchor (`balanceSettable: false`).

## Storage

`snapshots(account_id, window, used_percent, resets_at, credits, credits_unlimited, balance_usd, observed_at)` gets one row per window per successful poll; credits and balances are rows with window `credits` and `balance`. `accounts` holds each account's last status and attempt time, which is what enforces the poll floors across restarts.

## Adding a source

A provider is a function returning an `Observation` (`{ windows, credits?, balanceUsd?, models? }`), wired into `discoverAccounts` in `src/providers/index.ts`.

The OpenCode console endpoints are its *internal* API, so the parsers treat every field as optional, money and counts as string bigints in microcents (1e8 = $1), and `go/status` as nullable at every level. The Go `meters` block comes from the console bundle and hasn't been seen live yet, so check it the first time a Go subscription is active.
