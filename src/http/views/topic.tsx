import { raw } from "hono/html";
import { allowedTargets } from "../../domain/transitions.js";
import { ballHolder, QUESTION_STATUSES, type TopicStatus } from "../../domain/types.js";
import type { AiIndex, IndexedQuestion, IndexedTopic } from "../../index/index.js";
import { ago, renderMarkdown } from "../format.js";
import { AnsweredStub, QuestionCard } from "./inbox.js";

const LABELS: Record<TopicStatus, string> = {
  backlog: "Move to backlog",
  active: "Activate",
  "needs-decision": "Needs decision",
  review: "Send to review",
  done: "Approve",
  cancelled: "Cancel",
};

export function StatusActions({ t, error }: { t: IndexedTopic; error?: string | undefined }) {
  const targets = allowedTargets(t.fm.status, "human");
  const reject = t.fm.status === "review" && targets.includes("active");
  return (
    <div class="actions" id="actions">
      <span class={`status ${t.fm.status}`}>{t.fm.status}</span>
      <span class="meta">ball: {ballHolder(t.fm.status)}</span>
      {targets
        .filter((to) => !(reject && to === "active"))
        .map((to) => (
          <form hx-post={`/topics/${t.id}/status`} hx-target="#actions" hx-swap="outerHTML">
            <input type="hidden" name="status" value={to} />
            <button
              type="submit"
              class={to === "done" ? "primary" : to === "cancelled" ? "danger" : ""}
            >
              {t.fm.status === "done" || t.fm.status === "cancelled" ? "Reopen" : LABELS[to]}
            </button>
          </form>
        ))}
      {reject ? (
        <form
          hx-post={`/topics/${t.id}/status`}
          hx-target="#actions"
          hx-swap="outerHTML"
          class="reject"
        >
          <input type="hidden" name="status" value="active" />
          <input name="note" placeholder="Reason for rejecting (required)" required />
          <button type="submit" class="danger">
            Reject
          </button>
        </form>
      ) : null}
      {error ? <p class="error">{error}</p> : null}
    </div>
  );
}

function QuestionGroup({
  status,
  questions,
  now,
}: {
  status: string;
  questions: IndexedQuestion[];
  now: Date;
}) {
  if (questions.length === 0) return null;
  return (
    <details open={status === "open"}>
      <summary>
        {status} <span class="count">{questions.length}</span>
      </summary>
      {questions.map((q) =>
        status === "open" ? (
          <QuestionCard q={q} now={now} />
        ) : status === "answered" || status === "acknowledged" ? (
          <AnsweredStub q={q} />
        ) : (
          <article class="card question withdrawn">
            <header>
              <span class="tag">withdrawn</span>
              <code>{q.id}</code>
            </header>
            <div class="md">{raw(renderMarkdown(q.sections.Question))}</div>
            <div class="md muted">{raw(renderMarkdown(q.sections.Context))}</div>
          </article>
        ),
      )}
    </details>
  );
}

export function TopicFragment({ t, index, now }: { t: IndexedTopic; index: AiIndex; now: Date }) {
  const questions = index.questionsForTopic(t.id);
  return (
    <div
      id="topic"
      hx-get={`/fragments/topics/${t.id}`}
      hx-trigger="sse:changed"
      hx-swap="outerHTML"
    >
      <header class="topic-head">
        <h1>{t.fm.title}</h1>
        <p class="meta">
          <code>{t.id}</code> · created {ago(t.fm.created, now)} ago · updated{" "}
          {ago(t.fm.updated, now)} ago
          {t.fm.links.map((l) => (
            <>
              {" · "}
              <a href={l} rel="noopener">
                {l}
              </a>
            </>
          ))}
        </p>
        <StatusActions t={t} />
      </header>
      <div class="grid">
        <section class="md">
          <h2>Goal</h2>
          {raw(renderMarkdown(t.sections.Goal))}
          <h2>Plan</h2>
          {raw(renderMarkdown(t.sections.Plan))}
        </section>
        <section class="md">
          <h2>Decisions</h2>
          {raw(renderMarkdown(t.sections.Decisions || "_None yet._"))}
          <h2>Log</h2>
          {raw(renderMarkdown(t.sections.Log || "_Empty._"))}
        </section>
      </div>
      <section class="questions">
        <h2>Questions</h2>
        {questions.length === 0 ? <p class="empty">No questions on this topic.</p> : null}
        {QUESTION_STATUSES.map((s) => (
          <QuestionGroup
            status={s}
            questions={questions.filter((q) => q.fm.status === s)}
            now={now}
          />
        ))}
      </section>
    </div>
  );
}
