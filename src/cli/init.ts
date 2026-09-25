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

/** The one line AGENTS.md needs; init writes it, the README shows it. */
export const POINTER_LINE =
  "Follow .longe/AGENT-INSTRUCTIONS.md for tracking work and asking questions.";
/**
 * CLAUDE.md gets a link, not the protocol: AGENTS.md is the provider-agnostic file, and
 * Claude reads it when told to (progressive disclosure, no `@import` that inlines it).
 */
export const CLAUDE_LINE =
  "Read AGENTS.md first: the instructions for every agent working in this repository.";

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

export interface InitProjectResult extends InitResult {
  /** The Claude Code hook was added (ask_in_inbox on, and it was not there yet). */
  hook: boolean;
}

/**
 * Everything `longe init` does: the board, the agent files, and (with `ask_in_inbox`
 * on) the Claude Code hook that sends questions to the inbox. The CLI and "+ New
 * project" in the web UI both go through here, so a project set up either way is the same.
 */
export async function initProject(
  repoRoot: string,
  opts: { name?: string | undefined; local?: boolean } = {},
): Promise<InitProjectResult> {
  const result = await runInit(repoRoot, opts.name);
  const { askInInboxEnabled, installHook } = await import("./hooks.js");
  const hook = (await askInInboxEnabled(repoRoot))
    ? await installHook(repoRoot, opts.local ?? false).catch(() => false)
    : false;
  return { ...result, hook };
}

/**
 * AGENTS.md (every agent) points at the protocol; CLAUDE.md (Claude Code reads only
 * that one) points at AGENTS.md. Each file is created with its line when missing,
 * gets the line appended when it does not mention the target yet, and is left alone
 * otherwise. A CLAUDE.md that already names the protocol directly counts as linked.
 */
async function linkInstructions(repoRoot: string, result: InitResult): Promise<void> {
  const files: Array<[name: string, line: string, mentions: string[]]> = [
    ["AGENTS.md", POINTER_LINE, [".longe/AGENT-INSTRUCTIONS.md"]],
    ["CLAUDE.md", CLAUDE_LINE, ["AGENTS.md", ".longe/AGENT-INSTRUCTIONS.md"]],
  ];
  for (const [name, line, mentions] of files) {
    const file = path.join(repoRoot, name);
    const text = await readFile(file, "utf8").catch(() => undefined);
    if (text === undefined) {
      await writeFile(file, `${line}\n`, { flag: "wx" });
      result.created.push(name);
    } else if (mentions.some((m) => text.includes(m))) {
      result.skipped.push(name);
    } else {
      const gap = text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
      await appendFile(file, `${gap}${line}\n`);
      result.updated.push(name);
    }
  }
}
