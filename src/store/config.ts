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

export const configSchema = z.looseObject({
  version: z.literal(1),
  project: z.string().trim().min(1).optional(),
  hooks: hooksSchema.optional(),
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
`;
}
