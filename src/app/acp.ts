import type { ChildProcess } from "node:child_process";
import { packageVersion } from "../cli/args.js";
import type { SubagentState, SubagentUpdate } from "./subagents.js";

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
  status?: string;
  rawOutput?: unknown;
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
  tool(name: string, input: unknown, id?: string): void;
  /** Current context occupancy and capacity, not cumulative token billing. */
  usage(tokens: number, window?: number): void;
  /** Opt-in provider interpretation; ACP prompt usage is not always context occupancy. */
  contextFromPromptUsage?(usage: unknown): number | undefined;
  /**
   * A subagent started or changed: a tool call whose input names a `subagent_type`
   * (opencode's task tool). Only start and end are known; ACP does not forward the
   * child session's own activity.
   */
  subagent?(update: SubagentUpdate): void;
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
  private initialized = false;
  /** Updates can arrive before session/new or session/load returns. */
  private pendingUsage: { used: number; size: number } | undefined;
  private usageSeenThisTurn = false;
  private toolSeenThisTurn = false;
  private tools = new Map<string, ToolCallInfo>();
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
    let result:
      | { sessionId?: string; models?: AcpModels; configOptions?: unknown }
      | null
      | undefined;
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
        this.pendingUsage = undefined;
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
    let selection = modelOption(result?.configOptions);
    let models =
      selection?.models ??
      (result?.models?.availableModels ?? [])
        .map((m) => m.modelId)
        .filter((m): m is string => typeof m === "string");
    let current = selection?.current ?? result?.models?.currentModelId;
    if (options.model && options.model !== current) {
      try {
        if (selection) {
          const changed = (await this.request("session/set_config_option", {
            sessionId: this.sessionId,
            configId: selection.id,
            value: options.model,
          })) as { configOptions?: unknown } | null;
          selection = modelOption(changed?.configOptions);
          current = selection?.current ?? current;
          models = selection?.models ?? models;
          if (current !== options.model) throw new Error("model selection was not confirmed");
        } else {
          // Legacy ACP agents expose the unstable model API instead.
          await this.request("session/set_model", {
            sessionId: this.sessionId,
            modelId: options.model,
          });
          current = options.model;
        }
      } catch {
        this.callbacks.error(`The agent did not switch to model ${options.model}.`);
      }
    }
    this.callbacks.session(this.sessionId, current, models);
    this.initialized = true;
    if (this.pendingUsage) {
      this.callbacks.usage(this.pendingUsage.used, this.pendingUsage.size || undefined);
      this.pendingUsage = undefined;
    }
  }

  async send(text: string): Promise<void> {
    await this.turn;
    if (this.dead) throw new Error("ACP agent process is closed");
    this.lastText = "";
    this.usageSeenThisTurn = false;
    this.toolSeenThisTurn = false;
    this.tools.clear();
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
        const response = r as { stopReason?: string; usage?: unknown } | null;
        const stop = response?.stopReason ?? "end_turn";
        if (!this.usageSeenThisTurn) {
          const tokens = this.callbacks.contextFromPromptUsage?.(response?.usage);
          if (tokens !== undefined) this.callbacks.usage(tokens);
        }
        const empty = stop === "end_turn" && !this.lastText.trim() && !this.toolSeenThisTurn;
        this.callbacks.result(
          empty
            ? "The agent ended the turn without sending a reply or running any tools. With local models this often means the context window overflowed: raise the model's context length (and set it as the model's limit in the agent's config), then start a new session. Otherwise check the selected model in its own client, or try another model."
            : stop === "end_turn"
              ? this.lastText ||
                "The agent finished its tool calls without sending a written reply."
              : this.lastText || `stopped: ${stop}`,
          empty || (stop !== "end_turn" && stop !== "max_turn_requests"),
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
    if (msg.method !== "session/update") return;
    const update = (msg.params?.update ?? {}) as Record<string, unknown>;
    // Usage is session state, so retain it even while suppressing replayed messages.
    if (update.sessionUpdate === "usage_update") {
      const { used, size } = update;
      if (
        typeof used === "number" &&
        Number.isSafeInteger(used) &&
        used >= 0 &&
        typeof size === "number" &&
        Number.isSafeInteger(size) &&
        size >= 0
      ) {
        this.usageSeenThisTurn = true;
        if (this.initialized) this.callbacks.usage(used, size || undefined);
        else this.pendingUsage = { used, size };
      }
      return;
    }
    if (this.replaying) return;
    switch (update.sessionUpdate) {
      case "config_option_update": {
        const selection = modelOption(update.configOptions);
        if (this.initialized && selection)
          this.callbacks.session(this.sessionId, selection.current, selection.models);
        break;
      }
      case "agent_message_chunk": {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.type !== "text" || typeof content.text !== "string") break;
        const id = typeof update.messageId === "string" ? update.messageId : `m${this.messageSeq}`;
        const text = (this.texts.get(id) ?? "") + content.text;
        this.texts.set(id, text);
        if (!text.trim()) break;
        this.lastText = text;
        this.callbacks.text(id, text);
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        this.toolSeenThisTurn = true;
        const patch = update as ToolCallInfo;
        const id = patch.toolCallId;
        const prior = id ? this.tools.get(id) : undefined;
        if (update.sessionUpdate === "tool_call_update" && !prior && !patch.title && !patch.kind)
          break;
        const tool = { ...prior, ...patch };
        if (id) this.tools.set(id, tool);
        if (id) this.reportSubagent(id, tool);
        if (
          update.sessionUpdate === "tool_call" ||
          patch.title !== undefined ||
          patch.rawInput !== undefined
        )
          this.callbacks.tool(tool.title ?? tool.kind ?? "tool", tool.rawInput, id);
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

  /**
   * opencode's task tool: input `{description, prompt, subagent_type, background?}`; the
   * update's status ends it, and its output says `<task … state="running|completed|error">`
   * (a background task completes the tool call at once while the child still runs).
   */
  private reportSubagent(id: string, tool: ToolCallInfo): void {
    if (!this.callbacks.subagent) return;
    const input = (tool.rawInput ?? {}) as Record<string, unknown>;
    const type = typeof input.subagent_type === "string" ? input.subagent_type : undefined;
    if (!type) return;
    const output = (tool.rawOutput ?? {}) as { output?: unknown; metadata?: unknown };
    const taskState =
      typeof output.output === "string"
        ? /<task\b[^>]*\bstate="([a-z]+)"/.exec(output.output)?.[1]
        : undefined;
    const background = input.background === true || taskState === "running";
    let state: SubagentState = "running";
    if (tool.status === "failed" || taskState === "error") state = "failed";
    else if (tool.status === "completed" && taskState !== "running") state = "done";
    const description =
      typeof input.description === "string" ? input.description : (tool.title ?? "");
    this.callbacks.subagent({
      id,
      type,
      description,
      background,
      state,
      ...(background && state === "running" && tool.status === "completed"
        ? { activity: "runs in the background; opencode does not report its end over ACP" }
        : {}),
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

/** Current ACP uses configOptions; older agents still return models. */
function modelOption(raw: unknown): { id: string; current: string; models: string[] } | undefined {
  if (!Array.isArray(raw)) return;
  const option = raw.find(
    (o) => o?.type === "select" && (o.category === "model" || o.id === "model"),
  );
  if (!option || typeof option.id !== "string" || typeof option.currentValue !== "string") return;
  const choices: unknown[] = Array.isArray(option.options) ? option.options : [];
  const models = choices.flatMap((c) => {
    const choice = c as { value?: unknown; options?: unknown[] } | null;
    const values = Array.isArray(choice?.options) ? choice.options : [choice];
    return values.flatMap((v) => {
      const value = (v as { value?: unknown } | null)?.value;
      return typeof value === "string" ? [value] : [];
    });
  });
  return { id: option.id, current: option.currentValue, models };
}
