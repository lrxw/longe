import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { topicCommits, uncommittedFiles } from "../src/app/git.js";

const run = promisify(execFile);
let dir: string;
const git = (...args: string[]) =>
  run("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir });

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "longe-git-"));
  await git("init", "-q");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("git per card", () => {
  it("lists the commits whose trailer names exactly this topic, newest first", async () => {
    await writeFile(path.join(dir, "a.txt"), "1");
    await git("add", "a.txt");
    await git("commit", "-q", "-m", "feat: first\n\nTopic: billing");
    await writeFile(path.join(dir, "a.txt"), "2");
    await git("commit", "-q", "-am", "fix: other card\n\nTopic: billing-v2");
    await writeFile(path.join(dir, "a.txt"), "3");
    await git("commit", "-q", "-am", "fix: second\n\nTopic: billing");
    const commits = await topicCommits(dir, "billing");
    expect(commits.map((c) => c.subject)).toEqual(["fix: second", "feat: first"]);
    expect(commits[0]?.hash).toMatch(/^[0-9a-f]{7,}$/);
    expect(await topicCommits(dir, "nothing")).toEqual([]);
  });

  it("counts uncommitted files outside .longe/; nothing outside git", async () => {
    await writeFile(path.join(dir, "a.txt"), "1");
    await mkdir(path.join(dir, ".longe/topics"), { recursive: true });
    await writeFile(path.join(dir, ".longe/topics/t.md"), "x");
    expect(await uncommittedFiles(dir, 0)).toBe(1); // a.txt, not the board file
    const plain = await mkdtemp(path.join(os.tmpdir(), "longe-nogit-"));
    try {
      expect(await uncommittedFiles(plain, 0)).toBeUndefined();
      expect(await topicCommits(plain, "x")).toEqual([]);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});
