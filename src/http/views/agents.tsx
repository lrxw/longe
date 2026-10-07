import type { AgentStatus } from "../../app/agent.js";
import { PROVIDERS } from "../../app/providers/index.js";
import type { SubagentRun } from "../../app/subagents.js";
import { ago } from "../format.js";
import { StateBadge } from "./badge.js";

/** "1m 20s" / "45s" */
function duration(fromIso: string, to: Date): string {
  const s = Math.max(0, Math.round((to.getTime() - new Date(fromIso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const STATE_LABEL: Record<SubagentRun["state"], string> = {
  running: "running",
  done: "done",
  failed: "failed",
  stopped: "stopped",
};

function Run({ run, now }: { run: SubagentRun; now: Date }) {
  const running = run.state === "running";
  return (
    <li class={`subagent ${run.state}`}>
      <div class="head">
        <span class={`state-badge ${running ? "busy" : run.state === "failed" ? "attn" : "quiet"}`}>
          <i></i>
          {STATE_LABEL[run.state]}
        </span>
        <strong>{run.type}</strong>
        {run.name ? <span class="meta">{run.name}</span> : null}
        {run.background ? <span class="tag">background</span> : null}
        <span class="meta">
          {running
            ? `for ${duration(run.startedAt, now)}`
            : `${duration(run.startedAt, new Date(run.endedAt ?? run.startedAt))} · ${ago(
                run.endedAt ?? run.startedAt,
                now,
              )} ago`}
          {run.tools > 0 ? ` · ${run.tools} tool call${run.tools === 1 ? "" : "s"}` : ""}
          {run.tokens ? ` · ${Math.round(run.tokens / 1000)}k tokens` : ""}
        </span>
      </div>
      {run.description ? <p class="desc">{run.description}</p> : null}
      {run.activity ? (
        <p class="activity">
          <code>{run.activity}</code>
        </p>
      ) : null}
    </li>
  );
}

/**
 * The Agents page: the chat (main agent) and the subagents it started. Live over SSE;
 * while something runs it also refreshes every few seconds for the durations.
 */
export function AgentsPanel({
  status,
  base,
  now,
}: {
  status: AgentStatus;
  base: string;
  now: Date;
}) {
  const runs = status.subagents ?? [];
  const running = runs.filter((r) => r.state === "running");
  const finished = runs.filter((r) => r.state !== "running");
  const label = status.provider ? PROVIDERS[status.provider].label : "Claude Code";
  const chatState = status.working ? "working" : status.alive ? "idle" : "off";
  return (
    <section
      id="agents"
      class="agents"
      hx-get={`${base}/fragments/agents`}
      hx-trigger={
        running.length || status.working ? "sse:agent-changed, every 5s" : "sse:agent-changed"
      }
      hx-swap="outerHTML"
    >
      <h2>Agents</h2>
      <ul class="subagents">
        <li class={`subagent main ${chatState}`}>
          <div class="head">
            <span class={`state-badge ${status.working ? "busy" : "quiet"}`}>
              <i></i>
              {chatState}
            </span>
            <strong>Chat</strong>
            <span class="meta">
              {label}
              {status.modelInUse ? ` · ${status.modelInUse}` : ""}
              {status.working ? ` · ${status.pending} message(s) in progress` : ""}
            </span>
            <a class="meta" href={`${base}/chat`}>
              open chat
            </a>
          </div>
        </li>
      </ul>
      {!status.subagentsReported ? (
        <p class="empty">
          {label} does not report its subagents to longe yet; Claude Code, Codex and opencode do.
          The chat itself is shown above.
        </p>
      ) : runs.length === 0 ? (
        <p class="empty">
          No subagents reported yet. Ask the {label} chat to delegate a task to a subagent to see it
          here. Agents started outside this board chat are not tracked.
        </p>
      ) : (
        <>
          <h3>
            Running <span class="meta">{running.length}</span>
          </h3>
          {running.length ? (
            <ul class="subagents">
              {running.map((r) => (
                <Run run={r} now={now} />
              ))}
            </ul>
          ) : (
            <p class="meta">None right now.</p>
          )}
          {finished.length ? (
            <>
              <h3>
                Finished <span class="meta">{finished.length}</span>
              </h3>
              <ul class="subagents">
                {finished.map((r) => (
                  <Run run={r} now={now} />
                ))}
              </ul>
            </>
          ) : null}
          <p class="meta">
            This list shows subagents reported by the board chat, including background work. It
            starts fresh with a new session, a provider switch, or a server restart.
          </p>
        </>
      )}
      {status.provider === "codex" ? (
        <p class="meta">
          Codex shows the last reported child state. Activity and counts appear when child
          notifications arrive; completion may appear when the parent next checks the child.
        </p>
      ) : null}
      {status.provider === "opencode" ? (
        <p class="meta">
          opencode reports when a task subagent starts and ends, but not what it does meanwhile. A
          background task shows as running until the chat's process ends.
        </p>
      ) : null}
    </section>
  );
}

/** Next to "Agents" in the side menu: how many subagents run now. */
export function AgentsBadge({ status, base }: { status: AgentStatus; base: string }) {
  const n = (status.subagents ?? []).filter((r) => r.state === "running").length;
  return (
    <StateBadge
      id="agents-badge"
      tone={n > 0 ? "busy" : "quiet"}
      label={!status.subagentsReported ? "unavailable" : n > 0 ? `${n} running` : "none"}
      title={
        !status.subagentsReported
          ? "subagent tracking is not available for this provider"
          : n > 0
            ? `${n} subagent(s) running`
            : "no subagents reported running"
      }
      src={`${base}/fragments/agents-badge`}
      trigger="sse:agent-changed"
    />
  );
}
