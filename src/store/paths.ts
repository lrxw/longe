import path from "node:path";

export const AI_DIR = ".ai";

export function aiDir(root: string): string {
  return path.join(root, AI_DIR);
}
export function topicsDir(root: string): string {
  return path.join(root, AI_DIR, "topics");
}
export function questionsDir(root: string): string {
  return path.join(root, AI_DIR, "questions");
}
export function topicPath(root: string, id: string): string {
  return path.join(topicsDir(root), `${id}.md`);
}
export function questionPath(root: string, id: string): string {
  return path.join(questionsDir(root), `${id}.md`);
}
export function configPath(root: string): string {
  return path.join(root, AI_DIR, "config.yml");
}
export function instructionsPath(root: string): string {
  return path.join(root, AI_DIR, "AGENT-INSTRUCTIONS.md");
}

/** Filename stem of a `.md` file, or undefined for anything else. */
export function stemOf(file: string): string | undefined {
  const base = path.basename(file);
  if (!base.endsWith(".md") || base.startsWith(".")) return undefined;
  return base.slice(0, -3);
}
