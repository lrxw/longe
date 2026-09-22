import { raw } from "hono/html";
import type { HookStatus } from "../../app/hooks.js";
import type { IndexedQuestion } from "../../index/index.js";
import { ago, renderMarkdown } from "../format.js";
import { ErrorList } from "./layout.js";

export function QuestionCard({ q, now }: { q: IndexedQuestion; now: Date }) {
  const options = q.fm.options ?? [];
  return (
    <article class={`card question ${q.fm.blocking ? "blocking" : ""}`} id={`q-${q.id}`}>
      <header>
        {q.fm.blocking ? (
          <span class="tag block">blocking</span>
        ) : (
          <span class="tag">non-blocking</span>
        )}
        {q.fm.topic ? (
          <a class="topic" href={`/topics/${q.fm.topic}`}>
            {q.fm.topic}
          </a>
        ) : (
          <span class="topic">project-wide</span>
        )}
        <span class="meta">
          {q.fm.asked_by} · {ago(q.fm.asked_at, now)} ago · <code>{q.id}</code>
        </span>
      </header>
      <div class="body md">{raw(renderMarkdown(q.sections.Question))}</div>
      {q.sections.Context ? (
        <details>
          <summary>Context</summary>
          <div class="md">{raw(renderMarkdown(q.sections.Context))}</div>
        </details>
      ) : null}
      {q.fm.assumption ? (
        <p class="assumption">
          Assumption: <em>{q.fm.assumption}</em>
        </p>
      ) : null}
      <form
        class="answer"
        hx-post={`/questions/${q.id}/answer`}
        hx-target={`#q-${q.id}`}
        hx-swap="outerHTML"
      >
        {options.length > 0 ? (
          <div class="options">
            {options.map((o, i) => (
              <button type="submit" name="option_index" value={String(i)}>
                {o}
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          name="answer"
          rows={2}
          placeholder={options.length ? "Or answer in your own words…" : "Answer…"}
        />
        <div class="row">
          <input name="note" placeholder="Note (optional)" />
          <button type="submit" class="primary">
            Answer
          </button>
        </div>
      </form>
    </article>
  );
}

export function AnsweredStub({ q }: { q: IndexedQuestion }) {
  return (
    <article class="card question answered" id={`q-${q.id}`}>
      <header>
        <span class="tag ok">answered</span>
        <code>{q.id}</code>
      </header>
      <div class="body md">{raw(renderMarkdown(q.sections.Answer))}</div>
    </article>
  );
}

export function HookStatusLine({ hooks, now }: { hooks: HookStatus; now: Date }) {
  if (hooks.configured.length === 0) return null;
  const run = hooks.running ?? hooks.last;
  return (
    <p class="hookstatus meta">
      Agent hook <code>{hooks.configured.join(", ")}</code>:{" "}
      {hooks.running ? (
        <span class="tag block">running since {ago(hooks.running.startedAt, now)}</span>
      ) : run ? (
        <span class={`tag ${run.exitCode === 0 ? "ok" : "block"}`}>
          last run {ago(run.finishedAt ?? run.startedAt, now)} ago, exit {run.exitCode ?? "?"}
        </span>
      ) : (
        <span class="tag">idle</span>
      )}
      {hooks.queued > 0 ? <span class="tag">1 queued</span> : null}
      {" · "}
      log: <code>{hooks.logFile}</code>
    </p>
  );
}

export function InboxFragment({
  questions,
  now,
  errors,
  hooks,
}: {
  questions: IndexedQuestion[];
  now: Date;
  errors: { file: string; message: string }[];
  hooks: HookStatus;
}) {
  const blocking = questions.filter((q) => q.fm.blocking);
  const other = questions.filter((q) => !q.fm.blocking);
  return (
    <div id="inbox" hx-get="/fragments/inbox" hx-trigger="sse:changed" hx-swap="outerHTML">
      <ErrorList errors={errors} />
      <HookStatusLine hooks={hooks} now={now} />
      {questions.length === 0 ? <p class="empty">Nothing is waiting on you.</p> : null}
      {blocking.map((q) => (
        <QuestionCard q={q} now={now} />
      ))}
      {other.length > 0 ? (
        <details class="nonblocking" open={blocking.length === 0}>
          <summary>
            {other.length} non-blocking {other.length === 1 ? "question" : "questions"} (agent
            continues on its assumption)
          </summary>
          {other.map((q) => (
            <QuestionCard q={q} now={now} />
          ))}
        </details>
      ) : null}
    </div>
  );
}
