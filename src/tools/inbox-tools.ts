import { z } from "zod";
import { DomainError } from "../domain/errors.js";
import { subjectSchema } from "../inbox/schema.js";
import { AGENT_TOOLS, type ToolDef } from "./registry.js";

/**
 * The inbox's tools for agents that do not use the board (`longe mcp --inbox-only`):
 * ask the human, read the answers, acknowledge, wait, withdraw. No topics: a question
 * may name any `subject` (an issue, a pull request, …). The combined server stays the
 * default and offers the board's versions of these tools.
 */

const tool = (name: string): ToolDef => {
  const t = AGENT_TOOLS.find((d) => d.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

const options = z.array(z.string().trim().min(1));

const askInput = z
  .object({
    question: z.string().trim().min(1).describe("Markdown; code in ``` fences"),
    context: z
      .string()
      .optional()
      .describe("Why it matters / what depends on it. Markdown; code in ``` fences"),
    subject: subjectSchema
      .optional()
      .describe(
        "What the question is about, e.g. { kind: 'issue', id: '42', url: 'https://…' }; omit for a general question",
      ),
    options: options.min(2).max(4).optional(),
    reject_options: options
      .min(1)
      .optional()
      .describe("Options (copied exactly) that mean 'the work does not pass'"),
    approve_options: options
      .min(1)
      .optional()
      .describe("Options (copied exactly) that mean 'the work is accepted'"),
    assumption: z.string().trim().min(1).optional().describe("Required when blocking=false"),
    blocking: z.boolean(),
    asked_by: z.string().trim().min(1).optional().describe("Your agent name / session id"),
  })
  .refine((q) => q.blocking || q.assumption !== undefined, {
    message: "a non-blocking question requires an assumption (blocking: false ⇒ assumption)",
    path: ["assumption"],
  })
  .refine(
    (q) =>
      [...(q.reject_options ?? []), ...(q.approve_options ?? [])].every((o) =>
        q.options?.includes(o),
      ),
    { message: "approve_options and reject_options must each be one of the options" },
  )
  .refine((q) => !(q.approve_options ?? []).some((a) => q.reject_options?.includes(a)), {
    message: "an option cannot both approve and reject",
    path: ["approve_options"],
  });

const ask: ToolDef = {
  name: "ask_question",
  surface: "agent",
  description:
    "Ask the human a question; it appears in their inbox. RULE: if a reasonable default exists, set blocking=false, state your `assumption`, and keep working on it (assumption is REQUIRED when blocking is false). If you cannot proceed without the answer, set blocking=true and stop that work; the human gets a notification. Offer 2–4 `options` so the human can answer with one click. `question` and `context` are markdown (code in ``` fences). Then check_answers (or wait_for_answer) for the reply.",
  input: askInput as unknown as z.ZodObject,
  handler: async (ctx, raw) => {
    const input = raw as z.infer<typeof askInput>;
    // a topic subject is the board's: it must exist (the board then moves it)
    if (input.subject?.kind === "topic" && !ctx.index.topics.has(input.subject.id))
      throw new DomainError("not_found", `topic ${input.subject.id} not found`);
    const id = await ctx.repo.createQuestion({
      ...input,
      asked_by: input.asked_by ?? "agent",
      now: ctx.now(),
    });
    ctx.runner.expect(id, "open");
    await ctx.index.refresh("question", id);
    const q = ctx.index.questions.get(id);
    if (q) await ctx.inbox.emit({ kind: "asked", question: q.fm, text: q.sections.Question });
    return { id };
  },
};

const checkAnswers: ToolDef = {
  ...tool("check_answers"),
  description:
    "List questions the human has answered that you have not acknowledged yet. Read each answer, then acknowledge_answers.",
  input: z.object({}),
};

export const INBOX_ONLY_TOOLS: ToolDef[] = [
  ask,
  checkAnswers,
  tool("acknowledge_answers"),
  {
    ...tool("wait_for_answer"),
    description:
      "Block until a question is answered or withdrawn, or until timeout_seconds (max 300) pass. Use after a blocking ask_question when the human is likely nearby.",
  },
  {
    ...tool("withdraw_question"),
    description:
      "Withdraw an open question you no longer need (for example you found the answer yourself). The reason is recorded.",
  },
];

export const INBOX_ONLY_INSTRUCTIONS =
  "longe's inbox: ask the human questions with ask_question (they answer in the longe inbox, on the web or in Claude Code), read answers with check_answers and acknowledge_answers. Start every session with check_answers.";
