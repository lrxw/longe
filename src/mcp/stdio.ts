import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeAppContext, createAppContext } from "../app/context.js";
import { desktopNotifier } from "../notify/notifier.js";
import { createMcpServer } from "./server.js";

/** `longe mcp`: MCP over stdio. stdout is the protocol channel; logs go to stderr. */
export async function runMcpStdio(repo: string): Promise<void> {
  const ctx = await createAppContext(repo, { notify: desktopNotifier });
  const server = createMcpServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`longe mcp: serving ${ctx.root} over stdio\n`);
  const shutdown = async () => {
    await server.close().catch(() => {});
    await closeAppContext(ctx);
    process.exit(0);
  };
  process.stdin.on("close", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
