import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { askToInbox, HOOK_COMMAND, installHook, removeHook } from "../src/cli/hooks.js";
import { runInit } from "../src/cli/init.js";
import { parseQuestion } from "../src/store/question.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "longe-claude-hook-"));
  await runInit(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const settings = async () =>
  JSON.parse(await readFile(path.join(dir, ".claude/settings.json"), "utf8"));

describe("AskUserQuestion → inbox hook", () => {
  it("install adds the hook once and keeps other settings; remove takes it out again", async () => {
    await mkdir(path.join(dir, ".claude"));
    await writeFile(
      path.join(dir, ".claude/settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { Stop: [] } }),
    );
    expect(await installHook(dir)).toBe(true);
    expect(await installHook(dir)).toBe(false);
    const s = await settings();
    expect(s.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(s.hooks.Stop).toEqual([]);
    expect(s.hooks.PreToolUse).toEqual([
      { matcher: "AskUserQuestion", hooks: [{ type: "command", command: HOOK_COMMAND }] },
    ]);
    expect(await removeHook(dir)).toBe(true);
    expect(await removeHook(dir)).toBe(false);
    expect(await settings()).toEqual({ permissions: { allow: ["Bash(ls)"] }, hooks: { Stop: [] } });
  });

  it("the hook turns the question into a blocking inbox question and denies the tool", async () => {
    const sub = path.join(dir, "src/deep");
    await mkdir(sub, { recursive: true });
    const out = await askToInbox({
      cwd: sub, // the repo is found above the session's folder
      session_id: "abcdef123456",
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          {
            header: "Database",
            question: "Which database should we use?",
            options: [{ label: "Postgres", description: "Already in use" }, { label: "SQLite" }],
          },
        ],
      },
    });
    const files = await readdir(path.join(dir, ".ai/questions"));
    expect(files).toHaveLength(1);
    const q = parseQuestion(
      await readFile(path.join(dir, ".ai/questions", files[0] as string), "utf8"),
    );
    expect(q.fm.blocking).toBe(true);
    expect(q.fm.options).toEqual(["Postgres", "SQLite"]);
    expect(q.fm.asked_by).toBe("claude-code abcdef12");
    const reply = JSON.parse(out ?? "{}").hookSpecificOutput;
    expect(reply.permissionDecision).toBe("deny");
    expect(reply.permissionDecisionReason).toContain(q.fm.id);
    expect(reply.permissionDecisionReason).toContain("wait_for_answer");
  });

  it("lets the tool run when it is another tool, has no question, or no .ai/ is found", async () => {
    expect(await askToInbox({ cwd: dir, tool_name: "Bash" })).toBeUndefined();
    expect(
      await askToInbox({ cwd: dir, tool_name: "AskUserQuestion", tool_input: { questions: [] } }),
    ).toBeUndefined();
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), "longe-no-ai-"));
    try {
      expect(
        await askToInbox({
          cwd: elsewhere,
          tool_name: "AskUserQuestion",
          tool_input: { questions: [{ question: "Q?" }] },
        }),
      ).toBeUndefined();
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});
