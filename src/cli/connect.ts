import path from "node:path";
import { isProvider, PROVIDERS } from "../app/providers/index.js";
import type { AgentProvider } from "../store/config.js";
import { CliError } from "./args.js";

export interface ConnectResult {
  provider: AgentProvider;
  /** Where the integration lives (relative to the repo when inside it). */
  file: string;
  /** Changed now (added by connect, removed by disconnect). */
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
 * `longe connect`: every provider (or the named ones) gets what its CLI supports so
 * its own sessions ask through the inbox. Default is the user's own settings file;
 * `shared` writes the one committed with the repo.
 */
export async function connect(
  repo: string,
  opts: { shared?: boolean; providers?: string[] } = {},
): Promise<ConnectResult[]> {
  const shared = opts.shared ?? false;
  const out: ConnectResult[] = [];
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
 * `longe disconnect`: takes the integrations out again, from the user's own file and
 * the shared one (only the shared one with `shared`), so "disconnect" means gone.
 */
export async function disconnect(
  repo: string,
  opts: { shared?: boolean; providers?: string[] } = {},
): Promise<ConnectResult[]> {
  const out: ConnectResult[] = [];
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

export async function runConnect(
  command: "connect" | "disconnect",
  providers: string[],
  repo: string,
  shared: boolean,
): Promise<number> {
  if (command === "connect") {
    for (const r of await connect(repo, { shared, providers }))
      process.stdout.write(
        `${r.provider.padEnd(7)}${r.changed ? "added to" : "already in"} ${r.file}: ${r.what}\n`,
      );
    process.stdout.write("Restart running sessions to pick it up.\n");
  } else {
    const removed = await disconnect(repo, { shared, providers });
    for (const r of removed)
      process.stdout.write(`${r.provider.padEnd(7)}removed from ${r.file}\n`);
    if (removed.length === 0) process.stdout.write("nothing was connected\n");
  }
  return 0;
}
