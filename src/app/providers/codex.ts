import { CodexTransport } from "../codex.js";
import { type ChatProvider, shellQuote } from "./types.js";

/**
 * Codex: `codex app-server` speaks JSON-RPC on stdio (see ../codex.ts). Its thread
 * events are translated into the runner's stream-json events here, so idle
 * detection, the inbox reminder and the todo queue work the same as for Claude Code.
 */
export const codex: ChatProvider = {
  id: "codex",
  label: "Codex",
  defaultCommand: "codex",
  fileTag: ".codex",
  tracksCost: false,
  foldsMessages: false,
  args({ config, mcpUrl }) {
    return [
      "app-server",
      // Like Claude's mcp__longe allowlist: the headless chat must be able to
      // use its board without interactive approval. Only our endpoint gets this default.
      ...(mcpUrl
        ? [
            "-c",
            `mcp_servers.longe.url=${JSON.stringify(mcpUrl)}`,
            "-c",
            'mcp_servers.longe.default_tools_approval_mode="approve"',
          ]
        : []),
      ...(config.args ?? []),
    ];
  },
  attach(child, ctx, hooks) {
    const transport = new CodexTransport(child, {
      session: (id, model, models) => {
        hooks.models(models);
        hooks.ingest(JSON.stringify({ type: "system", subtype: "init", session_id: id, model }));
      },
      text: (id, text) => hooks.streamText(id, text),
      tool: (name, input) => hooks.tool(name, input),
      usage: (tokens, window) => hooks.usage(tokens, window),
      result: (text, error) =>
        hooks.ingest(JSON.stringify({ type: "result", result: text, is_error: error })),
      error: (text) => hooks.error(text),
    });
    const ready = transport.initialize({
      root: ctx.root,
      sessionId: ctx.sessionId,
      model: ctx.model,
      instructions: ctx.instructions,
      sandbox: ctx.config.sandbox ?? "workspace-write",
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
    `cd ${shellQuote(root)} && ${shellQuote(command)} resume ${shellQuote(sessionId)}`,
};
