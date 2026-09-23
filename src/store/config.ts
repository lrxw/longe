import * as YAML from "yaml";
import { z } from "zod";
import { ParseError } from "../domain/errors.js";
import { formatZodIssues } from "../domain/schemas.js";

export const hooksSchema = z.object({
  /**
   * Shell command run when a human answers a question. Placeholders
   * {question_id} {topic_id} {answer} {question} are replaced (shell-quoted);
   * the same values arrive as LONGE_QUESTION_ID, LONGE_TOPIC_ID, LONGE_ANSWER,
   * LONGE_QUESTION. Runs with cwd = repo root, one at a time per repo.
   */
  on_answer: z.string().trim().min(1).optional(),
});

/** How the board starts the coding agent (Claude Code by default). */
export const agentSchema = z.object({
  /** Binary to run. */
  command: z.string().trim().min(1).optional(),
  /** `--permission-mode` for headless runs. */
  permission_mode: z.string().trim().min(1).optional(),
  /** `--model` for the chat (alias like `sonnet` or a full id). The chat page can override it per session. */
  model: z.string().trim().min(1).optional(),
  /**
   * Claude Code permission rules the chat may use without asking, e.g.
   * `Bash(pnpm test:*)`; appended to `--allowedTools` (longe's own tools are always allowed).
   */
  allowed_tools: z.array(z.string().trim().min(1)).optional(),
  /** Extra CLI arguments appended verbatim. */
  args: z.array(z.string()).optional(),
  /** Close the agent process after this long without work (0: never). Default 30. */
  idle_minutes: z.number().min(0).optional(),
});
export type AgentConfig = z.infer<typeof agentSchema>;

export const configSchema = z.looseObject({
  version: z.literal(1),
  project: z.string().trim().min(1).optional(),
  /** Accent color for this repo in the UI (any CSS color). Default: derived from the name. */
  color: z.string().trim().min(1).optional(),
  hooks: hooksSchema.optional(),
  agent: agentSchema.optional(),
});
export type Config = z.infer<typeof configSchema>;
export type HookName = keyof z.infer<typeof hooksSchema>;

export function parseConfig(text: string, file?: string): Config {
  const parsed = configSchema.safeParse(YAML.parse(text) ?? {});
  if (!parsed.success) throw new ParseError(formatZodIssues(parsed.error), file);
  return parsed.data;
}

/** Template written by `longe init`. */
export function defaultConfigText(projectName: string): string {
  return `version: 1
project: ${JSON.stringify(projectName)}

# Optional: wake an agent when you answer a question on the board.
# Runs once per answer (coalesced while a run is in progress), cwd = this repo.
# Placeholders: {question_id} {topic_id} {answer} {question}
# Output goes to ~/.cache/longe/hooks/<project>.log and the inbox shows the status.
#
# hooks:
#   on_answer: >-
#     claude -p --permission-mode acceptEdits
#     "Question {question_id} on topic {topic_id} was answered: {answer}.
#      Call check_answers, acknowledge_answers, then continue that topic."

# Optional: how the board runs the agent behind the chat (and topic-page prompts).
# Defaults: command claude, permission_mode acceptEdits, claude's default model, no
# allowed_tools, no extra args, idle_minutes 30.
# One session per repo: a process stays open while you chat, closes after idle_minutes,
# and the next message resumes the session. longe's MCP endpoint is passed in.
# Answers you give on the board are fed into the chat unless hooks.on_answer is set.
# Headless runs cannot answer permission prompts: list what the chat may run in
# allowed_tools (Claude Code permission rules), or allow it in .claude/settings.json.
#
# agent:
#   command: claude
#   permission_mode: acceptEdits
#   model: sonnet
#   allowed_tools: ["Bash(pnpm test:*)", "Bash(git add:*)", "Bash(git commit:*)"]
#   args: []
#   idle_minutes: 30
`;
}
