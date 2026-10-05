import { AcpTransport, permissionPolicy } from "../acp.js";
import { type ChatProvider, shellQuote } from "./types.js";

/**
 * opencode (https://opencode.ai), run as `opencode acp`: the Agent Client Protocol over
 * stdio (see ../acp.ts). It uses your local opencode login, config, models and AGENTS.md.
 * longe's MCP server is passed per session; permission requests are answered by
 * `agent.permission_mode` (default acceptEdits: reads and edits, no shell commands
 * unless opencode's own permission config allows them without asking).
 */
export const opencode: ChatProvider = {
  id: "opencode",
  label: "opencode",
  defaultCommand: "opencode",
  fileTag: ".opencode",
  tracksCost: false,
  foldsMessages: false,
  args: ({ config }) => ["acp", ...(config.args ?? [])],
  attach(child, ctx, hooks) {
    const transport = new AcpTransport(
      child,
      {
        session: (id, model, models) => {
          hooks.models(models);
          hooks.ingest(
            JSON.stringify({ type: "system", subtype: "init", session_id: id, model: model ?? "" }),
          );
        },
        text: (id, text) => hooks.streamText(id, text),
        tool: (name, input) => hooks.tool(name, input),
        result: (text, error) =>
          hooks.ingest(JSON.stringify({ type: "result", result: text, is_error: error })),
        error: (text) => hooks.error(text),
      },
      permissionPolicy(ctx.config.permission_mode),
    );
    const ready = transport.initialize({
      root: ctx.root,
      sessionId: ctx.sessionId,
      model: ctx.model,
      mcpUrl: ctx.mcpUrl,
      instructions: ctx.instructions,
    });
    // send() observes the failure; keep initialization from becoming an unhandled rejection
    void ready.catch(() => {});
    return {
      async send(text) {
        await ready;
        await transport.send(text);
      },
      ingest: (line) => transport.ingest(line),
      close: () => transport.close(),
    };
  },
  resumeCommand: (root, command, sessionId) =>
    `cd ${shellQuote(root)} && ${shellQuote(command)} --session ${shellQuote(sessionId)}`,
};
