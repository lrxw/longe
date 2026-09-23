import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAppContext, createAppContext } from "../src/app/context.js";
import { runInit } from "../src/cli/init.js";
import { migrateBoardDir, staleMentions } from "../src/store/migrate.js";
import { hasBoardDir } from "../src/store/registry.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "longe-migrate-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const exists = (p: string) =>
  stat(path.join(dir, p)).then(
    () => true,
    () => false,
  );

/** An old board: what `longe init` used to create, with one topic. */
async function oldBoard(root = dir) {
  await mkdir(path.join(root, ".ai/topics"), { recursive: true });
  await mkdir(path.join(root, ".ai/questions"), { recursive: true });
  await writeFile(path.join(root, ".ai/config.yml"), 'version: 1\nproject: "Old"\n');
  await writeFile(path.join(root, ".ai/topics/t.md"), "x");
}

describe("board folder migration (.ai/ → .longe/)", () => {
  it("moves a longe .ai/ board, keeps its files, and only once", async () => {
    await oldBoard();
    expect(await migrateBoardDir(dir)).toBe(true);
    expect(await exists(".ai")).toBe(false);
    expect(await readFile(path.join(dir, ".longe/topics/t.md"), "utf8")).toBe("x");
    expect(await migrateBoardDir(dir)).toBe(false);
  });

  it("leaves a foreign .ai/ alone, and never overwrites an existing .longe/", async () => {
    await mkdir(path.join(dir, ".ai"));
    await writeFile(path.join(dir, ".ai/notes.txt"), "someone else's");
    expect(await migrateBoardDir(dir)).toBe(false);
    expect(await exists(".ai/notes.txt")).toBe(true);

    await rm(path.join(dir, ".ai"), { recursive: true });
    await oldBoard();
    await mkdir(path.join(dir, ".longe"));
    expect(await migrateBoardDir(dir)).toBe(false);
    expect(await exists(".ai/topics/t.md")).toBe(true);
  });

  it("happens wherever a repo is opened: app context, registry check, init", async () => {
    await oldBoard();
    const ctx = await createAppContext(dir, { index: { debounceMs: 20, usePolling: true } });
    expect(ctx.config.project).toBe("Old");
    expect(ctx.index.topics.size).toBe(0); // "x" is not a valid topic, but it was found
    expect(await exists(".longe/topics/t.md")).toBe(true);
    await closeAppContext(ctx);

    const other = path.join(dir, "other");
    await mkdir(other);
    await oldBoard(other);
    expect(await hasBoardDir(other)).toBe(true);
    expect(await readdir(path.join(other, ".longe"))).toContain("config.yml");

    const third = path.join(dir, "third");
    await mkdir(third);
    await oldBoard(third);
    const r = await runInit(third);
    expect(r.skipped).toContain(`.longe${path.sep}`); // moved, not created fresh
    expect(await readFile(path.join(third, ".longe/config.yml"), "utf8")).toContain("Old");
  });

  it("lists agent instruction files that still mention .ai/", async () => {
    await writeFile(path.join(dir, "CLAUDE.md"), "Follow .ai/AGENT-INSTRUCTIONS.md.\n");
    await writeFile(path.join(dir, "AGENTS.md"), "Nothing here about my.ai/stuff.\n");
    expect(await staleMentions(dir)).toEqual(["CLAUDE.md"]);
  });
});
