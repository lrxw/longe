import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { endsWithQuestion } from "../domain/ends-with-question.js";
import { askInInboxEnabled, findRepo } from "./hooks.js";

/**
 * Codex's part of `longe connect`. Codex has no hook for its own ask-the-user tool,
 * so the question cannot be redirected the way Claude Code's is. What it has is a
 * Stop hook that sees the last reply and may send the turn on with a new prompt: when
 * the reply ends with a question, Codex is told to ask it in the inbox instead.
 *
 * Codex has no git-ignored project file for hooks. The default (not shared) is the
 * user's own `~/.codex/hooks.json`; the hook only acts inside a repo with `.longe/`.
 * `--shared` writes `<repo>/.codex/hooks.json`, which Codex loads once the project
 * is trusted (review it with `/hooks` in Codex).
 */
export const CODEX_STOP_COMMAND = "longe hooks stop";

interface CommandHook {
  type?: string;
  command?: string;
  timeout?: number;
}
interface HooksFile {
  hooks?: { Stop?: { matcher?: string; hooks?: CommandHook[] }[]; [event: string]: unknown };
  [key: string]: unknown;
}

export function codexHooksPath(repo: string, shared = false): string {
  if (shared) return path.join(repo, ".codex", "hooks.json");
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(home, "hooks.json");
}

async function readHooks(file: string): Promise<HooksFile> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as HooksFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`${file} is not valid JSON; fix it first (${String(err)})`);
  }
}

const isOurs = (g: { hooks?: CommandHook[] }) =>
  (g.hooks ?? []).some((h) => h.command === CODEX_STOP_COMMAND);

/** Adds the Stop hook; keeps everything else in the file. False when it was there. */
export async function installCodexHook(repo: string, shared = false): Promise<boolean> {
  const file = codexHooksPath(repo, shared);
  const doc = await readHooks(file);
  const stop = doc.hooks?.Stop ?? [];
  if (stop.some(isOurs)) return false;
  doc.hooks = {
    ...doc.hooks,
    Stop: [...stop, { hooks: [{ type: "command", command: CODEX_STOP_COMMAND, timeout: 10 }] }],
  };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`);
  return true;
}

/** Removes the Stop hook again. False when it was not there. */
export async function removeCodexHook(repo: string, shared = false): Promise<boolean> {
  const file = codexHooksPath(repo, shared);
  const doc = await readHooks(file);
  const stop = doc.hooks?.Stop ?? [];
  if (!stop.some(isOurs)) return false;
  const rest = stop.filter((g) => !isOurs(g));
  const { Stop: _ours, ...others } = doc.hooks ?? {};
  const hooks = rest.length > 0 ? { ...others, Stop: rest } : others;
  if (Object.keys(hooks).length > 0) doc.hooks = hooks;
  else delete doc.hooks;
  await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`);
  return true;
}

interface StopInput {
  cwd?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string | null;
}

/** Sent back to Codex when its reply ends with a question. */
export const CODEX_ASK_PROMPT =
  "Your last reply ends with a question, but this repository uses the longe inbox and the human may not read the terminal. If you need an answer, ask it with the longe MCP tool ask_question (2-4 options), then wait_for_answer or continue on a stated assumption. If you already asked it there, or the question was rhetorical, just stop.";

/**
 * The hook itself. Returns the JSON Codex expects on stdout to continue the turn,
 * or undefined to let it stop (no `.longe/` above cwd, inbox asking off, already
 * continued once, or the reply does not end with a question).
 */
export async function codexStop(input: StopInput): Promise<string | undefined> {
  if (input.stop_hook_active) return undefined; // one reminder per turn, never a loop
  if (!endsWithQuestion(input.last_assistant_message ?? "")) return undefined;
  const root = await findRepo(input.cwd ?? process.cwd());
  if (!root || !(await askInInboxEnabled(root))) return undefined;
  return JSON.stringify({ decision: "block", reason: CODEX_ASK_PROMPT });
}
