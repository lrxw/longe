import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeAppContext, createAppContext } from "../app/context.js";
import { registerRepo } from "../store/registry.js";
import { createMcpServer } from "./server.js";

/** `longe mcp`: MCP over stdio. stdout is the protocol channel; logs go to stderr. */
export async function runMcpStdio(repo: string): Promise<void> {
  // no desktop notifications here: the server (longe serve) sends them, and this
  // process would report the same change a second time
  const ctx = await createAppContext(repo);
  await registerRepo(ctx.root).catch(() => undefined);
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
