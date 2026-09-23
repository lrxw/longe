import { readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { parseConfig } from "./config.js";
import { BOARD_DIR, boardDir } from "./paths.js";

/** Where the board lived before it was renamed to `.longe/`. */
export const LEGACY_DIR = ".ai";

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Moves an old `.ai/` board to `.longe/`. Only a folder that is clearly longe's
 * (its config.yml parses as a longe config) is moved, and only when `.longe/` does
 * not exist yet; anything else named `.ai/` belongs to someone else and stays.
 * Returns true when it moved the folder.
 */
export async function migrateBoardDir(root: string): Promise<boolean> {
  if (await isDir(boardDir(root))) return false;
  const legacy = path.join(root, LEGACY_DIR);
  if (!(await isDir(legacy))) return false;
  try {
    parseConfig(await readFile(path.join(legacy, "config.yml"), "utf8"));
  } catch {
    return false; // no longe config: not ours
  }
  await rename(legacy, boardDir(root));
  process.stderr.write(`longe: moved ${legacy} to ${path.join(root, BOARD_DIR)}\n`);
  const stale = await staleMentions(root);
  if (stale.length > 0)
    process.stderr.write(
      `longe: these files still mention .ai/; change them to .longe/: ${stale.join(", ")}\n`,
    );
  return true;
}

/** Agent instruction files in the repo root that still point to `.ai/`. */
export async function staleMentions(root: string): Promise<string[]> {
  const candidates = [
    "CLAUDE.md",
    "AGENTS.md",
    "GEMINI.md",
    ".cursorrules",
    ".github/copilot-instructions.md",
  ];
  const out: string[] = [];
  for (const f of candidates) {
    try {
      if (/(^|[^\w.])\.ai\//m.test(await readFile(path.join(root, f), "utf8"))) out.push(f);
    } catch {
      // not there
    }
  }
  return out;
}
