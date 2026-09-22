import { exec } from "node:child_process";
import path from "node:path";
import { serve } from "@hono/node-server";
import { createMultiHub, createSingleHub, type Hub } from "../app/hub.js";
import { createHttpApp } from "../http/app.js";
import { desktopNotifier } from "../notify/notifier.js";
import { readRegistry, registerRepo } from "../store/registry.js";
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
  repo: string;
  port: number;
  open: boolean;
  daemon: boolean;
  /** Serve every registered repo from one process. */
  hub: boolean;
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

export async function runServe(opts: ServeOptions): Promise<void> {
  const url = `http://127.0.0.1:${opts.port}`;
  const rootKey = opts.hub ? "*" : opts.repo;
  const label = opts.hub ? "all registered repos (hub mode)" : opts.repo;

  // Already running for this repo? Reuse it instead of failing with EADDRINUSE.
  const existing = await probeHealth(opts.port);
  if (existing) {
    if (existing.root === rootKey) {
      process.stdout.write(`longe already serving ${label} at ${url} (pid ${existing.pid})\n`);
      if (opts.open) openBrowser(url);
      process.exit(0);
    }
    process.stderr.write(
      `Port ${opts.port} is used by longe for ${existing.root === "*" ? "the hub" : existing.root}.\n` +
        `Pick another port: longe serve --port ${opts.port + 1}\n`,
    );
    process.exit(1);
  }

  if (opts.daemon) {
    const rec = await startDaemon({
      root: rootKey,
      port: opts.port,
      extraArgs: opts.hub ? ["--all"] : [],
    });
    await writeRecord(rec);
    const stopHint = opts.hub
      ? "longe stop --all"
      : `longe stop --repo ${JSON.stringify(opts.repo)}`;
    process.stdout.write(
      `longe serving ${label} in the background\n  UI   ${url}\n  pid  ${rec.pid}\n  log  ${rec.log}\n  stop with: ${stopHint}\n`,
    );
    if (opts.open) openBrowser(url);
    process.exit(0);
  }

  let hub: Hub;
  if (opts.hub) {
    const repos = await readRegistry();
    hub = await createMultiHub(
      repos.map((r) => ({ name: r.name, root: r.path })),
      { notify: desktopNotifier },
    );
  } else {
    await registerRepo(opts.repo).catch(() => undefined);
    hub = await createSingleHub(opts.repo, { notify: desktopNotifier });
  }
  const app = createHttpApp(hub, { port: opts.port });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: opts.port }, (info) => {
    const lines = [
      `longe serving ${label}`,
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
    if (opts.hub && hub.list().length === 0) {
      lines.push(
        "  (no repos registered yet: run `longe init` in a project or `longe repos add <dir>`)",
      );
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    void writeRecord({
      pid: process.pid,
      port: info.port,
      root: rootKey,
      startedAt: new Date().toISOString(),
      log: process.env.LONGE_DAEMON ? "(daemon log)" : "(foreground)",
    });
    if (opts.open) openBrowser(url);
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
    await removeRecord(rootKey);
    await hub.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

/** `longe status`: every known serve process and whether it still answers. */
export async function runStatus(): Promise<number> {
  const recs = await listRecords();
  if (recs.length === 0) {
    process.stdout.write("No longe serve processes recorded.\n");
    return 0;
  }
  for (const r of recs) {
    const h = await probeHealth(r.port);
    const state =
      h && h.root === r.root ? "running" : isAlive(r.pid) ? "pid alive, not answering" : "stale";
    if (state === "stale") await removeRecord(r.root);
    const name = r.root === "*" ? "hub" : path.basename(r.root);
    const where = r.root === "*" ? "(all registered repos)" : r.root;
    process.stdout.write(
      `${state.padEnd(24)} ${name.padEnd(24)} http://127.0.0.1:${r.port}  pid ${r.pid}  ${where}\n`,
    );
  }
  return 0;
}

/** `longe stop [--repo]`: stop the serve for one repo (or the hub), or all when --all. */
export async function runStop(repo: string | undefined, all: boolean): Promise<number> {
  const recs = await listRecords();
  const targets = all ? recs : recs.filter((r) => r.root === repo || r.root === "*");
  if (targets.length === 0) {
    process.stdout.write(
      all ? "Nothing to stop.\n" : `No longe serve recorded for ${repo}. Try: longe status\n`,
    );
    return all ? 0 : 1;
  }
  for (const r of targets) {
    const stopped = await stopDaemon(r);
    process.stdout.write(
      `${stopped ? "stopped" : "was not running"}  ${r.root === "*" ? "hub" : r.root} (pid ${r.pid})\n`,
    );
  }
  return 0;
}
