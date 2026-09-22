import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AppContext, closeAppContext, createAppContext } from "../src/app/context.js";
import { expandCommand, HookRunner, shellQuote } from "../src/app/hooks.js";
import { collectAnswers, formatAnswersForAgent } from "../src/cli/answers.js";
import { runInit } from "../src/cli/init.js";
import { createHttpApp } from "../src/http/app.js";
import { parseConfig } from "../src/store/config.js";
import { newQuestionText } from "../src/store/question.js";
import { newTopicText } from "../src/store/topic.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "longe-hooks-"));
  process.env.XDG_CACHE_HOME = path.join(dir, "cache");
  await runInit(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function waitFor(fn: () => boolean, ms = 10000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("hook command expansion", () => {
  it("maps placeholders to env references", () => {
    expect(shellQuote("it's")).toBe(String.raw`'it'\''s'`);
    expect(expandCommand("run {question_id} {answer}")).toBe(
      'run "$LONGE_QUESTION_ID" "$LONGE_ANSWER"',
    );
    expect(expandCommand('say "answer: {answer}"')).toBe('say "answer: "$LONGE_ANSWER""');
  });

  it("config accepts hooks and the init template parses", async () => {
    const text = await readFile(path.join(dir, ".ai/config.yml"), "utf8");
    expect(parseConfig(text).hooks).toBeUndefined();
    expect(parseConfig("version: 1\nhooks:\n  on_answer: echo hi\n").hooks?.on_answer).toBe(
      "echo hi",
    );
  });
});

describe("HookRunner", () => {
  it("runs the command with env + cwd, coalesces overlapping triggers, logs output", async () => {
    const marker = path.join(dir, "ran.txt");
    const runner = new HookRunner(
      dir,
      {
        on_answer: `sleep 0.3; echo "$LONGE_QUESTION_ID:{answer}:$(pwd)" >> ${shellQuote(marker)}`,
      },
      "test",
    );
    const statuses: string[] = [];
    runner.on("hook:changed", (s) => statuses.push(`${s.running ? "run" : "idle"}/${s.queued}`));
    expect(runner.trigger("on_answer", { question_id: "q-1", answer: "a1" })).toBe(true);
    expect(runner.trigger("on_answer", { question_id: "q-2", answer: "a2" })).toBe(true);
    expect(runner.trigger("on_answer", { question_id: "q-3", answer: "a3" })).toBe(true); // replaces q-2
    await waitFor(() => runner.status().last?.vars.question_id === "q-3");
    const lines = (await readFile(marker, "utf8")).trim().split("\n");
    const real = await realpath(dir);
    expect(lines).toEqual([`q-1:a1:${real}`, `q-3:a3:${real}`]);
    expect(runner.status().last?.exitCode).toBe(0);
    expect(statuses[0]).toBe("run/0");
    expect(statuses).toContain("run/1");
    const log = await readFile(runner.logFile, "utf8");
    expect(log).toContain("=== exit 0 ===");
    expect(runner.logFile.startsWith(path.join(dir, "cache", "longe", "hooks"))).toBe(true);
  });

  it("does nothing when no hook is configured", () => {
    const runner = new HookRunner(dir, {}, "none");
    expect(runner.trigger("on_answer", {})).toBe(false);
    expect(runner.status().configured).toEqual([]);
  });
});

describe("on_answer end to end", () => {
  let ctx: AppContext;
  afterEach(async () => {
    await closeAppContext(ctx);
  });

  it("fires on a REST answer and on a hand-edited answer", async () => {
    const marker = path.join(dir, "hook.txt");
    await writeFile(
      path.join(dir, ".ai/config.yml"),
      `version: 1\nhooks:\n  on_answer: echo "{question_id}|{topic_id}|{answer}" >> ${shellQuote(marker)}\n`,
    );
    await writeFile(
      path.join(dir, ".ai/topics/t.md"),
      newTopicText({ id: "t", title: "T", goal: "g", now: new Date() }),
    );
    for (const id of ["q-20260922-aaaa", "q-20260922-bbbb"]) {
      await writeFile(
        path.join(dir, ".ai/questions", `${id}.md`),
        newQuestionText({
          id,
          question: `Q ${id}?`,
          blocking: false,
          assumption: "x",
          topic: "t",
          asked_by: "a",
          now: new Date(),
        }),
      );
    }
    ctx = await createAppContext(dir, { index: { debounceMs: 20, usePolling: true } });
    const app = createHttpApp(ctx);
    const res = await app.request("/api/v1/answer_question", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "q-20260922-aaaa", answer: "Yes." }),
    });
    expect(res.status).toBe(200);
    await waitFor(() => ctx.hooks.status().last !== undefined);
    expect(await readFile(marker, "utf8")).toBe("q-20260922-aaaa|t|Yes.\n");

    // hand edit the second one
    const f = path.join(dir, ".ai/questions/q-20260922-bbbb.md");
    const text = await readFile(f, "utf8");
    await writeFile(
      f,
      text.replace("status: open", "status: answered").replace("## Answer\n", "## Answer\nNo.\n"),
    );
    await waitFor(() => ctx.hooks.status().last?.vars.question_id === "q-20260922-bbbb");
    expect(await readFile(marker, "utf8")).toBe("q-20260922-aaaa|t|Yes.\nq-20260922-bbbb|t|No.\n");

    // the inbox shows hook status
    const html = await (await app.request("/")).text();
    expect(html).toContain("on_answer");

    // `longe answers` sees both as pending
    const answers = await collectAnswers(dir);
    expect(answers.map((a) => a.id).sort()).toEqual(["q-20260922-aaaa", "q-20260922-bbbb"]);
    const txt = formatAnswersForAgent(answers);
    expect(txt).toContain("2 answered questions");
    expect(txt).toContain("A: Yes.");
    expect(formatAnswersForAgent([])).toBe("");
  });
});
