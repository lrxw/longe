export const TOPIC_STATUSES = [
  "backlog",
  "active",
  "needs-decision",
  "review",
  "done",
  "cancelled",
] as const;
export type TopicStatus = (typeof TOPIC_STATUSES)[number];

export const TERMINAL_STATUSES: readonly TopicStatus[] = ["done", "cancelled"];

export const QUESTION_STATUSES = ["open", "answered", "acknowledged", "withdrawn"] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export type Actor = "human" | "agent" | "system";
export type BallHolder = "human" | "agent" | "none";

export const TOPIC_SECTIONS = ["Goal", "Plan", "Decisions", "Log"] as const;
export const QUESTION_SECTIONS = ["Question", "Context", "Answer"] as const;

export interface TopicFrontmatter {
  id: string;
  title: string;
  status: TopicStatus;
  created: string;
  updated: string;
  links: string[];
  branch?: string | null;
  [key: string]: unknown;
}

export interface QuestionFrontmatter {
  id: string;
  topic?: string | null;
  asked_by: string;
  asked_at: string;
  status: QuestionStatus;
  blocking: boolean;
  options?: string[] | null;
  assumption?: string | null;
  answered_at?: string | null;
  acknowledged_at?: string | null;
  [key: string]: unknown;
}

/** Who has the ball is derived from status, never stored (§4). */
export function ballHolder(status: TopicStatus): BallHolder {
  switch (status) {
    case "backlog":
    case "needs-decision":
    case "review":
      return "human";
    case "active":
      return "agent";
    case "done":
    case "cancelled":
      return "none";
  }
}

export function isTerminal(status: TopicStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
