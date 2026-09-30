import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AppContext, closeAppContext, createAppContext } from "../src/app/context.js";
import { attachChatQueue } from "../src/app/todo-queue.js";
import { runInit } from "../src/cli/init.js";
import { createHttpApp } from "../src/http/app.js";
import * as atomic from "../src/store/atomic.js";
import { parseConfig } from "../src/store/config.js";
import { newTopicText } from "../src/store/topic.js";

let dir: string;
let configFile: string;
let ctx: AppContext;
let app: ReturnType<typeof createHttpApp>;

const post = (action: string, body: Record<string, string>, origin = "http://localhost") =>
  app.request(`/agent/${action}`, {
    method: "POST",
    headers: { origin, "hx-request": "true" },
    body: new URLSearchParams(body),
  });

async function idle() {
  await vi.waitFor(() => expect(ctx.agent.busy()).toBe(false), { timeout: 4000 });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "longe-provider-"));
  process.env.XDG_CACHE_HOME = path.join(dir, "cache");
  await runInit(dir);
  const fake = path.join(dir, "fake-agent");
  await writeFile(
    fake,
    `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const codex = process.argv[2] === 'app-server';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
fs.writeFileSync(${JSON.stringify(dir)} + '/' + (codex ? 'codex' : 'claude') + '-args.json', JSON.stringify(process.argv.slice(2)));
readline.createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (codex) {
    fs.appendFileSync(${JSON.stringify(dir)} + '/codex-input', line + '\\n');
    if (m.method === 'initialize') send({id:m.id,result:{}});
    if (m.method === 'model/list') send({id:m.id,result:{data:[{model:'codex-model'}]}});
    if (m.method === 'thread/start' || m.method === 'thread/resume') send({id:m.id,result:{thread:{id:m.params.threadId || 'codex-session'},model:'codex-model'}});
    if (m.method === 'turn/start') {
      send({id:m.id,result:{turn:{id:'turn'}}});
      setTimeout(() => send({method:'turn/completed',params:{turn:{status:'completed'}}}),30);
    }
  } else {
    send({type:'system',subtype:'init',session_id:'claude-session',model:'claude-model',slash_commands:['compact']});
    if (m.message.content[0].text !== 'hang') setTimeout(() => send({type:'result',result:'done',total_cost_usd:0.1}),30);
  }
});
`,
  );
  await chmod(fake, 0o755);
  configFile = path.join(dir, ".longe/config.yml");
  await writeFile(
    configFile,
    `# keep this comment
version: 1
project: switch-test
extra: keep-me
agent:
  command: ${JSON.stringify(fake)} # custom Claude launcher
  model: claude-default
  args: [--claude-only]
  allowed_tools: [Read]
  providers:
    codex:
      command: ${JSON.stringify(fake)}
      model: codex-default
`,
  );
  const cache = path.join(dir, "cache/longe/agent");
  await mkdir(cache, { recursive: true });
  await writeFile(
    path.join(cache, "switch-test.codex.sessions.json"),
    JSON.stringify({
      chat: { id: "codex-old" },
      model: "codex-user",
    }),
  );
  ctx = await createAppContext(dir, { index: { usePolling: true, debounceMs: 10 } });
  app = createHttpApp(ctx, { port: 8123 });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeAppContext(ctx);
  await rm(dir, { recursive: true, force: true });
});

