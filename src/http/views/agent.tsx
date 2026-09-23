import { raw } from "hono/html";
import {
  type AgentEvent,
  type AgentStatus,
  MODEL_CHOICES,
  STALL_AFTER_MS,
} from "../../app/agent.js";
import type { Message } from "../../store/messages.js";
import { ago, renderMarkdown } from "../format.js";
import { StateBadge } from "./badge.js";

/** "48k" / "1.2M" */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** Context in use vs the model's window, as a small bar plus numbers. */
export function ContextMeter({ status }: { status: AgentStatus }) {
  const used = status.contextTokens;
  // always rendered, so the status bar keeps its shape before the first turn
  if (used === undefined)
    return (
      <span class="ctx-meter" title="context in use: known after the first turn">
        context –
      </span>
    );
  const win = status.contextWindow;
  const pct = win ? Math.min(100, Math.round((used / win) * 100)) : undefined;
  const level = pct === undefined ? "" : pct >= 85 ? "high" : pct >= 60 ? "mid" : "";
  return (
    <span
      class={`ctx-meter ${level}`}
      title={
        win
          ? `${used.toLocaleString()} of ${win.toLocaleString()} context tokens in use`
          : `${used.toLocaleString()} context tokens in use`
      }
    >
      context {tokens(used)}
      {win ? (
        <>
          {" / "}
          {tokens(win)}
          <span class="bar">
            <b style={`width:${pct}%`} />
          </span>
          {pct}%
        </>
      ) : null}
    </span>
  );
}

/**
 * Which model the next process gets. Changing it stops a running process; the
 * session resumes with the new model on the next message.
 */
export function ModelSelect({ status, base }: { status: AgentStatus; base: string }) {
  const chosen = status.modelOverride ?? "";
  const choices = [...MODEL_CHOICES];
  if (chosen && !choices.includes(chosen)) choices.push(chosen);
  const inUse = status.modelInUse ? `in use: ${status.modelInUse}` : "no process yet";
  return (
    <select
      class="model"
      name="model"
      hx-post={`${base}/agent/model`}
      hx-trigger="change"
      hx-target="#agent"
      hx-swap="outerHTML"
      title={`Model for the next process (${inUse}). Switching stops a running process; the session resumes with the new model.`}
    >
      <option value="" selected={chosen === ""}>
        {status.defaultModel ? `default (${status.defaultModel})` : "default model"}
      </option>
      {choices.map((m) => (
        <option value={m} selected={chosen === m}>
          {m}
        </option>
      ))}
    </select>
  );
}

function stateOf(status: AgentStatus): "working" | "idle" | "off" {
  return status.working ? "working" : status.alive ? "idle" : "off";
}

/** idle / working / off, refreshed over SSE. Lives in the side menu next to "Chat". */
export function AgentBadge({ status, base }: { status: AgentStatus; base: string }) {
  const state = stateOf(status);
  return (
    <StateBadge
      id="agent-badge"
      tone={state === "working" ? "busy" : "quiet"}
      label={state}
      title={
        state === "working"
          ? `${status.pending} message(s) in progress`
          : state === "idle"
            ? `agent process open, closes after ${status.idleMinutes} min idle`
            : "no agent process; the next message resumes the session"
      }
      src={`${base}/fragments/agent-badge`}
      trigger="sse:agent-changed"
    />
  );
}

/** The chat page: prompt box plus the conversation. */
export function AgentSection({
  status,
  messages,
  base,
  now,
}: {
  status: AgentStatus;
  messages: Message[];
  base: string;
  now: Date;
}) {
  return (
    <section class="agent">
      <form
        class="prompt"
        hx-post={`${base}/agent/prompt`}
        hx-target="#agent"
        hx-swap="outerHTML"
        hx-on--after-request="if (event.detail.successful) this.reset()"
      >
        <textarea
          name="prompt"
          rows={3}
          placeholder="Tell the agent what to do. Name a topic, or let it create one. You can keep typing while it works…"
          required
        />
        <div class="row">
          <span class="meta">
            {status.sessionId ? (
              <>
                session <code>{status.sessionId.slice(0, 8)}</code>
              </>
            ) : (
              "new session"
            )}
          </span>
          <button type="submit" class="primary">
            Send
          </button>
        </div>
      </form>
      <AgentPanel status={status} messages={messages} base={base} now={now} />
    </section>
  );
}

