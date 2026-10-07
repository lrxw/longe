/**
 * The subagents a chat starts, as the Agents page shows them. Fed with the chat's
 * stream-json lines for Claude Code, or normalized updates from other providers:
 *
 * - **start:** a main-session `tool_use` named `Agent` (`Task` before Claude Code
 *   2.1.63) with `input.subagent_type`, `description`, `run_in_background`;
 * - **activity:** `assistant` messages whose `parent_tool_use_id` is that tool_use id;
 * - **end:** the `tool_result` for that id (`is_error`), or, for background runs, the
 *   system `task_notification` (`status` completed | failed | stopped);
 * - background runs also send `task_started` and `task_progress` (tokens, tool uses).
 *
 * Source: https://code.claude.com/docs/en/agent-sdk/subagents ("Detect subagent
 * invocation") and the Agent SDK's TaskStarted/TaskProgress/TaskNotification messages.
 */

export type SubagentState = "running" | "done" | "failed" | "stopped";

export interface SubagentRun {
  /** The tool_use id that started it (or the task id when only a task event was seen). */
  id: string;
  /** `subagent_type`; `general-purpose` when the call did not name one. */
  type: string;
  name?: string | undefined;
  description: string;
  background: boolean;
  state: SubagentState;
  startedAt: string;
  endedAt?: string | undefined;
  /** The last thing it did: a tool call or the start of a message. */
  activity?: string | undefined;
  /** Tool calls seen so far (or reported by task_progress). */
  tools: number;
  /** Tokens reported by task_progress / task_notification, when there are any. */
  tokens?: number | undefined;
}

/** A provider's observed child state; absent fields leave the previous report intact. */
export type SubagentUpdate = Pick<SubagentRun, "id"> &
  Partial<
    Pick<
      SubagentRun,
      "type" | "name" | "description" | "background" | "state" | "activity" | "tools" | "tokens"
    >
  >;

const MAX_KEPT = 30;
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

type Json = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

export class SubagentTracker {
  private runs = new Map<string, SubagentRun>();
  /** Claude's task id → tool_use id, for background runs. */
  private tasks = new Map<string, string>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Newest first. */
  list(): SubagentRun[] {
    return [...this.runs.values()].reverse().map((r) => ({ ...r }));
  }

  running(): number {
    let n = 0;
    for (const r of this.runs.values()) if (r.state === "running") n++;
    return n;
  }

  /** Providers with their own protocol report normalized state here. */
  update(update: SubagentUpdate): void {
    let run = this.runs.get(update.id);
    if (!run) {
      run = this.add({
        id: update.id,
        type: "agent",
        description: "",
        background: true,
        state: "running",
        startedAt: this.now().toISOString(),
        tools: 0,
      });
    }
    if (update.state === "running" && run.state !== "running") {
      run.startedAt = this.now().toISOString();
      run.endedAt = undefined;
    }
    Object.assign(run, update);
    if (update.activity !== undefined) run.activity = firstLine(update.activity);
    if (update.description !== undefined) run.description = firstLine(update.description);
    if (run.state !== "running" && !run.endedAt) run.endedAt = this.now().toISOString();
    this.prune();
  }

  /** Forget everything (new session). */
  clear(): void {
    this.runs.clear();
    this.tasks.clear();
  }

  /** The process ended: whatever still runs has stopped with it. True when anything changed. */
  stopAll(): boolean {
    let changed = false;
    for (const r of this.runs.values())
      if (r.state === "running") {
        r.state = "stopped";
        r.endedAt = this.now().toISOString();
        changed = true;
      }
    this.prune();
    return changed;
  }

  /** Inside a subagent: its messages are its own, not the main conversation's. */
  static parentOf(msg: Json): string | undefined {
    return str(msg.parent_tool_use_id);
  }

  /** One parsed stream-json message. True when the list changed. */
  ingest(msg: Json): boolean {
    switch (msg.type) {
      case "assistant":
        return this.assistant(msg);
      case "user":
        return this.user(msg);
      case "system":
        return this.system(msg);
      default:
        return false;
    }
  }

  private blocks(msg: Json): Json[] {
    const content = (msg.message as { content?: unknown } | undefined)?.content;
    return Array.isArray(content) ? (content as Json[]) : [];
  }

