import type { SubagentState, SubagentUpdate } from "./subagents.js";

type Json = Record<string, unknown>;
const object = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const text = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Matches the stable schema from codex-cli 0.159.2 `app-server generate-ts`.
 * Observes only this chat's children; never resumes or subscribes to other threads.
 */
export class CodexSubagents {
  private children = new Map<string, Set<string>>();
  private activityItems = new Set<string>();

  constructor(private readonly report: (update: SubagentUpdate) => void) {}

  private related(id: string | undefined, main: string): boolean {
    return !!id && (id === main || this.children.has(id));
  }

  private update(id: string, patch: Omit<SubagentUpdate, "id">): void {
    if (!this.children.has(id)) this.children.set(id, new Set());
    this.report({ id, ...patch });
  }

  ingest(method: string | undefined, params: unknown, main: string): void {
    if (!main) return;
    const p = object(params);
    if (method === "thread/started") {
      const t = object(p.thread);
      const source = object(object(object(t.source).subagent).thread_spawn);
      const parent = text(t.parentThreadId) ?? text(source.parent_thread_id);
      const id = text(t.id);
      if (!id || id === main || !this.related(parent, main)) return;
      const name = text(t.agentNickname) ?? text(source.agent_nickname);
      const role = text(t.agentRole) ?? text(source.agent_role);
      this.update(id, { ...(name ? { name } : {}), ...(role ? { type: role } : {}) });
      return;
    }
    const thread = text(p.threadId);
    const item = object(p.item);
    const itemEvent = method === "item/started" || method === "item/completed";
    if (itemEvent && item.type === "collabAgentToolCall") {
      // Some versions omit params.threadId, but the item always identifies its sender.
      const sender = text(item.senderThreadId);
      if (!this.related(sender, main) || (thread && thread !== sender)) return;
      const states = object(item.agentsStates);
      const ids = new Set([
        ...(Array.isArray(item.receiverThreadIds)
          ? item.receiverThreadIds.filter((id): id is string => typeof id === "string")
          : []),
        ...Object.keys(states),
      ]);
      for (const id of ids) {
        if (!id || id === main) continue;
        const agent = object(states[id]);
        const state =
          agentState(agent.status) ??
          (item.status === "completed" &&
          (item.tool === "closeAgent" || item.tool === "interruptAgent")
            ? "stopped"
            : undefined);
        const message = text(agent.message);
        const prompt = text(item.prompt);
        const firstSpawn = item.tool === "spawnAgent" && !this.children.has(id);
        this.update(id, {
          ...(state
            ? { state }
            : firstSpawn
              ? { state: item.status === "failed" ? "failed" : "running" }
              : {}),
          ...(message ? { activity: message } : {}),
          ...(prompt &&
          (item.tool === "spawnAgent" || item.tool === "followupTask" || item.tool === "sendInput")
            ? { description: prompt }
            : {}),
        });
      }
      return;
    }
    if (itemEvent && item.type === "subAgentActivity" && this.related(thread, main)) {
      const id = text(item.agentThreadId);
      if (!id || id === main) return;
      const eventId = text(item.id);
      if (eventId && this.activityItems.has(eventId)) return;
      if (eventId) this.activityItems.add(eventId);
      const state =
        item.kind === "started"
          ? "running"
          : item.kind === "completed"
            ? "done"
            : item.kind === "interrupted"
              ? "stopped"
              : undefined;
      const name = text(item.agentPath);
      this.update(id, { ...(state ? { state } : {}), ...(name ? { name } : {}) });
      return;
    }
    if (!thread || !this.children.has(thread)) return;
    // Child output must never enter the main transcript, usage meter, or turn queue.
    if (method === "turn/started") this.update(thread, { state: "running" });
    else if (method === "turn/completed") {
      const turn = object(p.turn);
      const state =
        turn.status === "completed"
          ? "done"
          : turn.status === "failed"
            ? "failed"
            : turn.status === "interrupted"
              ? "stopped"
              : undefined;
      if (state)
        this.update(thread, {
          state,
          ...(text(object(turn.error).message)
            ? { activity: text(object(turn.error).message) }
            : {}),
        });
    } else if (method === "thread/closed") this.update(thread, { state: "stopped" });
    else if (method === "thread/tokenUsage/updated") {
      const tokens = object(object(p.tokenUsage).last).totalTokens;
      if (typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0)
        this.update(thread, { tokens });
    } else if (itemEvent) {
      if (item.type === "agentMessage" && method === "item/completed" && text(item.text))
        this.update(thread, { activity: item.text as string });
      else if (method === "item/started") {
        const activity =
          item.type === "commandExecution"
            ? `command ${text(item.command) ?? ""}`
            : item.type === "mcpToolCall"
              ? `${item.server}/${item.tool}`
              : item.type === "fileChange"
                ? "fileChange"
                : undefined;
        const id = text(item.id);
        if (activity && id) {
          const seen = this.children.get(thread);
          if (!seen) return;
          seen.add(id);
          this.update(thread, { activity, tools: seen.size });
        }
      }
    }
  }
}

function agentState(status: unknown): SubagentState | undefined {
  switch (status) {
    case "pendingInit":
    case "running":
      return "running";
    case "completed":
      return "done";
    case "errored":
    case "notFound":
      return "failed";
    case "interrupted":
    case "shutdown":
      return "stopped";
    default:
      return undefined;
  }
}
