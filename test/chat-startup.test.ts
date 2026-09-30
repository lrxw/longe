import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/app/agent.js";
import { createMultiHub, type Hub } from "../src/app/hub.js";
import { runInit } from "../src/cli/init.js";
import { answerQuestion } from "../src/domain/question-ops.js";
import { createHttpApp } from "../src/http/app.js";
import type { Message } from "../src/store/messages.js";
import { newQuestionText, parseQuestion, serializeQuestion } from "../src/store/question.js";
import { newTopicText } from "../src/store/topic.js";

let dir: string;
let hub: Hub | undefined;
let launches: { url: string | undefined; text: string }[];

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "longe-chat-startup-"));
  process.env.XDG_CONFIG_HOME = path.join(dir, "config");
  process.env.XDG_CACHE_HOME = path.join(dir, "cache");
  launches = [];
  vi.spyOn(AgentRunner.prototype, "say").mockImplementation(function (
    this: AgentRunner,
    from,
    text,
  ) {
    launches.push({ url: this.mcpUrl, text });
    return Promise.resolve({ fm: { from }, text } as Message);
  });
});

afterEach(async () => {
  await hub?.close();
  hub = undefined;
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function repo(name: string, work: "todo" | "answer") {
  const root = path.join(dir, name);
  await runInit(root);
  if (work === "todo") {
    await writeFile(
      path.join(root, ".longe/topics/task.md"),
      newTopicText({ id: "task", title: "Task", goal: "Work", now: new Date() }).replace(
        "status: backlog",
        "status: todo",
      ),
    );
  } else {
    const q = parseQuestion(
      newQuestionText({
        id: "q-20260929-test",
        question: "Continue?",
        asked_by: "agent",
        blocking: true,
        now: new Date(),
      }),
    );
    answerQuestion(q, { answer: "yes" }, new Date());
    await writeFile(path.join(root, ".longe/questions/q-20260929-test.md"), serializeQuestion(q));
  }
  return root;
}

describe("hub chat startup", () => {
  it.each(["todo", "answer"] as const)(
    "waits for endpoint wiring and the listener before delivering startup %s work",
    async (work) => {
      vi.spyOn(AgentRunner.prototype, "hasChat").mockReturnValue(true);
      const first = await repo("first", work);
      const options = { drivesChat: true, index: { usePolling: true, debounceMs: 10 } };
      hub = await createMultiHub([{ name: "first", root: first }], options);
      // Indexing existing work must not wake an agent before the HTTP app exists.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(launches).toEqual([]);
      let ready!: () => void;
      const chatReady = new Promise<void>((resolve) => {
        ready = resolve;
      });
      createHttpApp(hub, { port: 8123, chatReady });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(launches).toEqual([]);
      ready();
      await vi.waitFor(() => expect(launches).toHaveLength(1));
      expect(launches[0]?.url).toBe("http://127.0.0.1:8123/r/first/mcp");
      expect(launches[0]?.text).toContain(work === "todo" ? "task" : "q-20260929-test");
      // Registry refreshes must not attach duplicate queues.
      hub.emit("changed", { repo: "", kind: "repos", id: "" });
      expect(launches).toHaveLength(1);

      const later = await repo("later", "todo");
      await hub.add("later", later, options);
      hub.emit("changed", { repo: "", kind: "repos", id: "" });
      await vi.waitFor(() => expect(launches).toHaveLength(2));
      expect(launches[1]?.url).toBe("http://127.0.0.1:8123/r/later/mcp");
    },
  );

  it("does not start automatic chat for hubs that do not own it", async () => {
    const first = await repo("first", "todo");
    hub = await createMultiHub([{ name: "first", root: first }], {
      index: { usePolling: true },
    });
    createHttpApp(hub);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(launches).toEqual([]);
  });
});
