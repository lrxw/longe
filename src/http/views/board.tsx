import { TOPIC_STATUSES, type TopicStatus } from "../../domain/types.js";
import type { AiIndex, IndexedTopic } from "../../index/index.js";
import { ago, lastLine } from "../format.js";
import { ErrorList } from "./layout.js";

export function TopicCard({ t, index, now }: { t: IndexedTopic; index: AiIndex; now: Date }) {
  const open = index.openQuestionCount(t.id);
  const blocking = index.openBlockingCount(t.id);
  const last = lastLine(t.sections.Log);
  return (
    <a class="card topic" href={`/topics/${t.id}`}>
      <strong>{t.fm.title}</strong>
      <span class="meta">
        {ago(t.fm.updated, now)} ago
        {open > 0 ? <span class={`tag ${blocking > 0 ? "block" : ""}`}>{open} open</span> : null}
      </span>
      {last ? <span class="last">{last}</span> : null}
    </a>
  );
}

const COLLAPSED: readonly TopicStatus[] = ["done", "cancelled"];

export function BoardFragment({ index, now }: { index: AiIndex; now: Date }) {
  return (
    <div id="board" hx-get="/fragments/board" hx-trigger="sse:changed" hx-swap="outerHTML">
      <ErrorList errors={[...index.errors.values()]} />
      <div class="columns">
        {TOPIC_STATUSES.map((status) => {
          const topics = index.topicsByStatus(status);
          const cards = topics.map((t) => <TopicCard t={t} index={index} now={now} />);
          return (
            <section class={`column ${status}`}>
              {COLLAPSED.includes(status) ? (
                <details>
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
