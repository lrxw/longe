import path from "node:path";

export const BOARD_DIR = ".longe";

export function boardDir(root: string): string {
  return path.join(root, BOARD_DIR);
}
export function topicsDir(root: string): string {
  return path.join(root, BOARD_DIR, "topics");
}
export function questionsDir(root: string): string {
  return path.join(root, BOARD_DIR, "questions");
}
export function topicPath(root: string, id: string): string {
  return path.join(topicsDir(root), `${id}.md`);
}
export function questionPath(root: string, id: string): string {
  return path.join(questionsDir(root), `${id}.md`);
}
/** Cleaned-up topics and their questions; outside the watched folders, so off the board. */
export function archiveDir(root: string, kind: "topics" | "questions"): string {
  return path.join(root, BOARD_DIR, "archive", kind);
}
export function configPath(root: string): string {
  return path.join(root, BOARD_DIR, "config.yml");
}
export function instructionsPath(root: string): string {
  return path.join(root, BOARD_DIR, "AGENT-INSTRUCTIONS.md");
}

/** Filename stem of a `.md` file, or undefined for anything else. */
export function stemOf(file: string): string | undefined {
  const base = path.basename(file);
  if (!base.endsWith(".md") || base.startsWith(".")) return undefined;
  return base.slice(0, -3);
}
