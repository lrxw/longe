import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import { parseConfig } from "./config.js";
import { randomBase36, slugify } from "./ids.js";
import {
  BOARD_DIR,
  boardDir,
  configPath,
  findProjectByRoot,
  instructionsPath,
  projectDir,
  projectIdOf,
  projectMetaPath,
  realRoot,
} from "./paths.js";

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
  const moved = await moveLegacyDir(root);
  const home = await ensureProjectHome(root).catch((err: unknown) => {
    process.stderr.write(`longe: could not move the board out of ${root}: ${String(err)}\n`);
    return false;
  });
  return moved || home;
}

async function moveLegacyDir(root: string): Promise<boolean> {
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

/** The board folders that live outside the repo (see paths.ts). */
export const BOARD_PARTS = ["topics", "questions", "messages", "archive"] as const;

/** `<slug of the project name>-<4 random>`: readable in ~/.longe/projects/ and unique. */
export function newProjectId(name: string): string {
  return `${slugify(name).slice(0, 40).replace(/-+$/, "")}-${randomBase36(4)}`;
}

/**
 * Gives a repo's board its home outside the repo. A config.yml without `id:` gets one
 * (written into the file, comments kept); then whatever board folders still sit in
 * `.longe/` (a board from before, or files that came in through git) are moved to
 * `~/.longe/projects/<id>/`, file by file, never over an existing file. Returns true
 * when it changed anything. A repo without `.longe/config.yml` is left alone.
 */
export async function ensureProjectHome(root: string): Promise<boolean> {
  const file = configPath(root);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return false;
  }
  let changed = false;
  let id = projectIdOf(root);
  const doc = parseDocument(text);
  const name = String(doc.get("project") ?? "") || path.basename(root);
  if (!id) {
    // the id went missing (config rewritten), or this board never had one
    id = findProjectByRoot(root) ?? newProjectId(name);
    // right after `version:`, where a human looks first
    doc.set("id", id);
    const items = (doc.contents as { items?: { key: { value?: unknown } }[] } | null)?.items;
    if (items) {
      const at = items.findIndex((p) => p.key?.value === "id");
      const [pair] = items.splice(at, 1);
      const version = items.findIndex((p) => p.key?.value === "version");
      if (pair) items.splice(version + 1, 0, pair);
    }
    await writeFile(file, doc.toString());
    changed = true;
  }
  const target = projectDir(id);
  await mkdir(target, { recursive: true });
  // which repo this board belongs to: finds it again if config.yml loses the id
  const meta = `${JSON.stringify({ root: realRoot(root), name }, null, 2)}\n`;
  if ((await readFile(projectMetaPath(id), "utf8").catch(() => "")) !== meta)
    await writeFile(projectMetaPath(id), meta);
  for (const part of BOARD_PARTS) {
    const from = path.join(boardDir(root), part);
    if (!(await isDir(from))) continue;
    await moveTree(from, path.join(target, part), path.join(target, "conflicts", part));
    await rm(from, { recursive: true, force: true });
    changed = true;
  }
  if (changed)
    process.stderr.write(`longe: the board of ${root} is in ${target} (id ${id} in config.yml)\n`);
  return changed;
}

/**
 * Moves every file under `from` into `to`. A file that already exists there with other
 * content is not overwritten: the repo's copy goes to `conflicts` instead, so nothing
 * is lost when the caller removes `from` afterwards.
 */
async function moveTree(from: string, to: string, conflicts: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    let dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await moveTree(src, dst, path.join(conflicts, entry.name));
      continue;
    }
    if (await exists(dst)) {
      const [a, b] = await Promise.all([readFile(src), readFile(dst)]);
      if (a.equals(b)) continue; // same file: nothing to keep
      await mkdir(conflicts, { recursive: true });
      dst = path.join(conflicts, entry.name);
      process.stderr.write(`longe: ${src} differs from the moved board; kept as ${dst}\n`);
    }
    await rename(src, dst).catch(async () => {
      // another file system: copy, then the caller removes `from`
      await writeFile(dst, await readFile(src));
    });
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keeps `.longe/AGENT-INSTRUCTIONS.md` at the current protocol: `longe init` writes it
 * once, and the protocol changes with longe. Rewritten when it differs (or is
 * missing while the board exists). Returns true when it wrote the file.
 */
export async function refreshInstructions(root: string, text: string): Promise<boolean> {
  if (!(await isDir(boardDir(root)))) return false;
  const file = instructionsPath(root);
  const current = await readFile(file, "utf8").catch(() => undefined);
  if (current === text) return false;
  await writeFile(file, text);
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
