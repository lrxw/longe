// longe-inbox: longe's question inbox inside Claude Code.
//
// Draws longe's inbox view model (GET /api/v1/inbox): the same order, labels,
// icons and meanings as the web inbox, with roles mapped to Claude Code theme
// keys. While `longe serve` is not running it reads the boards straight from
// disk (the files are longe's source of truth), so the inbox still shows.
// Answers go through longe's REST API, so longe applies its own rules
// (unblocking topics, review approve/reject, waking the chat).

import type { EngineInterface, Register } from "claude-code";
import { atom, read, update } from "claude-code";

import type { LongeInboxProblem, LongeInboxQuestion, LongeInboxSnapshot } from "../types";
import {
  ago,
  fromView,
  inboxOrder,
  parseQuestionFile,
  parseRegistry,
  parseYamlMap,
  toOpenQuestion,
} from "./parse";
import { INBOX_TOKENS, INBOX_VIEW_VERSION, type InboxViewWire, THEME } from "./tokens";

const PANE = "longe-inbox";
const PANE_TITLE = "longe inbox";
const POLL_MS = 5000;
// the size the pane asks for: docked beside a fullscreen transcript it opens this
// wide, inline above the prompt this tall. A size the person dragged to still wins.
const PANE_COLUMNS = 100;
const PANE_ROWS = 24;

const EMPTY: LongeInboxSnapshot = {
  questions: [],
  problems: [],
  scannedAt: 0,
  note: null,
  tokens: INBOX_TOKENS,
  source: "files",
};
const inbox = atom({ plugin: "longe-inbox", key: "inbox" } as const, EMPTY);
const flash = atom({ plugin: "longe-inbox", key: "flash" } as const, {});
const isBandHidden = atom({ plugin: "longe-inbox", key: "isBandHidden" } as const, false);
const selected = atom({ plugin: "longe-inbox", key: "selected" } as const, null);
// the mod's own version, read from its plugin.json at session start; in
// $.state so a pane already open redraws once it is known
const version = atom({ plugin: "longe-inbox", key: "version" } as const, "");
const openContext = atom({ plugin: "longe-inbox", key: "openContext" } as const, {});

type Cached = { mtimeMs: number; question: LongeInboxQuestion | null };

let base = "http://127.0.0.1:7311";
// id → parsed file, re-read only when its mtime changes
const cache = new Map<string, Cached>();
// ids already seen, so only questions that arrive later raise a toast
let seen: Set<string> | null = null;
let isScanning = false;

async function scan($: EngineInterface): Promise<void> {
  if (isScanning) return;
  isScanning = true;
  try {
    const view = await fetchView($);
    const snapshot =
      typeof view === "object" && view !== null
        ? view
        : {
            ...(await readBoards($)),
            ...(typeof view === "number"
              ? {
                  note: `longe sends inbox view v${view}, this mod reads v${INBOX_VIEW_VERSION}: showing the files instead. Update with: longe provider deep-integrate claude --mod`,
                }
              : {}),
          };
    await update($, inbox, () => snapshot);
    const ids = new Set(snapshot.questions.map((q) => q.id));
    if (seen) {
      const fresh = snapshot.questions.filter((q) => !seen!.has(q.id));
      const blocking = fresh.filter((q) => q.blocking);
      if (blocking.length > 0) {
        $.ui.toast(
          blocking.length === 1
            ? `longe: ${blocking[0]!.project} is waiting on you (blocking question)`
            : `longe: ${blocking.length} new blocking questions`,
        );
      }
      if (fresh.length > 0) await update($, isBandHidden, () => false);
    }
    seen = ids;
  } finally {
    isScanning = false;
  }
}

/**
 * The running longe's inbox view; null when longe is not reachable or sends something
 * else, the view's version when it is one this mod does not read.
 */
async function fetchView($: EngineInterface): Promise<LongeInboxSnapshot | number | null> {
  try {
    const res = await $.http.fetch(`${base}/api/v1/inbox`, { method: "GET" });
    if (!res.ok) return null;
    const view = JSON.parse(res.text) as Partial<InboxViewWire>;
    if (typeof view.version !== "number" || !Array.isArray(view.questions)) return null;
    if (view.version !== INBOX_VIEW_VERSION) return view.version;
    return {
      questions: view.questions.map(fromView),
      problems: Array.isArray(view.problems) ? view.problems : [],
      scannedAt: await $.clock.now(),
      note: null,
      tokens: view.tokens ?? INBOX_TOKENS,
      source: "server",
    };
  } catch {
    return null;
  }
}

