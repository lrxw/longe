import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as YAML from "yaml";
import { z } from "zod";
import { atomicWrite } from "./atomic.js";
import { parseConfig } from "./config.js";
import { slugify, uniqueSlug } from "./ids.js";
import { migrateBoardDir } from "./migrate.js";
import { boardDir, configPath } from "./paths.js";

/**
 * `~/.config/longe/repos.yml` — every repo longe has seen on this machine.
 * Filled implicitly by `longe init`, `longe mcp` and `longe serve --repo`,
 * managed explicitly with `longe repos`. Read by hub-mode `longe serve`.
 */
export const repoEntrySchema = z.object({
  path: z.string().min(1),
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  last_seen: z.string().optional(),
});
export type RepoEntry = z.infer<typeof repoEntrySchema>;

const registrySchema = z.object({ repos: z.array(repoEntrySchema).default([]) });

export function registryPath(): string {
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "longe",
    "repos.yml",
  );
}

export async function readRegistry(): Promise<RepoEntry[]> {
  let text: string;
  try {
    text = await readFile(registryPath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const parsed = registrySchema.safeParse(YAML.parse(text) ?? {});
  if (!parsed.success)
    throw new Error(`${registryPath()}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data.repos;
}

async function writeRegistry(repos: RepoEntry[]): Promise<void> {
  const file = registryPath();
  await mkdir(path.dirname(file), { recursive: true });
  const body = `# Repositories known to longe. Managed by \`longe repos\`; safe to edit.\n${YAML.stringify({ repos })}`;
  await atomicWrite(file, body);
}

async function canonical(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch {
    return path.resolve(root);
  }
}

/** Display name from .longe/config.yml `project`, falling back to the folder name. */
export async function projectNameOf(root: string): Promise<string> {
  try {
    const cfg = parseConfig(await readFile(configPath(root), "utf8"));
    if (cfg.project) return cfg.project;
  } catch {
    // no config or unreadable: fall through
  }
  return path.basename(root);
}

/** The repo has a board; an old `.ai/` board is moved to `.longe/` on the way. */
export async function hasBoardDir(root: string): Promise<boolean> {
  await migrateBoardDir(root).catch(() => false);
  try {
    return (await stat(boardDir(root))).isDirectory();
  } catch {
    return false;
  }
}

/** Adds or touches a repo. Name is derived once and kept afterwards. Returns the entry. */
export async function registerRepo(root: string, name?: string): Promise<RepoEntry> {
  const p = await canonical(root);
  const repos = await readRegistry();
  const now = new Date().toISOString();
  const existing = repos.find((r) => r.path === p);
  if (existing) {
    existing.last_seen = now;
    if (name) {
      const taken = repos.filter((r) => r !== existing).map((r) => r.name);
      existing.name = uniqueSlug(slugify(name), taken);
    }
    await writeRegistry(repos);
    return existing;
  }
  const base = slugify(name ?? (await projectNameOf(p)));
  const entry: RepoEntry = {
    path: p,
    name: uniqueSlug(
      base,
      repos.map((r) => r.name),
    ),
    last_seen: now,
  };
  repos.push(entry);
  await writeRegistry(repos);
  return entry;
}

export async function unregisterRepo(root: string): Promise<boolean> {
  const p = await canonical(root);
  const repos = await readRegistry();
  const next = repos.filter((r) => r.path !== p && r.path !== root);
  if (next.length === repos.length) return false;
  await writeRegistry(next);
  return true;
}

export async function renameRepo(root: string, name: string): Promise<RepoEntry | undefined> {
  const p = await canonical(root);
  const repos = await readRegistry();
  const entry = repos.find((r) => r.path === p);
  if (!entry) return undefined;
  entry.name = uniqueSlug(
    slugify(name),
    repos.filter((r) => r !== entry).map((r) => r.name),
  );
  await writeRegistry(repos);
  return entry;
}

/** Drops entries whose path no longer has a .longe/ folder. Returns the removed entries. */
export async function pruneRegistry(): Promise<RepoEntry[]> {
  const repos = await readRegistry();
  const gone: RepoEntry[] = [];
  const keep: RepoEntry[] = [];
  for (const r of repos) (await hasBoardDir(r.path)) ? keep.push(r) : gone.push(r);
  if (gone.length > 0) await writeRegistry(keep);
  return gone;
}
