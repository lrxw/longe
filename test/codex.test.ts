import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CodexTransport } from "../src/app/codex.js";
import { SubagentTracker, type SubagentUpdate } from "../src/app/subagents.js";
import { parseConfig } from "../src/store/config.js";

function harness() {
  const stdin = new PassThrough();
  const calls: { id: number; method: string; params: Record<string, unknown> }[] = [];
  const subagents = new SubagentTracker();
  const callbacks = {
    session: vi.fn(),
    text: vi.fn(),
    tool: vi.fn(),
    usage: vi.fn(),
    subagent: vi.fn((update: SubagentUpdate) => subagents.update(update)),
    result: vi.fn(),
    error: vi.fn(),
  };
  const transport = new CodexTransport({ stdin }, callbacks);
  stdin.on("data", (data) => {
    const call = JSON.parse(String(data));
    calls.push(call);
    const result =
      call.method === "model/list"
        ? { data: [{ model: "test-model" }] }
        : call.method === "thread/start" || call.method === "thread/resume"
          ? { thread: { id: "thread-1" }, model: "test-model" }
          : {};
    if (call.method && call.id)
      queueMicrotask(() => transport.ingest(JSON.stringify({ id: call.id, result })));
  });
  const notify = (method: string, params: unknown) =>
    transport.ingest(JSON.stringify({ method, params }));
  return { transport, callbacks, calls, notify, subagents };
}

// Stable event shape from installed codex-cli 0.159.2 app-server generate-ts.
const collab = (
  tool: string,
  agentsStates: Record<string, { status: string; message?: string }>,
  extra: Record<string, unknown> = {},
) => ({
  threadId: "thread-1",
  item: {
    id: "call-1",
    type: "collabAgentToolCall",
    tool,
    status: "completed",
    senderThreadId: "thread-1",
    receiverThreadIds: Object.keys(agentsStates),
    agentsStates,
    ...extra,
  },
});

