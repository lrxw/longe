import path from "node:path";
import { isProvider, PROVIDERS } from "../app/providers/index.js";
import type { AgentProvider } from "../store/config.js";
import { CliError } from "./args.js";

export interface DeepIntegrationResult {
  provider: AgentProvider;
  /** Where the integration lives (relative to the repo when inside it). */
  file: string;
  /** Changed now (added, or removed with --remove). */
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
 * `longe provider deep-integrate`: optional hooks into each provider's own CLI, as far
 * as it allows (see ChatProvider.terminal), so its terminal and IDE sessions use the
 * inbox more reliably. Agents work with longe without it (MCP and AGENTS.md); this
 * only catches what the protocol alone may miss. Default is the user's own settings
 * files; `shared` writes the ones committed with the repo.
 */
export async function deepIntegrate(
  repo: string,
  opts: { shared?: boolean; providers?: string[] } = {},
): Promise<DeepIntegrationResult[]> {
  const shared = opts.shared ?? false;
  const out: DeepIntegrationResult[] = [];
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
 * `longe provider deep-integrate --remove`: takes it out again, from the user's own
 * files and the shared ones (only the shared ones with `shared`), so it is gone.
 */
export async function removeDeepIntegration(
  repo: string,
  opts: { shared?: boolean; providers?: string[] } = {},
): Promise<DeepIntegrationResult[]> {
  const out: DeepIntegrationResult[] = [];
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

const USAGE = "Usage: longe provider deep-integrate [claude|codex …] [--shared] [--remove]\n";

/** `longe provider <subcommand>`; deep-integrate is the only one so far. */
export async function runProvider(
  rest: string[],
  repo: string,
  opts: { shared: boolean; remove: boolean },
): Promise<number> {
  const [sub, ...providers] = rest;
  if (sub !== "deep-integrate") {
    process.stderr.write(USAGE);
    return 2;
  }
  if (!opts.remove) {
    for (const r of await deepIntegrate(repo, { shared: opts.shared, providers }))
      process.stdout.write(
        `${r.provider.padEnd(7)}${r.changed ? "added to" : "already in"} ${r.file}: ${r.what}\n`,
      );
    process.stdout.write("Restart running sessions to pick it up.\n");
    return 0;
  }
  const removed = await removeDeepIntegration(repo, { shared: opts.shared, providers });
  for (const r of removed) process.stdout.write(`${r.provider.padEnd(7)}removed from ${r.file}\n`);
  if (removed.length === 0) process.stdout.write("no deep integration was installed\n");
  return 0;
}
