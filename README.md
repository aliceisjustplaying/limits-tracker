# limits

limits keeps an eye on your AI plans. Every few minutes it checks how much you have used on Claude, Codex, Grok, OpenCode, OpenRouter and Capy. It saves each reading in a small SQLite file. Then it tells you, as JSON, how close you are to each limit and when it resets. It also guesses when you will run out. There is a simple web page too. The [today](https://github.com/aliceisjustplaying/today-dashboard) app shows this data in its Limits tab.

## What it needs

- **Bun** to run it.
- **CLIProxyAPI** with its management key, for Claude, Codex and Grok. limits never holds those logins itself.
- **An OpenCode login** for each OpenCode workspace (you click Connect on the page), or an OpenCode Go key.
- **An OpenRouter management key**, if you use OpenRouter.
- **A Capy API key**, if you use Capy.

## Settings

limits reads two environment variables:

| Name | What it does |
| --- | --- |
| `LIMITS_CONFIG` | Path to your JSON config file |
| `CREDENTIALS_DIRECTORY` | Optional folder for key files (systemd sets it) |

Everything else lives in the JSON file. Copy `config.example.json` to start. Secrets never go in it: you point to a file that holds each key.

| Key | Default | What it does |
| --- | --- | --- |
| `listen.hosts` | `["127.0.0.1"]` | Addresses to listen on. There is no login, so keep it private |
| `listen.port` | `8790` | Port to listen on |
| `database` | `limits.sqlite` next to the config | Path to the SQLite file |
| `retentionDays` | `120` | How long to keep old readings |
| `cliproxy.baseUrl` | | Where CLIProxyAPI runs, like `http://localhost:8317` |
| `cliproxy.managementKeyFile` | | File with the CLIProxyAPI management key |
| `claude.accounts`, `codex.accounts`, `grok.accounts` | | Optional label, `disabled` or Codex `chatgptAccountId`, by email |
| `opencode` | `[]` | OpenCode workspaces: `{ id, label }` |
| `opencodeGo` | `[]` | OpenCode Go keys: `{ id, label, keyFile }` |
| `openrouter` | `[]` | OpenRouter keys: `{ id, label, keyFile }` |
| `capy` | `[]` | Capy keys: `{ id, label, keyFile }`, plus `sessionFile` or `balanceUsd` and `balanceAsOf` |
| `intervalMinutes` | per provider | How often to check each provider |

## Run it

```sh
bun install
cp config.example.json config.local.json   # edit it
LIMITS_CONFIG=config.local.json bun run start
```

Then open http://127.0.0.1:8790. The data is at `/api/summary`. To run the checks, use `bun test` and `bun run typecheck`.

`docs/REFERENCE.md` has the full details: every provider, the API, how the guesses work and how the OpenCode login works.

## Credits

The response parsers in `src/parse.ts` are ported from [pi-usage](https://github.com/aliceisjustplaying/pi-usage).

## License

MIT. See `LICENSE`.

Easiest way to set it up: point your coding agent at this README.
