import { readFile } from "node:fs/promises";
import path from "node:path";
import { EffectRunner, type Notifier, type EffectRunner as Runner } from "../index/effects.js";
import { AiIndex, type IndexOptions } from "../index/index.js";
import { type Config, parseConfig } from "../store/config.js";
import { configPath } from "../store/paths.js";
import { Repo } from "../store/repo.js";
import { AgentRunner } from "./agent.js";
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
  agent: AgentRunner;
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
  const logName = config.project ?? path.basename(root);
  const hooks = new HookRunner(root, config.hooks ?? {}, logName);
  // a repo that sets `project:` later keeps its chat: the folder-named files are read too
  const agent = new AgentRunner(root, config.agent ?? {}, logName, undefined, [
    path.basename(root),
  ]);
  // An answered question is told to the board's chat (if one exists) unless the
  // repo configured its own on_answer hook, which then owns that job.
  const runner = new EffectRunner(index, repo, notify, (name, vars) => {
    if (name === "on_answer" && !config.hooks?.on_answer) void agent.notifyAnswer(vars);
    return hooks.trigger(name, vars);
  });
  runner.attach();
  await index.start();
  return {
    root,
    config,
    repo,
    index,
    runner,
    notify,
    now: opts.now ?? (() => new Date()),
    hooks,
    agent,
  };
}

export async function closeAppContext(ctx: AppContext): Promise<void> {
  await ctx.agent.close();
  await ctx.index.stop();
}