async function answer(
  $: EngineInterface,
  q: LongeInboxQuestion,
  body: { option_index: number } | { answer: string },
): Promise<void> {
  const say = (text: string) => update($, flash, (f) => ({ ...f, [q.id]: text }));
  try {
    const res = await $.http.fetch(`${base}/api/v1/answer_question`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: q.repo, id: q.id, ...body }),
    });
    if (!res.ok) {
      let message = res.text;
      try {
        message = (JSON.parse(res.text) as { message?: string }).message ?? res.text;
      } catch {}
      await say(`Not sent (${res.status}): ${message}`);
      return;
    }
    await say("Answered.");
    $.ui.toast(`longe: answered ${q.id}`);
    await scan($);
  } catch {
    await say(`longe is not reachable at ${base}. Start it with: longe serve -d`);
  }
}

async function readVersion($: EngineInterface): Promise<string> {
  const root = $.plugin.root.replace(/[\\/]+$/, "");
  // `root` is the plugin's folder; also accept the manifest folder itself
  for (const path of [`${root}/.claude-plugin/plugin.json`, `${root}/plugin.json`]) {
    try {
      const manifest = JSON.parse(await $.fs.read(path)) as { version?: unknown };
      if (typeof manifest.version === "string") return manifest.version;
    } catch {}
  }
  return "";
}

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({
    id: PANE,
    title: PANE_TITLE,
    focus: true,
    columns: PANE_COLUMNS,
    rows: PANE_ROWS,
  });
}

async function openBoard($: EngineInterface, path: string): Promise<void> {
  const url = `${base}${path}`;
  for (const argv of [
    ["open", url],
    ["xdg-open", url],
  ]) {
    const ok = await $.process
      .run(argv, { timeoutMs: 5000 })
      .then((r) => r.exitCode === 0)
      .catch(() => false);
    if (ok) return;
  }
  $.ui.toast(`Open ${url} in your browser`);
}

