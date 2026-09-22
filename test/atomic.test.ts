import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicCreate, atomicWrite, modifyFile } from "../src/store/atomic.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "aiboard-atomic-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("atomic file ops", () => {
  it("atomicWrite replaces content and leaves no temp files", async () => {
    const f = path.join(dir, "a.md");
    await atomicWrite(f, "one");
    await atomicWrite(f, "two");
    expect(await readFile(f, "utf8")).toBe("two");
    expect(await readdir(dir)).toEqual(["a.md"]);
  });

  it("atomicCreate refuses to overwrite", async () => {
    const f = path.join(dir, "a.md");
    await atomicCreate(f, "one");
    await expect(atomicCreate(f, "two")).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(f, "utf8")).toBe("one");
    expect(await readdir(dir)).toEqual(["a.md"]);
  });

  it("modifyFile reads fresh, writes only on change, 404s on missing", async () => {
    const f = path.join(dir, "a.md");
    await writeFile(f, "x");
    expect(await modifyFile(f, (c) => `${c}y`)).toBe(true);
    expect(await readFile(f, "utf8")).toBe("xy");
    expect(await modifyFile(f, (c) => c)).toBe(false);
    expect(await modifyFile(f, () => null)).toBe(false);
    await expect(modifyFile(path.join(dir, "nope.md"), (c) => c)).rejects.toMatchObject({ code: "not_found" });
  });
});
