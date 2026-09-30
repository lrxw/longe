import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CodexTransport } from "../src/app/codex.js";
import { parseConfig } from "../src/store/config.js";

function harness() {
  const stdin = new PassThrough();
  const calls: { id: number; method: string; params: Record<string, unknown> }[] = [];
  const callbacks = {
    session: vi.fn(),
    text: vi.fn(),
    tool: vi.fn(),
    usage: vi.fn(),
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
  return { transport, callbacks, calls, notify };
}

describe("Codex app server", () => {
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
