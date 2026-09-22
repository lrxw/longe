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
  effects.push({
    kind: "notify",
    title: topic ? topic.fm.title : "longe",
    body: truncate(questionText),
  });
  return effects;
}

/** A question left `open` (answered or withdrawn). */
export function effectsForQuestionClosed(
  q: QuestionFrontmatter,
  topic: TopicView | undefined,
): Effect[] {
  if (!q.blocking || !topic) return [];
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

/** A topic changed status. */
export function effectsForTopicStatus(
  topic: TopicFrontmatter,
  from: TopicStatus,
  to: TopicStatus,
): Effect[] {
  if (to === "review" && from !== "review") {
    return [
      { kind: "notify", title: `Ready for review: ${topic.title}`, body: "Topic entered review." },
    ];
  }
  return [];
}