/**
 * Compact prompt on a topic page. It goes into the repo chat (same session),
 * prefixed with the topic, and the browser follows it to the chat page.
 */
export function TopicPrompt({
  base,
  topicId,
  title,
}: {
  base: string;
  topicId: string;
  title: string;
}) {
  return (
    <form class="prompt compact" method="post" action={`${base}/agent/prompt`}>
      <input type="hidden" name="topic" value={topicId} />
      <textarea
        name="prompt"
        rows={2}
        placeholder={`Tell the agent what to do on "${title}"…`}
        required
      />
      <div class="row">
        <span class="meta">
          goes to the repo <a href={`${base}/chat`}>chat</a>
        </span>
        <button type="submit" class="primary">
          Send
        </button>
      </div>
    </form>
  );
}

type Entry = { at: number; message: Message } | { at: number; event: AgentEvent };

/** Stored messages and the live transcript, one stream in time order. */
function entries(messages: Message[], events: AgentEvent[]): Entry[] {
  const all: Entry[] = [
    ...messages.map((message) => ({ at: Date.parse(message.fm.at), message })),
    ...events.map((event) => ({ at: Date.parse(event.at), event })),
  ];
  return all.sort((a, b) => a.at - b.at);
}

export function AgentPanel({
  status,
  messages,
  base,
  now,
  error,
}: {
  status: AgentStatus;
  messages: Message[];
  base: string;
  now: Date;
  error?: string | undefined;
}) {
  const state = stateOf(status);
  const list = entries(messages, status.events);
  const last = list.at(-1);
  // not working and there is a conversation: "Continue" nudges the agent on
  const canContinue = !status.working && status.sessionId !== undefined;
  // while working: silence for a while usually means a permission prompt or a long wait
  const silentMs = status.working && last ? now.getTime() - last.at : 0;
  const stalled = silentMs >= STALL_AFTER_MS;
  const since = status.startedAt ? ` since ${ago(status.startedAt, now)}` : "";
  // off: always say what the next message does; the exit code alone reads as a dead end
  const exited = status.exitCode !== undefined ? `exit ${status.exitCode ?? "?"} · ` : "";
  const detail =
    state === "working"
      ? `${status.pending > 1 ? `${status.pending} messages · ` : ""}process${since}`
      : state === "idle"
        ? `process open${since}`
        : status.sessionId
          ? `${exited}no process · the next message resumes the session`
          : `${exited}no session · the next message starts fresh`;
  return (
    <div
      id="agent"
      class={`agent-panel ${state}`}
      hx-get={`${base}/fragments/agent`}
      hx-trigger={status.working ? "sse:agent-changed, every 30s" : "sse:agent-changed"}
      hx-swap="morph"
    >
      <div class="agent-status">
        <span class="state">
          <span class={`tag ${state === "working" ? "block" : state === "idle" ? "ok" : ""}`}>
            {state}
          </span>
          {stalled ? (
            <span
              class="detail stall"
              title="Headless runs cannot answer permission prompts; Stop, then send the message again."
            >
              no output for {ago(new Date(now.getTime() - silentMs).toISOString(), now)}
            </span>
          ) : (
            <span class="detail">{detail}</span>
          )}
        </span>
        <span class="meters">
          <ModelSelect status={status} base={base} />
          <ContextMeter status={status} />
          <span class="cost" title="cost of this session so far">
            {status.costUsd !== undefined ? `$${status.costUsd.toFixed(2)}` : "–"}
          </span>
        </span>
        <span class="actions">
          {/* every button is always there, so the bar never changes shape */}
          <button
            type="button"
            class="small primary"
            hx-post={`${base}/agent/continue`}
            hx-target="#agent"
            hx-swap="outerHTML"
            title={
              canContinue
                ? "Send: continue where you left off"
                : status.working
                  ? "The agent is working; wait or Stop"
                  : "No session to continue; send a message to start one"
            }
            disabled={!canContinue}
          >
            Continue
          </button>
          <button
            type="button"
            class="small primary"
            hx-post={`${base}/agent/work`}
            hx-target="#agent"
            hx-swap="outerHTML"
            title={
              status.working
                ? "The agent is working; wait or Stop"
                : status.sessionId
                  ? "Send: work through the active topics, then the backlog"
                  : "Start a session that works through the active topics, then the backlog"
            }
            disabled={status.working}
          >
            Work on board
          </button>
          <button
            type="button"
            class="small"
            hx-post={`${base}/agent/stop`}
            hx-target="#agent"
            hx-swap="outerHTML"
            title="Kill the agent process; the session stays resumable"
            disabled={!status.alive}
          >
            Stop
          </button>
          <button
            type="button"
            class="small"
            hx-post={`${base}/agent/clear`}
            hx-target="#agent"
            hx-swap="outerHTML"
            hx-confirm="Clear the chat history? Delivered message files under .ai/messages/ are deleted; messages still waiting stay. The session stays."
            title="Empty this page; the agent keeps its memory"
            disabled={list.length === 0}
          >
            Clear history
          </button>
          <button
            type="button"
            class="small"
            hx-post={`${base}/agent/reset`}
            hx-target="#agent"
            hx-swap="outerHTML"
            hx-confirm="Forget this session? The next message starts a fresh conversation. Stored messages stay in .ai/messages/."
            title={
              status.sessionId
                ? "Forget the session; the next message starts fresh"
                : "No session yet; the next message starts a fresh one"
            }
            disabled={!status.sessionId}
          >
            New session
          </button>
          <button
            type="button"
            class="small"
            data-copy={status.resumeCommand}
            title={
              status.resumeCommand
                ? `Copy to the clipboard: ${status.resumeCommand}`
                : "No session yet"
            }
            disabled={!status.resumeCommand}
          >
            Copy resume command
          </button>
        </span>
      </div>
      <p class="meta agent-log" title={status.logFile}>
        log: <code>{status.logFile}</code>
      </p>
      {error ? <p class="error">{error}</p> : null}
      {list.length > 0 ? (
        <div class="transcript">
          {list.map((e) =>
            "message" in e ? (
              <div class={`you from-${e.message.fm.from}`}>
                <p class="meta">
                  <strong>{e.message.fm.from === "board" ? "Board" : "You"}</strong>{" "}
                  {ago(e.message.fm.at, now)} ago
                  {e.message.fm.topic ? (
                    <>
                      {" · "}
                      <a href={`${base}/topics/${e.message.fm.topic}`}>{e.message.fm.topic}</a>
                    </>
                  ) : null}
                  {e.message.fm.delivered_at ? null : (
                    <>
                      {" "}
                      <span class="tag">waiting</span>
                    </>
                  )}
                </p>
                <div class="md">{raw(renderMarkdown(e.message.text))}</div>
              </div>
            ) : e.event.kind === "text" || e.event.kind === "result" ? (
              <div class={`md ev ${e.event.kind}`}>{raw(renderMarkdown(e.event.text))}</div>
            ) : (
              <p class={`ev ${e.event.kind}`}>
                <code>{e.event.text}</code>
              </p>
            ),
          )}
          {status.working ? <p class="ev system">…</p> : null}
        </div>
      ) : (
        <p class="empty">No messages yet.</p>
      )}
    </div>
  );
}
