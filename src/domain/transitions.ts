import { DomainError } from "./errors.js";
import { type Actor, isTerminal, type TopicStatus } from "./types.js";

interface Rule {
  from: TopicStatus | "non-terminal";
  to: TopicStatus;
  actors: readonly Actor[];
  requiresNote?: boolean;
  /** Text used when an actor is refused. */
  rule: string;
}

/** Transition table from §4, in table order. */
export const TRANSITION_RULES: readonly Rule[] = [
  {
    from: "backlog",
    to: "active",
    actors: ["human", "agent"],
    rule: "agent or human picks up a topic",
  },
  { from: "active", to: "review", actors: ["human", "agent"], rule: "agent or human submits work" },
  {
    from: "review",
    to: "done",
    actors: ["human"],
    rule: "review → done is human-only: agents may never approve their own work",
  },
  {
    from: "review",
    to: "active",
    // system: the human picked one of a question's reject_options in the inbox
    actors: ["human", "system"],
    requiresNote: true,
    rule: "review → active (reject) is human-only and requires a note",
  },
  {
    from: "non-terminal",
    to: "cancelled",
    actors: ["human"],
    rule: "cancelling is human-only",
  },
  { from: "done", to: "active", actors: ["human"], rule: "reopening is human-only" },
  { from: "cancelled", to: "active", actors: ["human"], rule: "reopening is human-only" },
  {
    from: "active",
    to: "needs-decision",
    actors: ["system"],
    rule: "active → needs-decision is set by the system when a blocking question is created",
  },
  {
    from: "needs-decision",
    to: "active",
    actors: ["system"],
    rule: "needs-decision → active is set by the system when the last open blocking question is resolved",
  },
];

function matches(rule: Rule, from: TopicStatus, to: TopicStatus): boolean {
  if (rule.to !== to) return false;
  if (rule.from === "non-terminal") return !isTerminal(from);
  return rule.from === from;
}

export type TransitionResult = { ok: true } | { ok: false; error: DomainError };

/**
 * Pure check of §4. Does not mutate anything.
 * A note is only required where the table says so; extra notes are always fine.
 */
export function checkTransition(
  from: TopicStatus,
  to: TopicStatus,
  actor: Actor,
  note?: string | null,
): TransitionResult {
  if (from === to) {
    return { ok: false, error: new DomainError("same_status", `topic is already ${from}`) };
  }
  const candidates = TRANSITION_RULES.filter((r) => matches(r, from, to));
  if (candidates.length === 0) {
    return {
      ok: false,
      error: new DomainError("transition_not_allowed", `no transition from ${from} to ${to}`),
    };
  }
  const allowed = candidates.find((r) => r.actors.includes(actor));
  if (!allowed) {
    const rule = candidates[0] as Rule;
    const code = rule.actors.includes("human") ? "human_only" : "system_only";
    return {
      ok: false,
      error: new DomainError(code, `${from} → ${to} not allowed for ${actor}: ${rule.rule}`),
    };
  }
  if (allowed.requiresNote && !note?.trim()) {
    return {
      ok: false,
      error: new DomainError("note_required", `${from} → ${to} requires a note: ${allowed.rule}`),
    };
  }
  return { ok: true };
}

export function assertTransition(
  from: TopicStatus,
  to: TopicStatus,
  actor: Actor,
  note?: string | null,
): void {
  const r = checkTransition(from, to, actor, note);
  if (!r.ok) throw r.error;
}

/** Statuses a given actor may move a topic to from `from` (used by the UI to render buttons). */
export function allowedTargets(from: TopicStatus, actor: Actor): TopicStatus[] {
  const out = new Set<TopicStatus>();
  for (const r of TRANSITION_RULES) {
    if (r.actors.includes(actor) && matches(r, from, r.to)) out.add(r.to);
  }
  return [...out];
}
