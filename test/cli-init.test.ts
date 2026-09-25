import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLAUDE_LINE, initProject, POINTER_LINE, runInit } from "../src/cli/init.js";
import { AGENT_INSTRUCTIONS } from "../src/domain/agent-instructions.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "longe-init-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("longe init", () => {
  it("creates the .longe layout", async () => {
    const result = await runInit(dir);

    expect((await stat(path.join(dir, ".longe/topics"))).isDirectory()).toBe(true);
    expect((await stat(path.join(dir, ".longe/questions"))).isDirectory()).toBe(true);
    expect(await readdir(path.join(dir, ".longe/topics"))).toEqual([]);
    expect(await readdir(path.join(dir, ".longe/questions"))).toEqual([]);

    const config = await readFile(path.join(dir, ".longe/config.yml"), "utf8");
    expect(config).toMatch(/^version: 1\n/);
    expect(config).toContain(`project: "${path.basename(dir)}"`);

    const instructions = await readFile(path.join(dir, ".longe/AGENT-INSTRUCTIONS.md"), "utf8");
    expect(instructions).toBe(AGENT_INSTRUCTIONS);
    expect(instructions).toContain("blocking: true");

    // no agent instruction file yet: AGENTS.md points at the protocol, CLAUDE.md at AGENTS.md
    expect(await readFile(path.join(dir, "AGENTS.md"), "utf8")).toBe(`${POINTER_LINE}\n`);
    expect(await readFile(path.join(dir, "CLAUDE.md"), "utf8")).toBe(`${CLAUDE_LINE}\n`);

    expect(result.created).toHaveLength(7);
    expect(result.skipped).toHaveLength(0);
    expect(result.updated).toHaveLength(0);
  });

  it("is idempotent and never overwrites", async () => {
    await runInit(dir);
    const configPath = path.join(dir, ".longe/config.yml");
    const custom = "version: 1\nproject: Custom Name\n";
    await writeFile(configPath, custom);

    const second = await runInit(dir);

    expect(await readFile(configPath, "utf8")).toBe(custom);
    expect(second.created).toHaveLength(0);
    expect(second.updated).toHaveLength(0);
    expect(second.skipped).toHaveLength(7);
  });

  it("appends to existing instruction files once; a CLAUDE.md that links AGENTS.md is left alone", async () => {
    const claude = path.join(dir, "CLAUDE.md");
    const agents = path.join(dir, "AGENTS.md");
    await writeFile(claude, "# Project\n\nRun `pnpm test` before committing.");
    await writeFile(agents, "# Rules\n");
    const result = await runInit(dir);
    expect(result.updated).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(await readFile(agents, "utf8")).toBe(`# Rules\n\n${POINTER_LINE}\n`);
    const linked = `# Project\n\nRun \`pnpm test\` before committing.\n\n${CLAUDE_LINE}\n`;
    expect(await readFile(claude, "utf8")).toBe(linked);
    // a second run leaves both alone
    const again = await runInit(dir);
    expect(again.updated).toEqual([]);
    expect(again.skipped).toEqual(expect.arrayContaining(["AGENTS.md", "CLAUDE.md"]));
    expect(await readFile(claude, "utf8")).toBe(linked);
  });

  it("initProject adds the Claude Code hook too, unless ask_in_inbox is off", async () => {
    const first = await initProject(dir, { name: "P" });
    expect(first.hook).toBe(true);
    expect(first.created).toContain("AGENTS.md");
    const settings = JSON.parse(await readFile(path.join(dir, ".claude/settings.json"), "utf8"));
    expect(settings.hooks.PreToolUse[0].matcher).toBe("AskUserQuestion");
    expect(await readFile(path.join(dir, ".longe/config.yml"), "utf8")).toContain('project: "P"');
    expect((await initProject(dir)).hook).toBe(false); // already there

    const other = await mkdtemp(path.join(os.tmpdir(), "longe-init-"));
    try {
      await runInit(other);
      await writeFile(path.join(other, ".longe/config.yml"), "version: 1\nask_in_inbox: false\n");
      expect((await initProject(other)).hook).toBe(false);
      await expect(stat(path.join(other, ".claude/settings.json"))).rejects.toThrow();
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("a CLAUDE.md that already names the protocol directly counts as linked", async () => {
    const claude = path.join(dir, "CLAUDE.md");
    await writeFile(claude, `${POINTER_LINE}\n`);
    const result = await runInit(dir);
    expect(result.created).toContain("AGENTS.md");
    expect(result.skipped).toContain("CLAUDE.md");
    expect(await readFile(claude, "utf8")).toBe(`${POINTER_LINE}\n`);
  });
});
