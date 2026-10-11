import { loadConfig } from "./config.ts";
import { Store } from "./db.ts";
import { Poller } from "./poller.ts";
import { join } from "node:path";
import { discoverAccounts } from "./providers/index.ts";
import { OpencodeWorkspace, TokenFile } from "./providers/opencode-console.ts";
import { createApp } from "./server.ts";
import { buildSummary } from "./summary.ts";

const config = loadConfig(process.env.LIMITS_CONFIG ?? "config.json");
const store = new Store(config.database);
const log = (message: string) => console.error(`[limits] ${message}`);
const workspaces = new Map(
  config.opencode.map((w) => [w.id, new OpencodeWorkspace(new TokenFile(join(config.stateDirectory, `opencode-${w.id}.json`)), w.serviceKey)]),
);

const poller = new Poller({
  store,
  discover: () => discoverAccounts(config, workspaces, fetch, (id) => store.anchor(id)),
  intervalMs: config.intervalMs,
  retentionMs: config.retentionDays * 24 * 3_600_000,
  log,
});
poller.start();

const app = createApp({
  store,
  workspaces,
  accounts: () => poller.accounts,
  pollNow: (id) => poller.pollNow(id),
  summary: () => buildSummary(store, poller.accounts, poller.errors),
});
for (const hostname of config.hosts) {
  Bun.serve({ hostname, port: config.port, fetch: app.fetch });
  log(`listening on http://${hostname}:${config.port}`);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    poller.stop();
    store.close();
    process.exit(0);
  });
}
