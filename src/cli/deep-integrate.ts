import path from "node:path";
import { createInterface } from "node:readline/promises";
import { isProvider, PROVIDERS } from "../app/providers/index.js";
import type { TerminalIntegration } from "../app/providers/types.js";
import type { AgentProvider } from "../store/config.js";
import { CliError } from "./args.js";

export interface DeepIntegrationResult {
  provider: AgentProvider;
  /** `<provider>:<id>`, e.g. `claude:hook`, `claude:mod`. */
  key: string;
  /** Where the integration lives (relative to the repo when inside it). */
  file: string;
  /** Changed now (added, or removed with --remove). */
  changed: boolean;
  what: string;
}

/** One integration longe can add, with its provider. */
export interface DeepIntegrationItem {
  provider: AgentProvider;
  key: string;
  integration: TerminalIntegration;
}

function which(ids: string[]): AgentProvider[] {
  for (const id of ids)
    if (!isProvider(id))
      throw new CliError(`unknown provider: ${id} (one of: ${Object.keys(PROVIDERS).join(", ")})`);
  return ids.length > 0
    ? ([...new Set(ids)] as AgentProvider[])
    : (Object.keys(PROVIDERS) as AgentProvider[]);
}

/**
 * What can be added for these providers (all without names): each provider's
 * integrations this install offers; with `shared` only those that can live in the
 * repo's committed files.
 */
export function deepIntegrationItems(
  opts: { shared?: boolean; providers?: string[]; remove?: boolean } = {},
): DeepIntegrationItem[] {
  return which(opts.providers ?? []).flatMap((provider) =>
    (PROVIDERS[provider].terminal ?? [])
      .filter((t) => (opts.remove || (t.available?.() ?? true)) && !(opts.shared && t.userOnly))
      .map((integration) => ({ provider, key: `${provider}:${integration.id}`, integration })),
  );
}

function shown(repo: string, file: string): string {
  const rel = path.relative(repo, file);
  return rel.startsWith("..") ? file : rel;
}

/**
 * `longe provider deep-integrate`: optional hooks into each provider's own CLI, as far
 * as it allows (see ChatProvider.terminal), so its terminal and IDE sessions use the
 * inbox more reliably, and the longe-inbox mod for Claude Code. Agents work with longe
 * without it (MCP and AGENTS.md); this only catches what the protocol alone may miss.
 * Default is the user's own settings files; `shared` writes the ones committed with the
 * repo. `only` (keys) limits it to what was chosen; without it, everything.
 */
