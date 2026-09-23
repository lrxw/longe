import { readFile } from "node:fs/promises";
import path from "node:path";
import { AGENT_INSTRUCTIONS } from "../domain/agent-instructions.js";
import { EffectRunner, type Notifier, type EffectRunner as Runner } from "../index/effects.js";
import { AiIndex, type IndexOptions } from "../index/index.js";
import { type Config, parseConfig } from "../store/config.js";
import { migrateBoardDir, refreshInstructions } from "../store/migrate.js";
import { configPath } from "../store/paths.js";
import { Repo } from "../store/repo.js";
import { AgentRunner } from "./agent.js";
import { HookRunner } from "./hooks.js";
import { attachChatQueue } from "./todo-queue.js";

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
  /**
   * This process owns the repo's chat: it tells the chat about answers and hands it
   * the todo queue. Only the server (`longe serve`) does; a `longe mcp` process next
   * to it must not start a second chat.
   */
  drivesChat?: boolean;
}

/** Loads config, starts the index and wires external-change side effects. */
export async function createAppContext(root: string, opts: AppOptions = {}): Promise<AppContext> {
  await migrateBoardDir(root); // an old .ai/ board becomes .longe/
  // the protocol changes with longe: every repo gets the current text
  await refreshInstructions(root, AGENT_INSTRUCTIONS).catch(() => false);
  let config: Config = { version: 1 };
  try {
    config = parseConfig(await readFile(configPath(root), "utf8"), "config.yml");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  // with several repos, the title says which one: "longe · Ready for review"
  const send = opts.notify;
  const project = config.project ?? path.basename(root);
  const notify: Notifier = send ? (title, body) => send(`${project} · ${title}`, body) : () => {};
  const repo = new Repo(root);
  const index = new AiIndex(root, opts.index ?? {});
  const logName = config.project ?? path.basename(root);
  const hooks = new HookRunner(root, config.hooks ?? {}, logName);
  // a repo that sets `project:` later keeps its chat: the folder-named files are read too
  const agent = new AgentRunner(root, config.agent ?? {}, logName, undefined, [
    path.basename(root),
  ]);
  agent.askInInbox = config.ask_in_inbox !== false;
  const runner = new EffectRunner(index, repo, notify, (name, vars) => hooks.trigger(name, vars));
  runner.attach();
  // answers (unless the repo's own on_answer hook owns that job), then todo topics,
  // each handed to the chat only when it is free (see todo-queue.ts)
  const nextForChat = opts.drivesChat
    ? attachChatQueue(index, agent, { answers: !config.hooks?.on_answer })
    : undefined;
  await index.start();
  nextForChat?.(); // what came in while the server was down
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
