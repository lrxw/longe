import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentRunner,
  ASK_IN_INBOX_PROMPT,
  activatedPrompt,
  answeredPrompt,
  answersPrompt,
  CONTINUE_PROMPT,
  endsWithQuestion,
  resumeCommand,
  SETTLE_MS,
  todoPrompt,
  WORK_PROMPT,
} from "../src/app/agent.js";
import { type AppContext, closeAppContext, createAppContext } from "../src/app/context.js";
import { runInit } from "../src/cli/init.js";
import { createHttpApp } from "../src/http/app.js";
import {
  clearMessages,
  listMessages,
  markDelivered,
  parseMessage,
  writeMessage,
} from "../src/store/messages.js";
import { newQuestionText } from "../src/store/question.js";
import { newTopicText } from "../src/store/topic.js";
import { answerQuestion, setTopicStatus } from "../src/tools/ops.js";

let dir: string;
let fake: string;
let argsFile: string;
let inputFile: string;

async function waitFor(fn: () => boolean, ms = 10000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const inputLines = async () =>
  (await readFile(inputFile, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { message: { content: { text: string }[] } })
    .map((m) => m.message.content[0]?.text);

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "longe-agent-"));
  process.env.XDG_CACHE_HOME = path.join(dir, "cache");
  await runInit(dir);
  // a stand-in for `claude -p --input-format stream-json --output-format stream-json`:
  // answers every stdin line with one turn, exits when stdin closes
  fake = path.join(dir, "fake-claude");
  argsFile = path.join(dir, "args.txt");
  inputFile = path.join(dir, "input.txt");
  await writeFile(
    fake,
    `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}
echo 'warn' >&2
n=0
while IFS= read -r line; do
  n=$((n+1))
  printf '%s\\n' "$line" >> ${JSON.stringify(inputFile)}
  echo '{"type":"system","subtype":"init","session_id":"sess-1","model":"m","slash_commands":["compact","__internal"]}'
  echo '{"type":"assistant","session_id":"sess-1","message":{"usage":{"input_tokens":100,"cache_creation_input_tokens":900,"cache_read_input_tokens":40000,"output_tokens":5},"content":[{"type":"text","text":"Working on it"},{"type":"tool_use","name":"Read","input":{"file_path":"a.ts"}}]}}'
  echo 'not json'
  echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"All done $n\\",\\"session_id\\":\\"sess-1\\",\\"total_cost_usd\\":0.0$n,\\"usage\\":{\\"input_tokens\\":1},\\"modelUsage\\":{\\"m\\":{\\"contextWindow\\":200000}}}"
done
`,
  );
  await chmod(fake, 0o755);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("message store", () => {
  it("writes, lists, parses; skips broken files", async () => {
    const now = new Date("2026-09-22T10:00:00Z");
    const m = await writeMessage(dir, { from: "human", text: "hi there", topic: "t1", now });
    expect(m.fm.id).toMatch(/^m-20260922-[0-9a-z]{4}$/);
    expect(m.text).toBe("hi there");
    const text = await readFile(path.join(dir, ".longe/messages", `${m.fm.id}.md`), "utf8");
    expect(text).toContain("from: human");
    expect(text).toContain("topic: t1");
    expect(text).toContain("## Message\nhi there");
    expect(parseMessage(text).fm.delivered_at).toBeUndefined();
    await writeFile(path.join(dir, ".longe/messages/m-20260922-zzzz.md"), "garbage");
    await writeMessage(dir, { from: "board", text: "later", now: new Date(now.getTime() + 1000) });
    const all = await listMessages(dir);
    expect(all.map((x) => x.text)).toEqual(["hi there", "later"]);
    expect(await listMessages(path.join(dir, "nope"))).toEqual([]);
    // clearing removes delivered and broken files, keeps what still waits; a missing dir is fine
    await markDelivered(dir, m.fm.id, now);
    expect(await clearMessages(dir)).toBe(2);
    expect((await listMessages(dir)).map((x) => x.text)).toEqual(["later"]);
    expect(await clearMessages(path.join(dir, "nope"))).toBe(0);
  });
});

