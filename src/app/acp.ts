import type { ChildProcess } from "node:child_process";
import { packageVersion } from "../cli/args.js";

/**
 * Client side of the Agent Client Protocol (https://agentclientprotocol.com): JSON-RPC
 * 2.0, one JSON object per line on the agent's stdin/stdout. opencode speaks it with
 * `opencode acp`, and other agents do too (Gemini CLI, adapters for Claude and Codex),
 * so this transport is not tied to one provider.
 *
 * longe offers no client file system or terminal (the agent uses its own tools), passes
 * longe's MCP server in `session/new` / `session/load`, and answers permission requests
 * headlessly by a policy (see PermissionPolicy). Turns are serialized: `session/prompt`
 * resolves when the turn ends.
 */

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
}

interface ToolCallInfo {
  toolCallId?: string;
  title?: string;
  kind?: string;
  rawInput?: unknown;
}

interface PermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

export interface AcpCallbacks {
  /** A session was created or loaded; models the agent offers, when it says so. */
  session(id: string, model: string | undefined, models: string[]): void;
  /** Streaming text of the agent's current message (cumulative per message id). */
  text(id: string, text: string): void;
  tool(name: string, input: unknown): void;
  /** The turn ended; error when it stopped for another reason than end_turn. */
  result(text: string, error: boolean): void;
  error(text: string): void;
}

/** Which tool calls longe allows when the agent asks (nobody can be asked in a headless run). */
export type PermissionPolicy = (tool: ToolCallInfo) => boolean;

/** `acceptEdits` (default): read, search, edit, fetch; never commands. `bypassPermissions`: all. */
export function permissionPolicy(mode: string | undefined): PermissionPolicy {
  if (mode === "bypassPermissions") return () => true;
  const kinds =
    mode === "plan" || mode === "default"
      ? new Set(["read", "search", "think", "fetch"])
      : new Set(["read", "search", "think", "fetch", "edit", "switch_mode"]);
  // longe's own MCP tools are always allowed, like mcp__longe for Claude Code
  return (tool) =>
    kinds.has(tool.kind ?? "") || /(^|[^a-z])longe([^a-z]|$)/i.test(tool.title ?? "");
}

export interface AcpSessionOptions {
  root: string;
  sessionId?: string | undefined;
  model?: string | undefined;
  /** longe's MCP endpoint for this repo, passed to the agent as an HTTP MCP server. */
  mcpUrl?: string | undefined;
  /**
   * The chat's role and board protocol. ACP has no system prompt, so a new session gets
   * it as the first block of its first prompt; a loaded session has it already.
   */
  instructions?: string | undefined;
}