export async function deepIntegrate(
  repo: string,
  opts: { shared?: boolean; providers?: string[]; only?: string[] | undefined } = {},
): Promise<DeepIntegrationResult[]> {
  const shared = opts.shared ?? false;
  const out: DeepIntegrationResult[] = [];
  for (const { provider, key, integration: t } of deepIntegrationItems(opts)) {
    if (opts.only && !opts.only.includes(key)) continue;
    out.push({
      provider,
      key,
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
  opts: { shared?: boolean; providers?: string[]; only?: string[] | undefined } = {},
): Promise<DeepIntegrationResult[]> {
  const out: DeepIntegrationResult[] = [];
  for (const provider of which(opts.providers ?? [])) {
    for (const t of PROVIDERS[provider].terminal ?? []) {
      if (opts.only && !opts.only.includes(`${provider}:${t.id}`)) continue;
      const scopes = t.userOnly
        ? opts.shared
          ? []
          : [false]
        : opts.shared
          ? [true]
          : [false, true];
      for (const s of scopes) {
        if (!(await t.remove(repo, s))) continue;
        out.push({
          provider,
          key: `${provider}:${t.id}`,
          file: shown(repo, t.file(repo, s)),
          changed: true,
          what: t.what,
        });
      }
    }
  }
  return out;
}

/** Asks one question and returns the typed line. */
export type Ask = (question: string) => Promise<string>;

async function yes(question: string, ask: Ask, write: (text: string) => void): Promise<boolean> {
  for (;;) {
    const answer = (await ask(question)).trim().toLowerCase();
    if (answer === "" || answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    write("Please answer y or n (Enter means yes).\n");
  }
}

/**
 * The deep-integrate prompt: everything (the default), or one yes/no per integration.
 * Returns the chosen keys.
 */
export async function chooseIntegrations(
  repo: string,
  items: DeepIntegrationItem[],
  shared: boolean,
  ask: Ask,
  write: (text: string) => void,
): Promise<string[]> {
  if (items.length === 0) return [];
  write("longe can add these integrations:\n");
  for (const { integration: t } of items)
    write(`  - ${t.label}\n      → ${shown(repo, t.file(repo, shared))}\n`);
  if (await yes("Install all of them? [Y/n] (n: choose each one) ", ask, write))
    return items.map((i) => i.key);
  const chosen: string[] = [];
  for (const { key, integration: t } of items)
    if (await yes(`  ${t.label}? [Y/n] `, ask, write)) chosen.push(key);
  return chosen;
}

const USAGE =
  "Usage: longe provider deep-integrate [claude|codex …] [--all | --hook --mod] [--shared] [--remove]\n";

interface ChoiceOptions {
  shared: boolean;
  providers?: string[];
  all?: boolean;
  hook?: boolean;
  mod?: boolean;
  remove?: boolean;
}

/** Explicit flags bypass the prompt, and never silently skip an unsupported request. */
function explicitChoice(items: DeepIntegrationItem[], opts: ChoiceOptions): string[] | undefined {
  const ids = [opts.hook ? "hook" : "", opts.mod ? "mod" : ""].filter(Boolean);
  if (ids.length === 0) return undefined;
  if (opts.all) throw new CliError("Use --all or --hook/--mod, not both");
  for (const id of ids)
    if (!items.some((i) => i.integration.id === id))
      throw new CliError(
        `--${id} is not available for these providers and scope${id === "mod" ? " (the Claude mod uses user settings; omit --shared)" : ""}`,
      );
  return items.filter((i) => ids.includes(i.integration.id)).map((i) => i.key);
}

/** `longe provider <subcommand>`; deep-integrate is the only one so far. */
export async function runProvider(
  rest: string[],
  repo: string,
  opts: ChoiceOptions & { remove: boolean },
): Promise<number> {
  const [sub, ...providers] = rest;
  if (sub !== "deep-integrate") {
    process.stderr.write(USAGE);
    return 2;
  }
  if (!opts.remove) {
    const only = await promptedChoice(repo, { ...opts, providers });
    const results = await deepIntegrate(repo, { shared: opts.shared, providers, only });
    for (const r of results)
      process.stdout.write(
        `${r.key.padEnd(12)}${r.changed ? "added to" : "already in"} ${r.file}: ${r.what}\n`,
      );
    process.stdout.write(
      results.length > 0 ? "Restart running sessions to pick it up.\n" : "Nothing added.\n",
    );
    return 0;
  }
  const only = explicitChoice(deepIntegrationItems({ ...opts, providers }), opts);
  const removed = await removeDeepIntegration(repo, { shared: opts.shared, providers, only });
  for (const r of removed) process.stdout.write(`${r.key.padEnd(12)}removed from ${r.file}\n`);
  if (removed.length === 0) process.stdout.write("no deep integration was installed\n");
  return 0;
}

/**
 * In a terminal, without `--all`: asks what to add and returns the chosen keys.
 * Elsewhere (scripts, CI, the web UI) nobody can answer, so everything is added
 * (undefined), as before the prompt existed.
 */
export async function promptedChoice(
  repo: string,
  opts: ChoiceOptions,
): Promise<string[] | undefined> {
  const items = deepIntegrationItems(opts);
  const only = explicitChoice(items, opts);
  if (only) return only;
  if (opts.all || !process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await chooseIntegrations(
      repo,
      items,
      opts.shared,
      (q) => rl.question(q),
      (t) => process.stdout.write(t),
    );
  } finally {
    rl.close();
  }
}
