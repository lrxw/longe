import path from "node:path";
import { isProvider, PROVIDERS } from "../app/providers/index.js";
import type { AgentProvider } from "../store/config.js";
import { CliError } from "./args.js";

export interface InboxHookResult {
  provider: AgentProvider;
  /** Where the hook lives (relative to the repo when inside it). */
  file: string;
  /** Changed now (added by on, removed by off). */
  changed: boolean;
  what: string;
}

function which(ids: string[]): AgentProvider[] {
  for (const id of ids)
    if (!isProvider(id))
      throw new CliError(`unknown provider: ${id} (one of: ${Object.keys(PROVIDERS).join(", ")})`);
  const chosen =
    ids.length > 0 ? (ids as AgentProvider[]) : (Object.keys(PROVIDERS) as AgentProvider[]);
  return chosen.filter((id) => PROVIDERS[id].terminal);
}

function shown(repo: string, file: string): string {
  const rel = path.relative(repo, file);
  return rel.startsWith("..") ? file : rel;
}

/**
 * `longe ask-in-inbox on`: the agents' own sessions (terminal, IDE) ask through the
 * inbox, as far as each agent's CLI allows (see ChatProvider.terminal). Default is
 * the user's own settings files; `shared` writes the ones committed with the repo.
 * Using an agent with longe does not need this: MCP and AGENTS.md do that.
 */
export async function askInInboxOn(
  repo: string,
  opts: { shared?: boolean; providers?: string[] } = {},
): Promise<InboxHookResult[]> {
  const shared = opts.shared ?? false;
  const out: InboxHookResult[] = [];
  for (const id of which(opts.providers ?? [])) {
    const t = PROVIDERS[id].terminal;
    if (!t) continue;
    out.push({
      provider: id,
      file: shown(repo, t.file(repo, shared)),
      changed: await t.install(repo, shared),
      what: t.what,
    });
  }
  return out;
}

/**
 * `longe ask-in-inbox off`: takes the hooks out again, from the user's own files and
 * the shared ones (only the shared ones with `shared`), so "off" means gone.
 */
export async function askInInboxOff(
  repo: string,
  opts: { shared?: boolean; providers?: string[] } = {},
): Promise<InboxHookResult[]> {
  const out: InboxHookResult[] = [];
  for (const id of which(opts.providers ?? [])) {
    const t = PROVIDERS[id].terminal;
    if (!t) continue;
    for (const s of opts.shared ? [true] : [false, true]) {
      if (!(await t.remove(repo, s))) continue;
      out.push({ provider: id, file: shown(repo, t.file(repo, s)), changed: true, what: t.what });
    }
  }
  return out;
}

export async function runAskInInbox(
  rest: string[],
  repo: string,
  shared: boolean,
): Promise<number> {
  const [sub, ...providers] = rest;
  if (sub === "on") {
    for (const r of await askInInboxOn(repo, { shared, providers }))
      process.stdout.write(
        `${r.provider.padEnd(7)}${r.changed ? "added to" : "already in"} ${r.file}: ${r.what}\n`,
      );
    process.stdout.write("Restart running sessions to pick it up.\n");
    return 0;
  }
  if (sub === "off") {
    const removed = await askInInboxOff(repo, { shared, providers });
    for (const r of removed)
      process.stdout.write(`${r.provider.padEnd(7)}removed from ${r.file}\n`);
    if (removed.length === 0) process.stdout.write("no inbox hooks were installed\n");
    return 0;
  }
  process.stderr.write("Usage: longe ask-in-inbox on | off [claude|codex …] [--shared]\n");
  return 2;
}