export class AcpTransport {
  private nextId = 0;
  private requests = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }
  >();
  private sessionId = "";
  private dead = false;
  private turn: Promise<void> = Promise.resolve();
  /** `session/load` replays the history as updates: not shown again. */
  private replaying = false;
  private texts = new Map<string, string>();
  private lastText = "";
  private messageSeq = 0;
  /** Sent with the first prompt of a new session (see AcpSessionOptions.instructions). */
  private instructions: string | undefined;

  constructor(
    private child: Pick<ChildProcess, "stdin">,
    private callbacks: AcpCallbacks,
    private allow: PermissionPolicy,
  ) {}

  private write(value: unknown): void {
    if (this.dead || !this.child.stdin?.writable) throw new Error("ACP agent process is closed");
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...(value as object) })}\n`);
  }

  /** `timeoutMs` 0: no timeout (a prompt turn takes as long as it takes). */
  private request(method: string, params: unknown, timeoutMs = 60_000): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.requests.delete(id);
              reject(new Error(`ACP ${method} timed out`));
            }, timeoutMs)
          : undefined;
      this.requests.set(id, { resolve, reject, ...(timer ? { timer } : {}) });
      try {
        this.write({ id, method, params });
      } catch (error) {
        if (timer) clearTimeout(timer);
        this.requests.delete(id);
        reject(error);
      }
    });
  }

  async initialize(options: AcpSessionOptions): Promise<void> {
    const init = (await this.request("initialize", {
      protocolVersion: 1,
      // no fs or terminal: the agent works with its own tools
      clientCapabilities: {},
      clientInfo: { name: "longe", title: "longe", version: packageVersion() },
    })) as { agentCapabilities?: { loadSession?: boolean } };
    const mcpServers = options.mcpUrl
      ? [{ type: "http", name: "longe", url: options.mcpUrl, headers: [] }]
      : [];
    const base = { cwd: options.root, mcpServers };
    let result: { sessionId?: string; models?: AcpModels } | null | undefined;
    if (options.sessionId && init.agentCapabilities?.loadSession) {
      this.replaying = true;
      try {
        result = (await this.request("session/load", {
          ...base,
          sessionId: options.sessionId,
        })) as typeof result;
        this.sessionId = options.sessionId;
      } catch {
        result = undefined; // gone or unreadable: start a new one
      } finally {
        this.replaying = false;
      }
    }
    if (!this.sessionId) {
      result = (await this.request("session/new", base)) as typeof result;
      this.sessionId = result?.sessionId ?? "";
      if (!this.sessionId) throw new Error("ACP agent returned no session id");
      this.instructions = options.instructions;
    }
    const models = (result?.models?.availableModels ?? [])
      .map((m) => m.modelId)
      .filter((m): m is string => typeof m === "string");
    let current = result?.models?.currentModelId;
    if (options.model && options.model !== current) {
      // unstable in ACP; agents without it keep their own default
      await this.request("session/set_model", { sessionId: this.sessionId, modelId: options.model })
        .then(() => {
          current = options.model;
        })
        .catch(() => this.callbacks.error(`The agent did not switch to model ${options.model}.`));
    }
    this.callbacks.session(this.sessionId, current, models);
  }

  async send(text: string): Promise<void> {
    await this.turn;
    if (this.dead) throw new Error("ACP agent process is closed");
    this.lastText = "";
    this.texts.clear();
    this.messageSeq++;
    let done!: () => void;
    this.turn = new Promise((resolve) => {
      done = resolve;
    });
    const blocks = [
      ...(this.instructions ? [{ type: "text", text: this.instructions }] : []),
      { type: "text", text },
    ];
    this.instructions = undefined; // once per new session
    const prompt = this.request("session/prompt", { sessionId: this.sessionId, prompt: blocks }, 0);
    // the turn runs in the background; send() returns once the message is handed over
    prompt
      .then((r) => {
        const stop = (r as { stopReason?: string } | null)?.stopReason ?? "end_turn";
        this.callbacks.result(
          stop === "end_turn" ? this.lastText : this.lastText || `stopped: ${stop}`,
          stop !== "end_turn" && stop !== "max_turn_requests",
        );
      })
      .catch((e: unknown) =>
        this.callbacks.result(e instanceof Error ? e.message : String(e), true),
      )
      .finally(done);
  }

  /** Stops the running turn; the agent answers the open prompt with `cancelled`. */
  cancel(): void {
    try {
      this.write({ method: "session/cancel", params: { sessionId: this.sessionId } });
    } catch {
      // closed already
    }
  }

  ingest(line: string): void {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch {
      this.callbacks.error(line);
      return;
    }
    // a response to one of our requests
    if (msg.id !== undefined && !msg.method) {
      const request = this.requests.get(Number(msg.id));
      if (!request) return;
      if (request.timer) clearTimeout(request.timer);
      this.requests.delete(Number(msg.id));
      if (msg.error) request.reject(new Error(msg.error.message ?? "ACP error"));
      else request.resolve(msg.result);
      return;
    }
    // a request from the agent: only permission requests are supported
    if (msg.id !== undefined && msg.method) {
      if (msg.method === "session/request_permission") {
        this.answerPermission(msg.id, msg.params ?? {});
        return;
      }
      this.write({
        id: msg.id,
        error: { code: -32601, message: `longe does not support ${msg.method}` },
      });
      return;
    }
    if (msg.method !== "session/update" || this.replaying) return;
    const update = (msg.params?.update ?? {}) as Record<string, unknown>;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.type !== "text" || typeof content.text !== "string") break;
        const id = typeof update.messageId === "string" ? update.messageId : `m${this.messageSeq}`;
        const text = (this.texts.get(id) ?? "") + content.text;
        this.texts.set(id, text);
        this.lastText = text;
        this.callbacks.text(id, text);
        break;
      }
      case "tool_call": {
        const tool = update as ToolCallInfo;
        this.callbacks.tool(tool.title ?? tool.kind ?? "tool", tool.rawInput);
        break;
      }
      default:
        break; // thoughts, plans, tool progress, mode changes: not shown
    }
  }

  private answerPermission(id: number | string, params: Record<string, unknown>): void {
    const tool = (params.toolCall ?? {}) as ToolCallInfo;
    const options = (params.options ?? []) as PermissionOption[];
    const allowed = this.allow(tool);
    const pick = allowed
      ? (options.find((o) => o.kind === "allow_once") ??
        options.find((o) => o.kind === "allow_always"))
      : (options.find((o) => o.kind === "reject_once") ??
        options.find((o) => o.kind === "reject_always"));
    if (!allowed)
      this.callbacks.error(
        `Not allowed in the headless chat: ${tool.title ?? tool.kind ?? "a tool call"}. Allow it in the agent's own permission config, or set agent.permission_mode.`,
      );
    this.write({
      id,
      result: {
        outcome: pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" },
      },
    });
  }

  close(): void {
    this.dead = true;
    for (const request of this.requests.values()) {
      if (request.timer) clearTimeout(request.timer);
      request.reject(new Error("ACP agent process closed"));
    }
    this.requests.clear();
  }
}

interface AcpModels {
  availableModels?: { modelId?: string; name?: string }[];
  currentModelId?: string;
}
