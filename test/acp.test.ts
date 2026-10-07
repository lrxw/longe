import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AcpTransport, permissionPolicy } from "../src/app/acp.js";
import { PROVIDERS } from "../src/app/providers/index.js";

/** An in-memory ACP agent: answers longe's requests the way opencode acp does. */
function harness(
  opts: {
    loadSession?: boolean;
    mode?: string;
    startupUsage?: { used: number; size: number };
    loadError?: boolean;
    configOptions?: unknown[];
    rejectModel?: boolean;
  } = {},
) {
  const stdin = new PassThrough();
  const calls: {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
  }[] = [];
  const callbacks = {
    session: vi.fn(),
    text: vi.fn(),
    tool: vi.fn(),
    usage: vi.fn(),
    result: vi.fn(),
    error: vi.fn(),
    subagent: vi.fn(),
  };
  const transport = new AcpTransport({ stdin }, callbacks, permissionPolicy(opts.mode));
  const reply = (id: number | undefined, result: unknown) =>
    queueMicrotask(() => transport.ingest(JSON.stringify({ jsonrpc: "2.0", id, result })));
  let promptId: number | undefined;
  stdin.on("data", (data) => {
    for (const line of String(data).split("\n").filter(Boolean)) {
      const call = JSON.parse(line);
      calls.push(call);
      if (call.method === "initialize")
        reply(call.id, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: opts.loadSession ?? true },
        });
      if (call.method === "session/new")
        reply(call.id, {
          sessionId: "ses_new",
          models: {
            availableModels: [{ modelId: "anthropic/sonnet" }],
            currentModelId: "anthropic/sonnet",
          },
          ...(opts.configOptions ? { configOptions: opts.configOptions } : {}),
        });
      if (call.method === "session/load") {
        // the history comes back as updates before the response
        transport.ingest(
          JSON.stringify({
            method: "session/update",
            params: {
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "old" },
              },
            },
          }),
        );
        if (opts.startupUsage) update({ sessionUpdate: "usage_update", ...opts.startupUsage });
        if (opts.loadError) {
          queueMicrotask(() =>
            transport.ingest(JSON.stringify({ id: call.id, error: { message: "gone" } })),
          );
          continue;
        }
        reply(call.id, opts.configOptions ? { configOptions: opts.configOptions } : null);
      }
      if (call.method === "session/set_model") reply(call.id, {});
      if (call.method === "session/set_config_option")
        reply(call.id, {
          configOptions: opts.configOptions?.map((o) => {
            const option = o as { id: string };
            return option.id === call.params.configId && !opts.rejectModel
              ? { ...option, currentValue: call.params.value }
              : option;
          }),
        });
      if (call.method === "session/prompt") promptId = call.id;
    }
  });
  const update = (u: unknown) =>
    transport.ingest(
      JSON.stringify({ method: "session/update", params: { sessionId: "s", update: u } }),
    );
  const endTurn = (stopReason = "end_turn", usage?: unknown) =>
    reply(promptId, { stopReason, usage });
  return { transport, callbacks, calls, update, endTurn };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("ACP transport", () => {
  it("loads configOptions models, switches via their config id, and follows model updates", async () => {
    const config = {
      id: "model-selector",
      category: "model",
      type: "select",
      currentValue: "local/qwen",
      options: [{ group: "local", options: [{ value: "local/qwen" }, { value: "local/gemma" }] }],
    };
    const h = harness({ configOptions: [config] });
    await h.transport.initialize({ root: "/repo", sessionId: "ses_old", model: "local/gemma" });
    expect(h.calls.find((c) => c.method === "session/set_config_option")?.params).toEqual({
      sessionId: "ses_old",
      configId: "model-selector",
      value: "local/gemma",
    });
    expect(h.calls.some((c) => c.method === "session/set_model")).toBe(false);
    expect(h.callbacks.session).toHaveBeenCalledWith("ses_old", "local/gemma", [
      "local/qwen",
      "local/gemma",
    ]);
    h.update({ sessionUpdate: "config_option_update", configOptions: [config] });
    expect(h.callbacks.session).toHaveBeenLastCalledWith("ses_old", "local/qwen", [
      "local/qwen",
      "local/gemma",
    ]);
    h.transport.close();
  });

  it("prefers configOptions over legacy models and does not claim an unconfirmed switch", async () => {
    const h = harness({
      rejectModel: true,
      configOptions: [
        {
          id: "model",
          type: "select",
          currentValue: "local/qwen",
          options: [{ value: "local/qwen" }],
        },
      ],
    });
    await h.transport.initialize({ root: "/repo", model: "local/gemma" });
    expect(h.callbacks.session).toHaveBeenCalledWith("ses_new", "local/qwen", ["local/qwen"]);
    expect(h.callbacks.error).toHaveBeenCalledWith(
      "The agent did not switch to model local/gemma.",
    );
    h.transport.close();
  });

  it("reports a reasoning-only turn as an empty reply, but accepts a turn that ran tools", async () => {
    const h = harness();
    await h.transport.initialize({ root: "/repo" });
    await h.transport.send("anything open?");
    h.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
    h.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n\n" } });
    h.endTurn();
    await tick();
    expect(h.callbacks.text).not.toHaveBeenCalled();
    expect(h.callbacks.result).toHaveBeenLastCalledWith(
      expect.stringContaining("without sending a reply"),
      true,
    );
    await h.transport.send("check the board");
    h.update({ sessionUpdate: "tool_call", title: "longe_list_topics" });
    h.endTurn();
    await tick();
    expect(h.callbacks.result).toHaveBeenLastCalledWith(
      "The agent finished its tool calls without sending a written reply.",
      false,
    );
    h.transport.close();
  });

  it("reports opencode task subagents: start, end, failure and background tasks", async () => {
    const h = harness();
    await h.transport.initialize({ root: "/repo" });
    await h.transport.send("explore");
    const task = { description: "Map the repo", prompt: "…", subagent_type: "explore" };
    // the input can arrive with the call or in a later update
    h.update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "task", kind: "think" });
    expect(h.callbacks.subagent).not.toHaveBeenCalled(); // not known as a task yet
    h.update({ sessionUpdate: "tool_call_update", toolCallId: "t1", rawInput: task });
    expect(h.callbacks.subagent).toHaveBeenLastCalledWith({
      id: "t1",
      type: "explore",
      description: "Map the repo",
      background: false,
      state: "running",
    });
    h.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      rawOutput: {
        output: '<task id="x" state="completed"><summary>ok</summary></task>',
        metadata: { sessionId: "ses_child" },
      },
    });
    expect(h.callbacks.subagent).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "t1", state: "done" }),
    );
    // a failed task
    h.update({ sessionUpdate: "tool_call", toolCallId: "t2", title: "task", rawInput: task });
    h.update({ sessionUpdate: "tool_call_update", toolCallId: "t2", status: "failed" });
    expect(h.callbacks.subagent).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "t2", state: "failed" }),
    );
    // a background task completes its tool call at once while the child still runs
    h.update({
      sessionUpdate: "tool_call",
      toolCallId: "t3",
      title: "task",
      rawInput: { ...task, background: true },
    });
    h.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "t3",
      status: "completed",
      rawOutput: { output: '<task id="y" state="running"></task>' },
    });
    expect(h.callbacks.subagent).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "t3", state: "running", background: true }),
    );
    // other tools are no subagents
    h.update({ sessionUpdate: "tool_call", toolCallId: "r1", title: "read", rawInput: {} });
    expect(h.callbacks.subagent).toHaveBeenCalledTimes(6); // t1 ×2, t2 ×2, t3 ×2
    h.endTurn();
    await tick();
    h.transport.close();
  });

  it("fills tool arguments from later updates using the same call id", async () => {
    const h = harness();
    await h.transport.initialize({ root: "/repo" });
    await h.transport.send("read a file");
    h.update({ sessionUpdate: "tool_call", toolCallId: "r1", title: "read", rawInput: {} });
    h.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "r1",
      status: "in_progress",
      rawInput: { filePath: "/repo/main.ts" },
    });
    expect(h.callbacks.tool).toHaveBeenLastCalledWith("read", { filePath: "/repo/main.ts" }, "r1");
    h.update({ sessionUpdate: "tool_call_update", toolCallId: "r1", status: "completed" });
    expect(h.callbacks.tool).toHaveBeenCalledTimes(2);
    h.endTurn();
    await tick();
    h.transport.close();
  });

  it("reports context snapshots, including decreases and zero, rather than turn usage totals", async () => {
    const h = harness();
    await h.transport.initialize({ root: "/repo" });
    await h.transport.send("hello");
    expect(h.callbacks.usage).not.toHaveBeenCalled();
    h.update({ sessionUpdate: "usage_update", used: 41000, size: 200000 });
    h.endTurn("end_turn", { inputTokens: 90000, totalTokens: 100000 });
    await tick();
    expect(h.callbacks.usage).toHaveBeenCalledExactlyOnceWith(41000, 200000);
    // Providers may update after the response, or report a smaller context after compaction.
    h.update({ sessionUpdate: "usage_update", used: 1000, size: 200000 });
    expect(h.callbacks.usage).toHaveBeenLastCalledWith(1000, 200000);
    h.update({ sessionUpdate: "usage_update", used: 0, size: 200000 });
    expect(h.callbacks.usage).toHaveBeenLastCalledWith(0, 200000);
    h.update({ sessionUpdate: "usage_update", used: 42, size: 0 });
    expect(h.callbacks.usage).toHaveBeenLastCalledWith(42, undefined);
    h.transport.close();
  });

  it("ignores malformed usage instead of replacing the last valid context", async () => {
    const h = harness();
    await h.transport.initialize({ root: "/repo" });
    h.update({ sessionUpdate: "usage_update", used: 100, size: 200000 });
    for (const value of [undefined, null, "100", -1, 1.5, Infinity, NaN]) {
      h.update({ sessionUpdate: "usage_update", used: value, size: 200000 });
      h.update({ sessionUpdate: "usage_update", used: 100, size: value });
    }
    expect(h.callbacks.usage).toHaveBeenCalledExactlyOnceWith(100, 200000);
    h.transport.close();
  });

  it("publishes loaded context after establishing the session, without replaying history", async () => {
    const h = harness({ startupUsage: { used: 41000, size: 200000 } });
    await h.transport.initialize({ root: "/repo", sessionId: "ses_old" });
    expect(h.callbacks.usage).toHaveBeenCalledExactlyOnceWith(41000, 200000);
    expect(h.callbacks.session.mock.invocationCallOrder[0]).toBeLessThan(
      h.callbacks.usage.mock.invocationCallOrder[0] ?? 0,
    );
    expect(h.callbacks.text).not.toHaveBeenCalled();
    h.transport.close();
  });

  it("discards loaded context if loading fails and a fresh session replaces it", async () => {
    const h = harness({ startupUsage: { used: 41000, size: 200000 }, loadError: true });
    await h.transport.initialize({ root: "/repo", sessionId: "ses_old" });
    expect(h.callbacks.session).toHaveBeenCalledWith("ses_new", "anthropic/sonnet", [
      "anthropic/sonnet",
    ]);
    expect(h.callbacks.usage).not.toHaveBeenCalled();
    h.transport.close();
  });

  it("starts a session with longe's MCP server, sends the instructions once, streams a turn", async () => {
    const h = harness();
    await h.transport.initialize({
      root: "/repo",
      mcpUrl: "http://127.0.0.1:7311/r/repo/mcp",
      instructions: "board protocol",
    });
    expect(h.calls.map((c) => c.method)).toEqual(["initialize", "session/new"]);
    expect(h.calls[0]?.params).toMatchObject({ protocolVersion: 1, clientCapabilities: {} });
    expect(h.calls[1]?.params).toEqual({
      cwd: "/repo",
      mcpServers: [
        { type: "http", name: "longe", url: "http://127.0.0.1:7311/r/repo/mcp", headers: [] },
      ],
    });
    expect(h.callbacks.session).toHaveBeenCalledWith("ses_new", "anthropic/sonnet", [
      "anthropic/sonnet",
    ]);

    await h.transport.send("hello");
    const prompt = h.calls.find((c) => c.method === "session/prompt");
    expect(prompt?.params).toEqual({
      sessionId: "ses_new",
      prompt: [
        { type: "text", text: "board protocol" },
        { type: "text", text: "hello" },
      ],
    });
    h.update({
      sessionUpdate: "agent_message_chunk",
      messageId: "m1",
      content: { type: "text", text: "Hi" },
    });
    h.update({
      sessionUpdate: "agent_message_chunk",
      messageId: "m1",
      content: { type: "text", text: " there" },
    });
    h.update({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "longe_list_topics",
      kind: "other",
    });
    expect(h.callbacks.text).toHaveBeenLastCalledWith("m1", "Hi there");
    expect(h.callbacks.tool).toHaveBeenCalledWith("longe_list_topics", undefined, "t1");
    h.endTurn();
    await tick();
    expect(h.callbacks.result).toHaveBeenCalledWith("Hi there", false);

    // the next prompt has no instructions any more
    await h.transport.send("again");
    const second = h.calls.filter((c) => c.method === "session/prompt")[1];
    expect(second?.params).toEqual({
      sessionId: "ses_new",
      prompt: [{ type: "text", text: "again" }],
    });
  });

  it("loads a stored session without replaying its history, and switches the model", async () => {
    const h = harness();
    await h.transport.initialize({
      root: "/repo",
      sessionId: "ses_old",
      model: "openai/gpt",
      instructions: "x",
    });
    expect(h.calls.map((c) => c.method)).toEqual([
      "initialize",
      "session/load",
      "session/set_model",
    ]);
    expect(h.calls[1]?.params).toMatchObject({ sessionId: "ses_old", cwd: "/repo" });
    expect(h.callbacks.text).not.toHaveBeenCalled(); // "old" was the replay
    expect(h.callbacks.session).toHaveBeenCalledWith("ses_old", "openai/gpt", []);
    await h.transport.send("go on");
    const prompt = h.calls.find((c) => c.method === "session/prompt");
    expect(prompt?.params).toEqual({
      sessionId: "ses_old",
      prompt: [{ type: "text", text: "go on" }],
    });
  });

  it("starts a new session when the agent cannot load one; a cancelled turn is an error", async () => {
    const h = harness({ loadSession: false });
    await h.transport.initialize({ root: "/repo", sessionId: "ses_old" });
    expect(h.calls.map((c) => c.method)).toEqual(["initialize", "session/new"]);
    await h.transport.send("x");
    h.endTurn("cancelled");
    await tick();
    expect(h.callbacks.result).toHaveBeenCalledWith("stopped: cancelled", true);
  });

  it("answers permission requests by policy: edits yes, commands no, longe tools always", async () => {
    const h = harness();
    await h.transport.initialize({ root: "/repo" });
    const options = [
      { optionId: "once", name: "Allow", kind: "allow_once" },
      { optionId: "no", name: "Reject", kind: "reject_once" },
    ];
    const ask = (id: number, toolCall: unknown) =>
      h.transport.ingest(
        JSON.stringify({ id, method: "session/request_permission", params: { toolCall, options } }),
      );
    ask(901, { title: "Edit src/a.ts", kind: "edit" });
    ask(902, { title: "rm -rf build", kind: "execute" });
    ask(903, { title: "longe_ask_question", kind: "other" });
    const answers = Object.fromEntries(
      h.calls.filter((c) => (c.id ?? 0) >= 900).map((c) => [c.id, c.result]),
    );
    expect(answers[901]).toEqual({ outcome: { outcome: "selected", optionId: "once" } });
    expect(answers[902]).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
    expect(answers[903]).toEqual({ outcome: { outcome: "selected", optionId: "once" } });
    expect(h.callbacks.error).toHaveBeenCalledWith(expect.stringContaining("rm -rf build"));
    expect(permissionPolicy("bypassPermissions")({ kind: "execute" })).toBe(true);
    expect(permissionPolicy("plan")({ kind: "edit" })).toBe(false);
  });

  it("refuses client methods longe does not offer (fs, terminal)", async () => {
    const h = harness();
    h.transport.ingest(JSON.stringify({ id: 950, method: "fs/read_text_file", params: {} }));
    expect(h.calls.find((c) => c.id === 950)).toMatchObject({ error: { code: -32601 } });
  });
});

describe("opencode provider", () => {
  it("runs `opencode acp`, keeps its own files, resumes with --session", () => {
    const p = PROVIDERS.opencode;
    expect(p.label).toBe("opencode");
    expect(p.args({ config: { args: ["--print-logs"] } } as never)).toEqual([
      "acp",
      "--print-logs",
    ]);
    expect(p.fileTag).toBe(".opencode");
    expect(p.resumeCommand("/my repo", "opencode", "ses_1")).toBe(
      "cd '/my repo' && opencode --session ses_1",
    );
  });
});
