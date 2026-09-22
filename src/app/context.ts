import { readFile } from "node:fs/promises";
import path from "node:path";
import { EffectRunner, type Notifier, type EffectRunner as Runner } from "../index/effects.js";
import { AiIndex, type IndexOptions } from "../index/index.js";
import { type Config, parseConfig } from "../store/config.js";
import { configPath } from "../store/paths.js";
import { Repo } from "../store/repo.js";
import { HookRunner } from "./hooks.js";

export interface AppContext {
  root: string;
  config: Config;
  repo: Repo;
  index: AiIndex;
  runner: Runner;
  notify: Notifier;
  now: () => Date;
  hooks: HookRunner;
}

export interface AppOptions {
  notify?: Notifier;
  now?: () => Date;
  index?: IndexOptions;
}

/** Loads config, starts the index and wires external-change side effects. */
export async function createAppContext(root: string, opts: AppOptions = {}): Promise<AppContext> {
  let config: Config = { version: 1 };
  try {
    config = parseConfig(await readFile(configPath(root), "utf8"), "config.yml");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const notify = opts.notify ?? (() => {});
  const repo = new Repo(root);
  const index = new AiIndex(root, opts.index ?? {});
  const hooks = new HookRunner(root, config.hooks ?? {}, config.project ?? path.basename(root));
  const runner = new EffectRunner(index, repo, notify, (name, vars) => hooks.trigger(name, vars));
  runner.attach();
  await index.start();
  return { root, config, repo, index, runner, notify, now: opts.now ?? (() => new Date()), hooks };
}

export async function closeAppContext(ctx: AppContext): Promise<void> {
  await ctx.index.stop();
}
