import type { QuestionFrontmatter, TopicFrontmatter, TopicStatus } from "./types.js";

/**
 * Side effects (§5, §10) computed as data. The caller (tool handler or indexer)
 * executes them: `set_topic_status` becomes a read–modify–write of the topic
 * file via transitionTopic(..., "system", ...), `notify` becomes a desktop
 * notification.
 */
export type Effect =
  | { kind: "set_topic_status"; topic: string; from: TopicStatus; to: TopicStatus; note: string }
  | { kind: "notify"; title: string; body: string };

export interface TopicView {
  fm: TopicFrontmatter;
  /** Open blocking questions on this topic, *after* the triggering change. */
  openBlockingCount: number;
}

function truncate(s: string, n = 200): string {
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

/** A question was created (by the tool or detected by the watcher). */
export function effectsForQuestionCreated(
  q: QuestionFrontmatter,
  questionText: string,
  topic: TopicView | undefined,
): Effect[] {
  if (!q.blocking || q.status !== "open") return [];
  const effects: Effect[] = [];
  if (topic && topic.fm.status === "active") {
    effects.push({
      kind: "set_topic_status",
      topic: topic.fm.id,
      from: "active",
      to: "needs-decision",
      note: `blocked on ${q.id}`,
    });
  }
  // the question itself is the title; the body says where it belongs
  effects.push({
    kind: "notify",
    title: headline(questionText),
    body: topic ? `Blocking · ${topic.fm.title}` : "Blocking · project-wide",
  });
  return effects;
}

/**
 * A question left `open` (answered or withdrawn). `answer` is the text under
 * `## Answer`: the chosen option, then the human's note after a blank line.
 */
export function effectsForQuestionClosed(
  q: QuestionFrontmatter,
  topic: TopicView | undefined,
  answer = "",
): Effect[] {
  if (!topic) return [];
  // the human rejected reviewed work from the inbox: send the topic back to the agent
  const chosen = answer.split(/\n\s*\n/)[0]?.trim() ?? "";
  if (
    q.status === "answered" &&
    topic.fm.status === "review" &&
    chosen &&
    (q.reject_options ?? []).includes(chosen)
  ) {
    return [
      {
        kind: "set_topic_status",
        topic: topic.fm.id,
        from: "review",
        to: "active",
        note: `rejected in ${q.id}: ${truncate(answer)}`,
      },
    ];
  }
  if (!q.blocking) return [];
  if (topic.fm.status !== "needs-decision" || topic.openBlockingCount > 0) return [];
  return [
    {
      kind: "set_topic_status",
      topic: topic.fm.id,
      from: "needs-decision",
      to: "active",
      note: `${q.id} ${q.status === "withdrawn" ? "withdrawn" : "answered"}, unblocked`,
    },
  ];
}
