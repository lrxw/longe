import type { AiIndex, IndexedQuestion } from "../index/index.js";
import { type AgentRunner, answersPrompt, todoPrompt } from "./agent.js";

/**
 * What the chat is handed when it is free (no turn running, nothing on its way):
 *
 * 1. **Answers first.** Questions the human answered and the agent has not
 *    acknowledged yet wait in their files (the agent's inbox). They are never pushed
 *    into a running turn, where they would get lost; when the turn ends they go out as
 *    one message. Each answer is announced once. Only for a chat that has a session: a
 *    repo that never chatted gets no agent started behind the human's back. Off when
 *    `answers` is false (the repo's own on_answer hook owns that job).
 * 2. **Then todo** (§4): when no topic is active, the oldest todo topic (the one
 *    queued first). A topic is offered once per stay in todo, so an agent that does
 *    not pick it up is not asked again in a loop.
 */
export function attachChatQueue(
  index: AiIndex,
  agent: AgentRunner,
  opts: { answers: boolean } = { answers: true },
): () => void {
  const offered = new Set<string>();
  const announced = new Set<string>();
  // say() counts as busy only once its message file is written: bridge that gap
  let waking = false;
  const wake = (text: string) => {
    waking = true;
    void agent
      .say("board", text)
      .catch(() => {})
      .finally(() => {
        waking = false;
      });
  };
  const next = () => {
    const todo = index.topicsByStatus("todo");
    for (const id of offered) if (!todo.some((t) => t.id === id)) offered.delete(id);
    const unread = index.questionsByStatus("answered");
    for (const id of announced) if (!unread.some((q) => q.id === id)) announced.delete(id);
    if (waking || agent.busy()) return;

    const fresh = opts.answers && agent.hasChat() ? unread.filter((q) => !announced.has(q.id)) : [];
    if (fresh.length > 0) {
      const sorted = [...fresh].sort((a, b) =>
        (a.fm.answered_at ?? "").localeCompare(b.fm.answered_at ?? ""),
      );
      for (const q of sorted) announced.add(q.id);
      wake(answersPrompt(sorted.map(answerVars)));
      return;
    }

    if (index.topicsByStatus("active").length > 0) return;
    const first = [...todo]
      .filter((t) => !offered.has(t.id))
      .sort((a, b) => a.fm.updated.localeCompare(b.fm.updated))[0];
    if (!first) return;
    offered.add(first.id);
    wake(todoPrompt({ id: first.id, title: first.fm.title }));
  };
  index.on("batch", next);
  agent.on("agent:idle", next);
  return next;
}

function answerVars(q: IndexedQuestion) {
  return {
    question_id: q.id,
    topic_id: q.fm.topic ?? undefined,
    answer: q.sections.Answer,
  };
}
