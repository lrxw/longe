// Small, dependency-free readers for the files longe writes. They cover the
// YAML subset longe itself emits (plain or JSON-quoted scalars, block lists)
// and are lenient with hand edits; anything they cannot read is reported,
// never guessed.

import type { LongeInboxQuestion } from "../types";
import { type InboxViewWire, optionRole } from "./tokens";

export type Scalar = string | boolean | null;
export type Value = Scalar | string[];

export function scalar(raw: string): Scalar {
  const s = raw.trim();
  if (s === "" || s === "~" || s === "null") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (s.startsWith('"')) {
    try {
      return String(JSON.parse(s));
    } catch {
      return s.slice(1, s.endsWith('"') ? -1 : undefined);
    }
  }
  if (s.startsWith("'")) return s.slice(1, s.endsWith("'") ? -1 : undefined).replace(/''/g, "'");
  return s;
}

/** Top-level `key: value` pairs and `key:` + `  - item` block lists. */
export function parseYamlMap(text: string): Record<string, Value> {
  const out: Record<string, Value> = {};
  let listKey: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (out[listKey] as string[]).push(String(scalar(item[1]!) ?? ""));
      continue;
    }
    const pair = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(line);
    if (!pair) {
      listKey = null;
      continue;
    }
    const [, key, rest] = pair;
    if (rest === undefined || rest.trim() === "") {
      out[key!] = [];
      listKey = key!;
    } else if (rest.trim().startsWith("[") && rest.trim().endsWith("]")) {
      const inner = rest.trim().slice(1, -1).trim();
      out[key!] = inner === "" ? [] : inner.split(",").map((p) => String(scalar(p) ?? ""));
      listKey = null;
    } else if (rest.trim() === ">-" || rest.trim() === "|") {
      out[key!] = null; // block scalars are not needed by the inbox
      listKey = null;
    } else {
      out[key!] = scalar(rest);
      listKey = null;
    }
  }
  return out;
}

/** `~/.config/longe/repos.yml`: every repo longe knows, `{ path, name }`. */
export function parseRegistry(text: string): { path: string; name: string }[] {
  const repos: { path: string; name: string }[] = [];
  let cur: { path?: string; name?: string } | null = null;
  const flush = () => {
    if (cur?.path && cur.name) repos.push({ path: cur.path, name: cur.name });
  };
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(-\s+)?(path|name|last_seen):\s*(.*)$/.exec(line);
    if (!m) continue;
    if (m[1]) {
      flush();
      cur = {};
    }
    if (!cur) cur = {};
    const v = scalar(m[3]!);
    if (m[2] === "path" && typeof v === "string") cur.path = v;
    if (m[2] === "name" && typeof v === "string") cur.name = v;
  }
  flush();
  return repos;
}

export type QuestionFile = {
  fm: Record<string, Value>;
  sections: Record<string, string>;
};

export function parseQuestionFile(text: string): QuestionFile {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error("no frontmatter");
  const fm = parseYamlMap(m[1]!);
  const sections: Record<string, string> = {};
  let name: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (name) sections[name] = buf.join("\n").trim();
  };
  for (const line of m[2]!.split(/\r?\n/)) {
    const h = /^## +(.+?)\s*$/.exec(line);
    if (h) {
      flush();
      name = h[1]!;
      buf = [];
    } else buf.push(line);
  }
  flush();
  return { fm, sections };
}

/** An open question, or null when the file is not open; throws when unreadable. */
export function toOpenQuestion(
  file: QuestionFile,
  repo: string,
  project: string,
  color: string | null = null,
): LongeInboxQuestion | null {
  const { fm, sections } = file;
  if (fm.status !== "open") return null;
  if (typeof fm.id !== "string") throw new Error("missing id");
  if (typeof fm.blocking !== "boolean") throw new Error("blocking must be true or false");
  if (!sections.Question) throw new Error('missing "## Question" section');
  const str = (v: Value | undefined) => (typeof v === "string" ? v : null);
  const options = Array.isArray(fm.options) ? fm.options : [];
  const roles = {
    approveOptions: Array.isArray(fm.approve_options) ? fm.approve_options : [],
    rejectOptions: Array.isArray(fm.reject_options) ? fm.reject_options : [],
  };
  const topic = str(fm.topic);
  const context = sections.Context ?? "";
  return {
    id: fm.id,
    repo,
    project,
    color,
    topic,
    askedBy: str(fm.asked_by) ?? "agent",
    askedAt: str(fm.asked_at) ?? "",
    blocking: fm.blocking,
    options,
    ...roles,
    optionRoles: options.map((o) => optionRole(o, roles)),
    assumption: str(fm.assumption),
    question: sections.Question,
    context,
    contextOpen: context.includes("```"),
    links: { board: `/r/${repo}/board`, topic: topic ? `/r/${repo}/topics/${topic}` : null },
  };
}

/** A question from longe's view model (GET /api/v1/inbox), in the mod's shape. */
export function fromView(q: InboxViewWire["questions"][number]): LongeInboxQuestion {
  return {
    id: q.id,
    repo: q.repo,
    project: q.project,
    color: q.color,
    topic: q.topic,
    askedBy: q.askedBy,
    askedAt: q.askedAt,
    blocking: q.kind === "blocking",
    options: q.options.map((o) => o.label),
    approveOptions: q.options.filter((o) => o.role === "approve").map((o) => o.label),
    rejectOptions: q.options.filter((o) => o.role === "reject").map((o) => o.label),
    optionRoles: q.options.map((o) => o.role),
    assumption: q.assumption,
    question: q.question,
    context: q.context,
    contextOpen: q.contextOpen,
    links: q.links,
  };
}

/** longe's inbox order: blocking first, then oldest first. */
export function inboxOrder(a: LongeInboxQuestion, b: LongeInboxQuestion): number {
  if (a.blocking !== b.blocking) return a.blocking ? -1 : 1;
  return a.askedAt.localeCompare(b.askedAt) || a.id.localeCompare(b.id);
}

export function ago(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
