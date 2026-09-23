import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import type { HookStatus } from "../../app/hooks.js";
import type { IndexedQuestion } from "../../index/index.js";
import { ago, renderMarkdown } from "../format.js";
import { Avatar, ErrorList, type RepoNav } from "./layout.js";

export interface InboxItem {
  q: IndexedQuestion;
  repo: RepoNav;
  /** Show the repo tag (hub mode with several repos). */
  showRepo: boolean;
}

export function QuestionCard({ q, repo, showRepo, now }: InboxItem & { now: Date }) {
  const options = q.fm.options ?? [];
  const base = repo.base;
  return (
    <article class={`card question ${q.fm.blocking ? "blocking" : ""}`} id={`q-${q.id}`}>
      <header>
        {q.fm.blocking ? (
          <span class="tag block">blocking</span>
        ) : (
          <span class="tag">non-blocking</span>
        )}
        {showRepo ? (
          <a class="repo" href={`${base}/board`} style={`--repo:${repo.color}`}>
            <Avatar repo={repo} />
            {repo.title}
          </a>
        ) : null}
        {q.fm.topic ? (
          <a class="topic" href={`${base}/topics/${q.fm.topic}`}>
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
        // code is shown for the human to read: do not hide it behind a click
        <details data-key={`context:${q.id}`} open={q.sections.Context.includes("```")}>
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
        hx-post={`${base}/questions/${q.id}/answer`}
        hx-target={`#q-${q.id}`}
        hx-swap="outerHTML"
      >
        {options.length > 0 ? (
          <div class="options">
            {options.map((o, i) =>
              // a reject option sends the topic back from review to active
              q.fm.reject_options?.includes(o) ? (
                <button
                  type="submit"
                  name="option_index"
                  value={String(i)}
                  class="reject"
                  title="Rejects the work: the topic goes back to active"
                >
                  {o}
                </button>
              ) : (
                <button type="submit" name="option_index" value={String(i)}>
                  {o}
                </button>
              ),
            )}
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

export function HookStatusLine({
  hooks,
  label,
  now,
}: {
  hooks: HookStatus;
  label?: string | undefined;
  now: Date;
}) {
  if (hooks.configured.length === 0) return null;
  const run = hooks.running ?? hooks.last;
  return (
    <p class="hookstatus meta">
      {label ? <strong>{label} · </strong> : null}
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
  items,
  now,
  errors,
  hooks,
  missing,
  overview,
}: {
  items: InboxItem[];
  now: Date;
  errors: { file: string; message: string; repo?: string }[];
  hooks: { label?: string | undefined; status: HookStatus }[];
  missing: RepoNav[];
  overview?: Child;
}) {
  const blocking = items.filter((i) => i.q.fm.blocking);
  const other = items.filter((i) => !i.q.fm.blocking);
  return (
    <div
      id="inbox"
      hx-get="/fragments/inbox"
      hx-trigger="sse:changed"
      hx-sync="this:replace"
      hx-swap="morph"
    >
      {overview}
      <ErrorList errors={errors} />
      {missing.length > 0 ? (
        <section class="errors">
          <h2>Unavailable repos</h2>
          <ul>
            {missing.map((r) => (
              <li>
                <code>{r.name}</code>: {r.missing} — <code>longe repos remove &lt;path&gt;</code> to
                forget it
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {hooks.map((h) => (
        <HookStatusLine hooks={h.status} label={h.label} now={now} />
      ))}
      {items.length === 0 ? <p class="empty">Nothing is waiting on you.</p> : null}
      {blocking.map((i) => (
        <QuestionCard {...i} now={now} />
      ))}
      {other.length > 0 ? (
        <details class="nonblocking" data-key="inbox:nonblocking" open={blocking.length === 0}>
          <summary>
            {other.length} non-blocking {other.length === 1 ? "question" : "questions"} (agent
            continues on its assumption)
          </summary>
          {other.map((i) => (
            <QuestionCard {...i} now={now} />
          ))}
        </details>
      ) : null}
    </div>
  );
}