describe("AgentRunner", () => {
  it("one process takes several messages, tracks turns, context and cost; resumes after idle close", async () => {
    const runner = new AgentRunner(
      dir,
      {
        command: fake,
        permission_mode: "plan",
        idle_minutes: 0.005,
        model: "sonnet",
        allowed_tools: ["Bash(pnpm test:*)", "Bash(git commit:*)"],
      },
      "test",
    );
    runner.mcpUrl = "http://127.0.0.1:1/r/x/mcp";
    let changes = 0;
    runner.on("agent:changed", () => changes++);

    await runner.say("human", "hello");
    await runner.say("human", "second", { topic: { id: "t1", title: "Title" } });
    await waitFor(() => runner.status().pending === 2 || runner.status().events.length > 0);
    await waitFor(() => runner.status().pending === 0 && runner.status().events.length >= 8);
    expect(runner.status().alive).toBe(true);
    expect(await inputLines()).toEqual(["hello", 'On topic `t1` ("Title"):\nsecond']);

    const args = (await readFile(argsFile, "utf8")).split("\n");
    expect(args.slice(0, 3)).toEqual(["-p", "--input-format", "stream-json"]);
    expect(args).not.toContain("--resume");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(args[args.indexOf("--mcp-config") + 1]).toContain("http://127.0.0.1:1/r/x/mcp");
    // longe's tools first, then the repo's allowlist, as one --allowedTools list
    const at = args.indexOf("--allowedTools");
    expect(args.slice(at + 1, at + 4)).toEqual([
      "mcp__longe",
      "Bash(pnpm test:*)",
      "Bash(git commit:*)",
    ]);
    // questions go through the inbox, never the harness's own prompt
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe("AskUserQuestion");
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toContain("chat of this repository");

    const s = runner.status();
    expect(s.sessionId).toBe("sess-1");
    expect(s.model).toBe("sonnet");
    expect(s.modelInUse).toBe("m"); // from the init line
    expect(s.slashCommands).toEqual(["compact", "__internal"]); // likewise
    expect(s.contextTokens).toBe(41000);
    expect(s.contextWindow).toBe(200000);
    expect(s.costUsd).toBeCloseTo(0.02); // total_cost_usd is cumulative within a process
    expect(s.events.map((e) => e.kind)).toEqual([
      "error", // stderr "warn"
      "system",
      "text",
      "tool",
      "text",
      "result",
      "text",
      "tool",
      "text",
      "result",
    ]);
    expect(s.events[3]?.text).toBe("Read a.ts");
    expect(s.events[9]?.text).toBe("All done 2"); // differs from the last text, so it is shown
    expect(changes).toBeGreaterThan(0);
    const stored = await runner.messages();
    expect(stored.map((m) => m.fm.delivered_at !== undefined)).toEqual([true, true]);
    expect(stored[1]?.fm.topic).toBe("t1");

    // idle: stdin closed, process gone, session kept with its cost
    await waitFor(() => !runner.status().alive);
    expect(runner.status().exitCode).toBe(0);
    expect(runner.status().costUsd).toBeCloseTo(0.02);
    expect(runner.status().sessionId).toBe("sess-1");
    await waitFor(() => runner.status().exitCode === 0);
    await new Promise((r) => setTimeout(r, 50)); // the log line is written after the state change
    expect(await readFile(runner.logFile, "utf8")).toContain("=== exit 0 ===");

    // next message: new process resumes the session, cost adds up
    await runner.say("human", "third");
    await waitFor(() => runner.status().alive && runner.status().pending === 0);
    const args2 = (await readFile(argsFile, "utf8")).split("\n");
    expect(args2[args2.indexOf("--resume") + 1]).toBe("sess-1");
    expect(runner.status().costUsd).toBeCloseTo(0.03);

    // stop kills the process; the session survives a restart of the runner
    expect(runner.stop()).toBe(true);
    await waitFor(() => !runner.status().alive);
    const again = new AgentRunner(dir, { command: fake }, "test");
    await new Promise((r) => setTimeout(r, 50));
    expect(again.status().sessionId).toBe("sess-1");
    expect(again.status().contextTokens).toBe(41000);
    expect(again.status().costUsd).toBeCloseTo(0.03);
    // clearing the history empties the page but keeps the session
    await again.clearHistory();
    expect(again.status().events).toEqual([]);
    expect(await again.messages()).toEqual([]);
    expect(again.status().sessionId).toBe("sess-1");
    await writeMessage(dir, { from: "human", text: "again", now: new Date() });
    await again.reset();
    expect(again.status().sessionId).toBeUndefined();
    expect(again.status().contextTokens).toBeUndefined();
    expect(again.status().events).toEqual([]);
    expect((await again.messages()).length).toBe(1); // reset keeps the files
  });

  it("slash commands go out as typed, also from a topic; a compaction is shown and resets the context figure", async () => {
    // answers a /compact line like claude does: a compact_boundary, then a result
    // whose usage is the summary call over the old context
    const compacting = path.join(dir, "fake-compact");
    await writeFile(
      compacting,
      `#!/bin/sh
while IFS= read -r line; do
  printf '%s\\n' "$line" >> ${JSON.stringify(inputFile)}
  case "$line" in
    *'"/compact'*)
      echo '{"type":"system","subtype":"compact_boundary","session_id":"s","compact_metadata":{"trigger":"manual","pre_tokens":41000}}'
      echo '{"type":"result","subtype":"success","is_error":false,"result":"","session_id":"s","usage":{"input_tokens":41000}}' ;;
    *)
      echo '{"type":"assistant","session_id":"s","message":{"usage":{"input_tokens":41000},"content":[{"type":"text","text":"ok"}]}}'
      echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"s"}' ;;
  esac
done
`,
    );
    await chmod(compacting, 0o755);
    const runner = new AgentRunner(dir, { command: compacting }, "test");
    const topic = { id: "t1", title: "Title" };
    await runner.say("human", "hello", { topic });
    await waitFor(() => runner.status().contextTokens === 41000 && runner.status().pending === 0);
    await runner.say("human", "  /compact", { topic });
    await waitFor(() => runner.status().pending === 0 && runner.status().events.length >= 3);
    expect(await inputLines()).toEqual(['On topic `t1` ("Title"):\nhello', "/compact"]);
    expect((await runner.messages())[1]?.fm.topic).toBe("t1"); // the topic is still recorded
    const events = runner.status().events;
    expect(events.find((e) => e.text.startsWith("context "))?.text).toBe(
      "context compacted (41k tokens before)",
    );
    expect(runner.status().contextTokens).toBeUndefined();
    await runner.close();
  });

  it("a reply that ends with a question in the text gets one reminder to use the inbox", async () => {
    // always ends its reply with a question; "ask" makes it call ask_question instead
    const asking = path.join(dir, "fake-asking");
    await writeFile(
      asking,
      `#!/bin/sh
while IFS= read -r line; do
  printf '%s\\n' "$line" >> ${JSON.stringify(inputFile)}
  case "$line" in
    *'please ask'*)
      echo '{"type":"assistant","session_id":"s","message":{"content":[{"type":"tool_use","name":"mcp__longe__ask_question","input":{"question":"Q?"}}]}}'
      echo '{"type":"result","subtype":"success","is_error":false,"result":"Asked. Or not?","session_id":"s"}' ;;
    *)
      echo '{"type":"result","subtype":"success","is_error":false,"result":"Done. Shall I go on?","session_id":"s"}' ;;
  esac
done
`,
    );
    await chmod(asking, 0o755);
    const runner = new AgentRunner(dir, { command: asking }, "test");
    await runner.say("human", "hello");
    // turn 1 ends with a question → reminder; the reminder's turn ends with one too → no loop
    await waitFor(() => runner.status().events.filter((e) => e.kind === "result").length >= 2);
    await new Promise((r) => setTimeout(r, 150));
    expect(await inputLines()).toEqual(["hello", ASK_IN_INBOX_PROMPT]);
    // a turn that called ask_question is not reminded
    await runner.say("human", "please ask");
    await waitFor(() => runner.status().events.filter((e) => e.kind === "result").length >= 3);
    await new Promise((r) => setTimeout(r, 150));
    expect((await inputLines()).length).toBe(3);
    await runner.close();

    // ask_in_inbox: false → no reminder
    const off = new AgentRunner(dir, { command: asking }, "off");
    off.askInInbox = false;
    await off.say("human", "hello again");
    await waitFor(() => off.status().events.filter((e) => e.kind === "result").length >= 1);
    await new Promise((r) => setTimeout(r, 150));
    expect((await inputLines()).length).toBe(4);
    await off.close();
  });

  it("endsWithQuestion: the last paragraph asks, code does not count", () => {
    expect(endsWithQuestion("Done.\n\nShould I commit?")).toBe(true);
    expect(endsWithQuestion("Is it **ready?** I think so.")).toBe(true);
    expect(endsWithQuestion("Why? Because.\n\nAll done.")).toBe(false);
    expect(endsWithQuestion("Look:\n\n```js\nx ? a : b\n```")).toBe(false);
    expect(endsWithQuestion("")).toBe(false);
  });

  it("delivers messages written while no process was open, oldest first", async () => {
    const early = await writeMessage(dir, { from: "human", text: "by hand", now: new Date(0) });
    const runner = new AgentRunner(dir, { command: fake }, "test");
    await runner.say("human", "now");
    await waitFor(() => runner.status().pending === 0 && runner.status().events.length >= 4);
    expect(await inputLines()).toEqual(["by hand", "now"]);
    const m = (await runner.messages()).find((x) => x.fm.id === early.fm.id);
    expect(m?.fm.delivered_at).toBeDefined();
    runner.stop();
    await waitFor(() => !runner.status().alive);
  });

  it("reads the old sessions file that stored one id per key", async () => {
    const cache = path.join(dir, "cache", "longe", "agent");
    await mkdir(cache, { recursive: true });
    await writeFile(path.join(cache, "old.sessions.json"), '{"board":"sess-old"}');
    const runner = new AgentRunner(dir, { command: fake }, "old");
    await new Promise((r) => setTimeout(r, 50));
    expect(runner.status().sessionId).toBe("sess-old");
    // a file from another build, keyed by something else: the one session in it counts
    await writeFile(
      path.join(cache, "other.sessions.json"),
      '{"repo":{"id":"sess-other","costUsd":0.5}}',
    );
    const other = new AgentRunner(dir, { command: fake }, "other");
    await new Promise((r) => setTimeout(r, 50));
    expect(other.status().sessionId).toBe("sess-other");
    expect(other.status().costUsd).toBeCloseTo(0.5);
    await writeFile(path.join(cache, "junk.sessions.json"), '{"x":{"nope":1}}');
    const junk = new AgentRunner(dir, { command: fake }, "junk");
    await new Promise((r) => setTimeout(r, 50));
    expect(junk.status().sessionId).toBeUndefined();
  });

  it("keeps the chat when the repo gets a project name: the folder-named sessions file is moved", async () => {
    const cache = path.join(dir, "cache", "longe", "agent");
    await mkdir(cache, { recursive: true });
    await writeFile(
      path.join(cache, "folder.sessions.json"),
      '{"chat":{"id":"sess-folder","costUsd":1},"model":"haiku"}',
    );
    const runner = new AgentRunner(dir, { command: fake }, "named", undefined, ["folder", "named"]);
    await new Promise((r) => setTimeout(r, 50));
    expect(runner.status().sessionId).toBe("sess-folder");
    expect(runner.status().modelOverride).toBe("haiku");
    expect(await readFile(path.join(cache, "named.sessions.json"), "utf8")).toContain(
      "sess-folder",
    );
    await expect(readFile(path.join(cache, "folder.sessions.json"), "utf8")).rejects.toThrow();
    // the current file wins when both exist
    await writeFile(path.join(cache, "folder.sessions.json"), '{"chat":"sess-stale"}');
    const again = new AgentRunner(dir, { command: fake }, "named", undefined, ["folder"]);
    await new Promise((r) => setTimeout(r, 50));
    expect(again.status().sessionId).toBe("sess-folder");
  });

  it("switching the model stops the process; the next one resumes with --model", async () => {
    const runner = new AgentRunner(dir, { command: fake, model: "sonnet" }, "model");
    await runner.say("human", "hello");
    await waitFor(() => runner.status().pending === 0 && runner.status().alive);
    expect(runner.status().model).toBe("sonnet");
    await runner.setModel("opus");
    await waitFor(() => !runner.status().alive);
    expect(runner.status().sessionId).toBe("sess-1");
    expect(runner.status().model).toBe("opus");
    await runner.say("human", "again");
    await waitFor(() => runner.status().pending === 0 && runner.status().alive);
    const args = (await readFile(argsFile, "utf8")).split("\n");
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    expect(args[args.indexOf("--resume") + 1]).toBe("sess-1");
    // the same choice again is a no-op: the process stays
    await runner.setModel("opus");
    expect(runner.status().alive).toBe(true);
    // the choice survives a restart of the runner; "" goes back to the config default
    const later = new AgentRunner(dir, { command: fake, model: "sonnet" }, "model");
    await new Promise((r) => setTimeout(r, 50));
    expect(later.status().modelOverride).toBe("opus");
    await later.setModel("");
    expect(later.status().model).toBe("sonnet");
    expect(later.status().modelOverride).toBeUndefined();
    runner.stop();
    await waitFor(() => !runner.status().alive);
  });

  it("close waits for the process to end; a process that ignores SIGTERM is killed", async () => {
    // traps TERM and keeps reading, like a child that does not shut down on its own
    const stubborn = path.join(dir, "stubborn");
    // the init line tells the test the trap is armed, else SIGTERM may land before it
    await writeFile(
      stubborn,
      `#!/bin/sh
trap '' TERM
echo '{"type":"system","subtype":"init","session_id":"sess-s","model":"m"}'
while IFS= read -r line; do :; done
`,
    );
    await chmod(stubborn, 0o755);
    const runner = new AgentRunner(dir, { command: stubborn }, "stubborn");
    await runner.say("human", "hi");
    await waitFor(() => runner.status().events.some((e) => e.kind === "system"));
    const t = Date.now();
    await runner.close(100);
    expect(runner.status().alive).toBe(false);
    expect(Date.now() - t).toBeGreaterThanOrEqual(90);
    await runner.close(); // nothing open: returns at once
  });

  it("resumeCommand quotes for the shell", () => {
    expect(resumeCommand("/home/me/repo", "abc-123")).toBe(
      "cd /home/me/repo && claude --resume abc-123",
    );
    expect(resumeCommand("/home/me/my repo's", "abc", "/opt/bin/claude")).toBe(
      "cd '/home/me/my repo'\\''s' && /opt/bin/claude --resume abc",
    );
  });

  it("notifyAnswer writes a board message only when a session exists", async () => {
    const runner = new AgentRunner(dir, { command: fake }, "test");
    await new Promise((r) => setTimeout(r, 20));
    const vars = { question_id: "q-20260922-aaaa", topic_id: "t1", answer: "yes", question: "?" };
    expect(await runner.notifyAnswer(vars)).toBe(false); // no session yet
    expect(await readdir(path.join(dir, ".longe")).then((f) => f.includes("messages"))).toBe(false);
    await runner.say("human", "start");
    expect(await runner.notifyAnswer(vars)).toBe(true); // also while working
    await waitFor(() => runner.status().pending === 0 && (runner.status().events.length ?? 0) >= 8);
    expect(await inputLines()).toEqual(["start", answeredPrompt(vars)]);
    expect((await runner.messages())[1]?.fm.from).toBe("board");
    expect(answeredPrompt(vars)).toContain(
      "Question q-20260922-aaaa on topic `t1` was answered: yes",
    );
    runner.stop();
    await waitFor(() => !runner.status().alive);
  });

  it("notifyActivated starts the chat even without a session", async () => {
    const runner = new AgentRunner(dir, { command: fake }, "test");
    const vars = { id: "t1", title: "T one", from: "review", note: "tests missing" };
    await runner.notifyActivated(vars);
    await waitFor(() => runner.status().pending === 0 && runner.status().sessionId !== undefined);
    expect(await inputLines()).toEqual([activatedPrompt(vars)]);
    expect((await runner.messages())[0]?.fm.from).toBe("board");
    expect(activatedPrompt(vars)).toContain(
      'moved topic `t1` ("T one") to active (from review; note: tests missing)',
    );
    expect(activatedPrompt({ id: "t1", title: "T", from: "backlog" })).toContain("(from backlog)");
    runner.stop();
    await waitFor(() => !runner.status().alive);
  });

  it("reports a missing binary instead of throwing; the message waits", async () => {
    const runner = new AgentRunner(dir, { command: path.join(dir, "nope") }, "test");
    await runner.say("human", "go");
    await waitFor(() => runner.status().events.length > 0);
    expect(runner.status().events[0]?.text).toMatch(/not found|ENOENT/);
    await waitFor(() => !runner.status().alive);
    expect((await runner.messages())[0]?.fm.delivered_at).toBeUndefined();
  });
});

