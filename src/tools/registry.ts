import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { AppContext } from "../app/context.js";
import { DomainError } from "../domain/errors.js";
import { acknowledgeQuestion, withdrawQuestion } from "../domain/question-ops.js";
import { askQuestionInputSchema } from "../domain/schemas.js";
import { effectsForQuestionClosed, effectsForQuestionCreated } from "../domain/side-effects.js";
import { addDecision, appendLog, setPlan } from "../domain/topic-ops.js";
import { TOPIC_STATUSES } from "../domain/types.js";
import { applyEffects } from "../index/effects.js";
import type { IndexedQuestion, IndexedTopic } from "../index/index.js";
import { QUESTION_ID_RE, SLUG_RE, slugify } from "../store/ids.js";
import { instructionsPath } from "../store/paths.js";
import { answerQuestion, human, setTopicStatus } from "./ops.js";

/**
 * The single registry of operations (§7.1). MCP exposes `surface: "agent"`
 * entries; REST exposes everything. Both are thin adapters over `handler`.
 */
export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  surface: "agent" | "human";
  input: S;
  handler: (ctx: AppContext, input: z.infer<S>) => Promise<unknown>;
}

const topicId = z
  .string()
  .regex(SLUG_RE)
  .describe("Topic id (the filename stem under .ai/topics/)");
const questionId = z.string().regex(QUESTION_ID_RE).describe("Question id, e.g. q-20260922-3f9a");
const status = z.enum(TOPIC_STATUSES);

// ---- serializers ------------------------------------------------------------

export function topicSummary(ctx: AppContext, t: IndexedTopic) {
  return {
    id: t.id,
    title: t.fm.title,
    status: t.fm.status,
    updated: t.fm.updated,
    open_questions: ctx.index.openQuestionCount(t.id),
    open_blocking_questions: ctx.index.openBlockingCount(t.id),
  };
}

export function questionView(q: IndexedQuestion) {
  return {
    id: q.id,
    topic: q.fm.topic ?? null,
    asked_by: q.fm.asked_by,
    asked_at: q.fm.asked_at,
    status: q.fm.status,
    blocking: q.fm.blocking,
    options: q.fm.options ?? null,
    reject_options: q.fm.reject_options ?? null,
    assumption: q.fm.assumption ?? null,
    answered_at: q.fm.answered_at ?? null,
    acknowledged_at: q.fm.acknowledged_at ?? null,
    question: q.sections.Question,
    context: q.sections.Context,
    answer: q.sections.Answer,
  };
}

function requireTopic(ctx: AppContext, id: string): IndexedTopic {
  const t = ctx.index.topics.get(id);
  if (!t) throw new DomainError("not_found", `topic ${id} not found`);
  return t;
}

function requireQuestion(ctx: AppContext, id: string): IndexedQuestion {
  const q = ctx.index.questions.get(id);
  if (!q) throw new DomainError("not_found", `question ${id} not found`);
  return q;
}

async function runEffects(ctx: AppContext, effects: ReturnType<typeof effectsForQuestionCreated>) {
  for (const e of effects) if (e.kind === "set_topic_status") ctx.runner.expect(e.topic, e.to);
  await applyEffects(effects, ctx.repo, ctx.notify, ctx.now, ctx.index);
}

function topicView(ctx: AppContext, topicId: string | null | undefined, excludeQuestion?: string) {
  if (!topicId) return undefined;
  const t = ctx.index.topics.get(topicId);
  if (!t) return undefined;
  const openBlockingCount = ctx.index
    .questionsForTopic(topicId)
    .filter((q) => q.fm.status === "open" && q.fm.blocking && q.id !== excludeQuestion).length;
  return { fm: t.fm, openBlockingCount };
}

function def<S extends z.ZodObject>(d: ToolDef<S>): ToolDef {
  return d as unknown as ToolDef;
}

// ---- agent-facing -----------------------------------------------------------