  private assistant(msg: Json): boolean {
    const parent = SubagentTracker.parentOf(msg);
    let changed = false;
    for (const block of this.blocks(msg)) {
      if (parent) {
        const run = this.runs.get(parent);
        if (run?.state !== "running") continue;
        if (block.type === "tool_use") {
          run.tools++;
          run.activity = `${String(block.name)} ${brief(block.input)}`.trim();
          changed = true;
        } else if (block.type === "text" && str(block.text)?.trim()) {
          run.activity = firstLine(block.text as string);
          changed = true;
        }
        continue;
      }
      if (block.type !== "tool_use" || !SUBAGENT_TOOLS.has(String(block.name))) continue;
      const id = str(block.id);
      if (!id || this.runs.has(id)) continue;
      const input = (block.input ?? {}) as Json;
      this.add({
        id,
        type: str(input.subagent_type) ?? "general-purpose",
        description: str(input.description) ?? "",
        background: input.run_in_background === true,
        state: "running",
        startedAt: this.now().toISOString(),
        tools: 0,
      });
      changed = true;
    }
    return changed;
  }

  private user(msg: Json): boolean {
    let changed = false;
    for (const block of this.blocks(msg)) {
      if (block.type !== "tool_result") continue;
      const run = this.runs.get(str(block.tool_use_id) ?? "");
      if (run?.state !== "running") continue;
      if (block.is_error === true) this.end(run, "failed");
      // a background run answers at once ("started"); its end comes as task_notification
      else if (!run.background) this.end(run, "done");
      else continue;
      changed = true;
    }
    return changed;
  }

  private system(msg: Json): boolean {
    const taskId = str(msg.task_id);
    if (!taskId) return false;
    const toolId = str(msg.tool_use_id) ?? this.tasks.get(taskId);
    let run = toolId ? this.runs.get(toolId) : this.runs.get(taskId);
    if (msg.subtype === "task_started") {
      if (
        msg.task_type !== undefined &&
        msg.task_type !== "local_agent" &&
        msg.task_type !== "remote_agent"
      )
        return false; // a background shell, not an agent
      if (!run && msg.task_type === undefined) return false;
      if (!run) {
        run = this.add({
          id: toolId ?? taskId,
          type: str(msg.subagent_type) ?? "agent",
          description: str(msg.description) ?? "",
          background: msg.is_backgrounded !== false,
          state: "running",
          startedAt: this.now().toISOString(),
          tools: 0,
        });
      }
      if (typeof msg.is_backgrounded === "boolean") run.background = msg.is_backgrounded;
      if (str(msg.subagent_type)) run.type = msg.subagent_type as string;
      this.tasks.set(taskId, run.id);
      return true;
    }
    if (!run) return false;
    if (msg.subtype === "task_updated") {
      const patch = (msg.patch ?? {}) as Json;
      const status = str(patch.status) ?? str(msg.status);
      if (run.state !== "running") return false;
      if (
        status === "completed" ||
        status === "failed" ||
        status === "stopped" ||
        status === "killed"
      ) {
        this.end(run, status === "completed" ? "done" : status === "failed" ? "failed" : "stopped");
        return true;
      }
      return false;
    }
    if (msg.subtype === "task_progress") {
      if (run.state !== "running") return false;
      const usage = (msg.usage ?? {}) as Json;
      run.tokens = num(usage.total_tokens) ?? run.tokens;
      run.tools = num(usage.tool_uses) ?? run.tools;
      const last = str(msg.last_tool_name);
      if (last) run.activity = last;
      return true;
    }
    if (msg.subtype === "task_notification") {
      if (run.state !== "running") return false;
      const usage = (msg.usage ?? {}) as Json;
      run.tokens = num(usage.total_tokens) ?? run.tokens;
      run.tools = num(usage.tool_uses) ?? run.tools;
      const status = str(msg.status);
      if (status !== "completed" && status !== "failed" && status !== "stopped") return false;
      this.end(run, status === "failed" ? "failed" : status === "stopped" ? "stopped" : "done");
      const summary = str(msg.summary);
      if (summary) run.activity = firstLine(summary);
      return true;
    }
    return false;
  }

  private add(run: SubagentRun): SubagentRun {
    this.runs.set(run.id, run);
    this.prune();
    return run;
  }

  private prune(): void {
    // keep the running ones and the newest finished ones
    while (this.runs.size > MAX_KEPT) {
      const oldDone = [...this.runs.values()].find((r) => r.state !== "running");
      if (!oldDone) break;
      this.runs.delete(oldDone.id);
      for (const [task, id] of this.tasks) if (id === oldDone.id) this.tasks.delete(task);
    }
  }

  private end(run: SubagentRun, state: SubagentState): void {
    run.state = state;
    run.endedAt = this.now().toISOString();
    this.prune();
  }
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

/** The interesting part of a tool call's input: a path, a command, a pattern. */
function brief(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Json;
  for (const k of ["file_path", "path", "command", "pattern", "query", "url", "description"]) {
    const v = str(o[k]);
    if (v) return v.length > 80 ? `${v.slice(0, 80)}…` : v;
  }
  return "";
}
