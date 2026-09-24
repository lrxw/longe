import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AGENT_INSTRUCTIONS } from "../domain/agent-instructions.js";
import type { AgentConfig } from "../store/config.js";
import {
  clearMessages,
  listMessages,
  type Message,
  markDelivered,
  writeMessage,
} from "../store/messages.js";

/** One line of the live transcript (what the agent process printed). */
export interface AgentEvent {
  at: string;
  kind: "system" | "text" | "tool" | "result" | "error";
  text: string;
}

/** What is remembered about the session between processes and across restarts. */
export interface SessionInfo {
  id: string;
  contextTokens?: number | undefined;
  contextWindow?: number | undefined;
  /** Cost of finished processes; the live process adds its own on top. */
  costUsd?: number | undefined;
  /** Slash commands the last init listed (names without the `/`), for autocomplete. */
  slashCommands?: string[] | undefined;
}

export interface AgentStatus {
  /** A `claude` process is open and takes messages. */
  alive: boolean;
  /** Messages sent that have no result yet. */
  pending: number;
  working: boolean;
  sessionId?: string | undefined;
  contextTokens?: number | undefined;
  contextWindow?: number | undefined;
  /** Cost of the whole session so far. */
  costUsd?: number | undefined;
  /** When the live process (or the last one) started. */
  startedAt?: string | undefined;
  exitCode?: number | null | undefined;
  events: AgentEvent[];
  logFile: string;
  idleMinutes: number;
  /** Shell command that resumes this session interactively; unset without a session. */
  resumeCommand?: string | undefined;
  /** `--model` the next process gets: the chat-page override, else the config; unset = claude's default. */
  model?: string | undefined;
  /** Chosen on the chat page (remembered across processes and restarts). */
  modelOverride?: string | undefined;
  /** `agent.model` from .longe/config.yml. */
  defaultModel?: string | undefined;
  /** What the live (or last) process reported in its init line. */
  modelInUse?: string | undefined;
  /** Slash commands of the session (names without the `/`); unknown before the first init. */
  slashCommands?: string[] | undefined;
}

/** Choices offered on the chat page; the config default and a custom id are added when set. */
export const MODEL_CHOICES = ["fable", "opus", "sonnet", "haiku"];

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_\-./~]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

/** `cd <repo> && claude --resume <id>`: continue the chat's session in a terminal. */
export function resumeCommand(root: string, sessionId: string, command = "claude"): string {
  return `cd ${shellQuote(root)} && ${shellQuote(command)} --resume ${shellQuote(sessionId)}`;
}

export interface AgentEvents {
  "agent:changed": [];
  /** The last turn finished (or the process ended) and nothing is waiting to go out. */
  "agent:idle": [];
}

export interface SayOptions {
  /** The topic the message is about: it is prefixed so the shared chat knows where it belongs. */
  topic?: { id: string; title: string } | undefined;
}

/** Vars of an answered question, the same the `on_answer` hook gets. */
export interface AnsweredVars {
  question_id?: string | undefined;
  topic_id?: string | undefined;
  answer?: string | undefined;
  question?: string | undefined;
}

/** What the chat is told when the human answers a question on the board. */
export function answeredPrompt(v: AnsweredVars): string {
  const where = v.topic_id ? ` on topic \`${v.topic_id}\`` : "";
  return `Question ${v.question_id ?? "?"}${where} was answered: ${v.answer ?? ""}
Call check_answers and acknowledge_answers, then continue that topic.`;
}

/**
 * The answers that came in while the chat was busy, as one message once it is free.
 * One answer reads like answeredPrompt; several are listed.
 */
export function answersPrompt(list: AnsweredVars[]): string {
  const [only] = list;
  if (list.length === 1 && only) return answeredPrompt(only);
  const lines = list.map((v) => {
    const where = v.topic_id ? ` on topic \`${v.topic_id}\`` : "";
    const answer = (v.answer ?? "").trim().replace(/\s*\n\s*/g, " / ");
    return `- ${v.question_id ?? "?"}${where}: ${answer}`;
  });
  return `${list.length} questions were answered:\n${lines.join("\n")}\nCall check_answers and acknowledge_answers, then continue those topics.`;
}

