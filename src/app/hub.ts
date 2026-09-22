import { EventEmitter } from "node:events";
import path from "node:path";
import { hasAiDir } from "../store/registry.js";
import { type AppContext, type AppOptions, closeAppContext, createAppContext } from "./context.js";

/** One repo as the hub sees it. `ctx` is undefined when the path is gone or has no .ai/. */
export interface HubRepo {
  name: string;
  root: string;
  title: string;
  ctx?: AppContext | undefined;
  missing?: string | undefined;
}

export interface HubEvents {
  changed: [{ repo: string; kind: "topic" | "question" | "error" | "hook"; id: string }];
}

/**
 * A set of repos served by one process. Single-repo mode is a hub with one
 * entry, so the HTTP layer has one code path.
 */
export class Hub extends EventEmitter<HubEvents> {
  readonly repos = new Map<string, HubRepo>();

  constructor(public readonly mode: "single" | "hub") {
    super();
  }

  get(name: string): HubRepo | undefined {
    return this.repos.get(name);
  }

  list(): HubRepo[] {
    return [...this.repos.values()];
  }

  live(): HubRepo[] {
    return this.list().filter((r): r is HubRepo & { ctx: AppContext } => r.ctx !== undefined);
  }

  /** The only repo in single mode; undefined in hub mode. */
  single(): HubRepo | undefined {
    return this.mode === "single" ? this.list()[0] : undefined;
  }

  /** Base URL prefix for a repo's pages: "" in single mode, "/r/<name>" in hub mode. */
  base(name: string): string {
    return this.mode === "single" ? "" : `/r/${name}`;
  }

  async add(name: string, root: string, opts: AppOptions): Promise<HubRepo> {
    const entry: HubRepo = { name, root, title: path.basename(root) };
    if (!(await hasAiDir(root))) {
      entry.missing = `no .ai/ folder at ${root}`;
      this.repos.set(name, entry);
      return entry;
    }
    try {
      const ctx = await createAppContext(root, opts);
      entry.ctx = ctx;
      entry.title = ctx.config.project ?? entry.title;
      const forward =
        (kind: "topic" | "question" | "error" | "hook") => (e: { id?: string; file?: string }) =>
          this.emit("changed", { repo: name, kind, id: e.id ?? e.file ?? "" });
      ctx.index.on("topic:changed", forward("topic"));
      ctx.index.on("question:changed", forward("question"));
      ctx.index.on("error:changed", forward("error"));
      ctx.hooks.on("hook:changed", () =>
        this.emit("changed", { repo: name, kind: "hook", id: "" }),
      );
    } catch (err) {
      entry.missing = err instanceof Error ? err.message : String(err);
    }
    this.repos.set(name, entry);
    return entry;
  }

  async close(): Promise<void> {
    for (const r of this.live()) await closeAppContext(r.ctx as AppContext);
  }

  /** Total open blocking questions across live repos (title badge). */
  blockingCount(): number {
    return this.live().reduce((n, r) => n + (r.ctx?.index.blockingCount() ?? 0), 0);
  }
}

export async function createSingleHub(root: string, opts: AppOptions = {}): Promise<Hub> {
  const hub = new Hub("single");
  const entry = await hub.add(path.basename(root) || "repo", root, opts);
  if (entry.missing) throw new Error(entry.missing);
  return hub;
}

export async function createMultiHub(
  repos: { name: string; root: string }[],
  opts: AppOptions = {},
): Promise<Hub> {
  const hub = new Hub("hub");
  for (const r of repos) await hub.add(r.name, r.root, opts);
  return hub;
}
