import { todoOrder } from "../../domain/topic-ops.js";
import { allowedTargets } from "../../domain/transitions.js";
import { TOPIC_STATUSES, type TopicStatus } from "../../domain/types.js";
import type { AiIndex, IndexedTopic } from "../../index/index.js";
import { FINISHED } from "../../tools/ops.js";
import { ago, lastLine, planProgress } from "../format.js";
import { ErrorList } from "./layout.js";

export function TopicCard({
  t,
  index,
  now,
  base,
}: {
  t: IndexedTopic;
  index: AiIndex;
  now: Date;
  base: string;
}) {
  const open = index.openQuestionCount(t.id);
  const blocking = index.openBlockingCount(t.id);
  // answered, but the agent has not read them yet (the chat gets them when it is free)
  const unread = index.questionsForTopic(t.id).filter((q) => q.fm.status === "answered").length;
  const last = lastLine(t.sections.Log);
  const p = planProgress(t.sections.Plan);
  // drag to another column: the columns a human may move it to (§4)
  const targets = allowedTargets(t.fm.status, "human").join(",");
  return (
    // the id lets a morph refresh match this card by identity, not by position: a card
    // dragged away (and still focused) is not reused for the card that moves up
    <a
      id={`card-${t.id}`}
      class="card topic"
      href={`${base}/topics/${t.id}`}
      draggable="true"
      data-id={t.id}
      data-status={t.fm.status}
      data-targets={targets}
    >
      <strong>{t.fm.title}</strong>
      <span class="meta">
        {ago(t.fm.updated, now)} ago
        {p.total > 0 ? (
          <span class="progress" title={`${p.done} of ${p.total} plan steps done`}>
            <i>
              <b style={`width:${Math.round((p.done / p.total) * 100)}%`} />
            </i>
            {p.done}/{p.total}
          </span>
        ) : null}
        {open > 0 ? <span class={`tag ${blocking > 0 ? "block" : ""}`}>{open} open</span> : null}
        {unread > 0 ? (
          <span class="tag unread" title="Answered, not read by the agent yet">
            {unread} {unread === 1 ? "answer" : "answers"} waiting
          </span>
        ) : null}
      </span>
      {last ? <span class="last">{last}</span> : null}
    </a>
  );
}

const COLLAPSED: readonly TopicStatus[] = FINISHED;

/** Clears done and cancelled topics away; the human picks archive or delete each time. */
function Cleanup({ count, base }: { count: number; base: string }) {
  if (count === 0) return null;
  const what = `${count} done and cancelled ${count === 1 ? "topic" : "topics"}`;
  return (
    <div class="cleanup">
      <span class="meta">{what}</span>
      <button
        type="button"
        class="small"
        hx-post={`${base}/board/cleanup`}
        hx-vals='{"mode":"archive"}'
        hx-target="#board"
        hx-swap="outerHTML"
        hx-confirm={`Archive ${what} with their questions? The files move to .longe/archive/.`}
        title="Move them and their questions to .longe/archive/; nothing is lost"
      >
        Archive
      </button>
      <button
        type="button"
        class="small danger"
        hx-post={`${base}/board/cleanup`}
        hx-vals='{"mode":"delete"}'
        hx-target="#board"
        hx-swap="outerHTML"
        hx-confirm={`Delete ${what} and their questions for good? This cannot be undone.`}
        title="Delete their files and their questions' files"
      >
        Delete
      </button>
    </div>
  );
}

/**
 * Add a topic yourself, without asking the chat: it lands in backlog (parked) or todo
 * (the queue picks it up). The chat is not told.
 */
function NewTopic({ base, error }: { base: string; error?: string | undefined }) {
  return (
    // no data-key: its open state is not remembered, so the board that comes back after
    // an add has it closed again (open only to show an error); live refreshes (morph)
    // keep it open while you type
    <details class="new-topic" open={error ? true : undefined}>
      <summary>+ New topic</summary>
      <form
        hx-post={`${base}/topics/new`}
        hx-target="#board"
        hx-swap="outerHTML"
        hx-on--after-request="if (event.detail.successful) this.reset()"
      >
        <input name="title" placeholder="Title" required autocomplete="off" />
        <textarea name="goal" rows={2} placeholder="Goal: what and why (optional)" />
        <div class="row">
          <select name="status" title="Where it lands">
            <option value="backlog">Backlog (parked)</option>
            <option value="todo">Todo (the agent picks it up)</option>
          </select>
          <button type="submit" class="primary small">
            Add
          </button>
        </div>
        {error ? <p class="error">{error}</p> : null}
      </form>
    </details>
  );
}

export function BoardFragment({
  index,
  now,
  base,
  error,
}: {
  index: AiIndex;
  now: Date;
  base: string;
  /** Shown in the new-topic form after a failed add. */
  error?: string | undefined;
}) {
  const finished = FINISHED.reduce((n, s) => n + index.topicsByStatus(s).length, 0);
  return (
    // hx-sync: a newer refresh cancels one still in flight, so a late stale answer never wins
    <div
      id="board"
      hx-get={`${base}/fragments/board`}
      hx-trigger="sse:changed"
      hx-sync="this:replace"
      hx-swap="morph"
    >
      <ErrorList errors={[...index.errors.values()]} />
      <div class="board-tools">
        <NewTopic base={base} error={error} />
        <Cleanup count={finished} base={base} />
      </div>
      <div class="columns">
        {TOPIC_STATUSES.map((status) => {
          // todo shows the queue: the top card is handed to the chat next
          const topics =
            status === "todo"
              ? todoOrder(index.topicsByStatus(status))
              : index.topicsByStatus(status);
          const cards = topics.map((t) => <TopicCard t={t} index={index} now={now} base={base} />);
          return (
            <section id={`col-${status}`} class={`column ${status}`} data-status={status}>
              {COLLAPSED.includes(status) ? (
                <details data-key={`column:${status}`}>
                  <summary>
                    <h2>
                      {status} <span class="count">{topics.length}</span>
                    </h2>
                  </summary>
                  {cards}
                </details>
              ) : (
                <>
                  <h2>
                    {status} <span class="count">{topics.length}</span>
                  </h2>
                  {cards}
                </>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
