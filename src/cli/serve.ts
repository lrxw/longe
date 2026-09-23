import { exec } from "node:child_process";
import { serve } from "@hono/node-server";
import { createRegistryHub } from "../app/hub.js";
import { createHttpApp } from "../http/app.js";
import { coalescing, desktopNotifier } from "../notify/notifier.js";
import { hasBoardDir, registerRepo } from "../store/registry.js";
import {
  isAlive,
  listRecords,
  probeHealth,
  removeRecord,
  startDaemon,
  stopDaemon,
  writeRecord,
} from "./daemon.js";

export interface ServeOptions {
  /** Repo to register before starting (cwd by default); ignored when it has no .longe/. */
  repo: string;
  port: number;
  open: boolean;
  daemon: boolean;
}

export function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

const HUB = "*";

/**
 * `longe serve`: one hub process per machine, serving every registered repo on
 * one port. Running it inside a project registers that project first, so a hub
 * that is already up picks it up live.
 */
export async function runServe(opts: ServeOptions): Promise<void> {
  const url = `http://127.0.0.1:${opts.port}`;

  let entry: { name: string } | undefined;
  if (await hasBoardDir(opts.repo)) entry = await registerRepo(opts.repo).catch(() => undefined);
  const landing = entry ? `${url}/r/${entry.name}/board` : url;

  // Already running? Reuse it instead of failing with EADDRINUSE.
  const existing = await probeHealth(opts.port);
  if (existing) {
    if (existing.root === HUB) {
      process.stdout.write(
        `longe already running at ${url} (pid ${existing.pid})${entry ? `\n  ${landing}` : ""}\n`,
      );
      if (opts.open) openBrowser(landing);
      process.exit(0);
    }
    process.stderr.write(
      `Port ${opts.port} is used by another longe (${existing.root}). Pick a port: longe serve --port ${opts.port + 1}\n`,
    );
    process.exit(1);
  }

  if (opts.daemon) {
    const rec = await startDaemon({ root: HUB, port: opts.port });
    await writeRecord(rec);
    process.stdout.write(
      `longe running in the background\n  UI   ${landing}\n  pid  ${rec.pid}\n  log  ${rec.log}\n  stop with: longe stop\n`,
    );
    if (opts.open) openBrowser(landing);
    process.exit(0);
  }

  const hub = await createRegistryHub({ notify: coalescing(desktopNotifier), drivesChat: true });
  const app = createHttpApp(hub, { port: opts.port });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: opts.port }, (info) => {
    const lines = [
      "longe serving all registered repos",
      `  UI    ${url}`,
      `  REST  ${url}/api/v1  (docs: ${url}/api/docs)`,
      `  MCP   ${url}/mcp`,
    ];
    for (const r of hub.list()) {
      lines.push(
        r.missing
          ? `  missing ${r.name.padEnd(20)} ${r.root}  (${r.missing})`
          : `  repo    ${r.name.padEnd(20)} ${r.root}  ${url}${hub.base(r.name)}/board`,
      );
    }
    if (hub.list().length === 0) {
      lines.push(
        "  (no repos registered yet: run `longe init` in a project, or `longe repos add <dir>`)",
      );
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    void writeRecord({
      pid: process.pid,
      port: info.port,
      root: HUB,
      startedAt: new Date().toISOString(),
      log: process.env.LONGE_DAEMON ? "(daemon log)" : "(foreground)",
    });
    if (opts.open) openBrowser(landing);
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      process.stderr.write(
        `Port ${opts.port} is already in use on 127.0.0.1.\n` +
          `Something other than longe is listening there. Pick a port:\n  longe serve --port ${opts.port + 1}\n`,
      );
      process.exit(1);
    }
    throw err;
  });
  const shutdown = async () => {
    server.close();
    await removeRecord(HUB);
    await hub.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

/** `longe status`: the hub process, if any, and the repos it serves. */
export async function runStatus(): Promise<number> {
  const recs = await listRecords();
  if (recs.length === 0) {
    process.stdout.write("longe is not running. Start it with: longe serve -d\n");
    return 0;
  }
  for (const r of recs) {
    const h = await probeHealth(r.port);
    const state = h ? "running" : isAlive(r.pid) ? "pid alive, not answering" : "stale";
    if (state === "stale") {
      await removeRecord(r.root);
      continue;
    }
    process.stdout.write(`${state}  http://127.0.0.1:${r.port}  pid ${r.pid}\n`);
    for (const repo of h?.repos ?? []) {
      process.stdout.write(
        `  ${repo.missing ? "missing" : "repo   "} ${repo.name.padEnd(20)} ${repo.root}\n`,
      );
    }
  }
  return 0;
}

/** `longe stop`: stop the hub. */
export async function runStop(): Promise<number> {
  const recs = await listRecords();
  if (recs.length === 0) {
    process.stdout.write("longe is not running.\n");
    return 0;
  }
  for (const r of recs) {
    const stopped = await stopDaemon(r);
    process.stdout.write(`${stopped ? "stopped" : "was not running"} (pid ${r.pid})\n`);
  }
  return 0;
}
