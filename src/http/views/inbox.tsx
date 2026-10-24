import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import type { HookStatus } from "../../app/hooks.js";
import { subjectOf } from "../../inbox/subject.js";
import { INBOX_TOKENS, type InboxSource, toViewQuestion } from "../../inbox/view.js";
import type { IndexedQuestion } from "../../index/index.js";
import { ago, renderMarkdown } from "../format.js";
import { Avatar, ErrorList, type RepoNav } from "./layout.js";

export interface InboxItem {
  q: IndexedQuestion;
  repo: RepoNav;
  /** Show the repo tag (hub mode with several repos). */
  showRepo: boolean;
}

/**
 * The question as the inbox view model sees it (src/inbox/view.ts). The links are the
 * board's: a topic subject opens its topic page; any other subject its own `url`.
 */
export function inboxSource({ q, repo }: InboxItem): InboxSource {
  const subject = subjectOf(q.fm);
  return {
    id: q.id,
    repo: { name: repo.name, title: repo.title, color: repo.color },
    subject,
    links: {
      project: `${repo.base}/board`,
      subject:
        subject?.kind === "topic" ? `${repo.base}/topics/${subject.id}` : (subject?.url ?? null),
    },
    blocking: q.fm.blocking,
    askedBy: q.fm.asked_by,
    askedAt: q.fm.asked_at,
    question: q.sections.Question,
    context: q.sections.Context ?? "",
    assumption: q.fm.assumption,
    options: q.fm.options ?? [],
    approveOptions: q.fm.approve_options ?? [],
    rejectOptions: q.fm.reject_options ?? [],
  };
}

const { roles, text } = INBOX_TOKENS;

