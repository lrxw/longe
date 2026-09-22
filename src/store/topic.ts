import { DomainError, ParseError } from "../domain/errors.js";
import { formatZodIssues, topicFrontmatterSchema } from "../domain/schemas.js";
import { toLocalIso } from "../domain/time.js";
import { TOPIC_SECTIONS, type TopicFrontmatter } from "../domain/types.js";
import {
  findSection,
  frontmatterObject,
  type MdDoc,
  parseMarkdown,
  sectionText,
  serializeMarkdown,
} from "./markdown.js";

export interface Topic {
  fm: TopicFrontmatter;
  doc: MdDoc;
}

export interface ParseTopicOptions {
  /** Filename stem; when given, `id` must match it (§3.3). */
  expectedId?: string;
  file?: string;
}

export function parseTopic(text: string, opts: ParseTopicOptions = {}): Topic {
  const doc = parseMarkdown(text, opts.file);
  const parsed = topicFrontmatterSchema.safeParse(frontmatterObject(doc));
  if (!parsed.success) throw new ParseError(formatZodIssues(parsed.error), opts.file);
  const fm = parsed.data as TopicFrontmatter;
  if (opts.expectedId !== undefined && fm.id !== opts.expectedId) {
    throw new ParseError(
      `id "${fm.id}" does not match filename stem "${opts.expectedId}"`,
      opts.file,
    );
  }
  for (const title of TOPIC_SECTIONS) {
    if (!findSection(doc, title))
      throw new ParseError(`missing required section "## ${title}"`, opts.file);
  }
  return { fm, doc };
}

/** Re-reads frontmatter from the document after mutation. */
export function refreshTopic(topic: Topic): Topic {
  const parsed = topicFrontmatterSchema.safeParse(frontmatterObject(topic.doc));
  if (!parsed.success) throw new DomainError("validation", formatZodIssues(parsed.error));
  topic.fm = parsed.data as TopicFrontmatter;
  return topic;
}

export function serializeTopic(topic: Topic): string {
  return serializeMarkdown(topic.doc);
}

export function topicSections(topic: Topic): Record<(typeof TOPIC_SECTIONS)[number], string> {
  return {
    Goal: sectionText(topic.doc, "Goal"),
    Plan: sectionText(topic.doc, "Plan"),
    Decisions: sectionText(topic.doc, "Decisions"),
    Log: sectionText(topic.doc, "Log"),
  };
}

export interface NewTopicInput {
  id: string;
  title: string;
  goal: string;
  plan?: string | undefined;
  now: Date;
}

/** Builds the text of a fresh topic file in `backlog` (§7.1 create_topic). */
export function newTopicText(input: NewTopicInput): string {
  const ts = toLocalIso(input.now);
  const plan = (input.plan ?? "").trim();
  return [
    "---",
    `id: ${input.id}`,
    `title: ${yamlString(input.title)}`,
    "status: backlog",
    `created: ${ts}`,
    `updated: ${ts}`,
    "links: []",
    "---",
    "## Goal",
    input.goal.trim(),
    "",
    "## Plan",
    ...(plan ? [plan, ""] : [""]),
    "## Decisions",
    "",
    "## Log",
    "",
  ].join("\n");
}

/** Quotes a scalar for YAML when it could be misread as something else. */
export function yamlString(s: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9 _.,()/-]*$/.test(s) && !/^(true|false|null|yes|no|~)$/i.test(s)
    ? s
    : JSON.stringify(s);
}
