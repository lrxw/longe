import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

// every code block gets a copy button (app.js: button[data-copy-code] copies the <pre>).
// Rendered here, not added in the browser, so live refreshes (morph) keep it.
for (const rule of ["fence", "code_block"] as const) {
  const render = md.renderer.rules[rule];
  if (!render) continue;
  md.renderer.rules[rule] = (tokens, idx, options, env, self) =>
    `<div class="codeblock"><button type="button" class="copy small" data-copy-code title="Copy to clipboard">Copy</button>${render(tokens, idx, options, env, self)}</div>`;
}

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
