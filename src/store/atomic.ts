import { randomBytes } from "node:crypto";
import { link, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { DomainError } from "../domain/errors.js";

function tmpPath(target: string): string {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomBytes(4).toString("hex")}.tmp`,
  );
}

/** Writes `content` to a temp file in the same directory, then renames over `target` (§6.2). */
export async function atomicWrite(target: string, content: string): Promise<void> {
  const tmp = tmpPath(target);
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Atomically creates `target`; fails with `conflict` if it already exists. */
export async function atomicCreate(target: string, content: string): Promise<void> {
  const tmp = tmpPath(target);
  try {
    await writeFile(tmp, content, "utf8");
    try {
      await link(tmp, target); // link() fails if target exists → exclusive create
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new DomainError("conflict", `${path.basename(target)} already exists`);
      }
      throw err;
    }
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/**
 * Read–modify–write: reads the file fresh (never from an index), applies `fn`,
 * and atomically replaces the file. `fn` may return `null` to skip the write.
 */
export async function modifyFile(
  target: string,
  fn: (current: string) => Promise<string | null> | string | null,
): Promise<boolean> {
  let current: string;
  try {
    current = await readFile(target, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DomainError("not_found", `${path.basename(target)} not found`);
    }
    throw err;
  }
  const next = await fn(current);
  if (next === null || next === current) return false;
  await atomicWrite(target, next);
  return true;
}
