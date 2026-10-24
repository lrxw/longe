import { z } from "zod";
import { SLUG_RE } from "../store/ids.js";
import { isIsoTimestamp } from "./time.js";
import { TOPIC_STATUSES } from "./types.js";

// the question file format belongs to the inbox (src/inbox/); the board reuses it
export { formatZodIssues, questionFrontmatterSchema } from "../inbox/schema.js";

const isoTimestamp = z
  .string()
  .refine(isIsoTimestamp, "must be ISO 8601 with offset, e.g. 2026-09-22T14:10:00+02:00");

const nullishString = z.string().nullish();

export const topicFrontmatterSchema = z.looseObject({
  id: z.string().regex(SLUG_RE, "id must be a slug (lowercase, digits, hyphens)"),
  title: z.string().trim().min(1),
  status: z.enum(TOPIC_STATUSES),
  created: isoTimestamp,
  updated: isoTimestamp,
  links: z
    .array(z.string())
    .nullish()
    .transform((v) => v ?? []),
  branch: nullishString,
});

/** Input shape for creating a question through the tool (§7.1 ask_question). */
export const askQuestionInputSchema = z
  .object({
    question: z.string().trim().min(1),
    context: z.string().optional(),
    topic: z.string().regex(SLUG_RE).optional(),
    options: z.array(z.string().trim().min(1)).min(2).max(4).optional(),
    reject_options: z.array(z.string().trim().min(1)).min(1).optional(),
    approve_options: z.array(z.string().trim().min(1)).min(1).optional(),
    assumption: z.string().trim().min(1).optional(),
    blocking: z.boolean(),
    asked_by: z.string().trim().min(1).optional(),
  })
  .refine((q) => q.blocking || q.assumption !== undefined, {
    message: "a non-blocking question requires an assumption (blocking: false ⇒ assumption)",
    path: ["assumption"],
  })
  .refine((q) => (q.reject_options ?? []).every((r) => q.options?.includes(r)), {
    message: "reject_options must each be one of the options",
    path: ["reject_options"],
  })
  .refine((q) => !q.reject_options || q.topic !== undefined, {
    message: "reject_options need a topic",
    path: ["reject_options"],
  })
  .refine((q) => (q.approve_options ?? []).every((a) => q.options?.includes(a)), {
    message: "approve_options must each be one of the options",
    path: ["approve_options"],
  })
  .refine((q) => !q.approve_options || q.topic !== undefined, {
    message: "approve_options need a topic",
    path: ["approve_options"],
  })
  .refine((q) => !(q.approve_options ?? []).some((a) => q.reject_options?.includes(a)), {
    message: "an option cannot both approve and reject",
    path: ["approve_options"],
  });
export type AskQuestionInput = z.infer<typeof askQuestionInputSchema>;
