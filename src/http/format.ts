import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

/** Renders markdown to HTML with raw HTML disabled (§6.2). `- [ ]` / `- [x]` become checkboxes. */
export function renderMarkdown(text: string): string {
  return md
    .render(text)
    .replace(/<li>\[ \] /g, '<li><input type="checkbox" disabled> ')
    .replace(/<li>\[[xX]\] /g, '<li><input type="checkbox" disabled checked> ');
}

/** Human-readable age such as "3m", "2h", "5d". */
export function ago(iso: string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Last non-empty line of a section, without the leading list marker. */
export function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return (lines.at(-1) ?? "").replace(/^-\s*/, "");
}

/** Checklist progress of a markdown section: done / total task items. */
export function planProgress(text: string): { done: number; total: number } {
  const items = text.match(/^\s*[-*]\s+\[( |x|X)\]/gm) ?? [];
  const done = items.filter((i) => /\[[xX]\]/.test(i)).length;
  return { done, total: items.length };
}
