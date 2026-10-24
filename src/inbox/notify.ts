import type { InboxEvents } from "./events.js";
import { subjectOf } from "./subject.js";
import type { QuestionFrontmatter, Subject } from "./types.js";

export type Notifier = (title: string, body: string) => void;

export interface Notification {
  title: string;
  body: string;
}

function truncate(s: string, n: number): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * A short headline of a markdown question for a notification title: its first
 * paragraph without markdown marks, cut after the first sentence when that is
 * long enough, at most `n` characters.
 */
export function headline(markdown: string, n = 90): string {
  const first = markdown.trim().split(/\n\s*\n/)[0] ?? "";
  const plain = first
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = /^(.{20,}?[.?!])(\s|$)/.exec(plain)?.[1] ?? plain;
  return truncate(sentence || "Question", n);
}

/**
 * The desktop notification for a new question: only blocking open ones notify. The
 * question is the title; the body says where it belongs (`where`, e.g. a topic's
 * title, else "project-wide").
 */
export function askedNotification(
  q: QuestionFrontmatter,
  text: string,
  where: string,
): Notification | null {
  if (!q.blocking || q.status !== "open") return null;
  return { title: headline(text), body: `Blocking · ${where}` };
}

/**
 * Sends a notification for every blocking question asked. `describe` names a subject
 * for the body (the board gives a topic's title); without it, the subject's id.
 */
export function attachNotifications(
  events: InboxEvents,
  notify: Notifier,
  describe: (subject: Subject) => string | undefined = () => undefined,
): void {
  events.on((e) => {
    if (e.kind !== "asked") return;
    const subject = subjectOf(e.question);
    const where = subject ? (describe(subject) ?? subject.id) : "project-wide";
    const n = askedNotification(e.question, e.text, where);
    if (!n) return;
    try {
      notify(n.title, n.body);
    } catch {
      // notifications must never fail an operation (§10)
    }
  });
}