export const AGENT_TOOLS: ToolDef[] = [
  def({
    name: "list_topics",
    surface: "agent",
    description:
      "List topics on the board with status and open-question counts. Call at the start of a session with status=active to see what you own; call without a filter to see everything.",
    input: z.object({ status: status.optional().describe("Only topics in this status") }),
    handler: async (ctx, { status }) => {
      const all = [...ctx.index.topics.values()].filter((t) => !status || t.fm.status === status);
      all.sort((a, b) => b.fm.updated.localeCompare(a.fm.updated));
      return { topics: all.map((t) => topicSummary(ctx, t)) };
    },
  }),
  def({
    name: "get_topic",
    surface: "agent",
    description:
      "Read one topic in full: frontmatter, Goal, Plan, Decisions, Log, and every question on it (all statuses). Use before working on a topic.",
    input: z.object({ id: topicId }),
    handler: async (ctx, { id }) => {
      const t = requireTopic(ctx, id);
      return {
        ...topicSummary(ctx, t),
        created: t.fm.created,
        links: t.fm.links,
        goal: t.sections.Goal,
        plan: t.sections.Plan,
        decisions: t.sections.Decisions,
        log: t.sections.Log,
        questions: ctx.index.questionsForTopic(id).map(questionView),
      };
    },
  }),
  def({
    name: "create_topic",
    surface: "agent",
    description:
      "Create a new topic in backlog. Use when you start a piece of work that has no topic yet. Returns the new id; then set_status to active to pick it up.",
    input: z.object({
      title: z.string().trim().min(1).max(200),
      goal: z.string().trim().min(1).describe("One or two paragraphs: what and why"),
      plan: z.string().optional().describe("Markdown checklist, e.g. '- [ ] step one'"),
    }),
    handler: async (ctx, { title, goal, plan }) => {
      const id = await ctx.repo.createTopic(slugify(title), { title, goal, plan, now: ctx.now() });
      ctx.runner.expect(id, "backlog");
      await ctx.index.refresh("topic", id);
      return { id };
    },
  }),
  def({
    name: "set_plan",
    surface: "agent",
    description:
      "Replace the topic's ## Plan section with a markdown checklist. Keep it current: tick steps ('- [x]') as you finish them.",
    input: z.object({ id: topicId, plan: z.string() }),
    handler: async (ctx, { id, plan }) => {
      requireTopic(ctx, id);
      await ctx.repo.modifyTopic(id, (t) => setPlan(t, plan, ctx.now()));
      await ctx.index.refresh("topic", id);
      return { ok: true };
    },
  }),
  def({
    name: "set_status",
    surface: "agent",
    description:
      "Move a topic between statuses as the agent. Allowed for agents: todo→active (pick up the human's queue, oldest first), backlog→active (only a topic you just created, or when the human asks), active→review (submit finished work). done, cancelled, needs-decision and reopening are human- or system-only and are rejected with an explanation. Pass a note to add a Log entry.",
    input: z.object({ id: topicId, status, note: z.string().optional() }),
    handler: async (ctx, { id, status, note }) => {
      requireTopic(ctx, id);
      const t = await setTopicStatus(ctx, id, status, "agent", note);
      return { id, status: t.fm.status };
    },
  }),
  def({
    name: "add_decision",
    surface: "agent",
    description:
      "Append a dated line to ## Decisions. Use for every non-obvious choice: what you chose and why. One decision per call.",
    input: z.object({ id: topicId, text: z.string().trim().min(1) }),
    handler: async (ctx, { id, text }) => {
      requireTopic(ctx, id);
      await ctx.repo.modifyTopic(id, (t) => addDecision(t, text, ctx.now()));
      await ctx.index.refresh("topic", id);
      return { ok: true };
    },
  }),
  def({
    name: "append_log",
    surface: "agent",
    description:
      "Append a timestamped line to ## Log. Use before you stop working on a topic: what is done, what is not, what is blocked.",
    input: z.object({
      id: topicId,
      text: z.string().trim().min(1),
      actor: z.string().trim().min(1).optional().describe("Defaults to 'agent'"),
    }),
    handler: async (ctx, { id, text, actor }) => {
      requireTopic(ctx, id);
      await ctx.repo.modifyTopic(id, (t) => appendLog(t, text, actor ?? "agent", ctx.now()));
      await ctx.index.refresh("topic", id);
      return { ok: true };
    },
  }),
  def({
    name: "ask_question",
    surface: "agent",
    description:
      "Ask the human a question. RULE: if a reasonable default exists, set blocking=false, state your `assumption`, and keep working on that assumption (assumption is REQUIRED when blocking is false). If you cannot proceed without the answer, set blocking=true, append_log that you stopped, and stop working on that topic — a blocking question moves the topic to needs-decision. Offer 2–4 `options` when you can so the human can answer with one click. When you ask the human to verify a topic you put into review, list the options that mean 'it does not work' in `reject_options`: picking one moves the topic back to active. `question` and `context` are markdown: show code in ``` fences with a language (```ts), it renders as a code block in the inbox; options are plain text.",
    input: z.object({
      question: z.string().trim().min(1).describe("Markdown; code in ``` fences"),
      context: z
        .string()
        .optional()
        .describe("Why it matters / what depends on it. Markdown; code in ``` fences"),
      topic: topicId.optional().describe("Omit for project-wide questions"),
      options: z.array(z.string().trim().min(1)).min(2).max(4).optional(),
      reject_options: z
        .array(z.string().trim().min(1))
        .min(1)
        .optional()
        .describe(
          "Options (copied exactly) that reject the topic's reviewed work; picking one while the topic is in review moves it back to active",
        ),
      assumption: z.string().trim().min(1).optional().describe("Required when blocking=false"),
      blocking: z.boolean(),
      asked_by: z.string().trim().min(1).optional().describe("Your agent name / session id"),
    }),
    handler: async (ctx, raw) => {
      const parsed = askQuestionInputSchema.safeParse(raw);
      if (!parsed.success) {
        throw new DomainError("validation", parsed.error.issues.map((i) => i.message).join("; "));
      }
      const input = parsed.data;
      if (input.topic) requireTopic(ctx, input.topic);
      const id = await ctx.repo.createQuestion({
        ...input,
        asked_by: input.asked_by ?? "agent",
        now: ctx.now(),
      });
      ctx.runner.expect(id, "open");
      await ctx.index.refresh("question", id);
      const q = requireQuestion(ctx, id);
      await runEffects(
        ctx,
        effectsForQuestionCreated(q.fm, q.sections.Question, topicView(ctx, input.topic)),
      );
      return {
        id,
        topic_status: input.topic ? ctx.index.topics.get(input.topic)?.fm.status : null,
      };
    },
  }),
  def({
    name: "check_answers",
    surface: "agent",
    description:
      "List questions the human has answered that you have not acknowledged yet. Call at the start of every session, read each answer, then acknowledge_answers.",
    input: z.object({ topic: topicId.optional() }),
    handler: async (ctx, { topic }) => {
      const qs = ctx.index
        .questionsByStatus("answered")
        .filter((q) => !topic || q.fm.topic === topic);
      qs.sort((a, b) => (a.fm.answered_at ?? "").localeCompare(b.fm.answered_at ?? ""));
      return { questions: qs.map(questionView) };
    },
  }),
  def({
    name: "acknowledge_answers",
    surface: "agent",
    description: "Mark answered questions as read so they leave your check_answers list.",
    input: z.object({ ids: z.array(questionId).min(1) }),
    handler: async (ctx, { ids }) => {
      const acknowledged: string[] = [];
      for (const id of ids) {
        requireQuestion(ctx, id);
        ctx.runner.expect(id, "acknowledged");
        await ctx.repo.modifyQuestion(id, (q) => acknowledgeQuestion(q, ctx.now()));
        await ctx.index.refresh("question", id);
        acknowledged.push(id);
      }
      return { acknowledged };
    },
  }),
  def({
    name: "wait_for_answer",
    surface: "agent",
    description:
      "Block until a question is answered or withdrawn, or until timeout_seconds (max 300) pass. Use after a blocking ask_question when the human is likely nearby; otherwise stop and check_answers next session.",
    input: z.object({
      id: questionId,
      timeout_seconds: z.number().int().min(1).max(300).default(60),
    }),
    handler: async (ctx, { id, timeout_seconds }) => {
      const current = requireQuestion(ctx, id);
      if (current.fm.status !== "open")
        return { status: current.fm.status, question: questionView(current) };
      const result = await new Promise<IndexedQuestion | undefined>((resolve) => {
        const timer = setTimeout(() => {
          ctx.index.off("question:changed", onChange);
          resolve(undefined);
        }, timeout_seconds * 1000);
        const onChange = (c: { id: string; current?: IndexedQuestion | undefined }) => {
          if (c.id === id && c.current && c.current.fm.status !== "open") {
            clearTimeout(timer);
            ctx.index.off("question:changed", onChange);
            resolve(c.current);
          }
        };
        ctx.index.on("question:changed", onChange);
      });
      return result
        ? { status: result.fm.status, question: questionView(result) }
        : { status: "timeout" };
    },
  }),
  def({
    name: "withdraw_question",
    surface: "agent",
    description:
      "Withdraw an open question you no longer need (for example you found the answer yourself). The reason is recorded; a withdrawn blocking question unblocks its topic.",
    input: z.object({ id: questionId, reason: z.string().trim().min(1) }),
    handler: async (ctx, { id, reason }) => {
      requireQuestion(ctx, id);
      ctx.runner.expect(id, "withdrawn");
      const q = await ctx.repo.modifyQuestion(id, (question) =>
        withdrawQuestion(question, reason, ctx.now()),
      );
      await ctx.index.refresh("question", id);
      await runEffects(ctx, effectsForQuestionClosed(q.fm, topicView(ctx, q.fm.topic, id)));
      return { id, status: "withdrawn" };
    },
  }),
];

