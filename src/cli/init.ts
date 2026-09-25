import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { AGENT_INSTRUCTIONS } from "../domain/agent-instructions.js";
import { defaultConfigText } from "../store/config.js";
import { migrateBoardDir } from "../store/migrate.js";
import { BOARD_DIR } from "../store/paths.js";

export interface InitResult {
  created: string[];
  skipped: string[];
  /** Existing agent instruction files that got the pointer line appended. */
  updated: string[];
}

/** The one line an agent's instruction file needs; init writes it, the README shows it. */
export const POINTER_LINE =
  "Follow .longe/AGENT-INSTRUCTIONS.md for tracking work and asking questions.";
/** Repo-root files agents read; existing ones get the pointer, else both are created. */
const INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md"];

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates the .longe/ layout (§3.1) and points the repo's agent instructions at it.
 * Idempotent: existing files and folders are left untouched and reported under
 * `skipped`; an instruction file only ever gets the pointer line appended once.
 * `projectName` goes into a new config.yml (default: the folder name).
 */
export async function runInit(repoRoot: string, projectName?: string): Promise<InitResult> {
  await migrateBoardDir(repoRoot); // an old .ai/ board is moved, not started over
  const root = path.join(repoRoot, BOARD_DIR);
  const result: InitResult = { created: [], skipped: [], updated: [] };

  const dirs = [root, path.join(root, "topics"), path.join(root, "questions")];
  for (const dir of dirs) {
    const rel = path.relative(repoRoot, dir) + path.sep;
    if (await exists(dir)) {
      result.skipped.push(rel);
    } else {
      await mkdir(dir, { recursive: true });
      result.created.push(rel);
    }
  }

  const files: Array<[string, string]> = [
    [path.join(root, "config.yml"), defaultConfigText(projectName ?? path.basename(repoRoot))],
    [path.join(root, "AGENT-INSTRUCTIONS.md"), AGENT_INSTRUCTIONS],
  ];
  for (const [file, content] of files) {
    const rel = path.relative(repoRoot, file);
    if (await exists(file)) {
      result.skipped.push(rel);
    } else {
      await writeFile(file, content, { encoding: "utf8", flag: "wx" });
      result.created.push(rel);
    }
  }

  await linkInstructions(repoRoot, result);
  return result;
}

/**
 * CLAUDE.md and AGENTS.md in the repo root get the pointer line: appended to each one
 * that exists and does not mention the instructions yet; when neither exists, both
 * are created with just that line (Claude Code reads only CLAUDE.md, most other
 * agents AGENTS.md).
 */
async function linkInstructions(repoRoot: string, result: InitResult): Promise<void> {
  const existing: string[] = [];
  for (const name of INSTRUCTION_FILES) {
    const file = path.join(repoRoot, name);
    const text = await readFile(file, "utf8").catch(() => undefined);
    if (text === undefined) continue;
    existing.push(name);
    if (text.includes(".longe/AGENT-INSTRUCTIONS.md")) {
      result.skipped.push(name);
      continue;
    }
    const gap = text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    await appendFile(file, `${gap}${POINTER_LINE}\n`);
    result.updated.push(name);
  }
  if (existing.length > 0) return;
  for (const name of INSTRUCTION_FILES) {
    await writeFile(path.join(repoRoot, name), `${POINTER_LINE}\n`, { flag: "wx" });
    result.created.push(name);
  }
}
