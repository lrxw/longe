import * as YAML from "yaml";
import { ParseError } from "../domain/errors.js";

/**
 * A markdown document with YAML frontmatter and `## ` sections.
 *
 * Preservation rules:
 * - Frontmatter text is kept byte-for-byte until a field is set; then it is
 *   re-emitted through the YAML document model, which keeps comments and
 *   unknown fields.
 * - Section bodies are raw text. Untouched sections round-trip exactly.
 * - Every body line (preamble, heading, section content) is stored with a
 *   leading "\n", so `---\n<fm>---` + preamble + `\n## Title` + body reproduces
 *   the source exactly, trailing newline or not.
 */
export interface Section {
  title: string;
  /** Raw lines after the heading, each prefixed with "\n". */
  body: string;
}

export interface MdDoc {
  frontmatter: YAML.Document;
  /** Raw frontmatter text, used verbatim until `frontmatterDirty`. */
  frontmatterRaw: string;
  frontmatterDirty: boolean;
  /** Raw lines between frontmatter and the first `## ` heading, each prefixed with "\n". */
  preamble: string;
  sections: Section[];
}

const HEADING = /^## (.*)$/;

export function parseMarkdown(text: string, file?: string): MdDoc {
  const lines = text.split("\n");
  if (lines[0] !== "---")
    throw new ParseError("missing frontmatter (file must start with ---)", file);
  const end = lines.indexOf("---", 1);
  if (end === -1) throw new ParseError("unterminated frontmatter", file);

  const frontmatterRaw = end > 1 ? `${lines.slice(1, end).join("\n")}\n` : "";
  const frontmatter = YAML.parseDocument(frontmatterRaw);
  if (frontmatter.errors.length > 0) {
    throw new ParseError(`invalid frontmatter YAML: ${frontmatter.errors[0]?.message}`, file);
  }
  const fmValue = frontmatter.contents;
  if (fmValue !== null && !YAML.isMap(fmValue)) {
    throw new ParseError("frontmatter must be a YAML mapping", file);
  }

  const preambleLines: string[] = [];
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const line of lines.slice(end + 1)) {
    const m = HEADING.exec(line);
    if (m) {
      current = { title: (m[1] ?? "").trim(), body: "" };
      sections.push(current);
    } else if (current) {
      current.body += `\n${line}`;
    } else {
      preambleLines.push(line);
    }
  }
  const preamble = preambleLines.map((l) => `\n${l}`).join("");

  return { frontmatter, frontmatterRaw, frontmatterDirty: false, preamble, sections };
}

export function serializeMarkdown(doc: MdDoc): string {
  const fm = doc.frontmatterDirty ? frontmatterToString(doc.frontmatter) : doc.frontmatterRaw;
  const body = doc.sections.map((s) => `\n## ${s.title}${s.body}`).join("");
  return `---\n${fm}---${doc.preamble}${body}`;
}

function frontmatterToString(fm: YAML.Document): string {
  if (fm.contents === null) return "";
  const s = fm.toString();
  return s.endsWith("\n") ? s : `${s}\n`;
}

/** Frontmatter as a plain object (unknown fields included). */
export function frontmatterObject(doc: MdDoc): Record<string, unknown> {
  const v = doc.frontmatter.toJS() as unknown;
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export function setField(doc: MdDoc, key: string, value: unknown): void {
  if (doc.frontmatter.contents === null) doc.frontmatter = new YAML.Document({});
  doc.frontmatter.set(key, value);
  doc.frontmatterDirty = true;
}

export function findSection(doc: MdDoc, title: string): Section | undefined {
  return doc.sections.find((s) => s.title === title);
}

/** Section content: text after the heading line, surrounding blank lines removed, indentation kept. */
export function sectionText(doc: MdDoc, title: string): string {
  const s = findSection(doc, title);
  return s ? s.body.replace(/^\n+/, "").replace(/\s+$/, "") : "";
}

/**
 * Replaces a section's content. The section is created (appended) if missing.
 * Layout after write: heading, content, one blank line before the next heading
 * (or a single trailing newline at end of file).
 */
export function replaceSection(doc: MdDoc, title: string, content: string): void {
  let s = findSection(doc, title);
  if (!s) {
    s = { title, body: "" };
    // the previous last section must end with a newline so the new heading starts a line
    const prev = doc.sections[doc.sections.length - 1];
    if (prev && !prev.body.endsWith("\n")) prev.body += "\n";
    doc.sections.push(s);
  }
  s.body = normalizeBody(content.replace(/^\n+/, "").replace(/\s+$/, ""));
}

function normalizeBody(content: string): string {
  return content === "" ? "\n" : `\n${content}\n`;
}

/** Appends a line to a section (creating it if missing). */
export function appendLine(doc: MdDoc, title: string, line: string): void {
  const existing = sectionText(doc, title);
  replaceSection(doc, title, existing === "" ? line : `${existing}\n${line}`);
}
