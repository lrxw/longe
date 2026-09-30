import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CODEX_ASK_PROMPT,
  CODEX_STOP_COMMAND,
  codexHooksPath,
  codexStop,
} from "../src/cli/codex-hooks.js";
import { deepIntegrate, removeDeepIntegration } from "../src/cli/deep-integrate.js";
import { runInit } from "../src/cli/init.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "longe-deep-integrate-"));
  await rm(path.join(process.env.CODEX_HOME as string, "hooks.json"), { force: true });
  await runInit(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const json = async (file: string) => JSON.parse(await readFile(file, "utf8"));

describe("longe provider deep-integrate", () => {
  it("each provider gets what it supports, in the user's own files; --remove clears them", async () => {
    const results = await deepIntegrate(dir);
    expect(results.map((r) => [r.provider, r.changed])).toEqual([
      ["claude", true],
      ["codex", true],
    ]);
    const codexFile = codexHooksPath(dir);
    expect(codexFile).toBe(path.join(process.env.CODEX_HOME as string, "hooks.json"));
    expect((await json(codexFile)).hooks.Stop).toEqual([
      { hooks: [{ type: "command", command: CODEX_STOP_COMMAND, timeout: 10 }] },
    ]);
    expect(
      (await json(path.join(dir, ".claude/settings.local.json"))).hooks.PreToolUse,
    ).toHaveLength(1);
    expect((await deepIntegrate(dir)).every((r) => !r.changed)).toBe(true);

    const removed = await removeDeepIntegration(dir);
    expect(removed.map((r) => r.provider)).toEqual(["claude", "codex"]);
    expect(await json(codexFile)).toEqual({});
    expect(await removeDeepIntegration(dir)).toEqual([]);
  });

  it("a named provider only; other hooks in the file stay; --shared uses the repo's files", async () => {
    await mkdir(path.join(dir, ".codex"));
    await writeFile(
      path.join(dir, ".codex/hooks.json"),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] } }),
    );
    const results = await deepIntegrate(dir, { providers: ["codex"], shared: true });
    expect(results.map((r) => r.file)).toEqual([".codex/hooks.json"]);
    const stop = (await json(path.join(dir, ".codex/hooks.json"))).hooks.Stop;
    expect(stop).toHaveLength(2);
    await expect(stat(path.join(dir, ".claude/settings.json"))).rejects.toThrow();
    await removeDeepIntegration(dir, { providers: ["codex"], shared: true });
    expect((await json(path.join(dir, ".codex/hooks.json"))).hooks.Stop).toEqual([
      { hooks: [{ type: "command", command: "mine" }] },
    ]);
    await expect(deepIntegrate(dir, { providers: ["gemini"] })).rejects.toThrow(/unknown provider/);
  });
});

describe("Codex Stop hook", () => {
  it("sends the turn on once when the reply ends with a question, inside a longe repo", async () => {
    const out = await codexStop({ cwd: dir, last_assistant_message: "Done.\n\nShould I commit?" });
    expect(JSON.parse(out ?? "{}")).toEqual({ decision: "block", reason: CODEX_ASK_PROMPT });
    // already continued once, no question, or no .longe/ above: let it stop
    expect(
      await codexStop({ cwd: dir, stop_hook_active: true, last_assistant_message: "Ok?" }),
    ).toBeUndefined();
    expect(await codexStop({ cwd: dir, last_assistant_message: "All done." })).toBeUndefined();
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), "longe-no-board-"));
    try {
      expect(await codexStop({ cwd: elsewhere, last_assistant_message: "Ok?" })).toBeUndefined();
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
    await writeFile(path.join(dir, ".longe/config.yml"), "version: 1\nask_in_inbox: false\n");
    expect(await codexStop({ cwd: dir, last_assistant_message: "Ok?" })).toBeUndefined();
  });
});
