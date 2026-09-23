import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { AGENT_INSTRUCTIONS } from "../domain/agent-instructions.js";
import { defaultConfigText } from "../store/config.js";

export const AI_DIR = ".ai";

export interface InitResult {
  created: string[];
  skipped: string[];
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
 * Creates the .ai/ layout (§3.1). Idempotent: existing files and folders are
 * left untouched and reported under `skipped`. `projectName` goes into a new
 * config.yml (default: the folder name).
 */
export async function runInit(repoRoot: string, projectName?: string): Promise<InitResult> {
  const root = path.join(repoRoot, AI_DIR);
  const result: InitResult = { created: [], skipped: [] };

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

  return result;
}
