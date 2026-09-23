import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseConfig } from "../store/config.js";
import { migrateBoardDir } from "../store/migrate.js";
import { BOARD_DIR, configPath } from "../store/paths.js";
import { Repo } from "../store/repo.js";

/**
 * Claude Code hooks that route the harness's own questions to the longe inbox.
 *
 * `longe hooks install` adds a PreToolUse hook for AskUserQuestion to the repo's
 * `.claude/settings.json`. When an interactive Claude Code session wants to ask the
 * user, the hook (`longe hooks ask`) writes the question into `.longe/questions/`
 * instead and denies the tool with a reason that tells the agent where the question
 * went and how to get the answer. The web chat does not need it: it runs claude
 * with `--disallowedTools AskUserQuestion`.
 */

export const HOOK_COMMAND = "longe hooks ask";
const MATCHER = "AskUserQuestion";

interface HookEntry {
  type: string;
  command: string;
}
interface MatcherEntry {
  matcher?: string;
  hooks?: HookEntry[];
}
interface Settings {
  hooks?: { PreToolUse?: MatcherEntry[]; [event: string]: unknown };
  [key: string]: unknown;
}

function settingsPath(repo: string): string {
  return path.join(repo, ".claude", "settings.json");
}

async function readSettings(file: string): Promise<Settings> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Settings;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`${file} is not valid JSON; fix it first (${String(err)})`);
  }
}

const isOurs = (m: MatcherEntry) =>
  m.matcher === MATCHER && (m.hooks ?? []).some((h) => h.command === HOOK_COMMAND);

/** Adds the hook; keeps everything else in the file. Returns false when it was there. */
export async function installHook(repo: string): Promise<boolean> {
  const file = settingsPath(repo);
  const settings = await readSettings(file);
  const pre = settings.hooks?.PreToolUse ?? [];
  if (pre.some(isOurs)) return false;
  settings.hooks = {
    ...settings.hooks,
    PreToolUse: [...pre, { matcher: MATCHER, hooks: [{ type: "command", command: HOOK_COMMAND }] }],
  };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
  return true;
}

/** Removes the hook again. Returns false when it was not there. */
export async function removeHook(repo: string): Promise<boolean> {
  const file = settingsPath(repo);
  const settings = await readSettings(file);
  const pre = settings.hooks?.PreToolUse ?? [];
  if (!pre.some(isOurs)) return false;
  const rest = pre.filter((m) => !isOurs(m));
  const { PreToolUse: _ours, ...others } = settings.hooks ?? {};
  const hooks = rest.length > 0 ? { ...others, PreToolUse: rest } : others;
  if (Object.keys(hooks).length > 0) settings.hooks = hooks;
  else delete settings.hooks;
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
  return true;
}

/** `ask_in_inbox` from the repo's config.yml; on unless it says false (or is unreadable). */
export async function askInInboxEnabled(root: string): Promise<boolean> {
  try {
    return parseConfig(await readFile(configPath(root), "utf8")).ask_in_inbox !== false;
  } catch {
    return true;
  }
}

/** The nearest folder at or above `dir` that has `.longe/` (or an old `.ai/` board, moved now). */
async function findRepo(dir: string): Promise<string | undefined> {
  let cur = path.resolve(dir);
  for (;;) {
    await migrateBoardDir(cur).catch(() => false);
    try {
      if ((await stat(path.join(cur, BOARD_DIR))).isDirectory()) return cur;
    } catch {
      // not here: go up
    }
    const up = path.dirname(cur);
    if (up === cur) return undefined;
    cur = up;
  }
}

interface AskInput {
  cwd?: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: {
    questions?: {
      question?: string;
      header?: string;
      options?: { label?: string; description?: string }[];
      multiSelect?: boolean;
    }[];
  };
}

/**
 * The hook itself: turns an AskUserQuestion call into inbox questions. Returns the
 * JSON Claude Code expects on stdout, or undefined to let the tool run as usual
 * (not our tool, no questions, or no `.longe/` above the session's folder).
 */
export async function askToInbox(input: AskInput, now = new Date()): Promise<string | undefined> {
  if (input.tool_name !== MATCHER) return undefined;
  const questions = (input.tool_input?.questions ?? []).filter((q) => q.question?.trim());
  if (questions.length === 0) return undefined;
  const root = await findRepo(input.cwd ?? process.cwd());
  if (!root) return undefined;
  if (!(await askInInboxEnabled(root))) return undefined; // turned off in config.yml
  const repo = new Repo(root);
  const ids: string[] = [];
  for (const q of questions) {
    const labels = (q.options ?? []).map((o) => o.label?.trim() ?? "").filter(Boolean);
    const described = (q.options ?? []).filter((o) => o.label && o.description?.trim());
    const context = [
      "Asked from a Claude Code terminal session (its AskUserQuestion tool was sent here).",
      q.multiSelect ? "Several options may apply: pick one, or answer in your own words." : "",
      ...described.map((o) => `- **${o.label}**: ${o.description}`),
    ]
      .filter(Boolean)
      .join("\n");
    ids.push(
      await repo.createQuestion({
        question: q.header?.trim()
          ? `**${q.header.trim()}.** ${q.question?.trim()}`
          : `${q.question?.trim()}`,
        context,
        ...(labels.length >= 2 ? { options: labels.slice(0, 4) } : {}),
        blocking: true,
        asked_by: `claude-code${input.session_id ? ` ${input.session_id.slice(0, 8)}` : ""}`,
        now,
      }),
    );
  }
  const list = ids.join(", ");
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Not asked in the terminal: this repo uses the longe inbox, and the question is there now as ${list}. The human answers in the inbox. Get the answer with the longe MCP tool wait_for_answer (id ${ids[0]}), or continue on a reasonable assumption and call check_answers later. Do not ask the same question in plain text.`,
    },
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function runHooks(rest: string[], repo: string): Promise<number> {
  const [sub] = rest;
  switch (sub) {
    case "install": {
      const added = await installHook(repo);
      process.stdout.write(
        added
          ? `added the AskUserQuestion hook to ${settingsPath(repo)}\nClaude Code sessions in this repo now ask through the longe inbox (restart running sessions).\n`
          : `the hook is already in ${settingsPath(repo)}\n`,
      );
      return 0;
    }
    case "remove": {
      const removed = await removeHook(repo);
      process.stdout.write(
        removed ? `removed the hook from ${settingsPath(repo)}\n` : "the hook was not installed\n",
      );
      return 0;
    }
    case "ask": {
      // a failing hook must never break the session: on any error, let the tool run
      try {
        const out = await askToInbox(JSON.parse(await readStdin()) as AskInput);
        if (out) process.stdout.write(`${out}\n`);
      } catch (err) {
        process.stderr.write(`longe hooks ask: ${String(err)}\n`);
      }
      return 0;
    }
    default:
      process.stderr.write("Usage: longe hooks install | remove   (ask is run by Claude Code)\n");
      return 2;
  }
}
