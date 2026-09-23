import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { runInit } from "../cli/init.js";
import { DomainError } from "../domain/errors.js";
import { type RepoEntry, registerRepo } from "../store/registry.js";
import type { Hub, HubRepo } from "./hub.js";

export interface NewProjectInput {
  /** Absolute, or starting with `~`. */
  path: string;
  /** Project name for config.yml and the registry; default: the folder name. */
  name?: string | undefined;
}

/**
 * The folder a "New project" form asks for, as an absolute path inside `home`.
 * `~` expands to `home`; relative paths are refused (relative to what?), and so
 * is `home` itself.
 */
export function projectPath(input: string, home: string): string {
  const raw = input.trim();
  if (!raw) throw new DomainError("validation", "Enter a folder path.");
  const expanded = raw === "~" || raw.startsWith("~/") ? path.join(home, raw.slice(1)) : raw;
  if (!path.isAbsolute(expanded))
    throw new DomainError("validation", "Use an absolute path, or one starting with ~/.");
  const root = path.resolve(expanded);
  if (!inside(root, home))
    throw new DomainError("validation", `The folder must be inside your home folder (${home}).`);
  return root;
}

function inside(p: string, dir: string): boolean {
  return p.startsWith(dir + path.sep) && p.length > dir.length + 1;
}

/** Real path of `p`, or of its nearest existing ancestor with the rest appended. */
async function realOrAncestor(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    const up = path.dirname(p);
    return up === p ? p : path.join(await realOrAncestor(up), path.basename(p));
  }
}

/**
 * Creates the folder if missing, adds `.ai/` (like `longe init`), registers the
 * repo and has the hub serve it. The home check is repeated on the real path
 * before anything is created, so a symlink cannot lead outside.
 */
export async function createProject(
  hub: Hub,
  input: NewProjectInput,
  home: string,
): Promise<{ entry: RepoEntry; repo: HubRepo | undefined }> {
  const root = projectPath(input.path, home);
  if (!inside(await realOrAncestor(root), await realpath(home)))
    throw new DomainError("validation", `The folder must be inside your home folder (${home}).`);
  await mkdir(root, { recursive: true });
  const real = await realpath(root);
  const name = input.name?.trim() || undefined;
  await runInit(real, name);
  const entry = await registerRepo(real, name);
  const repo = await hub.ensure(entry.name, entry.path);
  return { entry, repo };
}
