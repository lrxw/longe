export const TOPIC_STATUSES = [
  "backlog",
  "todo",
  "active",
  "needs-decision",
  "review",
  "done",
  "cancelled",
] as const;
export type TopicStatus = (typeof TOPIC_STATUSES)[number];

export const TERMINAL_STATUSES: readonly TopicStatus[] = ["done", "cancelled"];

// questions belong to the inbox (src/inbox/); the board is one of its consumers
export {
  QUESTION_SECTIONS,
  QUESTION_STATUSES,
  type QuestionFrontmatter,
  type QuestionStatus,
  type Subject,
} from "../inbox/types.js";

export type Actor = "human" | "agent" | "system";
export type BallHolder = "human" | "agent" | "none";

export const TOPIC_SECTIONS = ["Goal", "Plan", "Decisions", "Log"] as const;

export interface TopicFrontmatter {
  id: string;
  title: string;
  status: TopicStatus;
  created: string;
  updated: string;
  links: string[];
  branch?: string | null;
  /** Place in the todo queue, set when the human reorders it (1 = next). */
  rank?: number;
  [key: string]: unknown;
}

/** Who has the ball is derived from status, never stored (§4). */
export function ballHolder(status: TopicStatus): BallHolder {
  switch (status) {
    case "backlog":
    case "needs-decision":
    case "review":
      return "human";
    case "todo": // queued: the chat picks it up when it is free
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
