import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../src/cli/init.js";
import { EffectRunner } from "../src/index/effects.js";
import { AiIndex, type QuestionChange, type TopicChange } from "../src/index/index.js";
import { newQuestionText } from "../src/store/question.js";
import { Repo } from "../src/store/repo.js";
import { newTopicText } from "../src/store/topic.js";

let dir: string;
let index: AiIndex;
const now = new Date();

async function waitFor(fn: () => boolean, ms = 10000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const topicFile = (id: string) => path.join(dir, ".ai/topics", `${id}.md`);
const questionFile = (id: string) => path.join(dir, ".ai/questions", `${id}.md`);

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "longe-index-"));
  await runInit(dir);
});

afterEach(async () => {
  await index?.stop();
  await rm(dir, { recursive: true, force: true });
});

describe("AiIndex", () => {
  it("a second write within chokidar's 50ms change throttle is not lost", async () => {
    await writeFile(topicFile("quick"), newTopicText({ id: "quick", title: "Q", goal: "g", now }));
    index = new AiIndex(dir, { debounceMs: 20, usePolling: true });
    await index.start();
    const text = await readFile(topicFile("quick"), "utf8");
    // the moment the first change is indexed (20ms debounce after chokidar's event),
    // write again: that is inside chokidar's 50ms window, so its event is dropped
    const seen = new Promise<void>((resolve) =>
      index.on("topic:changed", (c) => {
        if (c.current?.fm.status === "active") resolve();
      }),
    );
    await writeFile(topicFile("quick"), text.replace("status: backlog", "status: active"));
    await seen;
    await writeFile(topicFile("quick"), text.replace("status: backlog", "status: review"));
    await waitFor(() => index.topics.get("quick")?.fm.status === "review", 2000);
  });

  it("re-reading a file with unchanged text emits nothing", async () => {
    await writeFile(topicFile("same"), newTopicText({ id: "same", title: "S", goal: "g", now }));
    index = new AiIndex(dir, { debounceMs: 20, usePolling: true });
    await index.start();
    const events: TopicChange[] = [];
    index.on("topic:changed", (c) => events.push(c));
    await index.refresh("topic", "same");
    expect(events).toEqual([]);
  });

  it("indexes existing files on start and tracks add/change/delete", async () => {
    await writeFile(
      topicFile("first"),
      newTopicText({ id: "first", title: "First", goal: "g", now }),
    );
    index = new AiIndex(dir, { debounceMs: 20, usePolling: true });
    const topicEvents: TopicChange[] = [];
    const questionEvents: QuestionChange[] = [];
    index.on("topic:changed", (c) => topicEvents.push(c));
    index.on("question:changed", (c) => questionEvents.push(c));
    await index.start();
    expect([...index.topics.keys()]).toEqual(["first"]);
    expect(topicEvents.map((e) => e.type)).toEqual(["added"]);

    // add a question by hand
    await writeFile(
      questionFile("q-20260922-aaaa"),
      newQuestionText({
        id: "q-20260922-aaaa",
        question: "Q?",
        blocking: false,
        assumption: "x",
        topic: "first",
        asked_by: "me",
        now,
      }),
    );
    await waitFor(() => index.questions.has("q-20260922-aaaa"));
    expect(questionEvents.at(-1)).toMatchObject({ id: "q-20260922-aaaa", type: "added" });
    expect(index.openQuestionCount("first")).toBe(1);
    expect(index.openBlockingCount("first")).toBe(0);

    // change the topic
    const text = await readFile(topicFile("first"), "utf8");
    await writeFile(topicFile("first"), text.replace("status: backlog", "status: active"));
    await waitFor(() => index.topics.get("first")?.fm.status === "active");
    expect(topicEvents.at(-1)).toMatchObject({ id: "first", type: "changed" });
    expect(topicEvents.at(-1)?.previous?.fm.status).toBe("backlog");

    // delete
    await unlink(questionFile("q-20260922-aaaa"));
    await waitFor(() => !index.questions.has("q-20260922-aaaa"));
    expect(questionEvents.at(-1)).toMatchObject({ id: "q-20260922-aaaa", type: "removed" });
    expect(index.openQuestionCount("first")).toBe(0);
  });

  it("surfaces malformed files as errors and drops them from the index", async () => {
    index = new AiIndex(dir, { debounceMs: 20, usePolling: true });
    await index.start();
    await writeFile(topicFile("bad"), "---\nid: bad\ntitle: Bad\nstatus: nope\n---\n## Goal\n");
    await waitFor(() => index.errors.size === 1);
    expect(index.topics.has("bad")).toBe(false);
    expect([...index.errors.values()][0]?.message).toMatch(/status/);
    // fix it
    await writeFile(topicFile("bad"), newTopicText({ id: "bad", title: "Bad", goal: "g", now }));
    await waitFor(() => index.topics.has("bad"));
    expect(index.errors.size).toBe(0);
  });

  it("orders the inbox blocking first, then oldest", async () => {
    index = new AiIndex(dir, { debounceMs: 20, usePolling: true });
    await index.start();
    const mk = (id: string, blocking: boolean, at: Date) =>
      writeFile(
        questionFile(id),
        newQuestionText({ id, question: id, blocking, assumption: "a", asked_by: "me", now: at }),
      );
    await mk("q-20260922-nb01", false, new Date(2026, 8, 22, 9));
    await mk("q-20260922-bl02", true, new Date(2026, 8, 22, 10));
    await mk("q-20260922-bl01", true, new Date(2026, 8, 22, 8));
    await mk("q-20260922-nb02", false, new Date(2026, 8, 22, 7));
    await waitFor(() => index.questions.size === 4);
    expect(index.inbox().map((q) => q.id)).toEqual([
      "q-20260922-bl01",
      "q-20260922-bl02",
      "q-20260922-nb02",
      "q-20260922-nb01",
    ]);
    expect(index.blockingCount()).toBe(2);
  });
});

