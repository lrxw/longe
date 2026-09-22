import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Hono } from "hono";
import type { AppContext } from "../app/context.js";
import { createMcpServer } from "../mcp/server.js";

/**
 * Streamable HTTP MCP at /mcp (§7.2). Stateless: every request gets a fresh
 * server + transport pair (the SDK requires one transport per connection), and
 * responses are plain JSON so nothing outlives the request. Local single-user
 * tool, so no session bookkeeping.
 */
export function mountMcp(app: Hono, ctx: AppContext, path = "/mcp"): void {
  app.all(path, async (c) => {
    const server = createMcpServer(ctx);
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    const res = await transport.handleRequest(c.req.raw);
    // tear down once the client has gone away; the JSON body is already complete
    c.req.raw.signal.addEventListener("abort", () => void server.close().catch(() => {}), {
      once: true,
    });
    return res;
  });
}
