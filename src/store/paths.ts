import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";

/**
 * `.longe/` in the repository holds only what belongs with the code: config.yml
 * (settings and the project id) and AGENT-INSTRUCTIONS.md. The board itself (topics,
 * questions, messages, archive) is communication about the work and lives outside the
 * repo, in `~/.longe/projects/<id>/`. A repo whose config.yml has no id yet (set up
 * before this) keeps its board in `.longe/` until migrateBoardDir moves it.
 */
export const BOARD_DIR = ".longe";

/** `~/.longe`, or `$LONGE_HOME`. */
export function longeHome(): string {
  return process.env.LONGE_HOME || path.join(os.homedir(), ".longe");
}

/** The repo's `.longe/` folder (config.yml, AGENT-INSTRUCTIONS.md; the marker). */
export function boardDir(root: string): string {
  return path.join(root, BOARD_DIR);
}

export function configPath(root: string): string {
  return path.join(root, BOARD_DIR, "config.yml");
}
export function instructionsPath(root: string): string {
  return path.join(root, BOARD_DIR, "AGENT-INSTRUCTIONS.md");
}

/** Where a project's board lives, by its id. */
export function projectDir(id: string): string {
  return path.join(longeHome(), "projects", id);
}

const ids = new Map<string, { stamp: string; id: string | undefined }>();

/** The `id:` in the repo's config.yml; cached while the file is unchanged. */
export function projectIdOf(root: string): string | undefined {
  const file = configPath(root);
  let stamp: string;
  try {
    const s = statSync(file);
    stamp = `${s.mtimeMs}:${s.size}:${s.ino}`;
  } catch {
    return undefined;
  }
  const hit = ids.get(file);
  if (hit && hit.stamp === stamp) return hit.id;
  let id: string | undefined;
  try {
    const v = (parse(readFileSync(file, "utf8")) as { id?: unknown } | null)?.id;
    id = typeof v === "string" && /^[a-z0-9][a-z0-9-]*$/.test(v) ? v : undefined;
  } catch {
    id = undefined;
  }
  ids.set(file, { stamp, id });
  return id;
}

/** `project.json` in a project's folder: which repo it belongs to. */
export function projectMetaPath(id: string): string {
  return path.join(projectDir(id), "project.json");
}

/**
 * The project whose `project.json` names this repo: finds the board again when the
 * `id:` went missing from config.yml (rewritten by hand, an older copy from git).
 */
export function findProjectByRoot(root: string): string | undefined {
  const dir = path.join(longeHome(), "projects");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  const want = realRoot(root);
  for (const id of names) {
    try {
      const meta = JSON.parse(readFileSync(projectMetaPath(id), "utf8")) as { root?: unknown };
      if (typeof meta.root === "string" && realRoot(meta.root) === want) return id;
    } catch {
      // not a project folder, or no meta yet
    }
  }
  return undefined;
}

/** The same folder however it is spelled (macOS: /var is /private/var). */
export function realRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

/** The board's id for this repo: config.yml's `id:`, else the project that names this repo. */
export function resolveProjectId(root: string): string | undefined {
  return projectIdOf(root) ?? findProjectByRoot(root);
}

/** The folder with topics/, questions/, messages/, archive/ for this repo. */
export function dataDir(root: string): string {
  const id = resolveProjectId(root);
  return id ? projectDir(id) : boardDir(root);
}

export function topicsDir(root: string): string {
  return path.join(dataDir(root), "topics");
}
export function questionsDir(root: string): string {
  return path.join(dataDir(root), "questions");
}
export function messagesDir(root: string): string {
  return path.join(dataDir(root), "messages");
}
export function topicPath(root: string, id: string): string {
  return path.join(topicsDir(root), `${id}.md`);
}
export function questionPath(root: string, id: string): string {
  return path.join(questionsDir(root), `${id}.md`);
}
/** Cleaned-up topics and their questions; outside the watched folders, so off the board. */
export function archiveDir(root: string, kind: "topics" | "questions"): string {
  return path.join(dataDir(root), "archive", kind);
}

/** Filename stem of a `.md` file, or undefined for anything else. */
export function stemOf(file: string): string | undefined {
  const base = path.basename(file);
  if (!base.endsWith(".md") || base.startsWith(".")) return undefined;
  return base.slice(0, -3);
}
