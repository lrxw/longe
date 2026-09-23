import type { Child } from "hono/jsx";
import type { AgentStatus } from "../../app/agent.js";
import { AgentBadge } from "./agent.js";
import { BoardBadge, type BoardCounts, InboxBadge, type InboxCounts } from "./badge.js";

export interface RepoNav {
  name: string;
  title: string;
  base: string;
  /** Visual identity, the same on every surface. */
  color: string;
  mono: string;
  /** Open blocking questions (switcher badge). */
  blocking?: number | undefined;
  missing?: string | undefined;
}

/** The repo's avatar: monogram on its color. Links to the board when `href` is given. */
export function Avatar({ repo, href }: { repo: RepoNav; href?: string | undefined }) {
  const style = `--repo:${repo.color}`;
  const cls = `avatar ${repo.missing ? "missing" : ""}`;
  return href ? (
    <a class={cls} style={style} href={href} title={repo.title}>
      {repo.mono}
    </a>
  ) : (
    <span class={cls} style={style} title={repo.title}>
      {repo.mono}
    </span>
  );
}

/**
 * Hub header: one entry per repo, its board link, with the open blocking count.
 * A live fragment: re-fetched on every change so the counts stay right.
 */
export function ReposNav({ repos, current }: { repos: RepoNav[]; current?: string | undefined }) {
  const src = `/fragments/repos${current ? `?current=${encodeURIComponent(current)}` : ""}`;
  return (
    <nav
      id="repos"
      class="repos"
      aria-label="Boards"
      hx-get={src}
      hx-trigger="sse:changed"
      hx-swap="outerHTML"
    >
      {repos.map((r, i) => (
        <a
          href={r.missing ? "/" : `${r.base}/board`}
          class={`${current === r.name ? "on" : ""} ${r.missing ? "missing" : ""}`}
          title={r.missing ?? `${r.title} board`}
          data-n={i < 9 ? String(i + 1) : undefined}
          style={`--repo:${r.color}`}
        >
          <span class="avatar">{r.mono}</span>
          <span class="name">{r.title}</span>
          {r.blocking ? <span class="count">{r.blocking}</span> : null}
        </a>
      ))}
    </nav>
  );
}

export interface LayoutProps {
  title: string;
  project: string;
  /** Open questions across repos: title prefix and the Inbox badge. */
  inbox: InboxCounts;
  active: "inbox" | "board" | "topic" | "chat";
  /**
   * Hub mode: every registered repo, one avatar each in the header; each one is that
   * repo's board link. Undefined in single mode (a plain Board link instead).
   */
  repos?: RepoNav[] | undefined;
  /** The repo this page belongs to. Undefined on the inbox. */
  current?: RepoNav | undefined;
  /** The repo's topics by status, for the Board badge. Undefined on the hub inbox. */
  board?: BoardCounts | undefined;
  /** The repo's chat session, for the idle/working badge in the side menu. */
  agent?: AgentStatus | undefined;
  children?: Child;
}

/**
 * One inbox for everything that needs you, one board and one chat per repo. The
 * header is the same on every page: Inbox, then the repos. Inside a repo its
 * avatar is lit and a side menu switches between Board and Chat. Every menu link
 * carries a state badge: Inbox (questions), Board (topics), Chat (the agent).
 */
export function Layout({
  title,
  project,
  inbox,
  active,
  repos,
  current,
  board,
  agent,
  children,
}: LayoutProps) {
  const badge = inbox.blocking > 0 ? `(${inbox.blocking}) ` : "";
  const base = current?.base ?? "";
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${badge}${title} · longe`}</title>
        <link rel="icon" type="image/svg+xml" href="/public/logo/favicon.svg" />
        <link rel="stylesheet" href="/public/style.css" />
        <script src="/vendor/htmx.min.js"></script>
        <script src="/vendor/sse.js"></script>
        <script src="/vendor/idiomorph-ext.min.js"></script>
      </head>
      <body hx-ext="sse, morph" sse-connect="/events" data-page={active} data-base={base}>
        <header class="top">
          <a class="brand" href="/">
            <img src="/public/logo/wordmark.svg" alt="longe" height="22" />
          </a>
          <nav class="main">
            <a href="/" class={active === "inbox" ? "on" : ""}>
              Inbox
              <InboxBadge counts={inbox} />
            </a>
            {repos ? null : (
              <a href={`${base}/board`} class={active === "board" ? "on" : ""}>
                Board
                {board ? <BoardBadge counts={board} base={base} /> : null}
              </a>
            )}
          </nav>
          {repos ? (
            <ReposNav repos={repos} current={current?.name} />
          ) : (
            <span class="project">{project}</span>
          )}
        </header>
        <div class={current ? "shell" : "shell single"}>
          {current ? (
            <aside class="side">
              <nav aria-label={`${current.title} pages`}>
                <a
                  href={`${current.base}/board`}
                  class={active === "board" || active === "topic" ? "on" : ""}
                >
                  Board
                  {board ? <BoardBadge counts={board} base={current.base} /> : null}
                </a>
                <a href={`${current.base}/chat`} class={active === "chat" ? "on" : ""}>
                  Chat
                  {agent ? <AgentBadge status={agent} base={current.base} /> : null}
                </a>
              </nav>
            </aside>
          ) : null}
          <main>{children}</main>
        </div>
        <footer class="hints">
          <kbd>i</kbd> inbox · <kbd>b</kbd> board · <kbd>c</kbd> chat
          {repos ? (
            <>
              {" · "}
              <kbd>1</kbd>–<kbd>9</kbd> repo board
            </>
          ) : null}
          {active === "topic" ? (
            <>
              {" · "}
              <kbd>esc</kbd> back
            </>
          ) : null}
          {" · "}
          <kbd>/</kbd> prompt · <kbd>⌘↩</kbd> send
        </footer>
        <script src="/public/app.js"></script>
      </body>
    </html>
  );
}

export function ErrorList({
  errors,
}: {
  errors: { file: string; message: string; repo?: string }[];
}) {
  if (errors.length === 0) return null;
  return (
    <section class="errors">
      <h2>Malformed files</h2>
      <ul>
        {errors.map((e) => (
          <li>
            <code>
              {e.repo ? `${e.repo}: ` : ""}
              {e.file}
            </code>
            : {e.message}
          </li>
        ))}
      </ul>
    </section>
  );
}
