import { exec } from "node:child_process";
import { serve } from "@hono/node-server";
import { closeAppContext, createAppContext } from "../app/context.js";
import { createHttpApp } from "../http/app.js";
import { desktopNotifier } from "../notify/notifier.js";

export interface ServeOptions {
  repo: string;
  port: number;
  open: boolean;
}

export async function runServe(opts: ServeOptions): Promise<void> {
  const ctx = await createAppContext(opts.repo, { notify: desktopNotifier });
  const app = createHttpApp(ctx);
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: opts.port }, (info) => {
    const url = `http://127.0.0.1:${info.port}`;
    process.stdout.write(`longe serving ${ctx.root}\n  UI   ${url}\n`);
    if (opts.open) openBrowser(url);
  });
  const shutdown = async () => {
    server.close();
    await closeAppContext(ctx);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {});
}
