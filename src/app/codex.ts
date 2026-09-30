import type { ChildProcess } from "node:child_process";

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: {
    threadId?: string;
    itemId?: string;
    delta?: string;
    item?: {
      id: string;
      type: string;
      text?: string;
      server?: string;
      tool?: string;
      arguments?: unknown;
      command?: string;
      changes?: unknown;
    };
    tokenUsage?: { last: { totalTokens: number }; modelContextWindow: number | null };
    error?: { message: string };
    turn?: { status: string; error?: { message: string } | null };
  };
  result?: unknown;
  error?: { message: string };
}

export interface CodexCallbacks {
  session(id: string, model: string, models: string[]): void;
  text(id: string, text: string): void;
  tool(name: string, input: unknown): void;
  usage(tokens: number, window?: number): void;
  result(text: string, error: boolean): void;
  error(text: string): void;
}

/** JSON-RPC transport for one Codex app-server process. Turns are serialized. */
export class CodexTransport {
  private nextId = 0;
  private requests = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private threadId = "";
  private dead = false;
  private turn: Promise<void> = Promise.resolve();
  private finishTurn: (() => void) | undefined;
  private texts = new Map<string, string>();
  private lastText = "";

  constructor(
    private child: Pick<ChildProcess, "stdin">,
    private callbacks: CodexCallbacks,
  ) {}

  private write(value: unknown): void {
    if (this.dead || !this.child.stdin?.writable) throw new Error("Codex process is closed");
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, 60_000);
      this.requests.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.requests.delete(id);
        reject(error);
      }
    });
  }

  async initialize(options: {
    root: string;
    sessionId?: string | undefined;
    model?: string | undefined;
    instructions: string;
    sandbox: string;
  }): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "longe", version: "0.1.1" } });
    this.write({ method: "initialized", params: {} });
    const models: string[] = [];
    let cursor: string | undefined;
    do {
      const page = (await this.request("model/list", { ...(cursor ? { cursor } : {}) })) as {
        data: { hidden: boolean; model: string }[];
        nextCursor?: string;
      };
      for (const model of page.data ?? [])
        if (!model.hidden && typeof model.model === "string") models.push(model.model);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const result = (await this.request(options.sessionId ? "thread/resume" : "thread/start", {
      ...(options.sessionId ? { threadId: options.sessionId } : {}),
      cwd: options.root,
      ...(options.model ? { model: options.model } : {}),
      approvalPolicy: "never",
      sandbox: options.sandbox,
      developerInstructions: options.instructions,
    })) as { thread: { id: string }; model: string };
    this.threadId = result.thread.id;
    this.callbacks.session(this.threadId, result.model, models);
  }

  async send(text: string): Promise<void> {
    await this.turn;
    if (this.dead) throw new Error("Codex process is closed");
    this.lastText = "";
    this.texts.clear();
    this.turn = new Promise((resolve) => {
      this.finishTurn = resolve;
    });
    try {
      await this.request("turn/start", {
        threadId: this.threadId,
        input: [{ type: "text", text }],
      });
    } catch (error) {
      this.finishTurn?.();
      this.finishTurn = undefined;
      throw error;
    }
  }

  ingest(line: string): void {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      this.callbacks.error(line);
      return;
    }
    if (msg.id !== undefined && !msg.method) {
      const request = this.requests.get(Number(msg.id));
      if (!request) return;
      clearTimeout(request.timer);
      this.requests.delete(Number(msg.id));
      if (msg.error) request.reject(new Error(msg.error.message));
      else request.resolve(msg.result);
      return;
    }
    // Headless clients never silently grant permissions or leave requests hanging.
    if (msg.id !== undefined && msg.method) {
      this.callbacks.error(
        `Codex requested ${msg.method}; use the longe inbox for questions. Permissions were not granted.`,
      );
      if (msg.method.endsWith("/requestApproval"))
        this.write({ id: msg.id, result: { decision: "decline" } });
      else if (msg.method === "item/tool/requestUserInput")
        this.write({ id: msg.id, result: { answers: {} } });
      else
        this.write({
          id: msg.id,
          error: {
            code: -32601,
            message: "Unsupported by longe headless chat; use longe ask_question",
          },
        });
      return;
    }
    const p = msg.params ?? {};
    if (p.threadId && p.threadId !== this.threadId) return;
    switch (msg.method) {
      case "item/agentMessage/delta": {
        if (!p.itemId || typeof p.delta !== "string") break;
        const text = (this.texts.get(p.itemId) ?? "") + p.delta;
        this.texts.set(p.itemId, text);
        this.lastText = text;
        this.callbacks.text(p.itemId, text);
        break;
      }
      case "item/started": {
        const item = p.item;
        if (item?.type === "mcpToolCall")
          this.callbacks.tool(`${item.server}/${item.tool}`, item.arguments);
        else if (item?.type === "commandExecution")
          this.callbacks.tool("command", { command: item.command });
        else if (item?.type === "fileChange")
          this.callbacks.tool("fileChange", { changes: item.changes });
        break;
      }
      case "item/completed":
        if (p.item?.type === "agentMessage" && typeof p.item.text === "string") {
          this.lastText = p.item.text;
          this.callbacks.text(p.item.id, p.item.text);
        }
        break;
      case "thread/tokenUsage/updated":
        if (!p.tokenUsage) break;
        this.callbacks.usage(
          p.tokenUsage.last.totalTokens,
          p.tokenUsage.modelContextWindow ?? undefined,
        );
        break;
      case "error":
        this.callbacks.error(p.error?.message ?? "Codex error");
        break;
      case "turn/completed":
        if (!p.turn || !this.finishTurn) break;
        this.callbacks.result(
          p.turn.error?.message ?? this.lastText,
          p.turn.status === "failed" || p.turn.status === "interrupted",
        );
        this.finishTurn?.();
        this.finishTurn = undefined;
        break;
    }
  }

  close(): void {
    this.dead = true;
    for (const request of this.requests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Codex process closed"));
    }
    this.requests.clear();
    this.finishTurn?.();
    this.finishTurn = undefined;
  }
}
