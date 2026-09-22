import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Context, Hono } from "hono";
import type { AppContext } from "../app/context.js";
import type { Hub } from "../app/hub.js";
import { createHubMcpServer, createMcpServer } from "../mcp/server.js";

/**
 * Streamable HTTP MCP (§7.2). Stateless: every request gets a fresh
 * server + transport pair (the SDK requires one transport per connection), and
 * responses are plain JSON so nothing outlives the request.
 *
 * With `resolve`, the server is scoped to one repo. With `hub`, every tool takes
 * a `repo` argument.
 */
export function mountMcp(
  app: Hono,
  resolve: ((c: Context) => AppContext | undefined) | undefined,
  path: string,
  hub?: Hub,
): void {
  app.all(path, async (c) => {
    let server: ReturnType<typeof createMcpServer>;
    if (hub) server = createHubMcpServer(hub);
    else {
      const ctx = resolve?.(c);
      if (!ctx) return c.json({ error: "unknown or unavailable repo" }, 404);
      server = createMcpServer(ctx);
    }
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    const res = await transport.handleRequest(c.req.raw);
    c.req.raw.signal.addEventListener("abort", () => void server.close().catch(() => {}), {
      once: true,
    });
    return res;
  });
}
