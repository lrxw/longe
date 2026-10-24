import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAppContext, createAppContext } from "../src/app/context.js";
import { parseAskArgs, runAsk } from "../src/cli/ask.js";
import { runInit } from "../src/cli/init.js";
import { questionsDir } from "../src/store/paths.js";
import { answerQuestion } from "../src/tools/ops.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "longe-ask-"));
  await runInit(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const questionFiles = async () =>
  (await readdir(questionsDir(dir)).catch(() => [])).filter((f) => f.endsWith(".md"));

describe("longe ask", () => {
  it("parses the question, options, subject and wait", () => {
    const a = parseAskArgs([
      "Ship",
      "it?",
      "--option",
      "Yes",
      "--option",
      "No, wait",
      "--subject",
      "pr:7",
      "--subject-url",
      "https://example.com/pr/7",
      "--wait",
      "60",
    ]);
    expect(a).toMatchObject({
      question: "Ship it?",
      options: ["Yes", "No, wait"],
      subject: { kind: "pr", id: "7", url: "https://example.com/pr/7" },
      wait: 60,
      askedBy: "cli",
    });
    expect(() => parseAskArgs([])).toThrow(/question is missing/);
    expect(() => parseAskArgs(["Q", "--subject", "nocolon"])).toThrow(/kind:id/);
    expect(() => parseAskArgs(["Q", "--wait", "0"])).toThrow(/Invalid --wait/);
    expect(() => parseAskArgs(["Q", "--subject-url", "x"])).toThrow(/needs --subject/);
  });

  it("puts a blocking question into the inbox and prints its id", async () => {
    const out: string[] = [];
    const code = await runAsk(parseAskArgs(["Deploy now?", "--repo", dir]), (t) => out.push(t));
    expect(code).toBe(0);
    const [file] = await questionFiles();
    expect(out.join("").trim()).toBe(file?.replace(/\.md$/, ""));
    const text = await readFile(path.join(questionsDir(dir), file ?? ""), "utf8");
    expect(text).toContain("blocking: true");
    expect(text).toContain("asked_by: cli");
  });

  it("--wait prints the answer the human picked; exit 3 when none came", async () => {
    const out: string[] = [];
    const run = runAsk(
      parseAskArgs(["Which?", "--option", "A", "--option", "B", "--wait", "20", "--repo", dir]),
      (t) => out.push(t),
    );
    // the human answers from another process (here: another app context on the folder)
    let file: string | undefined;
    for (let i = 0; i < 200 && !file; i++) {
      [file] = await questionFiles();
      if (!file) await new Promise((r) => setTimeout(r, 25));
    }
    const human = await createAppContext(dir, { index: { debounceMs: 20, usePolling: true } });
    try {
      await answerQuestion(human, (file ?? "").replace(/\.md$/, ""), { option_index: 1 });
    } finally {
      await closeAppContext(human);
    }
    expect(await run).toBe(0);
    expect(out.join("")).toBe("B\n");

    const later: string[] = [];
    const code = await runAsk(
      parseAskArgs(["Still there?", "--assumption", "no", "--wait", "1", "--json", "--repo", dir]),
      (t) => later.push(t),
    );
    expect(code).toBe(3);
    expect(JSON.parse(later.join(""))).toMatchObject({ status: "timeout", answer: "" });
  });
});
