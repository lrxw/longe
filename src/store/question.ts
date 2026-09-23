import { DomainError, ParseError } from "../domain/errors.js";
import { formatZodIssues, questionFrontmatterSchema } from "../domain/schemas.js";
import { toLocalIso } from "../domain/time.js";
import type { QuestionFrontmatter } from "../domain/types.js";
import {
  findSection,
  frontmatterObject,
  type MdDoc,
  parseMarkdown,
  sectionText,
  serializeMarkdown,
} from "./markdown.js";
import { yamlString } from "./topic.js";

export interface Question {
  fm: QuestionFrontmatter;
  doc: MdDoc;
}

export interface ParseQuestionOptions {
  expectedId?: string;
  file?: string;
}

export function parseQuestion(text: string, opts: ParseQuestionOptions = {}): Question {
  const doc = parseMarkdown(text, opts.file);
  const parsed = questionFrontmatterSchema.safeParse(frontmatterObject(doc));
  if (!parsed.success) throw new ParseError(formatZodIssues(parsed.error), opts.file);
  const fm = parsed.data as QuestionFrontmatter;
  if (opts.expectedId !== undefined && fm.id !== opts.expectedId) {
    throw new ParseError(
      `id "${fm.id}" does not match filename stem "${opts.expectedId}"`,
      opts.file,
    );
  }
  if (!findSection(doc, "Question"))
    throw new ParseError('missing required section "## Question"', opts.file);
  return { fm, doc };
}

export function refreshQuestion(q: Question): Question {
  const parsed = questionFrontmatterSchema.safeParse(frontmatterObject(q.doc));
  if (!parsed.success) throw new DomainError("validation", formatZodIssues(parsed.error));
  q.fm = parsed.data as QuestionFrontmatter;
  return q;
}

export function serializeQuestion(q: Question): string {
  return serializeMarkdown(q.doc);
}

export function questionSections(q: Question): {
  Question: string;
  Context: string;
  Answer: string;
} {
  return {
    Question: sectionText(q.doc, "Question"),
    Context: sectionText(q.doc, "Context"),
    Answer: sectionText(q.doc, "Answer"),
  };
}

export interface NewQuestionInput {
  id: string;
  question: string;
  context?: string | undefined;
  topic?: string | undefined;
  options?: string[] | undefined;
  reject_options?: string[] | undefined;
  approve_options?: string[] | undefined;
  assumption?: string | undefined;
  blocking: boolean;
  asked_by: string;
  now: Date;
}

/** Builds the text of a fresh question file in `open` (§3.4). Caller validates input. */
export function newQuestionText(input: NewQuestionInput): string {
  const fm: string[] = ["---", `id: ${input.id}`];
  if (input.topic) fm.push(`topic: ${input.topic}`);
  fm.push(`asked_by: ${yamlString(input.asked_by)}`);
  fm.push(`asked_at: ${toLocalIso(input.now)}`);
  fm.push("status: open");
  fm.push(`blocking: ${input.blocking}`);
  if (input.options && input.options.length > 0) {
    fm.push("options:");
    for (const o of input.options) fm.push(`  - ${yamlString(o)}`);
  }
  if (input.reject_options && input.reject_options.length > 0) {
    fm.push("reject_options:");
    for (const o of input.reject_options) fm.push(`  - ${yamlString(o)}`);
  }
  if (input.approve_options && input.approve_options.length > 0) {
    fm.push("approve_options:");
    for (const o of input.approve_options) fm.push(`  - ${yamlString(o)}`);
  }
  if (input.assumption !== undefined) fm.push(`assumption: ${yamlString(input.assumption)}`);
  fm.push("---");
  return [
    ...fm,
    "## Question",
    input.question.trim(),
    "",
    "## Context",
    ...(input.context?.trim() ? [input.context.trim(), ""] : [""]),
    "## Answer",
    "",
  ].join("\n");
}