describe("EffectRunner (§7.4 external changes)", () => {
  const notifications: string[] = [];
  let runner: EffectRunner;

  beforeEach(async () => {
    notifications.length = 0;
    await writeFile(
      topicFile("t"),
      newTopicText({ id: "t", title: "Topic T", goal: "g", now }).replace(
        "status: backlog",
        "status: active",
      ),
    );
    index = new AiIndex(dir, { debounceMs: 20, usePolling: true });
    runner = new EffectRunner(index, new Repo(dir), (title, body) =>
      notifications.push(`${title}: ${body}`),
    );
    runner.attach();
    await index.start();
  });

  it("hand-written blocking question moves the topic to needs-decision and notifies", async () => {
    await writeFile(
      questionFile("q-20260922-bbbb"),
      newQuestionText({
        id: "q-20260922-bbbb",
        question: "Which DB?",
        blocking: true,
        topic: "t",
        asked_by: "me",
        now,
      }),
    );
    await waitFor(() => index.topics.get("t")?.fm.status === "needs-decision");
    const text = await readFile(topicFile("t"), "utf8");
    expect(text).toContain("status: needs-decision");
    expect(text).toMatch(/system — blocked on q-20260922-bbbb/);
    expect(notifications).toEqual(["Which DB?: Blocking · Topic T"]);

    // answer it by editing the file → back to active
    const q = await readFile(questionFile("q-20260922-bbbb"), "utf8");
    await writeFile(questionFile("q-20260922-bbbb"), q.replace("status: open", "status: answered"));
    await waitFor(() => index.topics.get("t")?.fm.status === "active");
    expect(await readFile(topicFile("t"), "utf8")).toMatch(
      /system — q-20260922-bbbb answered, unblocked/,
    );
    expect(notifications).toHaveLength(1);
  });

  it("topic moves do not notify (only blocking questions do)", async () => {
    const text = await readFile(topicFile("t"), "utf8");
    await writeFile(topicFile("t"), text.replace("status: active", "status: review"));
    await waitFor(() => index.topics.get("t")?.fm.status === "review");
    runner.expect("t", "active");
    await writeFile(topicFile("t"), text);
    await waitFor(() => index.topics.get("t")?.fm.status === "active");
    await new Promise((r) => setTimeout(r, 100));
    expect(notifications).toEqual([]);
  });
});