/** One question, drawn from the view model; the mod draws the same fields. */
export function QuestionCard({ q, repo, showRepo, now }: InboxItem & { now: Date }) {
  const v = toViewQuestion(inboxSource({ q, repo, showRepo }));
  const blocking = v.kind === "blocking";
  const base = repo.base;
  return (
    <article class={`card question ${blocking ? "blocking" : ""}`} id={`q-${q.id}`}>
      <header>
        <span class={`tag ${blocking ? "block" : "nonblocking"}`}>
          {roles[v.kind].icon} {roles[v.kind].label}
        </span>
        {showRepo ? (
          <a class="repo" href={v.links.board} style={`--repo:${v.color}`}>
            <Avatar repo={repo} />
            {v.project}
          </a>
        ) : null}
        {v.topic && v.links.topic ? (
          <a class="topic" href={v.links.topic}>
            {v.topic}
          </a>
        ) : (
          <span class="topic">{text.projectWide}</span>
        )}
        <span class="meta">
          {v.askedBy} · {ago(v.askedAt, now)} ago · <code>{v.id}</code>
        </span>
        <button
          type="button"
          class="delete small"
          hx-post={`${base}/questions/${q.id}/delete`}
          hx-target={`#q-${q.id}`}
          hx-swap="outerHTML"
          hx-confirm="Delete this question? The agent is not told."
          title="Delete this question (for test or junk questions)"
        >
          Delete
        </button>
      </header>
      <div class="body md">{raw(renderMarkdown(v.question))}</div>
      {v.context ? (
        // code is shown for the human to read: do not hide it behind a click
        <details data-key={`context:${v.id}`} open={v.contextOpen}>
          <summary>{text.context}</summary>
          <div class="md">{raw(renderMarkdown(v.context))}</div>
        </details>
      ) : null}
      {v.assumption ? (
        <p class="assumption">
          {text.workingOn} <em>{v.assumption}</em>
        </p>
      ) : null}
      <form
        class="answer"
        hx-post={`${base}/questions/${q.id}/answer`}
        hx-target={`#q-${q.id}`}
        hx-swap="outerHTML"
      >
        {v.options.length > 0 ? (
          <div class="options">
            {v.options.map((o) => (
              // a reject option sends the topic back from review to active; an approve
              // option moves it to done
              <button
                type="submit"
                name="option_index"
                value={String(o.index)}
                class={o.role === "neutral" ? undefined : o.role}
                title={
                  o.role === "reject"
                    ? "Rejects the work: the topic goes back to active"
                    : o.role === "approve"
                      ? "Approves the work: the topic moves to done"
                      : undefined
                }
              >
                {o.role === "neutral" ? "" : `${roles[o.role].icon} `}
                {o.label}
              </button>
            ))}
          </div>
        ) : null}
        <label for={`reply-${q.id}`}>{text.reply}</label>
        <div class="row">
          <textarea
            id={`reply-${q.id}`}
            name="reply"
            rows={2}
            placeholder="Your reply or details for an option…"
            aria-describedby={`reply-help-${q.id}`}
          />
          <button type="submit" class="primary">
            Send reply
          </button>
        </div>
        <p class="meta" id={`reply-help-${q.id}`}>
          {v.options.length > 0
            ? "Click an option to send it with your text, or Send reply to send just your text."
            : "Send your answer to the agent."}
          {v.review
            ? " A reply returns work in review to the agent for follow-up. Approval requires an approval option."
            : ""}
        </p>
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

/** What the inbox shows; lives in the URL (`/?repo=…`). */
export interface InboxFilter {
  repo?: string | undefined;
}

/** Reads the filter from query values; an unknown repo is ignored. */
export function parseInboxFilter(
  query: { repo?: string | undefined },
  repos: string[],
): InboxFilter {
  return { repo: query.repo && repos.includes(query.repo) ? query.repo : undefined };
}

/** `?repo=…`, or "" for no filter. */
export function inboxQuery(f: InboxFilter): string {
  return f.repo ? `?${new URLSearchParams({ repo: f.repo })}` : "";
}

export function filterInbox(items: InboxItem[], f: InboxFilter): InboxItem[] {
  return f.repo ? items.filter((i) => i.repo.name === f.repo) : items;
}

/**
 * One chip per project that has questions, with its count (red when one blocks), plus
 * "All". A chip is a link (`/?repo=…`, so a filter can be reloaded and bookmarked) that
 * htmx swaps in place; clicking the chosen chip again clears the filter. Several repos
 * only, and only while something waits.
 */
function ProjectChips({
  items,
  repos,
  filter,
}: {
  items: InboxItem[];
  repos: RepoNav[];
  filter: InboxFilter;
}) {
  if (repos.length < 2 || items.length === 0) return null;
  const counts = new Map<string, { open: number; blocking: number }>();
  for (const i of items) {
    const c = counts.get(i.repo.name) ?? { open: 0, blocking: 0 };
    c.open++;
    if (i.q.fm.blocking) c.blocking++;
    counts.set(i.repo.name, c);
  }
  const allBlocking = items.filter((i) => i.q.fm.blocking).length;
  const chip = (
    href: string,
    on: boolean,
    label: Child,
    n: number,
    blocking: number,
    style?: string,
  ) => (
    <a
      class={`chip${on ? " on" : ""}`}
      href={`/${href}`}
      hx-get={`/fragments/inbox${href}`}
      hx-target="#inbox"
      hx-swap="morph"
      hx-push-url={`/${href}`}
      aria-current={on ? "true" : undefined}
      style={style}
    >
      {label}
      <span
        class={`count${blocking > 0 ? " block" : ""}`}
        title={blocking > 0 ? `${blocking} blocking` : undefined}
      >
        {n}
      </span>
    </a>
  );
  return (
    <nav class="inbox-filter" aria-label="Filter by project">
      {chip("", !filter.repo, "All", items.length, allBlocking)}
      {repos
        .filter((r) => counts.has(r.name) || r.name === filter.repo)
        .map((r) => {
          const c = counts.get(r.name) ?? { open: 0, blocking: 0 };
          const on = filter.repo === r.name;
          return chip(
            on ? "" : inboxQuery({ repo: r.name }),
            on,
            <>
              <Avatar repo={r} />
              {r.title}
            </>,
            c.open,
            c.blocking,
            `--repo:${r.color}`,
          );
        })}
    </nav>
  );
}

/** Id of the most recently asked question. */
function newest(items: InboxItem[]): string {
  return items.reduce((a, b) => (b.q.fm.asked_at > a.q.fm.asked_at ? b : a)).q.id;
}

export function InboxFragment({
  items,
  now,
  errors,
  hooks,
  missing,
  overview,
  repos = [],
  filter = {},
}: {
  items: InboxItem[];
  now: Date;
  errors: { file: string; message: string; repo?: string }[];
  hooks: { label?: string | undefined; status: HookStatus }[];
  missing: RepoNav[];
  overview?: Child;
  /** The live repos, for the project chips. */
  repos?: RepoNav[];
  filter?: InboxFilter;
}) {
  const total = items.length;
  const shown = filterInbox(items, filter);
  const blocking = shown.filter((i) => i.q.fm.blocking);
  const other = shown.filter((i) => !i.q.fm.blocking);
  return (
    <div
      id="inbox"
      // a live refresh keeps the filter
      hx-get={`/fragments/inbox${inboxQuery(filter)}`}
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
      {total === 0 ? <p class="empty">{text.empty}</p> : null}
      <ProjectChips items={items} repos={repos} filter={filter} />
      {total > 0 && shown.length === 0 ? (
        <p class="empty">
          {text.emptyProject} <a href="/">Show all</a>
        </p>
      ) : null}
      {blocking.map((i) => (
        <QuestionCard {...i} now={now} />
      ))}
      {other.length > 0 ? (
        // closing the box only hides the questions there were at that moment: the key
        // names the newest one, so a new question gets a fresh key and the box opens
        <details
          class="nonblocking"
          data-key={`inbox:nonblocking:${newest(other)}`}
          data-default-open
          open
        >
          <summary>
            {roles.nonBlocking.icon} {other.length} {roles.nonBlocking.label}{" "}
            {other.length === 1 ? "question" : "questions"} (agent continues on its assumption)
          </summary>
          {other.map((i) => (
            <QuestionCard {...i} now={now} />
          ))}
        </details>
      ) : null}
    </div>
  );
}
