import { TOPIC_STATUSES, type TopicStatus } from "../../domain/types.js";
import type { AiIndex, IndexedTopic } from "../../index/index.js";
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
  return (
    <a class="card topic" href={`${base}/topics/${t.id}`}>
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

const COLLAPSED: readonly TopicStatus[] = ["done", "cancelled"];

export function BoardFragment({ index, now, base }: { index: AiIndex; now: Date; base: string }) {
  return (
    <div id="board" hx-get={`${base}/fragments/board`} hx-trigger="sse:changed" hx-swap="outerHTML">
      <ErrorList errors={[...index.errors.values()]} />
      <div class="columns">
        {TOPIC_STATUSES.map((status) => {
          const topics = index.topicsByStatus(status);
          const cards = topics.map((t) => <TopicCard t={t} index={index} now={now} base={base} />);
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
