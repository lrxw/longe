import type { ChildProcess } from "node:child_process";
import type { AgentConfig, AgentProvider } from "../../store/config.js";

/** What a provider needs to start a process for this chat. */
export interface ProviderContext {
  root: string;
  config: AgentConfig;
  /** longe's MCP endpoint for this repo, when the HTTP layer knows its port. */
  mcpUrl: string | undefined;
  /** config `ask_in_inbox`: the provider's own way to ask the user is switched off. */
  askInInbox: boolean;
  model: string | undefined;
  /** The stored session to resume. */
  sessionId: string | undefined;
  /** The chat's system prompt (role + board protocol). */
  instructions: string;
}

/**
 * How a provider reports back to the runner. Everything is expressed in the runner's
 * own event model: `ingest` takes one line of Claude Code's stream-json (system init,
 * assistant, result), the rest cover what that format has no event for.
 */
export interface ProviderHooks {
  ingest(streamJsonLine: string): void;
  error(text: string): void;
  /** A tool call, e.g. `longe/ask_question` or `command`. */
  tool(name: string, input: unknown): void;
  /** A message that grows while it streams (same id: replace the text). */
  streamText(id: string, text: string): void;
  /** Models the provider offers, known once its process started. */
  models(list: string[]): void;
  usage(tokens: number, window?: number): void;
}

/** One running provider process as the runner sees it. */
export interface ProviderProcess {
  /** Hands one user message to the process; rejects when it cannot take it. */
  send(text: string): Promise<void>;
  /** One line the process printed on stdout. */
  ingest(line: string): void;
  close(): void;
}

/** A coding agent longe can chat with. One file per provider, listed in index.ts. */
export interface ChatProvider {
  id: AgentProvider;
  /** Shown in the provider select and in handoff messages. */
  label: string;
  /** Binary name when config has no `command`. */
  defaultCommand: string;
  /**
   * Log and session file tag (`<repo><tag>.log`); "" for Claude Code, whose files
   * predate providers.
   */
  fileTag: string;
  /** Fixed model choices; without them the list comes from the process (`hooks.models`). */
  staticModels?: string[];
  /** The result carries `total_cost_usd`; summed per session. */
  tracksCost: boolean;
  /**
   * A message sent mid-turn can be folded into the running turn (two messages, one
   * result); the runner then clears the leftover count after a quiet spell.
   */
  foldsMessages: boolean;
  args(ctx: ProviderContext): string[];
  attach(child: ChildProcess, ctx: ProviderContext, hooks: ProviderHooks): ProviderProcess;
  /** Shell command that continues the session in a terminal. */
  resumeCommand(root: string, command: string, sessionId: string): string;
}

export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_\-./~]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}
