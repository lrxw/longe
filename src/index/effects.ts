import {
  type Effect,
  effectsForQuestionClosed,
  effectsForQuestionCreated,
  effectsForTopicStatus,
} from "../domain/side-effects.js";
import { transitionTopic } from "../domain/topic-ops.js";
import type { Repo } from "../store/repo.js";
import type { AiIndex, QuestionChange, TopicChange } from "./index.js";

export type Notifier = (title: string, body: string) => void;
export type HookTrigger = (
  hook: "on_answer",
  vars: { question_id: string; topic_id?: string; answer: string; question: string },
) => void;

/**
 * Executes effects. Topic status changes go through the normal read–modify–write
 * path as the `system` actor; notifications go to `notify` and never throw.
 */
export async function applyEffects(
  effects: Effect[],
  repo: Repo,
  notify: Notifier,
  now: () => Date = () => new Date(),
  index?: AiIndex,
): Promise<void> {
  for (const e of effects) {
    switch (e.kind) {
      case "set_topic_status":
        try {
          await repo.modifyTopic(e.topic, (topic) => {
            // re-check on the fresh file: someone may have moved it already
            if (topic.fm.status !== e.from) return;
            transitionTopic(topic, e.to, "system", now(), e.note);
          });
          await index?.refresh("topic", e.topic);
        } catch {
          // topic vanished or is unparsable — the index will surface that
        }
        break;
      case "notify":
        try {
          notify(e.title, e.body);
        } catch {
          // notifications must never fail an operation (§10)
        }
        break;
    }
  }
}

/**
 * Reacts to changes the index observed but the tool did not perform itself
 * (§7.4): a blocking question file appearing, a question being answered by
 * hand, a topic being moved to review by editing the file.
 *
 * Tool handlers apply their own effects synchronously and call `expect()`
 * beforehand so that the watcher does not apply them twice.
 */
export class EffectRunner {
  private readonly expected = new Map<string, string>();

  constructor(
    private readonly index: AiIndex,
    private readonly repo: Repo,
    private readonly notify: Notifier,
    private readonly hook: HookTrigger = () => {},
  ) {}

  /** Declares that `id` is about to reach `state` because of a tool call. */
  expect(id: string, state: string): void {
    this.expected.set(id, state);
  }

  private consume(id: string, state: string): boolean {
    if (this.expected.get(id) === state) {
      this.expected.delete(id);
      return true;
    }
    return false;
  }

  attach(): void {
    this.index.on("batch", ({ topics, questions }) => {
      void this.handle(topics, questions);
    });
  }

  /** Wakes the configured agent hook for an answered question (tool-driven or hand-edited). */
  fireAnswerHook(q: {
    id: string;
    fm: { topic?: string | null | undefined };
    sections: { Question: string; Answer: string };
  }): void {
    const vars: Parameters<HookTrigger>[1] = {
      question_id: q.id,
      answer: q.sections.Answer,
      question: q.sections.Question,
    };
    if (q.fm.topic) vars.topic_id = q.fm.topic;
    this.hook("on_answer", vars);
  }

  async handle(topics: TopicChange[], questions: QuestionChange[]): Promise<void> {
    const effects: import("../domain/side-effects.js").Effect[] = [];

    for (const c of questions) {
      const cur = c.current;
      if (!cur) continue;
      const state = cur.fm.status;
      const before = c.previous?.fm.status;
      if (before === state) continue; // body edit only
      if (this.consume(cur.id, state)) continue; // tool did this and already applied effects
      const topic = cur.fm.topic ? this.index.topics.get(cur.fm.topic) : undefined;
      const view = topic
        ? { fm: topic.fm, openBlockingCount: this.index.openBlockingCount(topic.id) }
        : undefined;
      if (state === "open" && before === undefined) {
        effects.push(...effectsForQuestionCreated(cur.fm, cur.sections.Question, view));
      } else if (before === "open" && (state === "answered" || state === "withdrawn")) {
        effects.push(...effectsForQuestionClosed(cur.fm, view));
        if (state === "answered") this.fireAnswerHook(cur);
      }
    }

    for (const c of topics) {
      const cur = c.current;
      if (!cur || !c.previous) continue;
      const from = c.previous.fm.status;
      const to = cur.fm.status;
      if (from === to) continue;
      if (this.consume(cur.id, to)) continue;
      effects.push(...effectsForTopicStatus(cur.fm, from, to));
    }

    // a system status change we are about to write will show up in the next batch: expect it
    for (const e of effects) if (e.kind === "set_topic_status") this.expect(e.topic, e.to);
    await applyEffects(effects, this.repo, this.notify, () => new Date(), this.index);
  }
}
