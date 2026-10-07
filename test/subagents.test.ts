import { describe, expect, it } from "vitest";
import { SubagentTracker } from "../src/app/subagents.js";

const start = (id: string, background = false, name = "Agent") => ({
  type: "assistant",
  message: {
    content: [
      {
        type: "tool_use",
        id,
        name,
        input: {
          subagent_type: "Explore",
          description: "Inspect routes",
          run_in_background: background,
        },
      },
    ],
  },
});
const result = (id: string, is_error = false) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id, is_error }] },
});
const task = (subtype: string, extra: Record<string, unknown> = {}) => ({
  type: "system",
  subtype,
  task_id: "task-1",
  ...extra,
});

describe("subagent tracking", () => {
  it("tracks foreground Agent and legacy Task calls without counting normal tools", () => {
    let now = new Date("2026-10-06T12:00:00Z");
    const tracker = new SubagentTracker(() => now);
    expect(tracker.ingest(start("read", false, "Read"))).toBe(false);
    tracker.ingest(start("a"));
    tracker.ingest(start("a")); // repeated invocation does not create another run
    tracker.ingest(start("b", false, "Task"));
    expect(tracker.running()).toBe(2);
    tracker.ingest({
      type: "assistant",
      parent_tool_use_id: "a",
      message: {
        content: [{ type: "tool_use", name: "Read", input: { file_path: "src/router.ts" } }],
      },
    });
    expect(tracker.list().find((r) => r.id === "a")).toMatchObject({
      tools: 1,
      activity: "Read src/router.ts",
    });
    now = new Date("2026-10-06T12:00:10Z");
    tracker.ingest(result("a"));
    tracker.ingest(result("b", true));
    expect(tracker.running()).toBe(0);
    expect(tracker.list().map((r) => [r.id, r.state, r.endedAt])).toEqual([
      ["b", "failed", now.toISOString()],
      ["a", "done", now.toISOString()],
    ]);
  });

  it("keeps background agents running after launch and ends them through task notifications", () => {
    const tracker = new SubagentTracker();
    tracker.ingest(start("a", true));
    tracker.ingest(task("task_started", { tool_use_id: "a", task_type: "local_agent" }));
    tracker.ingest(result("a"));
    expect(tracker.running()).toBe(1);
    tracker.ingest(
      task("task_progress", {
        last_tool_name: "Grep",
        usage: { total_tokens: 1700, tool_uses: 3 },
      }),
    );
    expect(tracker.list()[0]).toMatchObject({ activity: "Grep", tokens: 1700, tools: 3 });
    tracker.ingest(
      task("task_notification", {
        status: "completed",
        summary: "Found it\nmore",
        usage: { total_tokens: 2200, tool_uses: 4 },
      }),
    );
    expect(tracker.list()[0]).toMatchObject({
      state: "done",
      activity: "Found it",
      tokens: 2200,
      tools: 4,
    });
    expect(tracker.ingest(task("task_progress", { usage: { total_tokens: 0 } }))).toBe(false);
    expect(tracker.list()[0]?.tokens).toBe(2200);
  });

  it("uses the reported foreground/background flag instead of treating every task as background", () => {
    const tracker = new SubagentTracker();
    tracker.ingest(start("a"));
    tracker.ingest(
      task("task_started", {
        tool_use_id: "a",
        task_type: "local_agent",
        is_backgrounded: false,
        subagent_type: "general-purpose",
      }),
    );
    expect(tracker.list()[0]).toMatchObject({ background: false, type: "general-purpose" });
    tracker.ingest(result("a"));
    expect(tracker.list()[0]?.state).toBe("done");
  });

  it("handles task-only starts and terminal task_updated events, ignoring unrelated tasks", () => {
    const tracker = new SubagentTracker();
    expect(tracker.ingest(task("task_started", { task_type: "local_bash" }))).toBe(false);
    expect(tracker.ingest(task("task_started"))).toBe(false);
    tracker.ingest(task("task_started", { task_type: "local_agent", description: "Search" }));
    tracker.ingest(task("task_updated", { patch: { status: "running" } }));
    expect(tracker.running()).toBe(1);
    tracker.ingest(task("task_updated", { patch: { status: "killed" } }));
    expect(tracker.list()[0]?.state).toBe("stopped");
    tracker.clear();
    expect(tracker.list()).toEqual([]);
    expect(tracker.ingest(task("task_progress"))).toBe(false);
  });

  it("retains all live agents, bounds finished history, and stops live runs on process exit", () => {
    const tracker = new SubagentTracker();
    for (let i = 0; i < 35; i++) tracker.ingest(start(String(i)));
    expect(tracker.running()).toBe(35);
    tracker.ingest(result("0"));
    expect(tracker.list()).toHaveLength(34);
    tracker.stopAll();
    expect(tracker.list()).toHaveLength(30);
    expect(tracker.running()).toBe(0);
    expect(tracker.list().every((r) => r.state === "stopped" && r.endedAt)).toBe(true);
    const copy = tracker.list();
    if (copy[0]) copy[0].state = "running";
    expect(tracker.running()).toBe(0);
    expect(tracker.stopAll()).toBe(false);
  });
});
