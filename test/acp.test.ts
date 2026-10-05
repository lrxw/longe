import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AcpTransport, permissionPolicy } from "../src/app/acp.js";
import { PROVIDERS } from "../src/app/providers/index.js";

/** An in-memory ACP agent: answers longe's requests the way opencode acp does. */
function harness(opts: { loadSession?: boolean; mode?: string } = {}) {
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
    result: vi.fn(),
    error: vi.fn(),
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
        reply(call.id, null);
      }
      if (call.method === "session/set_model") reply(call.id, {});
      if (call.method === "session/prompt") promptId = call.id;
    }
  });
  const update = (u: unknown) =>
    transport.ingest(
      JSON.stringify({ method: "session/update", params: { sessionId: "s", update: u } }),
    );
  const endTurn = (stopReason = "end_turn") => reply(promptId, { stopReason });
  return { transport, callbacks, calls, update, endTurn };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("ACP transport", () => {
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
    expect(h.callbacks.tool).toHaveBeenCalledWith("longe_list_topics", undefined);
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
