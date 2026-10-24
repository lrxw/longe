import type { Subject } from "./types.js";

/**
 * The inbox as both surfaces show it: the web inbox (htmx) and the longe-inbox mod in
 * Claude Code. One view model (`GET /api/v1/inbox`) and one set of semantic tokens, so
 * order, labels, icons and the meaning of colours stay the same in both. The tokens
 * name roles, not colours: the web maps them to CSS variables, the mod to Claude Code
 * theme keys. Bump INBOX_VIEW_VERSION when a field changes meaning or goes away; adding
 * fields keeps it.
 *
 * The inbox knows nothing about boards: where a question's links point is the
 * caller's to say (`InboxSource.links`).
 *
 * The mod keeps a copy of the tokens (mods/longe-inbox/hooks/tokens.ts; a mod cannot
 * import files outside its folder); a test keeps the copy equal.
 */

export const INBOX_VIEW_VERSION = 1;

export type InboxRole = "blocking" | "nonBlocking" | "approve" | "reject" | "muted" | "accent";
export type OptionRole = "approve" | "reject" | "neutral";

export const INBOX_TOKENS = {
  roles: {
    blocking: { label: "blocking", icon: "●" },
    nonBlocking: { label: "non-blocking", icon: "○" },
    approve: { label: "approves the work", icon: "✓" },
    reject: { label: "sends the work back", icon: "✗" },
    muted: { label: "", icon: "" },
    accent: { label: "", icon: "" },
  },
  text: {
    workingOn: "Working on:",
    projectWide: "project-wide",
    context: "Context",
    reply: "Reply",
    empty: "Nothing is waiting on you.",
    emptyProject: "Nothing is waiting on you in this project.",
  },
} as const satisfies {
  roles: Record<InboxRole, { label: string; icon: string }>;
  text: Record<string, string>;
};

export type InboxTokens = typeof INBOX_TOKENS;

/** What a question needs to become part of the view; filled by the caller. */
export interface InboxSource {
  id: string;
  /** The project (repository) the question lives in. */
  repo: { name: string; title: string; color: string };
  subject: Subject | null;
  /**
   * Where a human looks, as paths or URLs: the project's page and the subject's page
   * (null when there is none). The caller knows its routes; the inbox does not.
   */
  links: { project: string; subject: string | null };
  blocking: boolean;
  askedBy: string;
  askedAt: string;
  question: string;
  context: string;
  assumption?: string | null | undefined;
  options: string[];
  approveOptions: string[];
  rejectOptions: string[];
}

export interface InboxViewOption {
  index: number;
  label: string;
  role: OptionRole;
}

export interface InboxViewQuestion {
  id: string;
  repo: string;
  project: string;
  /** The project's colour (hex), the same on every surface. */
  color: string;
  subject: Subject | null;
  /** The subject's id (for board questions, the topic); null when there is none. */
  topic: string | null;
  kind: "blocking" | "nonBlocking";
  /** Has approve or reject options: a request to verify work in review. */
  review: boolean;
  askedBy: string;
  askedAt: string;
  /** Markdown. */
  question: string;
  /** Markdown; "" when there is none. */
  context: string;
  /** Show the context open from the start: it holds code, which is meant to be read. */
  contextOpen: boolean;
  assumption: string | null;
  options: InboxViewOption[];
  /** `board`: the project's page; `topic`: the subject's page (names kept from v1). */
  links: { board: string; topic: string | null };
}

export interface InboxView {
  version: typeof INBOX_VIEW_VERSION;
  tokens: InboxTokens;
  counts: { total: number; blocking: number; nonBlocking: number; projects: number };
  questions: InboxViewQuestion[];
  /** Files longe could not read, so they are not lost silently. */
  problems: { file: string; message: string; repo?: string }[];
}

/** longe's inbox order: blocking first, then oldest first, then by id. */
export function inboxOrder(
  a: { blocking: boolean; askedAt: string; id: string },
  b: { blocking: boolean; askedAt: string; id: string },
): number {
  if (a.blocking !== b.blocking) return a.blocking ? -1 : 1;
  return a.askedAt.localeCompare(b.askedAt) || a.id.localeCompare(b.id);
}

export function optionRole(
  label: string,
  q: { approveOptions: string[]; rejectOptions: string[] },
): OptionRole {
  return q.rejectOptions.includes(label)
    ? "reject"
    : q.approveOptions.includes(label)
      ? "approve"
      : "neutral";
}

export function toViewQuestion(s: InboxSource): InboxViewQuestion {
  return {
    id: s.id,
    repo: s.repo.name,
    project: s.repo.title,
    color: s.repo.color,
    subject: s.subject,
    topic: s.subject?.id ?? null,
    kind: s.blocking ? "blocking" : "nonBlocking",
    review: s.approveOptions.length > 0 || s.rejectOptions.length > 0,
    askedBy: s.askedBy,
    askedAt: s.askedAt,
    question: s.question,
    context: s.context,
    contextOpen: s.context.includes("```"),
    assumption: s.assumption ?? null,
    options: s.options.map((label, index) => ({ index, label, role: optionRole(label, s) })),
    links: { board: s.links.project, topic: s.links.subject },
  };
}

export function buildInboxView(
  sources: InboxSource[],
  problems: InboxView["problems"] = [],
): InboxView {
  const questions = [...sources].sort(inboxOrder).map(toViewQuestion);
  const blocking = questions.filter((q) => q.kind === "blocking").length;
  return {
    version: INBOX_VIEW_VERSION,
    tokens: INBOX_TOKENS,
    counts: {
      total: questions.length,
      blocking,
      nonBlocking: questions.length - blocking,
      projects: new Set(questions.map((q) => q.repo)).size,
    },
    questions,
    problems,
  };
}
