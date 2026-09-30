import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAppContext, createAppContext } from "../src/app/context.js";
import { runInit } from "../src/cli/init.js";
import { AGENT_INSTRUCTIONS } from "../src/domain/agent-instructions.js";
import { migrateBoardDir, refreshInstructions, staleMentions } from "../src/store/migrate.js";
import { dataDir, projectDir, projectIdOf, topicsDir } from "../src/store/paths.js";
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
    expect(await readFile(path.join(topicsDir(dir), "t.md"), "utf8")).toBe("x");
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
    expect(await readFile(path.join(topicsDir(dir), "t.md"), "utf8")).toBe("x");
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

  it("keeps AGENT-INSTRUCTIONS.md at the current protocol", async () => {
    await runInit(dir);
    const file = path.join(dir, ".longe/AGENT-INSTRUCTIONS.md");
    await writeFile(file, "old protocol text\n");
    const ctx = await createAppContext(dir, { index: { debounceMs: 20, usePolling: true } });
    await closeAppContext(ctx);
    expect(await readFile(file, "utf8")).toBe(AGENT_INSTRUCTIONS);
    expect(await refreshInstructions(dir, AGENT_INSTRUCTIONS)).toBe(false); // already current
    // no board, nothing written
    const empty = path.join(dir, "empty");
    await mkdir(empty);
    expect(await refreshInstructions(empty, AGENT_INSTRUCTIONS)).toBe(false);
  });

  it("moves a board that still lives in .longe/ to ~/.longe/projects/<id>/, keeping every file", async () => {
    // a board from before: no id, topics, questions, messages and archive inside the repo
    await mkdir(path.join(dir, ".longe/topics"), { recursive: true });
    await mkdir(path.join(dir, ".longe/questions"), { recursive: true });
    await mkdir(path.join(dir, ".longe/messages"), { recursive: true });
    await mkdir(path.join(dir, ".longe/archive/topics"), { recursive: true });
    await writeFile(
      path.join(dir, ".longe/config.yml"),
      "version: 1\n# a comment\nproject: My App\n",
    );
    await writeFile(path.join(dir, ".longe/topics/a.md"), "topic a");
    await writeFile(path.join(dir, ".longe/questions/q-1.md"), "question");
    await writeFile(path.join(dir, ".longe/messages/m-1.md"), "message");
    await writeFile(path.join(dir, ".longe/archive/topics/old.md"), "archived");

    expect(await migrateBoardDir(dir)).toBe(true);
    const config = await readFile(path.join(dir, ".longe/config.yml"), "utf8");
    const id = /^id: (\S+)$/m.exec(config)?.[1] as string;
    expect(id).toMatch(/^my-app-[0-9a-z]{4}$/);
    expect(config).toMatch(/^version: 1\nid: my-app-[0-9a-z]{4}\n# a comment\nproject: My App\n$/);
    const home = projectDir(id);
    expect(dataDir(dir)).toBe(home);
    expect(await readFile(path.join(home, "topics/a.md"), "utf8")).toBe("topic a");
    expect(await readFile(path.join(home, "questions/q-1.md"), "utf8")).toBe("question");
    expect(await readFile(path.join(home, "messages/m-1.md"), "utf8")).toBe("message");
    expect(await readFile(path.join(home, "archive/topics/old.md"), "utf8")).toBe("archived");
    // only settings stay in the repo
    expect((await readdir(path.join(dir, ".longe"))).sort()).toEqual(["config.yml"]);
    expect(JSON.parse(await readFile(path.join(home, "project.json"), "utf8"))).toEqual({
      root: await realpath(dir),
      name: "My App",
    });
    expect(await migrateBoardDir(dir)).toBe(false); // done: nothing left to move
  });

  it("finds the board again when config.yml loses its id, and keeps both copies of a clash", async () => {
    await runInit(dir);
    const id = projectIdOf(dir) as string;
    await writeFile(path.join(topicsDir(dir), "same.md"), "home version");
    // config rewritten without the id; a stale copy of the board comes in through git
    await writeFile(path.join(dir, ".longe/config.yml"), "version: 1\nproject: P\n");
    await mkdir(path.join(dir, ".longe/topics"), { recursive: true });
    await writeFile(path.join(dir, ".longe/topics/same.md"), "repo version");
    await writeFile(path.join(dir, ".longe/topics/new.md"), "only in repo");

    expect(dataDir(dir)).toBe(projectDir(id)); // found by project.json before migration
    await migrateBoardDir(dir);
    expect(projectIdOf(dir)).toBe(id); // written back
    expect(await readFile(path.join(topicsDir(dir), "same.md"), "utf8")).toBe("home version");
    expect(await readFile(path.join(topicsDir(dir), "new.md"), "utf8")).toBe("only in repo");
    expect(await readFile(path.join(projectDir(id), "conflicts/topics/same.md"), "utf8")).toBe(
      "repo version",
    );
    expect(await exists(".longe/topics")).toBe(false);
  });

  it("lists agent instruction files that still mention .ai/", async () => {
    await writeFile(path.join(dir, "CLAUDE.md"), "Follow .ai/AGENT-INSTRUCTIONS.md.\n");
    await writeFile(path.join(dir, "AGENTS.md"), "Nothing here about my.ai/stuff.\n");
    expect(await staleMentions(dir)).toEqual(["CLAUDE.md"]);
  });
});
