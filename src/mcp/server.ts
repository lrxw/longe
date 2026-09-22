import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../app/context.js";
import { DomainError } from "../domain/errors.js";
import { AGENT_TOOLS, invokeTool, readAgentInstructions } from "../tools/registry.js";

export const MCP_SERVER_NAME = "longe";
export const INSTRUCTIONS_URI = "longe://agent-instructions";

/** One MCP server exposing every agent-facing registry entry (§7.2). */
export function createMcpServer(ctx: AppContext): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: "0.1.0" },
    {
      instructions:
        "longe tracks your work in this repository's .ai/ folder. Start every session with check_answers then list_topics(status=active). Read the resource longe://agent-instructions for the full protocol.",
    },
  );

  for (const tool of AGENT_TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input },
      async (args) => {
        try {
          const result = await invokeTool(ctx, tool, args);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          const code = err instanceof DomainError ? err.code : "internal";
          const message = err instanceof Error ? err.message : String(err);
          return {
            isError: true,
            content: [{ type: "text", text: JSON.stringify({ error: code, message }) }],
          };
        }
      },
    );
  }

  server.registerResource(
    "agent-instructions",
    INSTRUCTIONS_URI,
    {
      title: "Agent instructions",
      description: "How to work with the .ai board (generated into .ai/AGENT-INSTRUCTIONS.md).",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "text/markdown", text: await readAgentInstructions(ctx) },
      ],
    }),
  );

  return server;
}