describe("UI provider switching", () => {
  it("switches live, preserves settings and sessions, and persists across server restarts", async () => {
    const runner = ctx.agent;
    await post("prompt", { prompt: "hello" });
    await idle();
    await post("model", { model: "sonnet" });
    const changed = await post("provider", { provider: "codex" });
    expect(changed.status).toBe(200);
    expect(await changed.text()).toMatch(/<option value="codex" selected/);
    expect(ctx.agent).toBe(runner);
    expect(ctx.agent.status()).toMatchObject({
      provider: "codex",
      sessionId: "codex-old",
      modelOverride: "codex-user",
      defaultModel: "codex-default",
      alive: false,
    });
    expect(ctx.agent.status().costUsd).toBeUndefined();
    expect(ctx.agent.status().slashCommands).toBeUndefined();
    expect(ctx.agent.mcpUrl).toBe("http://127.0.0.1:8123/mcp");
    const saved = await readFile(configFile, "utf8");
    expect(saved).toContain("# keep this comment");
    expect(saved).toContain("# custom Claude launcher");
    expect(parseConfig(saved)).toMatchObject({
      extra: "keep-me",
      agent: {
        provider: "codex",
        allowed_tools: ["Read"],
        providers: { claude: { model: "claude-default", args: ["--claude-only"] } },
      },
    });
    expect(parseConfig(saved).agent?.command).toBeUndefined();
    await post("prompt", { prompt: "codex hello" });
    await idle();
    expect(JSON.parse(await readFile(path.join(dir, "codex-args.json"), "utf8"))).not.toContain(
      "--claude-only",
    );
    expect(await readFile(path.join(dir, "codex-input"), "utf8")).toContain(
      '"method":"thread/resume"',
    );
    await closeAppContext(ctx);
    ctx = await createAppContext(dir, { index: { usePolling: true } });
    app = createHttpApp(ctx);
    expect(ctx.agent.status().provider).toBe("codex");
    const back = await post("provider", { provider: "claude" });
    expect(back.status).toBe(200);
    expect(ctx.agent.status()).toMatchObject({
      provider: "claude",
      sessionId: "claude-session",
      modelOverride: "sonnet",
      defaultModel: "claude-default",
      costUsd: 0.1,
    });
    expect(ctx.agent.status().slashCommands).toEqual(["compact"]);
    await post("prompt", { prompt: "back" });
    await idle();
    const args = JSON.parse(await readFile(path.join(dir, "claude-args.json"), "utf8"));
    expect(args).toContain("--claude-only");
    expect(args).toContain("--resume");
    expect(args).toContain("claude-session");
    expect((await ctx.agent.messages()).length).toBe(3);
  });

  it("rejects invalid, cross-origin, queued and active-turn switches without changing config", async () => {
    const original = await readFile(configFile, "utf8");
    expect((await post("provider", { provider: "other" })).status).toBe(400);
    expect((await post("provider", { provider: "codex" }, "http://other.example")).status).toBe(
      403,
    );
    const writing = ctx.agent.say("human", "hang");
    await expect(ctx.agent.setProvider("codex")).rejects.toMatchObject({ code: "conflict" });
    await writing;
    await vi.waitFor(() => expect(ctx.agent.status().sessionId).toBe("claude-session"));
    const response = await post("provider", { provider: "codex" });
    expect(response.status).toBe(409);
    expect(await response.text()).toMatch(/name="provider"[^>]*disabled/);
    expect(ctx.agent.status().provider).toBe("claude");
    expect(ctx.agent.status().alive).toBe(true);
    expect(await readFile(configFile, "utf8")).toBe(original);
    ctx.agent.stop();
    await idle();
    expect((await post("provider", { provider: "codex" })).status).toBe(200);
  });

  it("keeps the old provider and saved config when persistence fails", async () => {
    const original = await readFile(configFile, "utf8");
    vi.spyOn(atomic, "atomicWrite").mockRejectedValueOnce(new Error("config is read-only"));
    const response = await post("provider", { provider: "codex" });
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("config is read-only");
    expect(ctx.agent.status()).toMatchObject({ provider: "claude", canSwitchProvider: true });
    expect(await readFile(configFile, "utf8")).toBe(original);
  });

  it("rejects conflicting actions during a switch instead of changing the wrong session", async () => {
    const originalWrite = atomic.atomicWrite;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(atomic, "atomicWrite").mockImplementationOnce(async (...args) => {
      await barrier;
      await originalWrite(...args);
    });
    const switching = post("provider", { provider: "codex" });
    await vi.waitFor(() => expect(ctx.agent.status().switchingProvider).toBe(true));
    try {
      expect((await post("provider", { provider: "claude" })).status).toBe(409);
      expect((await post("model", { model: "haiku" })).status).toBe(409);
      expect((await post("prompt", { prompt: "too early" })).status).toBe(409);
      expect(await ctx.agent.messages()).toEqual([]);
      // Board work arriving during the switch must wake on the new provider afterward.
      attachChatQueue(ctx.index, ctx.agent);
      await writeFile(
        path.join(dir, ".longe/topics/next.md"),
        newTopicText({ id: "next", title: "Next", goal: "Work", now: new Date() }).replace(
          "status: backlog",
          "status: todo",
        ),
      );
      await vi.waitFor(() => expect(ctx.index.topicsByStatus("todo")).toHaveLength(1));
      expect(await ctx.agent.messages()).toEqual([]);
    } finally {
      release();
    }
    expect((await switching).status).toBe(200);
    expect(ctx.agent.status().modelOverride).toBe("codex-user");
    await vi.waitFor(async () => expect(await ctx.agent.messages()).toHaveLength(1));
    await idle();
    expect(await readFile(path.join(dir, "codex-input"), "utf8")).toContain(
      '"method":"turn/start"',
    );
  });
});
