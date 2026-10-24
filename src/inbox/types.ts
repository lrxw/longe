/**
 * The inbox: questions an agent asks a human, their answers, notifications. It knows
 * nothing about topics or boards. A question may name a `subject` (what it is about);
 * the board is one consumer that uses subjects of kind "topic" (see src/board/).
 */

export const QUESTION_STATUSES = ["open", "answered", "acknowledged", "withdrawn"] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export const QUESTION_SECTIONS = ["Question", "Context", "Answer"] as const;

/**
 * What a question is about, for whoever consumes the inbox: a board topic, an issue, a
 * pull request… `kind` and `id` are the consumer's; `url` is where a human can look.
 * Stored as `subject:` in the file; a plain `topic: <id>` (all older files, and every
 * board question) reads as `{ kind: "topic", id }`.
 */
export interface Subject {
  kind: string;
  id: string;
  url?: string | undefined;
}

export interface QuestionFrontmatter {
  id: string;
  /** Board questions store their subject this way (the alias of `{ kind: "topic" }`). */
  topic?: string | null;
  subject?: Subject | null;
  asked_by: string;
  asked_at: string;
  status: QuestionStatus;
  blocking: boolean;
  options?: string[] | null;
  /**
   * Options that reject the subject's reviewed work. The inbox only stores and shows
   * them; a consumer gives them meaning (the board: review → active).
   */
  reject_options?: string[] | null;
  /** Options that approve the subject's reviewed work (the board: review → done). */
  approve_options?: string[] | null;
  /** Submitted option label; null for a custom answer, absent on legacy answers. */
  selected_option?: string | null;
  assumption?: string | null;
  answered_at?: string | null;
  acknowledged_at?: string | null;
  [key: string]: unknown;
}