describe("Codex app server", () => {
  it("keeps a spawned child running and isolates its completion from queued parent turns", async () => {
    const h = harness();
    await h.transport.initialize({ root: "/repo", instructions: "board", sandbox: "read-only" });
    await h.transport.send("delegate");
    const queued = h.transport.send("next parent turn");
    h.notify(
      "item/completed",
      collab("spawnAgent", { child: { status: "running" } }, { prompt: "Review routes" }),
    );
    expect(h.subagents.list()[0]).toMatchObject({
      id: "child",
      description: "Review routes",
      state: "running",
    });
    h.notify("item/completed", {
      threadId: "child",
      item: { id: "reply", type: "agentMessage", text: "Child review" },
    });
    h.notify("thread/tokenUsage/updated", {
      threadId: "child",
      tokenUsage: { last: { totalTokens: 1234 }, modelContextWindow: 4000 },
    });
    h.notify("turn/completed", { threadId: "child", turn: { status: "completed" } });
    expect(h.subagents.list()[0]).toMatchObject({
      state: "done",
      activity: "Child review",
      tokens: 1234,
    });
    expect(h.callbacks.text).not.toHaveBeenCalled();
    expect(h.callbacks.usage).not.toHaveBeenCalled();
    expect(h.callbacks.result).not.toHaveBeenCalled();
    expect(h.calls.filter((c) => c.method === "turn/start")).toHaveLength(1);
    h.notify("turn/completed", { threadId: "thread-1", turn: { status: "completed" } });
    await queued;
    expect(h.calls.filter((c) => c.method === "turn/start")).toHaveLength(2);
    h.transport.close();
  });

  it("uses agent states for wait/failure/resume, not the collaboration tool's completion", async () => {
    const h = harness();
    await h.transport.initialize({ root: "/repo", instructions: "board", sandbox: "read-only" });
    h.notify(
      "item/completed",
      collab("spawnAgent", { a: { status: "pendingInit" }, b: { status: "running" } }),
    );
    h.notify(
      "item/completed",
      collab("wait", {
        a: { status: "completed", message: "Review ready" },
        b: { status: "running" },
      }),
    );
    expect(h.subagents.running()).toBe(1);
    h.notify("item/completed", collab("wait", {}, { receiverThreadIds: ["b"], status: "failed" }));
    expect(h.subagents.list().find((r) => r.id === "b")?.state).toBe("running");
    h.notify("item/completed", collab("resumeAgent", { a: { status: "running" } }));
    expect(h.subagents.list().find((r) => r.id === "a")?.endedAt).toBeUndefined();
    h.notify("item/completed", collab("closeAgent", {}, { receiverThreadIds: ["a"] }));
    h.notify(
      "item/completed",
      collab("wait", {
        b: { status: "errored", message: "Child failed" },
        c: { status: "notFound" },
        d: { status: "shutdown" },
        e: { status: "interrupted" },
      }),
    );
    expect(Object.fromEntries(h.subagents.list().map((r) => [r.id, r.state]))).toEqual({
      a: "stopped",
      b: "failed",
      c: "failed",
      d: "stopped",
      e: "stopped",
    });
    h.transport.close();
  });

  it("correlates child metadata/activity, deduplicates tools and ignores unrelated threads", async () => {
    const h = harness();
    await h.transport.initialize({ root: "/repo", instructions: "board", sandbox: "read-only" });
    h.notify("thread/started", { thread: { id: "other", parentThreadId: "elsewhere" } });
    h.notify("item/completed", {
      ...collab("spawnAgent", { unrelated: { status: "running" } }),
      threadId: "elsewhere",
    });
    expect(h.subagents.list()).toEqual([]);
    h.notify("thread/started", {
      thread: {
        id: "child",
        parentThreadId: "thread-1",
        agentNickname: "Ada",
        agentRole: "explorer",
      },
    });
    const command = {
      threadId: "child",
      item: { id: "cmd-1", type: "commandExecution", command: "ls" },
    };
    h.notify("item/started", command);
    h.notify("item/started", command);
    expect(h.subagents.list()[0]).toMatchObject({
      id: "child",
      name: "Ada",
      type: "explorer",
      tools: 1,
      activity: "command ls",
    });
    expect(h.callbacks.tool).not.toHaveBeenCalled();
    const activity = {
      threadId: "thread-1",
      item: {
        id: "activity-1",
        type: "subAgentActivity",
        agentThreadId: "child",
        agentPath: "/root/explore",
        kind: "started",
      },
    };
    h.notify("item/started", activity);
    h.notify("turn/completed", { threadId: "child", turn: { status: "completed" } });
    h.notify("item/completed", activity); // duplicate must not resurrect completed work
    expect(h.subagents.list()[0]?.state).toBe("done");
    h.transport.close();
  });

  it("initializes, resumes, discovers models and serializes turns until completion", async () => {
    const h = harness();
    await h.transport.initialize({
      root: "/repo",
      sessionId: "thread-1",
      instructions: "board protocol",
      sandbox: "workspace-write",
    });
    expect(h.calls.map((c) => c.method)).toEqual([
      "initialize",
      "initialized",
      "model/list",
      "thread/resume",
    ]);
    expect(h.calls.at(-1)?.params).toMatchObject({
      approvalPolicy: "never",
      sandbox: "workspace-write",
      developerInstructions: "board protocol",
    });
    expect(h.callbacks.session).toHaveBeenCalledWith("thread-1", "test-model", ["test-model"]);
    await h.transport.send("first");
    const second = h.transport.send("second");
    await Promise.resolve();
    expect(h.calls.filter((c) => c.method === "turn/start")).toHaveLength(1);
    h.notify("item/agentMessage/delta", { threadId: "thread-1", itemId: "a", delta: "Hello " });
    h.notify("item/agentMessage/delta", { threadId: "thread-1", itemId: "a", delta: "world" });
    expect(h.callbacks.text).toHaveBeenLastCalledWith("a", "Hello world");
    h.notify("item/started", {
      item: { type: "mcpToolCall", server: "longe", tool: "list_topics", arguments: {} },
    });
    expect(h.callbacks.tool).toHaveBeenCalledWith("longe/list_topics", {});
    h.notify("thread/tokenUsage/updated", {
      tokenUsage: { last: { totalTokens: 123 }, modelContextWindow: 4000 },
    });
    expect(h.callbacks.usage).toHaveBeenCalledWith(123, 4000);
    h.notify("turn/completed", { turn: { status: "completed" } });
    await second;
    expect(h.callbacks.result).toHaveBeenCalledWith("Hello world", false);
    expect(h.calls.filter((c) => c.method === "turn/start")).toHaveLength(2);
    h.transport.close();
  });

  it("rejects queued sends on process death and declines approval requests", async () => {
    const h = harness();
    await h.transport.initialize({ root: "/repo", instructions: "board", sandbox: "read-only" });
    await h.transport.send("first");
    const queued = h.transport.send("queued");
    h.transport.ingest(
      JSON.stringify({ id: 99, method: "item/commandExecution/requestApproval", params: {} }),
    );
    expect(h.calls.at(-1)).toMatchObject({ id: 99, result: { decision: "decline" } });
    h.transport.close();
    await expect(queued).rejects.toThrow("closed");
  });

  it("validates provider and sandbox configuration", () => {
    expect(parseConfig("version: 1\nagent:\n  provider: codex\n").agent?.provider).toBe("codex");
    expect(() => parseConfig("version: 1\nagent:\n  provider: typo\n")).toThrow();
    expect(() => parseConfig("version: 1\nagent:\n  sandbox: danger-full-access\n")).toThrow();
  });
});
