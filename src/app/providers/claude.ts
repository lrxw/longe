import { installHook, removeHook, settingsPath } from "../../cli/hooks.js";
import { type ChatProvider, shellQuote } from "./types.js";

/** Choices offered on the chat page; the config default and a custom id are added when set. */
export const MODEL_CHOICES = ["fable", "opus", "sonnet", "haiku"];

/** `cd <repo> && claude --resume <id>`: continue the chat's session in a terminal. */
export function resumeCommand(root: string, sessionId: string, command = "claude"): string {
  return `cd ${shellQuote(root)} && ${shellQuote(command)} --resume ${shellQuote(sessionId)}`;
}

/**
 * Claude Code: one long-lived `claude -p --input-format stream-json` process takes
 * messages on stdin at any time, also mid-turn; its stdout is already the runner's
 * event format.
 */
export const claude: ChatProvider = {
  id: "claude",
  label: "Claude Code",
  defaultCommand: "claude",
  fileTag: "",
  staticModels: MODEL_CHOICES,
  tracksCost: true,
  foldsMessages: true,
  args(ctx) {
    const { config, mcpUrl } = ctx;
    const mcp = mcpUrl
      ? ["--mcp-config", JSON.stringify({ mcpServers: { longe: { type: "http", url: mcpUrl } } })]
      : [];
    // headless: nobody answers permission prompts, so what the chat may run is listed up front
    const allowed = [...(mcpUrl ? ["mcp__longe"] : []), ...(config.allowed_tools ?? [])];
    return [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      config.permission_mode ?? "acceptEdits",
      ...(ctx.model ? ["--model", ctx.model] : []),
      ...(ctx.sessionId ? ["--resume", ctx.sessionId] : []),
      ...mcp,
      ...(allowed.length > 0 ? ["--allowedTools", ...allowed] : []),
      // questions go to the inbox (ask_question), never to a prompt nobody sees
      ...(ctx.askInInbox ? ["--disallowedTools", "AskUserQuestion"] : []),
      "--append-system-prompt",
      ctx.instructions,
      ...(config.args ?? []),
    ];
  },
  attach(child, _ctx, hooks) {
    return {
      async send(text) {
        const line = JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "text", text }] },
        });
        child.stdin?.write(`${line}\n`);
      },
      ingest: (line) => hooks.ingest(line),
      close() {},
    };
  },
  resumeCommand: (root, command, sessionId) => resumeCommand(root, sessionId, command),
  terminal: {
    what: "AskUserQuestion goes to the inbox (PreToolUse hook)",
    file: settingsPath,
    install: installHook,
    remove: removeHook,
  },
};
