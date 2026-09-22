import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendLine,
  frontmatterObject,
  parseMarkdown,
  replaceSection,
  sectionText,
  serializeMarkdown,
  setField,
} from "../src/store/markdown.js";

const fixture = (name: string) => readFile(path.join(import.meta.dirname, "fixtures", name), "utf8");

describe("markdown round-trip", () => {
  it("parse → serialize is byte-identical on the odd fixture", async () => {
    const text = await fixture("topic-odd.md");
    const doc = parseMarkdown(text);
    expect(serializeMarkdown(doc)).toBe(text);
    expect(doc.sections.map((s) => s.title)).toEqual(["Goal", "Plan", "Decisions", "Notes", "Log"]);
    expect(doc.preamble).toBe("\nSome preamble text before sections.\n");
  });

  it("parse → serialize → parse is stable", async () => {
    const text = await fixture("topic-odd.md");
    const once = serializeMarkdown(parseMarkdown(text));
    const twice = serializeMarkdown(parseMarkdown(once));
    expect(twice).toBe(once);
  });

  it("keeps unknown frontmatter fields and comments after setField", async () => {
    const doc = parseMarkdown(await fixture("topic-odd.md"));
    setField(doc, "status", "review");
    const out = serializeMarkdown(doc);
    expect(out).toContain("status: review\n");
    expect(out).toContain("custom_field: keep me\n");
    expect(out).toContain("# trailing comment");
    expect(out).toContain("branch:\n");
    expect(frontmatterObject(parseMarkdown(out)).custom_field).toBe("keep me");
    // body untouched
    expect(out).toContain("Goal paragraph two   with   odd spacing.\n\n\n## Plan");
  });

  it("handles files without trailing newline and empty sections", () => {
    const text = "---\nid: x\n---\n## A\n## B";
    const doc = parseMarkdown(text);
    expect(serializeMarkdown(doc)).toBe(text);
    expect(sectionText(doc, "A")).toBe("");
    expect(sectionText(doc, "B")).toBe("");
  });

  it("handles empty frontmatter", () => {
    const text = "---\n---\n## A\nhi\n";
    const doc = parseMarkdown(text);
    expect(serializeMarkdown(doc)).toBe(text);
    setField(doc, "k", "v");
    expect(serializeMarkdown(doc)).toBe("---\nk: v\n---\n## A\nhi\n");
  });

  it("rejects missing or broken frontmatter", () => {
    expect(() => parseMarkdown("## A\n")).toThrow(/missing frontmatter/);
    expect(() => parseMarkdown("---\nid: x\n")).toThrow(/unterminated/);
    expect(() => parseMarkdown("---\n- a\n- b\n---\n")).toThrow(/mapping/);
    expect(() => parseMarkdown("---\nid: [\n---\n")).toThrow(/invalid frontmatter YAML/);
  });
});

describe("section editing", () => {
  const base = "---\nid: x\n---\n## Goal\nG\n\n## Plan\n- [ ] a\n\n## Decisions\n\n## Log\n";

  it("replaceSection keeps layout for middle and last sections", () => {
    const doc = parseMarkdown(base);
    replaceSection(doc, "Plan", "- [x] a\n- [ ] b");
    expect(serializeMarkdown(doc)).toBe(
      "---\nid: x\n---\n## Goal\nG\n\n## Plan\n- [x] a\n- [ ] b\n\n## Decisions\n\n## Log\n",
    );
    replaceSection(doc, "Log", "- line");
    expect(serializeMarkdown(doc)).toMatch(/## Log\n- line\n$/);
  });

  it("appendLine adds to empty and non-empty sections", () => {
    const doc = parseMarkdown(base);
    appendLine(doc, "Decisions", "- d1");
    appendLine(doc, "Decisions", "- d2");
    appendLine(doc, "Log", "- l1");
    expect(serializeMarkdown(doc)).toBe(
      "---\nid: x\n---\n## Goal\nG\n\n## Plan\n- [ ] a\n\n## Decisions\n- d1\n- d2\n\n## Log\n- l1\n",
    );
  });

  it("appendLine creates a missing section at the end", () => {
    const doc = parseMarkdown("---\nid: x\n---\n## Question\nQ?\n");
    appendLine(doc, "Context", "Withdrawn — no longer needed");
    expect(serializeMarkdown(doc)).toBe(
      "---\nid: x\n---\n## Question\nQ?\n\n## Context\nWithdrawn — no longer needed\n",
    );
  });

  it("does not touch sections it did not edit", async () => {
    const text = await fixture("topic-odd.md");
    const doc = parseMarkdown(text);
    appendLine(doc, "Log", "- new");
    const out = serializeMarkdown(doc);
    const [head] = text.split("## Log");
    expect(out.startsWith(head as string)).toBe(true);
    expect(out.endsWith("## Log\n- 2026-09-22 14:10 agent — Implemented step one.\n- new\n")).toBe(true);
  });
});

describe("indentation", () => {
  it("keeps leading indentation of the first content line", () => {
    const doc = parseMarkdown("---\nid: x\n---\n## Plan\n\n  - [ ] indented\n\n## Log\n");
    expect(sectionText(doc, "Plan")).toBe("  - [ ] indented");
    replaceSection(doc, "Plan", "    - deep\n  - less");
    expect(serializeMarkdown(doc)).toBe("---\nid: x\n---\n## Plan\n    - deep\n  - less\n\n## Log\n");
  });
});
