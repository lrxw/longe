import type { AppContext } from "../app/context.js";
import { DomainError } from "../domain/errors.js";
import { type AnswerInput, answerQuestion as answerOp } from "../domain/question-ops.js";
import { type Effect, effectsForQuestionClosed } from "../domain/side-effects.js";
import { transitionTopic } from "../domain/topic-ops.js";
import type { Actor, TopicStatus } from "../domain/types.js";
import { applyEffects } from "../index/effects.js";
import { type Question, questionSections } from "../store/question.js";
import type { Topic } from "../store/topic.js";

/**
 * Operations shared by the UI, REST and MCP. Each one:
 *  1. announces the state it is about to write (so the watcher skips it),
 *  2. does a read–modify–write on the file,
 *  3. computes §5/§10 effects from the *fresh* file and applies them.
 */

function topicView(ctx: AppContext, topicId: string | null | undefined, excludeQuestion?: string) {
  if (!topicId) return undefined;
  const topic = ctx.index.topics.get(topicId);
  if (!topic) return undefined;
  const openBlockingCount = ctx.index
    .questionsForTopic(topicId)
    .filter((q) => q.fm.status === "open" && q.fm.blocking && q.id !== excludeQuestion).length;
  return { fm: topic.fm, openBlockingCount };
}

async function runEffects(ctx: AppContext, effects: Effect[]): Promise<void> {
  for (const e of effects) if (e.kind === "set_topic_status") ctx.runner.expect(e.topic, e.to);
  await applyEffects(effects, ctx.repo, ctx.notify, ctx.now, ctx.index);
}

export async function setTopicStatus(
  ctx: AppContext,
  id: string,
  to: TopicStatus,
  actor: Actor,
  note?: string | null,
): Promise<Topic> {
  ctx.runner.expect(id, to);
  let topic: Topic;
  try {
    topic = await ctx.repo.modifyTopic(id, (t) => {
      transitionTopic(t, to, actor, ctx.now(), note);
    });
  } catch (err) {
    ctx.runner.expect(id, ""); // clear the expectation on failure
    throw err;
  }
  await ctx.index.refresh("topic", id);
  return topic;
}

export async function answerQuestion(
  ctx: AppContext,
  id: string,
  input: AnswerInput,
): Promise<Question> {
  ctx.runner.expect(id, "answered");
  let q: Question;
  try {
    q = await ctx.repo.modifyQuestion(id, (question) => answerOp(question, input, ctx.now()));
  } catch (err) {
    ctx.runner.expect(id, "");
    throw err;
  }
  await ctx.index.refresh("question", id);
  await runEffects(
    ctx,
    effectsForQuestionClosed(q.fm, topicView(ctx, q.fm.topic, id), questionSections(q).Answer),
  );
  const indexed = ctx.index.questions.get(id);
  if (indexed) ctx.runner.fireAnswerHook(indexed);
  return q;
}

/** Human-facing status operations (§7.1). */
export const human = {
  approve: (ctx: AppContext, id: string) => setTopicStatus(ctx, id, "done", "human"),
  reject: (ctx: AppContext, id: string, note: string) => {
    if (!note?.trim()) throw new DomainError("note_required", "reject requires a note");
    return setTopicStatus(ctx, id, "active", "human", note);
  },
  cancel: (ctx: AppContext, id: string, note?: string) =>
    setTopicStatus(ctx, id, "cancelled", "human", note),
  reopen: (ctx: AppContext, id: string, note?: string) =>
    setTopicStatus(ctx, id, "active", "human", note),
  cleanup: (ctx: AppContext, mode: CleanupMode) => cleanupFinished(ctx, mode),
};

/** Statuses the board's cleanup clears away. */
export const FINISHED: readonly TopicStatus[] = ["done", "cancelled"];

/** `archive` moves the files to `.ai/archive/`; `delete` removes them. */
export type CleanupMode = "archive" | "delete";

/**
 * Archives or deletes every done and cancelled topic with its questions. The status
 * is checked on the fresh file, so a topic reopened a moment ago stays. Returns the
 * topic ids cleared away.
 */
async function cleanupFinished(ctx: AppContext, mode: CleanupMode): Promise<string[]> {
  const clear = (kind: "topic" | "question", id: string) =>
    mode === "archive" ? ctx.repo.archive(kind, id) : ctx.repo.remove(kind, id);
  const cleared: string[] = [];
  const ids = [...ctx.index.topics.values()]
    .filter((t) => FINISHED.includes(t.fm.status))
    .map((t) => t.id);
  for (const id of ids) {
    try {
      const t = await ctx.repo.readTopic(id);
      if (!FINISHED.includes(t.fm.status)) continue;
    } catch {
      continue; // gone or unparsable: nothing to archive
    }
    for (const q of ctx.index.questionsForTopic(id)) {
      await clear("question", q.id);
      await ctx.index.refresh("question", q.id);
    }
    await clear("topic", id);
    await ctx.index.refresh("topic", id);
    cleared.push(id);
  }
  return cleared;
}
