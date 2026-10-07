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
  // start and end of task subagents only; ACP does not forward the child's activity
  reportsSubagents: true,
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
        tool: (name, input, id) => hooks.tool(name, input, id),
        usage: (tokens, window) => hooks.usage(tokens, window),
        subagent: (update) => hooks.subagent(update),
        contextFromPromptUsage: contextFromPromptUsage,
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

/** OpenCode's prompt response describes its last model call, even without a known window. */
function contextFromPromptUsage(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object") return;
  const usage = raw as Record<string, unknown>;
  const counts = [usage.inputTokens, usage.cachedReadTokens ?? 0, usage.cachedWriteTokens ?? 0];
  if (!counts.every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) return;
  const tokens = (counts as number[]).reduce((sum, n) => sum + n, 0);
  return Number.isSafeInteger(tokens) ? tokens : undefined;
}