/** A topic the human moved to active on the board (drag or topic-page button). */
export interface ActivatedVars {
  id: string;
  title: string;
  from: string;
  note?: string | undefined;
}

/** What the chat is told when the human moves a topic to active. */
export function activatedPrompt(v: ActivatedVars): string {
  const why = v.note?.trim() ? `; note: ${v.note.trim()}` : "";
  return `The human moved topic \`${v.id}\` ("${v.title}") to active (from ${v.from}${why}).
Call check_answers, then get_topic and work on it. Report on the board when you stop.`;
}

/** What the chat is told when it is free and the todo queue has a topic for it. */
export function todoPrompt(v: { id: string; title: string }): string {
  return `Next in the todo queue: topic \`${v.id}\` ("${v.title}"). Call check_answers, then set_status active on it, get_topic and work on it until it is in review or blocked on a question. Report on the board when you stop.`;
}

/** Sent when a turn ends with a question in its text and no ask_question call. */
export const ASK_IN_INBOX_PROMPT =
  "Your last reply ends with a question in the text. The human does not read the chat: if you need an answer, ask it with ask_question (2-4 options) now; if it was rhetorical, ignore this.";

/**
 * The reply's last paragraph asks something: it ends with "?", or a sentence in it
 * does. Code blocks do not count.
 */
