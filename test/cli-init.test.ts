import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../src/cli/init.js";
import { AGENT_INSTRUCTIONS } from "../src/domain/agent-instructions.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "longe-init-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("longe init", () => {
  it("creates the .ai layout", async () => {
    const result = await runInit(dir);

    expect((await stat(path.join(dir, ".ai/topics"))).isDirectory()).toBe(true);
    expect((await stat(path.join(dir, ".ai/questions"))).isDirectory()).toBe(true);
    expect(await readdir(path.join(dir, ".ai/topics"))).toEqual([]);
    expect(await readdir(path.join(dir, ".ai/questions"))).toEqual([]);

    const config = await readFile(path.join(dir, ".ai/config.yml"), "utf8");
    expect(config).toMatch(/^version: 1\n/);
    expect(config).toContain(`project: "${path.basename(dir)}"`);

    const instructions = await readFile(path.join(dir, ".ai/AGENT-INSTRUCTIONS.md"), "utf8");
    expect(instructions).toBe(AGENT_INSTRUCTIONS);
    expect(instructions).toContain("blocking: true");

    expect(result.created).toHaveLength(5);
    expect(result.skipped).toHaveLength(0);
  });

  it("is idempotent and never overwrites", async () => {
    await runInit(dir);
    const configPath = path.join(dir, ".ai/config.yml");
    const custom = "version: 1\nproject: Custom Name\n";
    await (await import("node:fs/promises")).writeFile(configPath, custom);

    const second = await runInit(dir);

    expect(await readFile(configPath, "utf8")).toBe(custom);
    expect(second.created).toHaveLength(0);
    expect(second.skipped).toHaveLength(5);
  });
});
