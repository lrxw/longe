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
        hx-confirm={`Archive ${what} with their questions? The files move to .ai/archive/.`}
        title="Move them and their questions to .ai/archive/; nothing is lost"
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

export function BoardFragment({ index, now, base }: { index: AiIndex; now: Date; base: string }) {
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
      <Cleanup count={finished} base={base} />
      <div class="columns">
        {TOPIC_STATUSES.map((status) => {
          const topics = index.topicsByStatus(status);
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