export function endsWithQuestion(text: string): boolean {
  const prose = text.replace(/```[\s\S]*?```/g, "").trim();
  const last =
    prose
      .split(/\n\s*\n/)
      .at(-1)
      ?.trim() ?? "";
  return /\?(\s|$|["'`)*_])/.test(last);
}

/** What the Continue button sends: pick the conversation up where it stopped (needs a session). */
export const CONTINUE_PROMPT = "Continue where you left off. Report on the board when you stop.";

/** What the Work on board button sends: the board is the task list, with or without a session. */
export const WORK_PROMPT =
  "Work through the board: call check_answers and acknowledge_answers, then list_topics with status active and keep working on those topics until each is in review or blocked on a question. When no active topic is left to work on, pick up todo topics one at a time, oldest first (set_status active), and work them the same way. Never pick up backlog topics: the backlog is parked. Report on the board when you stop.";

/** Quiet this long after a result, with messages still counted: they were folded in. */
export const SETTLE_MS = 3000;

/** While the agent works: silence this long is shown as a stall hint. */
export const STALL_AFTER_MS = 120_000;

export function agentLogDir(): string {
  return path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
    "longe",
    "agent",
  );
}

const MAX_EVENTS = 600;
const DEFAULT_IDLE_MINUTES = 30;

const SYSTEM_PROMPT = `You are the chat of this repository's longe board: one conversation across all its topics, and the human can send you a message at any time, also while you work. A message starting with "On topic \`id\`" is about that topic; for new work create a topic with \`create_topic\` first. Track everything on the board.
Assume the human does not read what you print: it is not stored and they may never see it; the board files are the record. Put results in the topic's Log and Decisions. Anything left open for the human (uncommitted work, a suggested next step, something to check or approve) goes into \`ask_question\`, even when it is not phrased as a question.
Whenever you want something from the human (a decision, a choice between options, a go-ahead, an opinion), call \`ask_question\` with 2-4 \`options\` and do not ask in your printed text. The human answers in the inbox with one click and the answer comes back to you here. Ending a turn with "say go" or a question in text means the human has to type; the inbox is the way. If you can proceed on a default, ask with \`blocking: false\` and an \`assumption\` and continue; if you cannot, ask with \`blocking: true\` and stop.
When the human thinks out loud ("I wonder if…"), give your view in one short paragraph and put the choice into \`ask_question\`.

${AGENT_INSTRUCTIONS}`;

/**
 * A message sent from a topic page carries the topic. A slash command (`/compact`)
 * goes out as typed: claude only runs it when the message starts with the `/`.
 */
function withTopic(text: string, opts: SayOptions): string {
  if (!opts.topic || text.trimStart().startsWith("/")) return text;
  return `On topic \`${opts.topic.id}\` ("${opts.topic.title}"):\n${text}`;
}

/**
 * The repo's conversation with the coding agent (Claude Code). One long-lived
 * `claude -p --input-format stream-json` process takes messages on stdin at any
 * time, also mid-turn; its session id is stored and the next process after an
 * idle close, a stop or a server restart `--resume`s it. Messages are files under
 * `.longe/messages/` (see store/messages.ts), so the chat outlives the process.
 */
export class AgentRunner extends EventEmitter<AgentEvents> {
  private child: ChildProcess | undefined;
  private session: SessionInfo | undefined;
  private events: AgentEvent[] = [];
  private pending = 0;
  /** Messages `say` accepted that `deliver` has not written yet. */
  private queued = 0;
  /** `total_cost_usd` of the live process (cumulative within a process). */
  private processCost = 0;
  private startedAt: string | undefined;
  private exitCode: number | null | undefined;
  private initSeen = false;
  private settleTimer: NodeJS.Timeout | undefined;
  /** The running turn called ask_question. */
  private askedThisTurn = false;
  /** The last turn ended with a reminder to use the inbox (so the next one is not reminded). */
  private remindedLastTurn = false;
  /** A compaction happened and no reply since: the context size is unknown. */
  private compacted = false;
  private modelOverride: string | undefined;
  private runningModel: string | undefined;
  private loaded: Promise<void>;
  private notifyTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private sending: Promise<void> = Promise.resolve();
  /** The last file write (log, sessions); see write(). */
  private writes: Promise<void> = Promise.resolve();
  /** The exit bookkeeping of the last process; close() waits for it. */
  private closing: Promise<void> = Promise.resolve();
  readonly logFile: string;
  private readonly sessionsFile: string;
  readonly idleMinutes: number;
  /** Longe MCP endpoint for this repo, set by the HTTP layer once it knows its port. */
  mcpUrl: string | undefined;
  /** config `ask_in_inbox`: no AskUserQuestion, and a reminder for questions left in text. */
  askInInbox = true;

  /**
   * `logName` names the log and the sessions file (the repo's `project:`, else its
   * folder). `legacyNames` are names the same repo had before (the folder name once
   * `project:` is set): their sessions file is read, and moved, when the current
   * one does not exist, so setting a project name does not forget the chat.
   */
  constructor(
    private readonly root: string,
    private readonly config: AgentConfig,
    logName: string,
    private readonly spawnImpl: typeof spawn = spawn,
    legacyNames: string[] = [],
  ) {
    super();
    this.logFile = path.join(agentLogDir(), `${logName}.log`);
    this.sessionsFile = path.join(agentLogDir(), `${logName}.sessions.json`);
    this.idleMinutes = config.idle_minutes ?? DEFAULT_IDLE_MINUTES;
    this.loaded = this.loadSession(
      legacyNames
        .filter((n) => n !== logName)
        .map((n) => path.join(agentLogDir(), `${n}.sessions.json`)),
    );
  }

  private async loadSession(legacyFiles: string[]): Promise<void> {
    for (const file of [this.sessionsFile, ...legacyFiles]) {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue; // first run, or renamed: try the older name
      }
      try {
        const { model, ...raw } = JSON.parse(text) as Record<string, string | SessionInfo>;
        if (typeof model === "string" && model) this.modelOverride = model;
        // one session per repo now; older files stored one per key (and bare ids):
        // take the known keys first, else whatever single session the file holds
        const v = raw.chat ?? raw.board ?? Object.values(raw).find(Boolean);
        if (typeof v === "string") this.session = { id: v };
        else if (v && typeof v.id === "string") this.session = v;
      } catch {
        // unreadable: start fresh
      }
      if (file !== this.sessionsFile) {
        // carry it over under the new name, so the old file is not read again later
        await this.saveSession();
        await rm(file, { force: true }).catch(() => {});
      }
      return;
    }
  }

  private saveSession(): Promise<void> {
    // the state is taken now, the write waits its turn (losing it only costs continuity)
    const text = JSON.stringify(
      { ...(this.session ? { chat: this.session } : {}), model: this.modelOverride },
      null,
      2,
    );
    return this.write(async () => {
      await mkdir(agentLogDir(), { recursive: true });
      await writeFile(this.sessionsFile, text);
    });
  }

  status(): AgentStatus {
    return {
      alive: this.child !== undefined,
      pending: this.pending,
      working: this.pending > 0,
      sessionId: this.session?.id,
      contextTokens: this.session?.contextTokens,
      contextWindow: this.session?.contextWindow,
      costUsd:
        this.session?.costUsd !== undefined || this.processCost > 0
          ? (this.session?.costUsd ?? 0) + this.processCost
          : undefined,
      startedAt: this.startedAt,
      exitCode: this.exitCode,
      events: this.events,
      logFile: this.logFile,
      idleMinutes: this.idleMinutes,
      resumeCommand: this.session
        ? resumeCommand(this.root, this.session.id, this.config.command ?? "claude")
        : undefined,
      model: this.modelOverride ?? this.config.model,
      modelOverride: this.modelOverride,
      defaultModel: this.config.model,
      modelInUse: this.runningModel,
      slashCommands: this.session?.slashCommands,
    };
  }

  /**
   * Picks the model for this chat (undefined: back to the config default). A running
   * process cannot switch, so it is stopped; the next message resumes the session
   * with the new `--model`.
   */
  async setModel(model: string | undefined): Promise<void> {
    await this.loaded;
    const next = model?.trim() || undefined;
    if (next === this.modelOverride) return;
    this.modelOverride = next;
    await this.saveSession();
    this.stop();
    this.emit("agent:changed");
  }

  /** The stored messages, oldest first (the chat page merges them with `events`). */
  messages(): Promise<Message[]> {
    return listMessages(this.root);
  }

  /**
   * Stores the message as a file and hands it to the agent process, starting
   * one if needed. Returns once the file is written; delivery is asynchronous.
   */
  async say(from: Message["fm"]["from"], text: string, opts: SayOptions = {}): Promise<Message> {
    const m = await writeMessage(this.root, {
      from,
      text: withTopic(text, opts),
      topic: opts.topic?.id,
      now: new Date(),
    });
    this.emit("agent:changed");
    this.queued++;
    this.sending = this.sending
      .then(() => this.deliver([m]))
      .catch(() => {})
      .finally(() => {
        this.queued--;
        // a fast reply can end the turn while the message is still being booked
        // (see deliver): the result saw the chat as busy, so idle is announced here
        if (this.child && !this.busy()) this.emit("agent:idle");
      });
    return m;
  }

  /** The repo has a chat: a stored session or a live process. */
  hasChat(): boolean {
    return this.session !== undefined || this.child !== undefined;
  }

  /** A turn is running or a message is on its way to one. */
  busy(): boolean {
    return this.pending > 0 || this.queued > 0;
  }

  /**
   * A question was answered on the board: tell the chat, so the human does not
   * have to type "go on". Only when a session exists; a repo that never chatted
   * gets no agent started behind the human's back.
   */
  async notifyAnswer(vars: AnsweredVars): Promise<boolean> {
    await this.loaded;
    await this.sending; // a message may be on its way to a process that is just starting
    if (!this.session && !this.child) return false;
    await this.say("board", answeredPrompt(vars));
    return true;
  }

  /**
   * The human moved a topic to active: that asks for work now, so unlike an answer
   * this starts the chat also when the repo has no session yet.
   */
  async notifyActivated(vars: ActivatedVars): Promise<void> {
    await this.loaded;
    await this.say("board", activatedPrompt(vars));
  }

  /** Kills the live process (SIGTERM). The session stays resumable. */
  stop(): boolean {
    if (!this.child) return false;
    this.child.kill("SIGTERM");
    return true;
  }

  /**
   * Stops and waits until the process is gone; SIGKILL after `graceMs`. Used on
   * shutdown: a child that outlives the server keeps writing to the log while the
   * next server shows the chat as off.
   */
  async close(graceMs = 3000): Promise<void> {
    const child = this.child;
    if (child) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        this.stop();
      });
    }
    // the exit bookkeeping and the last file writes: after this nothing touches the disk
    await this.closing;
    await this.writes;
  }

  /**
   * Empties the chat page: delivered messages are deleted, the live transcript is
   * dropped. Messages still waiting stay. The session stays; the agent keeps its memory.
   */
  async clearHistory(): Promise<void> {
    await this.loaded;
    await this.sending; // a message on its way out is marked delivered first
    this.events = [];
    await clearMessages(this.root);
    this.emit("agent:changed");
  }

  /** Forget the session and the transcript: the next message starts a fresh conversation. */
  async reset(): Promise<void> {
    await this.loaded;
    this.stop();
    this.session = undefined;
    this.events = [];
    this.processCost = 0;
    await this.saveSession();
    this.emit("agent:changed");
  }

  private async deliver(messages: Message[]): Promise<void> {
    await this.loaded;
    if (!this.child) {
      // anything written while no process was open (server down, by hand) goes first
      const waiting = (await this.messages()).filter(
        (m) => !m.fm.delivered_at && !messages.some((n) => n.fm.id === m.fm.id),
      );
      messages = [...waiting, ...messages];
      if (!this.spawn()) return;
    }
    for (const m of messages) {
      if (!this.child) break;
      const line = JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: m.text }] },
      });
      // count the turn before the write: a fast answer must not arrive first
      this.pending++;
      try {
        await markDelivered(this.root, m.fm.id, new Date());
      } catch {
        // the flag is bookkeeping; the message still goes out
      }
      this.child.stdin?.write(`${line}\n`);
      await this.log(`>>> ${m.fm.id}\n${line}\n`);
    }
    this.armIdle();
    this.emit("agent:changed");
  }

  private args(): string[] {
    const mcpUrl = this.mcpUrl;
    const mcp = mcpUrl
      ? ["--mcp-config", JSON.stringify({ mcpServers: { longe: { type: "http", url: mcpUrl } } })]
      : [];
    // headless: nobody answers permission prompts, so what the chat may run is listed up front
    const allowed = [...(mcpUrl ? ["mcp__longe"] : []), ...(this.config.allowed_tools ?? [])];
    const model = this.modelOverride ?? this.config.model;
    return [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      this.config.permission_mode ?? "acceptEdits",
      ...(model ? ["--model", model] : []),
      ...(this.session ? ["--resume", this.session.id] : []),
      ...mcp,
      ...(allowed.length > 0 ? ["--allowedTools", ...allowed] : []),
      // questions go to the inbox (ask_question), never to a prompt nobody sees
      ...(this.askInInbox ? ["--disallowedTools", "AskUserQuestion"] : []),
      "--append-system-prompt",
      SYSTEM_PROMPT,
      ...(this.config.args ?? []),
    ];
  }

  /** Starts the process. False when it could not be spawned (an error event says why). */
  private spawn(): boolean {
    const command = this.config.command ?? "claude";
    const args = this.args();
    this.startedAt = new Date().toISOString();
    this.exitCode = undefined;
    this.initSeen = false;
    this.processCost = 0;
    void this.log(`\n=== ${this.startedAt} start\n$ ${command} ${JSON.stringify(args)}\n`);
    let child: ChildProcess;
    try {
      child = this.spawnImpl(command, args, {
        cwd: this.root,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.push("error", `spawn failed: ${m}`);
      void this.log(`spawn failed: ${m}\n`);
      return false;
    }
    // ENOENT and friends: no pid, an "error" event follows on the next tick
    if (child.pid !== undefined) this.child = child;
    child.stdin?.on("error", () => {
      // EPIPE after the process died: the close handler reports it
    });
    let buf = "";
    child.stdout?.on("data", (d: Buffer) => {
      const s = d.toString();
      void this.log(s);
      buf += s;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) this.ingest(l);
    });
    child.stderr?.on("data", (d: Buffer) => {
      const s = d.toString();
      void this.log(s);
      if (s.trim()) this.push("error", s.trim());
    });
    child.on("error", (err) => {
      this.push(
        "error",
        err.message.includes("ENOENT") ? `${command}: command not found` : err.message,
      );
      void this.log(`error: ${err.message}\n`);
      if (this.child === child) this.closing = this.closed(null);
    });
    child.on("close", (code) => {
      if (buf.trim()) this.ingest(buf);
      buf = "";
      if (this.child === child) this.closing = this.closed(code);
    });
    return child.pid !== undefined;
  }

  private async closed(code: number | null): Promise<void> {
    this.child = undefined;
    this.exitCode = code;
    this.clearIdle();
    if (this.pending > 0 && code !== 0)
      this.push(
        "error",
        `agent exited (${code ?? "?"}) with ${this.pending} message(s) unanswered`,
      );
    this.pending = 0;
    if (this.session) {
      this.session.costUsd = (this.session.costUsd ?? 0) + this.processCost;
      this.processCost = 0;
      await this.saveSession();
    }
    await this.log(`=== exit ${code ?? "?"} ===\n`);
    this.flushNotify();
    if (!this.busy()) this.emit("agent:idle");
  }

  /** After `idle_minutes` without pending work the process is closed; the next message resumes the session. */
  private armIdle(): void {
    this.clearIdle();
    if (this.pending > 0 || !this.child || this.idleMinutes <= 0) return;
    this.idleTimer = setTimeout(
      () => {
        this.idleTimer = undefined;
        if (this.pending === 0 && this.child) {
          void this.log("=== idle: closing stdin ===\n");
          this.child.stdin?.end();
        }
      },
      Math.max(50, this.idleMinutes * 60_000),
    );
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private log(line: string): Promise<void> {
    return this.write(async () => {
      await mkdir(path.dirname(this.logFile), { recursive: true });
      await appendFile(this.logFile, line);
    });
  }

  /**
   * File writes (log, sessions) run one after the other, in order, and never
   * throw; close() waits for the last one so nothing lands after the runner is gone.
   */
  private write(work: () => Promise<void>): Promise<void> {
    const next = this.writes.then(work).catch(() => {
      // logging and session bookkeeping must never break the run
    });
    this.writes = next;
    return next;
  }

  private push(kind: AgentEvent["kind"], text: string): void {
    this.events.push({ at: new Date().toISOString(), kind, text });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    // coalesce UI refreshes while streaming
    if (!this.notifyTimer)
      this.notifyTimer = setTimeout(() => {
        this.notifyTimer = undefined;
        this.emit("agent:changed");
      }, 250);
  }

  private flushNotify(): void {
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = undefined;
    }
    this.emit("agent:changed");
  }

  /** One line of `--output-format stream-json`. */
  /**
   * A message sent while a turn runs is sometimes folded into that turn: two messages,
   * one result, and `pending` would stay above 0 for good, so the chat would never
   * count as free (no answers, no todo). After a result, if the stream stays quiet for
   * SETTLE_MS, no further turn is coming: the count is cleared.
   */
  private armSettle(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = undefined;
      if (this.pending === 0 || this.queued > 0 || !this.child) return;
      this.pending = 0;
      this.armIdle();
      this.flushNotify();
      this.emit("agent:idle");
    }, SETTLE_MS);
    this.settleTimer.unref?.();
  }

  private ingest(line: string): void {
    // any output means a turn is running: the leftover count is real, keep it
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = undefined;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.push("text", line);
      return;
    }
    const sid = typeof msg.session_id === "string" ? msg.session_id : undefined;
    if (sid && this.session?.id !== sid) {
      this.session = {
        id: sid,
        costUsd: this.session?.costUsd,
        slashCommands: this.session?.slashCommands,
      };
      void this.saveSession();
    }
    switch (msg.type) {
      case "system":
        // one init per turn; only the first tells the human something new
        if (msg.subtype === "init" && !this.initSeen) {
          this.initSeen = true;
          if (typeof msg.model === "string" && msg.model) this.runningModel = msg.model;
          const cmds = Array.isArray(msg.slash_commands)
            ? msg.slash_commands.filter((c): c is string => typeof c === "string")
            : undefined;
          if (cmds && this.session) {
            this.session.slashCommands = cmds;
            void this.saveSession();
          }
          this.push("system", `session ${sid ?? "?"} · model ${String(msg.model ?? "?")}`);
        } else if (msg.subtype === "compact_boundary") {
          // /compact or auto-compaction: the old context figure is stale until the next reply
          const meta = msg.compact_metadata as
            | { pre_tokens?: unknown; trigger?: unknown }
            | undefined;
          const pre = typeof meta?.pre_tokens === "number" ? meta.pre_tokens : undefined;
          const how = meta?.trigger === "auto" ? "auto-compacted" : "compacted";
          this.push(
            "system",
            `context ${how}${pre !== undefined ? ` (${Math.round(pre / 1000)}k tokens before)` : ""}`,
          );
          this.compacted = true;
          if (this.session) {
            this.session.contextTokens = undefined;
            void this.saveSession();
          }
        }
        break;
      case "assistant": {
        const m = msg.message as { content?: unknown; usage?: unknown } | undefined;
        const ctx = contextOf(m?.usage);
        if (ctx !== undefined && this.session) this.session.contextTokens = ctx;
        this.compacted = false;
        const content = Array.isArray(m?.content) ? (m?.content as Record<string, unknown>[]) : [];
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string" && block.text.trim())
            this.push("text", block.text);
          else if (block.type === "tool_use") {
            this.push("tool", `${String(block.name)} ${summarize(block.input)}`);
            if (String(block.name).endsWith("ask_question")) this.askedThisTurn = true;
          }
        }
        break;
      }
      case "result": {
        if (typeof msg.total_cost_usd === "number") this.processCost = msg.total_cost_usd;
        if (this.session) {
          const win = contextWindowOf(msg.modelUsage);
          if (win !== undefined) this.session.contextWindow = win;
          // after a compaction the result's usage is the summary call over the old context
          const ctx = this.compacted ? undefined : contextOf(msg.usage);
          if (ctx !== undefined && this.session.contextTokens === undefined)
            this.session.contextTokens = ctx;
          void this.saveSession();
        }
        const text = typeof msg.result === "string" ? msg.result : "";
        // the result repeats the last assistant text; show it once
        const last = this.events.at(-1);
        if (msg.is_error || !text || last?.kind !== "text" || last.text !== text)
          this.push(msg.is_error ? "error" : "result", text || String(msg.subtype ?? "done"));
        this.pending = Math.max(0, this.pending - 1);
        // a question left in the reply text never reaches the human: remind the chat
        // once to use the inbox; the reminder's own turn is never reminded again
        const remind =
          this.askInInbox &&
          !msg.is_error &&
          !this.askedThisTurn &&
          !this.remindedLastTurn &&
          this.pending === 0 &&
          endsWithQuestion(text);
        this.remindedLastTurn = remind;
        this.askedThisTurn = false;
        if (remind) void this.say("board", ASK_IN_INBOX_PROMPT);
        this.armIdle();
        this.flushNotify();
        if (!this.busy()) this.emit("agent:idle");
        else this.armSettle();
        break;
      }
      default:
        break;
    }
  }
}

/** Context in use after a turn: everything the model read (`usage` of an assistant message or result). */
function contextOf(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
  const total = n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens");
  return total > 0 ? total : undefined;
}

/** Largest `contextWindow` in a result's `modelUsage` (one entry per model used). */
function contextWindowOf(modelUsage: unknown): number | undefined {
  if (!modelUsage || typeof modelUsage !== "object") return undefined;
  let max = 0;
  for (const v of Object.values(modelUsage as Record<string, unknown>)) {
    const w = (v as { contextWindow?: unknown } | null)?.contextWindow;
    if (typeof w === "number" && w > max) max = w;
  }
  return max > 0 ? max : undefined;
}

/** Short one-line view of a tool call's input. */
function summarize(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const pick = ["command", "file_path", "path", "pattern", "query", "topic_id", "title", "id"];
  for (const k of pick) {
    const v = o[k];
    if (typeof v === "string" && v) return v.length > 100 ? `${v.slice(0, 100)}…` : v;
  }
  const s = JSON.stringify(o);
  return s.length > 100 ? `${s.slice(0, 100)}…` : s;
}