describe("agent over HTTP", () => {
  let ctx: AppContext;
  afterEach(async () => {
    await closeAppContext(ctx);
  });

  it("todo is a queue: the free chat gets the oldest todo topic, each once, never while one is active", async () => {
    await writeFile(
      path.join(dir, ".longe/config.yml"),
      `version: 1\nproject: P\nagent:\n  command: ${JSON.stringify(fake)}\n`,
    );
    const topic = (id: string, status: string, at: string) =>
      writeFile(
        path.join(dir, `.longe/topics/${id}.md`),
        newTopicText({ id, title: id.toUpperCase(), goal: "g", now: new Date(at) }).replace(
          "status: backlog",
          `status: ${status}`,
        ),
      );
    await topic("busy", "active", "2026-09-23T08:00:00Z");
    await topic("second", "todo", "2026-09-23T10:00:00Z");
    await topic("first", "todo", "2026-09-23T09:00:00Z");
    await topic("parked", "backlog", "2026-09-23T07:00:00Z");
    ctx = await createAppContext(dir, {
      index: { debounceMs: 20, usePolling: true },
      drivesChat: true,
    });
    // a topic is active: the queue waits
    await new Promise((r) => setTimeout(r, 150));
    expect(await inputLines()).toEqual([]);

    await setTopicStatus(ctx, "busy", "review", "agent");
    // the fake agent never picks the topic up; once idle, it gets the next one, then stops
    await waitFor(() => ctx.agent.status().events.filter((e) => e.kind === "result").length >= 2);
    await new Promise((r) => setTimeout(r, 150));
    expect(await inputLines()).toEqual([
      todoPrompt({ id: "first", title: "FIRST" }),
      todoPrompt({ id: "second", title: "SECOND" }),
    ]);
  });

  it("chat page has the prompt box; board and topic pages link to it; topic prompt lands in the chat", async () => {
    await writeFile(
      path.join(dir, ".longe/config.yml"),
      `version: 1\nproject: P\nagent:\n  command: ${JSON.stringify(fake)}\n`,
    );
    await writeFile(
      path.join(dir, ".longe/topics/t1.md"),
      newTopicText({ id: "t1", title: "Topic one", goal: "g", now: new Date() }),
    );
    ctx = await createAppContext(dir, { index: { debounceMs: 20, usePolling: true } });
    const app = createHttpApp(ctx, { port: 1 });

    const board = await (await app.request("/board")).text();
    expect(board).not.toContain('hx-post="/agent/');
    expect(board).toContain('href="/chat"');
    expect(board).toContain('id="agent-badge" class="state-badge quiet"');
    expect(board).toContain("<i></i>off</span>");
    const chat = await (await app.request("/chat")).text();
    expect(chat).toContain('hx-post="/agent/prompt"');
    expect(chat).toContain("new session");
    expect(chat).toContain("no session · the next message starts fresh");
    expect(chat).toMatch(/hx-post="\/agent\/continue"[^>]*disabled/);
    // hotkeys must work on arrival: the prompt is focused with `/`, not on load
    expect(chat).not.toContain("autofocus");
    expect(chat).toContain("No messages yet.");
    // no session yet: no slash commands to offer
    expect(await (await app.request("/agent/commands")).json()).toEqual([]);
    const topic = await (await app.request("/topics/t1")).text();
    expect(topic).toContain('action="/agent/prompt"');
    expect(topic).toContain('name="topic" value="t1"');

    const post = (url: string, data: Record<string, string>, hx = true) =>
      app.request(url, {
        method: "POST",
        body: new URLSearchParams(data),
        headers: hx ? { "hx-request": "true" } : {},
      });
    expect((await post("/agent/prompt", { prompt: " " })).status).toBe(400);
    expect((await post("/agent/prompt", { prompt: "x", topic: "nope" })).status).toBe(404);
    // a plain form post from the topic page redirects to the chat
    const fromTopic = await post("/agent/prompt", { prompt: "do it", topic: "t1" }, false);
    expect(fromTopic.status).toBe(303);
    expect(fromTopic.headers.get("location")).toBe("/chat");
    await waitFor(() => ctx.agent.status().pending === 0 && ctx.agent.status().alive);
    // the init line's commands, internal ones left out
    expect(await (await app.request("/agent/commands")).json()).toEqual(["compact"]);
    expect(await inputLines()).toEqual(['On topic `t1` ("Topic one"):\ndo it']);
    expect(await (await app.request("/fragments/agent-badge")).text()).toContain("idle");

    const panel = await (await app.request("/fragments/agent")).text();
    expect(panel).toContain("<strong>You</strong>");
    expect(panel).toContain('href="/topics/t1"');
    expect(panel).toContain("All done 1");
    expect(panel).toContain("<code>Read a.ts</code>");
    expect(panel).toContain("context 41k / 200k");
    expect(panel).toContain("$0.01");
    const args = (await readFile(argsFile, "utf8")).split("\n");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe(
      '{"mcpServers":{"longe":{"type":"http","url":"http://127.0.0.1:1/mcp"}}}',
    );
    // a second message goes into the same open process
    expect((await post("/agent/prompt", { prompt: "and more" })).status).toBe(200);
    await waitFor(() => ctx.agent.status().events.filter((e) => e.kind === "result").length === 2);
    expect(await inputLines()).toHaveLength(2);
    const after = await (await app.request("/chat")).text();
    expect(after).toContain("session <code>sess-1</code>");
    // a button copies the command that resumes this session in a terminal
    const cmd = resumeCommand(dir, "sess-1", fake).replace(/&/g, "&amp;");
    expect(after).toContain(`data-copy="${cmd}"`);
    expect(after).toContain("and more");
    // the agent spoke last: Continue is offered and sends the canned message
    expect(after).toContain('hx-post="/agent/continue"');
    expect((await post("/agent/continue", {})).status).toBe(200);
    await waitFor(() => ctx.agent.status().events.filter((e) => e.kind === "result").length === 3);
    expect((await inputLines()).at(-1)).toBe(CONTINUE_PROMPT);
    // Work on board sends the board-work message into the same session
    expect(after).toContain('hx-post="/agent/work"');
    expect((await post("/agent/work", {})).status).toBe(200);
    await waitFor(() => ctx.agent.status().events.filter((e) => e.kind === "result").length === 4);
    expect((await inputLines()).at(-1)).toBe(WORK_PROMPT);
    expect((await post("/agent/stop", {})).status).toBe(200);
    await waitFor(() => !ctx.agent.status().alive);
    expect(await (await app.request("/fragments/agent-badge")).text()).toContain("off");
    // the model select: config default shown, a choice is remembered and rendered selected
    expect(after).toContain('hx-post="/agent/model"');
    expect(after).toMatch(/<option value="" selected[^>]*>default model<\/option>/);
    const picked = await (await post("/agent/model", { model: "haiku" })).text();
    expect(picked).toMatch(/<option value="haiku" selected[^>]*>haiku<\/option>/);
    expect(picked).not.toMatch(/<option value="" selected/);
    expect(ctx.agent.status().model).toBe("haiku");
    await post("/agent/model", { model: "" });
    expect(ctx.agent.status().model).toBeUndefined();
    // Clear history empties the transcript and the message files, keeps the session
    // every action button is always rendered; unavailable ones are disabled
    expect(after).toMatch(/hx-post="\/agent\/clear"[^>]*>/);
    expect(after).not.toMatch(/hx-post="\/agent\/clear"[^>]*disabled/);
    const cleared = await (await post("/agent/clear", {})).text();
    expect(cleared).toContain("No messages yet.");
    expect(cleared).toMatch(/hx-post="\/agent\/clear"[^>]*disabled/);
    expect(cleared).not.toMatch(/hx-post="\/agent\/reset"[^>]*disabled/);
    expect(cleared).toMatch(/hx-post="\/agent\/stop"[^>]*disabled/);
    expect(await ctx.agent.messages()).toEqual([]);
  });

  it("answering a question is told to the chat", async () => {
    await writeFile(
      path.join(dir, ".longe/config.yml"),
      `version: 1\nproject: P\nagent:\n  command: ${JSON.stringify(fake)}\n`,
    );
    await writeFile(
      path.join(dir, ".longe/topics/t1.md"),
      newTopicText({ id: "t1", title: "Topic one", goal: "g", now: new Date() }),
    );
    const q = (id: string, question: string) =>
      newQuestionText({
        id,
        topic: "t1",
        asked_by: "agent",
        question,
        blocking: false,
        assumption: "first",
        now: new Date(),
      });
    await writeFile(
      path.join(dir, ".longe/questions/q-20260922-aaaa.md"),
      q("q-20260922-aaaa", "Which?"),
    );
    ctx = await createAppContext(dir, {
      index: { debounceMs: 20, usePolling: true },
      drivesChat: true,
    });
    createHttpApp(ctx, { port: 1 });
    // no session yet: nothing happens; the answer waits (the question stays `answered`)
    await answerQuestion(ctx, "q-20260922-aaaa", { answer: "the first" });
    await new Promise((r) => setTimeout(r, 50));
    expect(await ctx.agent.messages()).toEqual([]);
    // once the chat exists and its turn is over, the waiting answer is handed over
    await ctx.agent.say("human", "hi");
    await waitFor(() => ctx.agent.status().events.filter((e) => e.kind === "result").length === 2);
    let msgs = await ctx.agent.messages();
    expect(msgs[1]?.fm.from).toBe("board");
    expect(msgs[1]?.text).toContain(
      "Question q-20260922-aaaa on topic `t1` was answered: the first",
    );
    // a later answer is announced once; the one already told is not repeated
    await writeFile(
      path.join(dir, ".longe/questions/q-20260922-bbbb.md"),
      q("q-20260922-bbbb", "And?"),
    );
    await ctx.index.refresh("question", "q-20260922-bbbb");
    await answerQuestion(ctx, "q-20260922-bbbb", { answer: "that one" });
    await waitFor(() => ctx.agent.status().events.filter((e) => e.kind === "result").length === 3);
    await new Promise((r) => setTimeout(r, 150));
    msgs = await ctx.agent.messages();
    expect(msgs).toHaveLength(3);
    expect(msgs[2]?.text).toContain("q-20260922-bbbb");
    expect(msgs[2]?.text).not.toContain("q-20260922-aaaa");
  });

  it("an answer given mid-turn waits and is handed over when the turn ends", async () => {
    // a slow agent: every turn takes 0.6 s
    const slow = path.join(dir, "fake-slow");
    await writeFile(
      slow,
      `#!/bin/sh
while IFS= read -r line; do
  printf '%s\\n' "$line" >> ${JSON.stringify(inputFile)}
  sleep 0.6
  echo '{"type":"system","subtype":"init","session_id":"s","model":"m"}'
  echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"s"}'
done
`,
    );
    await chmod(slow, 0o755);
    await writeFile(
      path.join(dir, ".longe/config.yml"),
      `version: 1\nproject: P\nagent:\n  command: ${JSON.stringify(slow)}\n`,
    );
    await writeFile(
      path.join(dir, ".longe/questions/q-20260922-cccc.md"),
      newQuestionText({
        id: "q-20260922-cccc",
        asked_by: "agent",
        question: "Now?",
        blocking: false,
        assumption: "x",
        now: new Date(),
      }),
    );
    ctx = await createAppContext(dir, {
      index: { debounceMs: 20, usePolling: true },
      drivesChat: true,
    });
    await ctx.agent.say("human", "work");
    let lines: (string | undefined)[] = [];
    for (let i = 0; i < 100 && lines.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      lines = await inputLines();
    }
    expect(ctx.agent.busy()).toBe(true);
    await answerQuestion(ctx, "q-20260922-cccc", { answer: "yes, now" });
    await new Promise((r) => setTimeout(r, 100));
    expect(await inputLines()).toEqual(["work"]); // not pushed into the running turn
    await waitFor(
      () => ctx.agent.status().events.filter((e) => e.kind === "result").length >= 2,
      5000,
    );
    lines = await inputLines();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("Question q-20260922-cccc was answered: yes, now");
  });

  it("a message folded into the running turn does not leave the chat busy for good", async () => {
    // answers "work" with a result, but folds "extra" into it (no result of its own)
    const folding = path.join(dir, "fake-folding");
    await writeFile(
      folding,
      `#!/bin/sh
while IFS= read -r line; do
  printf '%s\\n' "$line" >> ${JSON.stringify(inputFile)}
  case "$line" in
    *extra*) ;;
    *)
      sleep 0.3
      echo '{"type":"system","subtype":"init","session_id":"s","model":"m"}'
      echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"s"}' ;;
  esac
done
`,
    );
    await chmod(folding, 0o755);
    const runner = new AgentRunner(dir, { command: folding }, "fold");
    let idle = 0;
    runner.on("agent:idle", () => idle++);
    await runner.say("human", "work");
    await runner.say("human", "extra");
    await waitFor(() => runner.status().events.some((e) => e.kind === "result"));
    expect(runner.busy()).toBe(true); // one message still counted
    await waitFor(() => !runner.busy(), SETTLE_MS + 2000);
    expect(idle).toBe(1);
    await runner.close();
  }, 10000);

  it("answersPrompt: one answer reads like before, several are listed", () => {
    const one = { question_id: "q-1", topic_id: "t", answer: "yes" };
    expect(answersPrompt([one])).toBe(answeredPrompt(one));
    const two = answersPrompt([one, { question_id: "q-2", answer: "Tea\n\nwith milk" }]);
    expect(two).toContain("2 questions were answered:");
    expect(two).toContain("- q-1 on topic `t`: yes");
    expect(two).toContain("- q-2: Tea / with milk");
  });

  it("a process that does not drive the chat (longe mcp) never wakes it", async () => {
    await writeFile(
      path.join(dir, ".longe/config.yml"),
      `version: 1\nproject: P\nagent:\n  command: ${JSON.stringify(fake)}\n`,
    );
    await writeFile(
      path.join(dir, ".longe/topics/t1.md"),
      newTopicText({ id: "t1", title: "T", goal: "g", status: "todo", now: new Date() }),
    );
    ctx = await createAppContext(dir, { index: { debounceMs: 20, usePolling: true } });
    await new Promise((r) => setTimeout(r, 150));
    expect(await inputLines()).toEqual([]);
    expect(ctx.agent.status().alive).toBe(false);
  });
});
