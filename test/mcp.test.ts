import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AppContext, closeAppContext, createAppContext } from "../src/app/context.js";
import { runInit } from "../src/cli/init.js";
import { createHttpApp } from "../src/http/app.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "longe-mcp-"));
  process.env.XDG_CONFIG_HOME = path.join(dir, "config");
  await runInit(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  const text = res.content[0]?.text ?? "";
  return { isError: res.isError === true, body: JSON.parse(text) as Record<string, unknown> };
}

async function scenario(client: Client, root: string) {
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  expect(names).toEqual([
    "acknowledge_answers",
    "add_decision",
    "append_log",
    "ask_question",
    "check_answers",
    "create_topic",
    "get_topic",
    "list_topics",
    "set_plan",
    "set_status",
    "wait_for_answer",
    "withdraw_question",
  ]);
  expect(names).not.toContain("approve");
  const ask = tools.tools.find((t) => t.name === "ask_question");
  expect(ask?.description).toMatch(/blocking=false/);
  expect(ask?.description).toMatch(/assumption/);

  const resources = await client.listResources();
  expect(resources.resources.map((r) => r.uri)).toContain("longe://agent-instructions");
  const instr = await client.readResource({ uri: "longe://agent-instructions" });
  expect((instr.contents[0] as { text: string }).text).toContain("check_answers");

  let r = await call(client, "create_topic", { title: "MCP topic", goal: "Prove the transport." });
  expect(r.isError).toBe(false);
  expect(r.body.id).toBe("mcp-topic");
  r = await call(client, "set_status", { id: "mcp-topic", status: "active" });
  expect(r.body.status).toBe("active");

  r = await call(client, "ask_question", {
    question: "Which?",
    blocking: true,
    topic: "mcp-topic",
    options: ["A", "B"],
  });
  const qid = r.body.id as string;
  expect(r.body.topic_status).toBe("needs-decision");
  expect(await readFile(path.join(root, ".ai/topics/mcp-topic.md"), "utf8")).toContain(
    "status: needs-decision",
  );

  // answer through REST (human surface) — mcp has no answer tool
  r = await call(client, "check_answers", {});
  expect(r.body.questions).toEqual([]);
  return qid;
}

async function finish(client: Client, qid: string) {
  let r = await call(client, "check_answers", {});
  expect((r.body.questions as { id: string }[]).map((q) => q.id)).toEqual([qid]);
  r = await call(client, "acknowledge_answers", { ids: [qid] });
  expect(r.body.acknowledged).toEqual([qid]);
  r = await call(client, "set_status", { id: "mcp-topic", status: "review" });
  expect(r.isError).toBe(false);
  r = await call(client, "set_status", { id: "mcp-topic", status: "done" });
  expect(r.isError).toBe(true);
  expect(r.body.error).toBe("human_only");
  expect(String(r.body.message)).toMatch(/never approve their own work/);
  r = await call(client, "get_topic", { id: "nope" });
  expect(r.isError).toBe(true);
  expect(r.body.error).toBe("not_found");
}

describe("MCP", () => {
  it("stdio: full scenario through `longe mcp`, answer via REST in a second process", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", path.resolve("src/cli/main.ts"), "mcp", "--repo", dir],
      env: { ...process.env } as Record<string, string>,
      stderr: "pipe",
    });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    try {
      const qid = await scenario(client, dir);
      // human side: a separate app context on the same folder (like `longe serve` would be)
      const ctx: AppContext = await createAppContext(dir, {
        index: { debounceMs: 20, usePolling: true },
      });
      try {
        const app = createHttpApp(ctx);
        const res = await app.request("/api/v1/answer_question", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: qid, option_index: 1 }),
        });
        expect(res.status).toBe(200);
      } finally {
        await closeAppContext(ctx);
      }
      // the stdio process sees the change through its own watcher
      const wait = await call(client, "wait_for_answer", { id: qid, timeout_seconds: 5 });
      expect(wait.body.status).toBe("answered");
      await finish(client, qid);
    } finally {
      await client.close();
    }
  }, 20000);

  it("streamable HTTP at /mcp on the same server as REST", async () => {
    const ctx = await createAppContext(dir, { index: { debounceMs: 20, usePolling: true } });
    const app = createHttpApp(ctx);
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise<void>((r) => server.once("listening", () => r()));
    const port = (server.address() as { port: number }).port;
    const client = new Client({ name: "test-http", version: "0" });
    try {
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
      await client.connect(transport as never);
      const qid = await scenario(client, dir);
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/answer_question`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: qid, answer: "B" }),
      });
      expect(res.status).toBe(200);
      await finish(client, qid);
    } finally {
      await client.close();
      server.close();
      await closeAppContext(ctx);
    }
  }, 20000);
});
