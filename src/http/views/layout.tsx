import type { Child } from "hono/jsx";

export interface LayoutProps {
  title: string;
  project: string;
  blocking: number;
  active: "inbox" | "board" | "topic";
  children?: Child;
}

export function Layout({ title, project, blocking, active, children }: LayoutProps) {
  const badge = blocking > 0 ? `(${blocking}) ` : "";
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${badge}${title} · longe`}</title>
        <link rel="stylesheet" href="/public/style.css" />
        <script src="/public/vendor/htmx.min.js"></script>
        <script src="/public/vendor/sse.js"></script>
      </head>
      <body hx-ext="sse" sse-connect="/events" data-page={active} data-back="/board">
        <header class="top">
          <a class="brand" href="/">
            <span id="badge" hx-get="/fragments/badge" hx-trigger="sse:changed" hx-swap="outerHTML">
              {badge}
            </span>
            longe
          </a>
          <span class="project">{project}</span>
          <nav>
            <a href="/" class={active === "inbox" ? "on" : ""}>
              Inbox
            </a>
            <a href="/board" class={active === "board" ? "on" : ""}>
              Board
            </a>
          </nav>
        </header>
        <main>{children}</main>
        <footer class="hints">
          <kbd>i</kbd> inbox · <kbd>b</kbd> board · <kbd>⌘↩</kbd> send
          {active === "topic" ? (
            <>
              {" · "}
              <kbd>esc</kbd> back
            </>
          ) : null}
        </footer>
        <script src="/public/app.js"></script>
      </body>
    </html>
  );
}

export function Badge({ blocking }: { blocking: number }) {
  return (
    <span id="badge" hx-get="/fragments/badge" hx-trigger="sse:changed" hx-swap="outerHTML">
      {blocking > 0 ? `(${blocking}) ` : ""}
    </span>
  );
}

export function ErrorList({ errors }: { errors: { file: string; message: string }[] }) {
  if (errors.length === 0) return null;
  return (
    <section class="errors">
      <h2>Malformed files</h2>
      <ul>
        {errors.map((e) => (
          <li>
            <code>{e.file}</code>: {e.message}
          </li>
        ))}
      </ul>
    </section>
  );
}
