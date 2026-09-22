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
  const app = createHttpApp(ctx, { port: opts.port });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: opts.port }, (info) => {
    const url = `http://127.0.0.1:${info.port}`;
    process.stdout.write(
      `longe serving ${ctx.root}\n  UI    ${url}\n  REST  ${url}/api/v1  (docs: ${url}/api/docs)\n  MCP   ${url}/mcp\n`,
    );
    if (opts.open) openBrowser(url);
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      process.stderr.write(
        `Port ${opts.port} is already in use on 127.0.0.1.\n` +
          `Another longe serve (or something else) is listening there. Stop it or pick a port:\n` +
          `  longe serve --port ${opts.port + 1}\n`,
      );
      process.exit(1);
    }
    throw err;
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
