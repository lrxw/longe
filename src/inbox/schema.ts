import { z } from "zod";
import { isIsoTimestamp } from "../domain/time.js";
import { QUESTION_ID_RE, SLUG_RE } from "../store/ids.js";
import { QUESTION_STATUSES } from "./types.js";

const isoTimestamp = z
  .string()
  .refine(isIsoTimestamp, "must be ISO 8601 with offset, e.g. 2026-09-22T14:10:00+02:00");

const nullishString = z.string().nullish();

export const subjectSchema = z.object({
  kind: z.string().trim().min(1),
  id: z.string().trim().min(1),
  url: z.string().trim().min(1).optional(),
});

/** A subject in a file: a hand-written `id: 42` reads as the string "42". */
const fileSubjectSchema = z.object({
  kind: z.string().trim().min(1),
  id: z.union([z.string(), z.number()]).transform(String).pipe(z.string().trim().min(1)),
  url: z.string().trim().min(1).optional(),
});

export const questionFrontmatterSchema = z
  .looseObject({
    id: z.string().regex(QUESTION_ID_RE, "id must look like q-YYYYMMDD-xxxx"),
    topic: z.string().regex(SLUG_RE).nullish(),
    subject: fileSubjectSchema.nullish(),
    asked_by: z.string().trim().min(1),
    asked_at: isoTimestamp,
    status: z.enum(QUESTION_STATUSES),
    blocking: z.boolean(),
    options: z.array(z.string().trim().min(1)).min(2).max(4).nullish(),
    reject_options: z.array(z.string().trim().min(1)).nullish(),
    approve_options: z.array(z.string().trim().min(1)).nullish(),
    selected_option: nullishString,
    assumption: nullishString,
    answered_at: isoTimestamp.nullish(),
    acknowledged_at: isoTimestamp.nullish(),
  })
  .refine((q) => q.blocking || (typeof q.assumption === "string" && q.assumption.trim() !== ""), {
    message: "a non-blocking question requires an assumption (blocking: false ⇒ assumption)",
    path: ["assumption"],
  });

export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => (i.path.length ? `${i.path.map(String).join(".")}: ${i.message}` : i.message))
    .join("; ");
}
