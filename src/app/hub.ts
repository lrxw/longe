import { EventEmitter } from "node:events";
import { watch } from "node:fs";
import path from "node:path";
import { hasAiDir, readRegistry, registryPath } from "../store/registry.js";
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
  changed: [
    {
      repo: string;
      kind: "topic" | "question" | "error" | "hook" | "agent" | "repos";
      id: string;
    },
  ];
}

/**
 * A set of repos served by one process. Single-repo mode is a hub with one
 * entry, so the HTTP layer has one code path.
 */
export class Hub extends EventEmitter<HubEvents> {
  readonly repos = new Map<string, HubRepo>();

  private registryWatcher: ReturnType<typeof watch> | undefined;
  private syncing: Promise<void> = Promise.resolve();
  private opts: AppOptions = {};

  constructor(public readonly mode: "single" | "hub") {
    super();
  }

  /**
   * Keeps the hub in sync with ~/.config/longe/repos.yml: repos added by a
   * later `longe init` / `longe serve` appear without a restart, removed ones
   * are closed. Polling fallback in case fs.watch misses events.
   */
  async followRegistry(opts: AppOptions): Promise<void> {
    this.opts = opts;
    await this.syncRegistry();
    const file = registryPath();
    const trigger = () => {
      this.syncing = this.syncing.then(() => this.syncRegistry()).catch(() => {});
    };
    try {
      this.registryWatcher = watch(path.dirname(file), { persistent: false }, (_e, name) => {
        if (!name || name === path.basename(file)) trigger();
      });
    } catch {
      // directory may not exist yet; polling covers it
    }
    const timer = setInterval(trigger, 3000);
    timer.unref();
  }

  async syncRegistry(): Promise<void> {
    let entries: { name: string; path: string }[];
    try {
      entries = await readRegistry();
    } catch {
      return;
    }
    const wanted = new Map(entries.map((e) => [e.name, e.path]));
    let changed = false;
    for (const [name, r] of this.repos) {
      if (wanted.get(name) !== r.root) {
        if (r.ctx) await closeAppContext(r.ctx);
        this.repos.delete(name);
        changed = true;
      }
    }
    for (const [name, root] of wanted) {
      const have = this.repos.get(name);
      if (!have) {
        await this.add(name, root, this.opts);
        changed = true;
      } else if (have.missing && (await hasAiDir(root))) {
        await this.add(name, root, this.opts); // came back
        changed = true;
      }
    }
    if (changed) this.emit("changed", { repo: "", kind: "repos", id: "" });
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
      ctx.agent.on("agent:changed", () =>
        this.emit("changed", { repo: name, kind: "agent", id: "" }),
      );
    } catch (err) {
      entry.missing = err instanceof Error ? err.message : String(err);
    }
    this.repos.set(name, entry);
    return entry;
  }

  async close(): Promise<void> {
    this.registryWatcher?.close();
    for (const r of this.live()) await closeAppContext(r.ctx as AppContext);
  }

  /** Total open blocking questions across live repos (title badge). */
  blockingCount(): number {
    return this.live().reduce((n, r) => n + (r.ctx?.index.blockingCount() ?? 0), 0);
  }

  /** Total open questions across live repos (Inbox badge). */
  openCount(): number {
    return this.live().reduce((n, r) => n + (r.ctx?.index.inbox().length ?? 0), 0);
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

/** Hub that mirrors the registry file and follows it while running. */
export async function createRegistryHub(opts: AppOptions = {}): Promise<Hub> {
  const hub = new Hub("hub");
  await hub.followRegistry(opts);
  return hub;
}
