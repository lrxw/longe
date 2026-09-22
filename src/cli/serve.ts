import { exec } from "node:child_process";
import path from "node:path";
import { serve } from "@hono/node-server";
import { closeAppContext, createAppContext } from "../app/context.js";
import { createHttpApp } from "../http/app.js";
import { desktopNotifier } from "../notify/notifier.js";
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

  // Already running for this repo? Reuse it instead of failing with EADDRINUSE.
  const existing = await probeHealth(opts.port);
  if (existing) {
    if (existing.root === opts.repo) {
      process.stdout.write(`longe already serving ${opts.repo} at ${url} (pid ${existing.pid})\n`);
      if (opts.open) openBrowser(url);
      process.exit(0);
    }
    process.stderr.write(
      `Port ${opts.port} is used by longe for a different repo (${existing.root}).\n` +
        `Pick another port: longe serve --port ${opts.port + 1}\n`,
    );
    process.exit(1);
  }

  if (opts.daemon) {
    const rec = await startDaemon({ root: opts.repo, port: opts.port });
    await writeRecord(rec);
    process.stdout.write(
      `longe serving ${opts.repo} in the background\n  UI   ${url}\n  pid  ${rec.pid}\n  log  ${rec.log}\n  stop with: longe stop --repo ${JSON.stringify(opts.repo)}\n`,
    );
    if (opts.open) openBrowser(url);
    process.exit(0);
  }

  const ctx = await createAppContext(opts.repo, { notify: desktopNotifier });
  const app = createHttpApp(ctx, { port: opts.port });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: opts.port }, (info) => {
    process.stdout.write(
      `longe serving ${ctx.root}\n  UI    ${url}\n  REST  ${url}/api/v1  (docs: ${url}/api/docs)\n  MCP   ${url}/mcp\n`,
    );
    void writeRecord({
      pid: process.pid,
      port: info.port,
      root: ctx.root,
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
    await removeRecord(ctx.root);
    await closeAppContext(ctx);
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
    process.stdout.write(
      `${state.padEnd(24)} ${path.basename(r.root).padEnd(24)} http://127.0.0.1:${r.port}  pid ${r.pid}  ${r.root}\n`,
    );
  }
  return 0;
}

/** `longe stop [--repo]`: stop the serve for one repo, or all when --all. */
export async function runStop(repo: string | undefined, all: boolean): Promise<number> {
  const recs = await listRecords();
  const targets = all ? recs : recs.filter((r) => r.root === repo);
  if (targets.length === 0) {
    process.stdout.write(
      all ? "Nothing to stop.\n" : `No longe serve recorded for ${repo}. Try: longe status\n`,
    );
    return all ? 0 : 1;
  }
  for (const r of targets) {
    const stopped = await stopDaemon(r);
    process.stdout.write(`${stopped ? "stopped" : "was not running"}  ${r.root} (pid ${r.pid})\n`);
  }
  return 0;
}