// ---- human-facing (REST + UI only) -----------------------------------------

export const HUMAN_TOOLS: ToolDef[] = [
  def({
    name: "answer_question",
    surface: "human",
    description: "Answer an open question with free text or by option index; optional note.",
    input: z.object({
      id: questionId,
      answer: z.string().optional(),
      option_index: z.number().int().min(0).optional(),
      note: z.string().optional(),
    }),
    handler: async (ctx, { id, ...input }) => {
      requireQuestion(ctx, id);
      const q = await answerQuestion(ctx, id, input);
      return { id, status: q.fm.status };
    },
  }),
  def({
    name: "approve",
    surface: "human",
    description: "review → done.",
    input: z.object({ id: topicId }),
    handler: async (ctx, { id }) => ({ id, status: (await human.approve(ctx, id)).fm.status }),
  }),
  def({
    name: "reject",
    surface: "human",
    description: "review → active with a required note, logged as 'human — rejected: <note>'.",
    input: z.object({ id: topicId, note: z.string().trim().min(1) }),
    handler: async (ctx, { id, note }) => ({
      id,
      status: (await human.reject(ctx, id, note)).fm.status,
    }),
  }),
  def({
    name: "cancel",
    surface: "human",
    description: "Any non-terminal status → cancelled.",
    input: z.object({ id: topicId, note: z.string().optional() }),
    handler: async (ctx, { id, note }) => ({
      id,
      status: (await human.cancel(ctx, id, note)).fm.status,
    }),
  }),
  def({
    name: "reopen",
    surface: "human",
    description: "done or cancelled → active.",
    input: z.object({ id: topicId, note: z.string().optional() }),
    handler: async (ctx, { id, note }) => ({
      id,
      status: (await human.reopen(ctx, id, note)).fm.status,
    }),
  }),
];

export const ALL_TOOLS: ToolDef[] = [...AGENT_TOOLS, ...HUMAN_TOOLS];

export function findTool(name: string): ToolDef | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}

/** Validates and runs a tool. Throws DomainError on validation failure. */
export async function invokeTool(
  ctx: AppContext,
  tool: ToolDef,
  rawInput: unknown,
): Promise<unknown> {
  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => (i.path.length ? `${i.path.map(String).join(".")}: ${i.message}` : i.message))
      .join("; ");
    throw new DomainError("validation", msg);
  }
  return tool.handler(ctx, parsed.data);
}

export async function readAgentInstructions(ctx: AppContext): Promise<string> {
  try {
    return await readFile(instructionsPath(ctx.root), "utf8");
  } catch {
    const { AGENT_INSTRUCTIONS } = await import("../domain/agent-instructions.js");
    return AGENT_INSTRUCTIONS;
  }
}
