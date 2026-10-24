import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AppContext, closeAppContext, createAppContext } from "../src/app/context.js";
import { runInit } from "../src/cli/init.js";
import { InboxEvents, type QuestionEvent } from "../src/inbox/events.js";
import { newQuestionText, parseQuestion } from "../src/inbox/store.js";
import { subjectOf } from "../src/inbox/subject.js";
import { createMcpServer } from "../src/mcp/server.js";
import { questionsDir, topicsDir } from "../src/store/paths.js";
import { newTopicText } from "../src/store/topic.js";

const now = new Date("2026-10-24T12:00:00+02:00");

describe("the inbox module stands alone", () => {
  it("imports nothing from the board (topics, index, tools, app, http)", async () => {
    const dir = path.resolve("src/inbox");
    const offenders: string[] = [];
    for (const file of await readdir(dir)) {
      const text = await readFile(path.join(dir, file), "utf8");
      for (const m of text.matchAll(/from "([^"]+)"/g)) {
        const spec = m[1] ?? "";
        if (/\/(board|index|tools|app|http|mcp|cli)\/|topic/.test(spec))
          offenders.push(`${file}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("subject: written as a block, read back; `topic:` is its alias", () => {
    const issue = newQuestionText({
      id: "q-20261024-aaaa",
      question: "Merge it?",
      subject: { kind: "issue", id: "42", url: "https://example.com/issues/42" },
      blocking: true,
      asked_by: "ci",
      now,
    });
    expect(issue).toContain(
      'subject:\n  kind: issue\n  id: "42"\n  url: "https://example.com/issues/42"',
    );
    expect(issue).not.toContain("topic:");
    expect(subjectOf(parseQuestion(issue).fm)).toEqual({
      kind: "issue",
      id: "42",
      url: "https://example.com/issues/42",
    });
    // a topic subject stays `topic:` in the file, so older readers (and the mod) see it
    const board = newQuestionText({
      id: "q-20261024-bbbb",
      question: "Q?",
      subject: { kind: "topic", id: "billing" },
      blocking: true,
      asked_by: "a",
      now,
    });
    expect(board).toContain("topic: billing");
    expect(subjectOf(parseQuestion(board).fm)).toEqual({ kind: "topic", id: "billing" });
  });

  it("events: listeners run in order, are awaited, and a failing one does not stop the rest", async () => {
    const events = new InboxEvents();
    const seen: string[] = [];
    events.on(async () => {
      await new Promise((r) => setTimeout(r, 10));
      seen.push("first");
    });
    events.on(() => {
      throw new Error("boom");
    });
    const off = events.on((e) => {
      seen.push(`last:${e.kind}`);
    });
    const e: QuestionEvent = {
      kind: "asked",
      question: {
        id: "q-20261024-cccc",
        asked_by: "a",
        asked_at: "2026-10-24T12:00:00+02:00",
        status: "open",
        blocking: true,
      },
      text: "Q",
    };
    await events.emit(e);
    expect(seen).toEqual(["first", "last:asked"]);
    off();
    await events.emit(e);
    expect(seen).toEqual(["first", "last:asked", "first"]);
  });
});

describe("longe mcp --inbox-only", () => {
  let dir: string;
  let ctx: AppContext;
  let client: Client;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "longe-inbox-only-"));
    await runInit(dir);
    await writeFile(
      path.join(topicsDir(dir), "billing.md"),
      newTopicText({ id: "billing", title: "Billing", goal: "g", now }).replace(
        "status: backlog",
        "status: active",
      ),
    );
    ctx = await createAppContext(dir, { index: { debounceMs: 20, usePolling: true } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMcpServer(ctx, { inboxOnly: true }).connect(a);
    client = new Client({ name: "test", version: "0" });
    await client.connect(b);
  });

  afterEach(async () => {
    await client.close();
    await closeAppContext(ctx);
    await rm(dir, { recursive: true, force: true });
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    return { isError: res.isError === true, body: JSON.parse(res.content[0]?.text ?? "{}") };
  };

  it("offers only the inbox's tools and no board protocol", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "acknowledge_answers",
      "ask_question",
      "check_answers",
      "wait_for_answer",
      "withdraw_question",
    ]);
    const ask = (await client.listTools()).tools.find((t) => t.name === "ask_question");
    expect(ask?.description).not.toMatch(/topic/i);
    expect(client.getServerCapabilities()?.resources).toBeUndefined();
  });

  it("asks about any subject; answers come back; a topic subject still moves the topic", async () => {
    let r = await call("ask_question", {
      question: "Ship the release?",
      subject: { kind: "pull_request", id: "7", url: "https://example.com/pr/7" },
      options: ["Ship", "Wait"],
      blocking: false,
      assumption: "wait",
    });
    expect(r.isError).toBe(false);
    const id = r.body.id as string;
    const file = await readFile(path.join(questionsDir(dir), `${id}.md`), "utf8");
    expect(file).toContain("kind: pull_request");

    // the human answers (REST/UI path); the agent reads and acknowledges
    const { answerQuestion } = await import("../src/tools/ops.js");
    await answerQuestion(ctx, id, { option_index: 0 });
    r = await call("check_answers", {});
    expect(
      (r.body.questions as { id: string; answer: string }[]).map((q) => [q.id, q.answer]),
    ).toEqual([[id, "Ship"]]);
    r = await call("acknowledge_answers", { ids: [id] });
    expect(r.body.acknowledged).toEqual([id]);

    // a blocking question about a board topic: the board still reacts to the event
    r = await call("ask_question", {
      question: "Which provider?",
      subject: { kind: "topic", id: "billing" },
      blocking: true,
    });
    expect(r.isError).toBe(false);
    expect(ctx.index.topics.get("billing")?.fm.status).toBe("needs-decision");
    r = await call("ask_question", {
      question: "Q?",
      subject: { kind: "topic", id: "nope" },
      blocking: true,
    });
    expect(r.isError).toBe(true);
  });
});
