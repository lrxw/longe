import type { InboxEvents, QuestionEvent } from "../inbox/events.js";
import { subjectId } from "../inbox/subject.js";
import type { AiIndex, QuestionChange, TopicChange } from "./index.js";

export type { Notifier } from "../inbox/notify.js";

export type HookTrigger = (
  hook: "on_answer",
  vars: { question_id: string; topic_id?: string; answer: string; question: string },
) => void;

/**
 * Turns changes the index observed but no tool performed (§7.4) into inbox events: a
 * question file appearing, a question answered or withdrawn by hand. Consumers (the
 * notifications, the board) subscribe to the events.
 *
 * Tool handlers emit their own events and call `expect()` beforehand so the watcher
 * does not emit them a second time.
 */
export class EffectRunner {
  private readonly expected = new Map<string, string>();

  constructor(
    private readonly index: AiIndex,
    private readonly events: InboxEvents,
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
    fm: { topic?: string | null | undefined; subject?: { kind: string; id: string } | null };
    sections: { Question: string; Answer: string };
  }): void {
    const vars: Parameters<HookTrigger>[1] = {
      question_id: q.id,
      answer: q.sections.Answer,
      question: q.sections.Question,
    };
    const topic = subjectId(q.fm, "topic");
    if (topic) vars.topic_id = topic;
    this.hook("on_answer", vars);
  }

  async handle(topics: TopicChange[], questions: QuestionChange[]): Promise<void> {
    const events: QuestionEvent[] = [];

    for (const c of questions) {
      const cur = c.current;
      if (!cur) continue;
      const state = cur.fm.status;
      const before = c.previous?.fm.status;
      if (before === state) continue; // body edit only
      if (this.consume(cur.id, state)) continue; // a tool did this and emitted the event
      if (state === "open" && before === undefined) {
        events.push({ kind: "asked", question: cur.fm, text: cur.sections.Question });
      } else if (before === "open" && state === "answered") {
        events.push({
          kind: "answered",
          question: cur.fm,
          text: cur.sections.Question,
          answer: cur.sections.Answer,
        });
        this.fireAnswerHook(cur);
      } else if (before === "open" && state === "withdrawn") {
        events.push({ kind: "withdrawn", question: cur.fm, text: cur.sections.Question });
      }
    }

    // topic moves have no events of their own (no notification since the human asked
    // for questions only); clear what a tool announced so the map does not grow
    for (const c of topics) {
      const cur = c.current;
      if (cur && c.previous && c.previous.fm.status !== cur.fm.status)
        this.consume(cur.id, cur.fm.status);
    }

    for (const e of events) await this.events.emit(e);
  }
}
