import { transitionTopic } from "../domain/topic-ops.js";
import type { TopicFrontmatter, TopicStatus } from "../domain/types.js";
import type { InboxEvents, QuestionEvent } from "../inbox/events.js";
import { subjectId } from "../inbox/subject.js";
import type { Subject } from "../inbox/types.js";
import type { AiIndex } from "../index/index.js";
import type { Repo } from "../store/repo.js";

/**
 * The board as a consumer of the inbox (§5): a question about a topic moves the topic.
 * A blocking question parks an active topic in needs-decision until the last blocking
 * question on it is closed; a review question's approve/reject options move a topic in
 * review to done or back to active. The inbox only stores `blocking`, `approve_options`
 * and `reject_options`; their meaning for topics lives here.
 */

export interface TopicEffect {
  kind: "set_topic_status";
  topic: string;
  from: TopicStatus;
  to: TopicStatus;
  note: string;
}

export interface TopicView {
  fm: TopicFrontmatter;
  /** Open blocking questions on this topic, *after* the triggering change. */
  openBlockingCount: number;
}

function truncate(s: string, n = 200): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** What a question event does to its topic (none for questions without one). */
export function topicEffects(event: QuestionEvent, topic: TopicView | undefined): TopicEffect[] {
  if (!topic) return [];
  const q = event.question;
  if (event.kind === "asked") {
    if (!q.blocking || q.status !== "open" || topic.fm.status !== "active") return [];
    return [
      {
        kind: "set_topic_status",
        topic: topic.fm.id,
        from: "active",
        to: "needs-decision",
        note: `blocked on ${q.id}`,
      },
    ];
  }
  const answer = event.kind === "answered" ? event.answer : "";
  // Preserve the submitted choice: custom feedback may start with an approval label.
  // Older files and hand-written answers have no selection metadata.
  const firstParagraph = answer.split(/\n\s*\n/)[0]?.trim() ?? "";
  const chosen =
    q.selected_option !== undefined
      ? q.selected_option
      : q.options?.includes(firstParagraph)
        ? firstParagraph
        : null;
  const isReviewQuestion = (q.reject_options?.length ?? 0) + (q.approve_options?.length ?? 0) > 0;
  if (event.kind === "answered" && topic.fm.status === "review" && answer.trim()) {
    if (
      (chosen === null && isReviewQuestion) ||
      (chosen !== null && (q.reject_options ?? []).includes(chosen))
    )
      return [
        {
          kind: "set_topic_status",
          topic: topic.fm.id,
          from: "review",
          to: "active",
          note: `${chosen === null ? "follow-up" : "rejected"} in ${q.id}: ${truncate(answer)}`,
        },
      ];
    if (chosen !== null && (q.approve_options ?? []).includes(chosen))
      return [
        {
          kind: "set_topic_status",
          topic: topic.fm.id,
          from: "review",
          to: "done",
          note: `approved in ${q.id}: ${truncate(answer)}`,
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
      note: `${q.id} ${event.kind === "withdrawn" ? "withdrawn" : "answered"}, unblocked`,
    },
  ];
}

/**
 * Writes topic status changes as the `system` actor, re-checking the status on the
 * fresh file: someone may have moved the topic in the meantime.
 */
export async function applyTopicEffects(
  effects: TopicEffect[],
  repo: Repo,
  now: () => Date,
  index?: AiIndex,
): Promise<void> {
  for (const e of effects) {
    try {
      await repo.modifyTopic(e.topic, (topic) => {
        if (topic.fm.status !== e.from) return;
        transitionTopic(topic, e.to, "system", now(), e.note);
      });
      await index?.refresh("topic", e.topic);
    } catch {
      // topic vanished or is unparsable — the index will surface that
    }
  }
}

/** The topic a question is about, with its open blocking questions besides this one. */
export function topicViewFor(index: AiIndex, event: QuestionEvent): TopicView | undefined {
  const id = subjectId(event.question, "topic");
  const topic = id ? index.topics.get(id) : undefined;
  if (!id || !topic) return undefined;
  const openBlockingCount = index
    .questionsForTopic(id)
    .filter((q) => q.fm.status === "open" && q.fm.blocking && q.id !== event.question.id).length;
  return { fm: topic.fm, openBlockingCount };
}

/** A topic subject's title, for notifications ("Blocking · <title>"). */
export function describeTopic(index: AiIndex): (subject: Subject) => string | undefined {
  return (subject) =>
    subject.kind === "topic" ? index.topics.get(subject.id)?.fm.title : undefined;
}

/**
 * Subscribes the board to the inbox. `expect` announces a status the board is about to
 * write, so the file watcher does not react to it a second time.
 */
export function attachBoard(
  events: InboxEvents,
  deps: {
    index: AiIndex;
    repo: Repo;
    now: () => Date;
    expect: (id: string, state: string) => void;
  },
): void {
  events.on(async (event) => {
    const effects = topicEffects(event, topicViewFor(deps.index, event));
    for (const e of effects) deps.expect(e.topic, e.to);
    await applyTopicEffects(effects, deps.repo, deps.now, deps.index);
  });
}