export const register: Register = (on, options) => {
  base = `http://127.0.0.1:${typeof options.port === "number" ? options.port : 7311}`;

  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "longe",
      description: "Show longe's question inbox (questions your agents asked you)",
    });
    const v = await readVersion($);
    await update($, version, () => v);
    await scan($);
    $.clock.every(POLL_MS, () => scan($));
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    void scan($);
    return next(e);
  });

  on("command.run", { command: "longe" }, async ($) => {
    await scan($);
    await openPane($);
    const { questions } = await read($, inbox);
    return { text: `longe inbox: ${counts(questions) || "nothing waiting on you"}.` };
  });

  // ---- the band above the prompt -------------------------------------------
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const { questions } = await read($, inbox);
    const first = questions[0];
    if (!first || e.props.hasSurvey || (await read($, isBandHidden))) return next(e);
    const { Box, Button, Text } = $.ui.resolve(e);
    const blocking = questions.filter((q) => q.blocking).length;
    const room = Math.max(10, (e.props.bodyColumns ?? 80) - 48);
    return (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Text
          backgroundColor={blocking > 0 ? THEME.blocking : THEME.nonBlocking}
          color="inverseText"
          bold
        >
          {" longe "}
        </Text>
        <Text bold>{counts(questions)}</Text>
        <Text dimColor>
          · {first.project}: {headline(first.question, room)}
        </Text>
        <Button key="open" label="Open inbox" variant="primary" onPress={() => void openPane($)} />
        <Button key="hide" label="Hide" onPress={() => update($, isBandHidden, () => true)} />
      </Box>
    );
  });

  // ---- the pane ---------------------------------------------------------------
  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e);
    const { Box, Button, Text, Markdown } = els;
    // every surface but mobile has text fields
    const Input = "Input" in els ? els.Input : null;
    const snap = await read($, inbox);
    const notes = await read($, flash);
    const chosen = await read($, selected);
    const expanded = await read($, openContext);
    const ver = await read($, version);
    const now = await $.clock.now();
    const width = Math.max(30, e.props.bodyColumns);
    const qs = snap.questions;
    const current = qs.find((q) => q.id === chosen) ?? qs[0];
    const { roles, text } = snap.tokens;

    const header = (
      <Box flexDirection="column" marginBottom={1}>
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text backgroundColor={THEME.accent} color="inverseText" bold>
            {" longe "}
          </Text>
          <Text bold>inbox</Text>
          {ver !== "" && <Text dimColor>v{ver}</Text>}
          {snap.source === "files" && <Text dimColor>(from files: longe is not running)</Text>}
          <Box flexGrow={1} />
          <Button key="refresh" label="↻ Refresh" plain dimColor onPress={() => scan($)} />
          <Button key="board" label="↗ Board" plain dimColor onPress={() => openBoard($, "/")} />
        </Box>
        {qs.length > 0 && (
          <Box flexDirection="row" gap={2} marginTop={1}>
            {qs.some((q) => q.blocking) && (
              <Text color={THEME.blocking} bold>
                {roles.blocking.icon} {qs.filter((q) => q.blocking).length} {roles.blocking.label}
              </Text>
            )}
            {qs.some((q) => !q.blocking) && (
              <Text color={THEME.nonBlocking}>
                {roles.nonBlocking.icon} {qs.filter((q) => !q.blocking).length}{" "}
                {roles.nonBlocking.label}
              </Text>
            )}
            {new Set(qs.map((q) => q.project)).size > 1 && (
              <Text dimColor>{new Set(qs.map((q) => q.project)).size} projects</Text>
            )}
          </Box>
        )}
      </Box>
    );

    const empty = (
      <Box flexDirection="column" alignItems="center" paddingY={2}>
        <Text color={THEME.approve} bold>
          {roles.approve.icon} Inbox zero
        </Text>
        <Text dimColor>
          {snap.note ?? `${text.empty} Questions your agents ask in longe land here.`}
        </Text>
      </Box>
    );

    // one row per question; shown when there is more than one to choose from
    const list = (
      <Box flexDirection="column" marginBottom={1}>
        {qs.map((q) => {
          const isOn = q.id === current?.id;
          return (
            <Box
              key={`row-${q.id}`}
              flexDirection="row"
              backgroundColor={isOn ? "promptBorder" : undefined}
              hover={{ backgroundColor: "promptBorder" }}
            >
              <Button key={`sel-${q.id}`} plain onPress={() => update($, selected, () => q.id)}>
                <Text color={isOn ? THEME.accent : THEME.muted}>{isOn ? "▌" : " "}</Text>
                <Text color={q.blocking ? THEME.blocking : THEME.nonBlocking}>
                  {q.blocking ? roles.blocking.icon : roles.nonBlocking.icon}{" "}
                </Text>
                <Text bold={isOn} color={q.color ?? undefined}>
                  {q.project}
                </Text>
                <Text dimColor>
                  {" "}
                  {headline(q.question, Math.max(10, width - q.project.length - 14))}{" "}
                </Text>
                <Text dimColor>{ago(q.askedAt, now)}</Text>
              </Button>
            </Box>
          );
        })}
      </Box>
    );

    const card = (q: LongeInboxQuestion) => {
      const isOpen = expanded[q.id] ?? q.contextOpen;
      const kind = q.blocking ? "blocking" : "nonBlocking";
      const note = notes[q.id];
      return (
        <Box
          key={`q-${q.id}`}
          flexDirection="column"
          borderStyle="round"
          borderColor={q.blocking ? THEME.blocking : (q.color ?? "subtle")}
          paddingX={1}
        >
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Text backgroundColor={THEME[kind]} color="inverseText" bold>
              {` ${roles[kind].icon} ${roles[kind].label.toUpperCase()} `}
            </Text>
            <Text color={q.color ?? undefined} bold>
              {q.project}
            </Text>
            <Text dimColor>›</Text>
            <Text>{q.topic ?? text.projectWide}</Text>
            <Box flexGrow={1} />
            <Text dimColor>
              {q.askedBy} · {ago(q.askedAt, now)} ago
            </Text>
          </Box>

          <Box marginTop={1}>
            <Markdown key={`md-${q.id}`} text={q.question} />
          </Box>

          {q.context !== "" && (
            <Box flexDirection="column" marginTop={1}>
              <Button
                key={`ctx-toggle-${q.id}`}
                plain
                dimColor
                label={`${isOpen ? "▾" : "▸"} ${text.context}`}
                onPress={() => update($, openContext, (m) => ({ ...m, [q.id]: !isOpen }))}
              />
              {isOpen && (
                <Box paddingLeft={2} borderStyle="quote" borderDimColor>
                  <Markdown key={`ctx-${q.id}`} text={q.context} dimColor />
                </Box>
              )}
            </Box>
          )}

          {q.assumption && (
            <Box marginTop={1} flexDirection="row" gap={1}>
              <Text color={THEME.nonBlocking}>{text.workingOn}</Text>
              <Text italic>{q.assumption}</Text>
            </Box>
          )}

          {q.options.length > 0 && (
            <Box flexDirection="row" flexWrap="wrap" gap={1} marginTop={1}>
              {q.options.map((label, i) => {
                const role = q.optionRoles[i] ?? "neutral";
                return (
                  <Button
                    key={`opt-${q.id}-${i}`}
                    hotkey={i < 9 ? String(i + 1) : undefined}
                    variant={role === "approve" ? "primary" : undefined}
                    label={`${role === "neutral" ? "" : `${roles[role].icon} `}${label}`}
                    onPress={() => answer($, q, { option_index: i })}
                  />
                );
              })}
            </Box>
          )}

          {Input && (
            <Box marginTop={1}>
              <Input
                key={`reply-${q.id}`}
                label={`${text.reply} › `}
                placeholder={
                  q.options.length > 0 ? "or write your own answer…" : "write your answer…"
                }
                submitLabel="send"
                onSubmit={(text: string) => {
                  const t = text.trim();
                  if (t !== "") void answer($, q, { answer: t });
                }}
              />
            </Box>
          )}

          {note && (
            <Box marginTop={1}>
              <Text color={note === "Answered." ? THEME.approve : THEME.reject}>
                {note === "Answered." ? `${roles.approve.icon} ` : `${roles.reject.icon} `}
                {note}
              </Text>
            </Box>
          )}

          <Box flexDirection="row" gap={2} marginTop={1}>
            <Button
              key={`topic-${q.id}`}
              plain
              dimColor
              label={q.topic ? "↗ Open topic" : "↗ Open in longe"}
              onPress={() => openBoard($, q.links.topic ?? `/#q-${q.id}`)}
            />
            <Box flexGrow={1} />
            <Text dimColor>{q.id}</Text>
          </Box>
        </Box>
      );
    };

    return (
      <Box flexDirection="column">
        {header}
        {qs.length === 0 && empty}
        {qs.length > 1 && list}
        {current && card(current)}
        {snap.problems.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="error">⚠ Files longe-inbox could not read:</Text>
            {snap.problems.map((p: LongeInboxProblem) => (
              <Text dimColor>
                {"  "}
                {p.file}: {p.message}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    );
  });
};

/** "2 blocking · 1 open", the band's count. */
function counts(questions: LongeInboxQuestion[]): string {
  const blocking = questions.filter((q) => q.blocking).length;
  const rest = questions.length - blocking;
  return [blocking > 0 ? `${blocking} blocking` : "", rest > 0 ? `${rest} open` : ""]
    .filter(Boolean)
    .join(" · ");
}

/** The question's first line as plain text, cut to `room` characters. */
function headline(markdown: string, room: number): string {
  const line =
    markdown
      .split("\n")
      .map((l) => l.replace(/[*_`#>]/g, "").trim())
      .find((l) => l !== "") ?? "";
  return line.length > room ? `${line.slice(0, Math.max(1, room - 1))}…` : line;
}

/** Every registered repo's open questions, read from `~/.longe/projects/<id>/questions/`. */
async function readBoards($: EngineInterface): Promise<LongeInboxSnapshot> {
  const now = await $.clock.now();
  const home = (await $.env.get("HOME")) ?? "";
  const longeHome = (await $.env.get("LONGE_HOME")) || `${home}/.longe`;
  const configHome = (await $.env.get("XDG_CONFIG_HOME")) || `${home}/.config`;

  let repos: { path: string; name: string }[];
  try {
    repos = parseRegistry(await $.fs.read(`${configHome}/longe/repos.yml`));
  } catch {
    return {
      ...EMPTY,
      scannedAt: now,
      note: "No longe repositories registered yet (run `longe init` in a repo).",
    };
  }

  const questions: LongeInboxQuestion[] = [];
  const problems: LongeInboxProblem[] = [];
  const live = new Set<string>();

  for (const repo of repos) {
    let id: string | null = null;
    let project = repo.name;
    let color: string | null = null;
    try {
      const cfg = parseYamlMap(await $.fs.read(`${repo.path}/.longe/config.yml`));
      if (typeof cfg.id === "string") id = cfg.id;
      if (typeof cfg.project === "string") project = cfg.project;
      if (typeof cfg.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(cfg.color)) color = cfg.color;
    } catch {
      continue; // repo moved or no longer has .longe/
    }
    if (!id) continue;
    const dir = `${longeHome}/projects/${id}/questions`;
    let entries: Awaited<ReturnType<typeof $.fs.list>>;
    try {
      entries = await $.fs.list(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.kind !== "file" || !/^q-.*\.md$/.test(entry.name)) continue;
      const file = `${dir}/${entry.name}`;
      live.add(file);
      const hit = cache.get(file);
      if (hit && hit.mtimeMs === entry.mtimeMs) {
        if (hit.question) questions.push(hit.question);
        continue;
      }
      try {
        const q = toOpenQuestion(
          parseQuestionFile(await $.fs.read(file)),
          repo.name,
          project,
          color,
        );
        cache.set(file, { mtimeMs: entry.mtimeMs, question: q });
        if (q) questions.push(q);
      } catch (err) {
        cache.delete(file);
        problems.push({ file, message: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  for (const key of [...cache.keys()]) if (!live.has(key)) cache.delete(key);

  questions.sort(inboxOrder);
  return { questions, problems, scannedAt: now, note: null, tokens: INBOX_TOKENS, source: "files" };
}
