import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppContext } from "../app/context.js";
import type { Hub } from "../app/hub.js";
import { DomainError } from "../domain/errors.js";
import { AGENT_TOOLS, invokeTool, readAgentInstructions, type ToolDef } from "../tools/registry.js";

export const MCP_SERVER_NAME = "longe";
export const INSTRUCTIONS_URI = "longe://agent-instructions";

const INSTRUCTIONS =
  "longe tracks your work in this repository's .longe/ folder. Start every session with check_answers then list_topics(status=active). Read the resource longe://agent-instructions for the full protocol.";

function toolResult(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

function toolError(err: unknown) {
  const code = err instanceof DomainError ? err.code : "internal";
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: code, message }) }],
  };
}

function registerInstructions(server: McpServer, read: () => Promise<string>): void {
  server.registerResource(
    "agent-instructions",
    INSTRUCTIONS_URI,
    {
      title: "Agent instructions",
      description:
        "How to work with the .longe board (generated into .longe/AGENT-INSTRUCTIONS.md).",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: await read() }],
    }),
  );
}

/** One MCP server for one repo, exposing every agent-facing registry entry (§7.2). */
export function createMcpServer(ctx: AppContext): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );
  for (const tool of AGENT_TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input },
      async (args) => {
        try {
          return toolResult(await invokeTool(ctx, tool, args));
        } catch (err) {
          return toolError(err);
        }
      },
    );
  }
  registerInstructions(server, () => readAgentInstructions(ctx));
  return server;
}

/** Hub variant: same tools plus a required `repo` argument naming a registered repo. */
export function createHubMcpServer(hub: Hub): McpServer {
  const names = () => hub.live().map((r) => r.name);
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: "0.1.0" },
    {
      instructions: `${INSTRUCTIONS} This server hosts several repos; pass repo (one of: ${names().join(", ")}) to every tool.`,
    },
  );
  for (const tool of AGENT_TOOLS) {
    const input = (tool as ToolDef).input.extend({
      repo: z.string().describe(`Registered repo name, one of: ${names().join(", ")}`),
    });
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: input },
      async (args) => {
        const { repo, ...rest } = args as { repo: string } & Record<string, unknown>;
        const entry = hub.get(repo);
        if (!entry?.ctx)
          return toolError(
            new DomainError("not_found", `unknown repo ${repo}; known: ${names().join(", ")}`),
          );
        try {
          return toolResult(await invokeTool(entry.ctx, tool, rest));
        } catch (err) {
          return toolError(err);
        }
      },
    );
  }
  server.registerTool(
    "list_repos",
    {
      description: "List the repos this hub serves. Use the `name` as `repo` in every other tool.",
      inputSchema: z.object({}),
    },
    async () =>
      toolResult({
        repos: hub
          .list()
          .map((r) => ({ name: r.name, root: r.root, title: r.title, available: !r.missing })),
      }),
  );
  registerInstructions(server, async () => {
    const first = hub.live()[0];
    return first ? readAgentInstructions(first.ctx as AppContext) : "";
  });
  return server;
}
