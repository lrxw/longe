import { readFile } from "node:fs/promises";
import path from "node:path";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppContext } from "../app/context.js";
import { Hub, type HubRepo } from "../app/hub.js";
import { DomainError } from "../domain/errors.js";
import { TOPIC_STATUSES, type TopicStatus } from "../domain/types.js";
import { answerQuestion, human, setTopicStatus } from "../tools/ops.js";
import { API_BASE, createApiApp, docsPage, openApiDocument } from "./api.js";
import { statusFor } from "./errors.js";
import { mountMcp } from "./mcp.js";
import { BoardFragment } from "./views/board.js";
import { AnsweredStub, InboxFragment, type InboxItem, QuestionCard } from "./views/inbox.js";
import { Badge, Layout, type RepoNav } from "./views/layout.js";
import { StatusActions, TopicFragment } from "./views/topic.js";

export const PUBLIC_DIR = path.resolve(import.meta.dirname, "../../public");

export interface HttpOptions {
  /** Port the server listens on; only used for the OpenAPI `servers` entry. */
  port?: number;
}

function nav(hub: Hub, r: HubRepo): RepoNav {
  return { name: r.name, title: r.title, base: hub.base(r.name), missing: r.missing };
}

/** Accepts a single AppContext (tests, embedding) or a Hub. */
export function createHttpApp(target: AppContext | Hub, opts: HttpOptions = {}): Hono {
  if (target instanceof Hub) return buildApp(target, opts);
  const hub = new Hub("single");
  const ctx = target;
  const entry: HubRepo = {
    name: path.basename(ctx.root) || "repo",
    root: ctx.root,
    title: ctx.config.project ?? path.basename(ctx.root),
    ctx,
  };
  hub.repos.set(entry.name, entry);
  const fwd = (kind: "topic" | "question" | "error") => (e: { id?: string; file?: string }) =>
    hub.emit("changed", { repo: entry.name, kind, id: e.id ?? e.file ?? "" });
  ctx.index.on("topic:changed", fwd("topic"));
  ctx.index.on("question:changed", fwd("question"));
  ctx.index.on("error:changed", fwd("error"));
  ctx.hooks.on("hook:changed", () =>
    hub.emit("changed", { repo: entry.name, kind: "hook", id: "" }),
  );
  return buildApp(hub, opts);
}

function buildApp(hub: Hub, opts: HttpOptions): Hono {
  const app = new Hono();
  const port = opts.port ?? 7311;
  const now = () => new Date();
  const repoNavs = () => hub.list().map((r) => nav(hub, r));

  app.get("/health", (c) =>
    c.json({
      ok: true,
      root: hub.mode === "single" ? (hub.single()?.root ?? "") : "*",
      project: hub.mode === "single" ? (hub.single()?.title ?? "") : "hub",
      pid: process.pid,
      port,
      repos: hub.list().map((r) => ({ name: r.name, root: r.root, missing: r.missing ?? null })),
    }),
  );

  app.get("/public/*", async (c) => {
    const rel = c.req.path.replace(/^\/public\//, "");
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(`${PUBLIC_DIR}${path.sep}`)) return c.text("forbidden", 403);
    try {
      const body = await readFile(file);
      const type = file.endsWith(".css")
        ? "text/css"
        : file.endsWith(".js")
          ? "text/javascript"
          : "application/octet-stream";
      return c.body(body, 200, {
        "content-type": `${type}; charset=utf-8`,
        "cache-control": "no-cache",
      });
    } catch {
      return c.text("not found", 404);
    }
  });

  // ---- inbox: always merged across repos --------------------------------------
  const inboxItems = (): InboxItem[] => {
    const live = hub.live();
    const showRepo = live.length > 1;
    const items = live.flatMap((r) =>
      (r.ctx as AppContext).index.inbox().map((q) => ({ q, repo: nav(hub, r), showRepo })),
    );
    return items.sort((a, b) => {
      if (a.q.fm.blocking !== b.q.fm.blocking) return a.q.fm.blocking ? -1 : 1;
      return a.q.fm.asked_at.localeCompare(b.q.fm.asked_at) || a.q.id.localeCompare(b.q.id);
    });
  };
  const inboxErrors = (): { file: string; message: string; repo?: string }[] =>
    hub
      .live()
      .flatMap((r) =>
        [...(r.ctx as AppContext).index.errors.values()].map((e) =>
          hub.mode === "hub"
            ? { file: e.file, message: e.message, repo: r.title }
            : { file: e.file, message: e.message },
        ),
      );
  const inboxHooks = () =>
    hub
      .live()
      .filter((r) => (r.ctx as AppContext).hooks.status().configured.length > 0)
      .map((r) => ({
        label: hub.mode === "hub" ? r.title : undefined,
        status: (r.ctx as AppContext).hooks.status(),
      }));
  const inboxMissing = () =>
    hub
      .list()
      .filter((r) => r.missing)
      .map((r) => nav(hub, r));
  const inboxFragment = () => (
    <InboxFragment
      items={inboxItems()}
      now={now()}
      errors={inboxErrors()}
      hooks={inboxHooks()}
      missing={inboxMissing()}
    />
  );
  const projectLabel = () =>
    hub.mode === "single" ? (hub.single()?.title ?? "") : `${hub.live().length} repos`;

  app.get("/", (c) =>
    c.html(
      <Layout
        title="Inbox"
        project={projectLabel()}
        blocking={hub.blockingCount()}
        active="inbox"
        repos={repoNavs()}
        base={hub.mode === "single" ? "" : hub.live()[0] ? hub.base(hub.live()[0]?.name ?? "") : ""}
      >
        {inboxFragment()}
      </Layout>,
    ),
  );
  app.get("/fragments/inbox", (c) => c.html(inboxFragment()));
  app.get("/fragments/badge", (c) => c.html(<Badge blocking={hub.blockingCount()} />));

  // ---- per-repo routes ---------------------------------------------------------
  // Mounted twice: under /r/:repo (always) and at the root (single mode only).
  const repoApp = (
    resolve: (c: { req: { param: (k: string) => string | undefined } }) => HubRepo | undefined,
  ) => {
    const r = new Hono();
    const withRepo = (c: Context): { repo: HubRepo; ctx: AppContext; view: RepoNav } | Response => {
      const repo = resolve(c);
      if (!repo) return c.text("unknown repo", 404);
      if (!repo.ctx) return c.text(`repo unavailable: ${repo.missing}`, 503);
      return { repo, ctx: repo.ctx, view: nav(hub, repo) };
    };
    const isResponse = (x: unknown): x is Response => x instanceof Response;

    r.get("/board", (c) => {
      const w = withRepo(c);
      if (isResponse(w)) return w;
      return c.html(
        <Layout
          title={`Board · ${w.repo.title}`}
          project={w.repo.title}
          blocking={hub.blockingCount()}
          active="board"
          repos={repoNavs()}
          current={w.view}
          base={w.view.base}
        >
          <BoardFragment index={w.ctx.index} now={now()} base={w.view.base} />
        </Layout>,
      );
    });
    r.get("/fragments/board", (c) => {
      const w = withRepo(c);
      if (isResponse(w)) return w;
      return c.html(<BoardFragment index={w.ctx.index} now={now()} base={w.view.base} />);
    });
    r.get("/topics/:id", (c) => {
      const w = withRepo(c);
      if (isResponse(w)) return w;
      const t = w.ctx.index.topics.get(c.req.param("id"));
      if (!t) return c.text("topic not found", 404);
      return c.html(
        <Layout
          title={t.fm.title}
          project={w.repo.title}
          blocking={hub.blockingCount()}
          active="topic"
          repos={repoNavs()}
          current={w.view}
          base={w.view.base}
        >
          <TopicFragment t={t} index={w.ctx.index} now={now()} repo={w.view} />
        </Layout>,
      );
    });
    r.get("/fragments/topics/:id", (c) => {
      const w = withRepo(c);
      if (isResponse(w)) return w;
      const t = w.ctx.index.topics.get(c.req.param("id"));
      if (!t) return c.html(<p class="error">Topic was removed.</p>, 404);
      return c.html(<TopicFragment t={t} index={w.ctx.index} now={now()} repo={w.view} />);
    });

    r.post("/questions/:id/answer", async (c) => {
      const w = withRepo(c);
      if (isResponse(w)) return w;
      const id = c.req.param("id");
      const form = await c.req.parseBody();
      const optionRaw = str(form.option_index);
      const input = {
        answer: str(form.answer),
        option_index: optionRaw !== undefined && optionRaw !== "" ? Number(optionRaw) : undefined,
        note: str(form.note),
      };
      try {
        await answerQuestion(w.ctx, id, input);
        const q = w.ctx.index.questions.get(id);
        return c.html(q ? <AnsweredStub q={q} /> : <p class="ok">Answered.</p>);
      } catch (err) {
        const q = w.ctx.index.questions.get(id);
        const msg = err instanceof Error ? err.message : String(err);
        return c.html(
          <>
            {q ? (
              <QuestionCard q={q} repo={w.view} showRepo={hub.live().length > 1} now={now()} />
            ) : null}
            <p class="error">{msg}</p>
          </>,
          statusFor(err) as 400,
        );
      }
    });

    r.post("/topics/:id/status", async (c) => {
      const w = withRepo(c);
      if (isResponse(w)) return w;
      const id = c.req.param("id");
      const form = await c.req.parseBody();
      const to = str(form.status) as TopicStatus;
      const note = str(form.note);
      try {
        if (!TOPIC_STATUSES.includes(to))
          throw new DomainError("validation", `unknown status ${to}`);
        if (to === "done") await human.approve(w.ctx, id);
        else if (to === "cancelled") await human.cancel(w.ctx, id, note);
        else await setTopicStatus(w.ctx, id, to, "human", note);
        const t = w.ctx.index.topics.get(id);
        if (!t) return c.html(<p class="error">Topic was removed.</p>, 404);
        return c.html(<StatusActions t={t} base={w.view.base} />);
      } catch (err) {
        const t = w.ctx.index.topics.get(id);
        const msg = err instanceof Error ? err.message : String(err);
        if (!t) return c.html(<p class="error">{msg}</p>, 404);
        return c.html(
          <StatusActions t={t} base={w.view.base} error={msg} />,
          statusFor(err) as 400,
        );
      }
    });

    // agent surfaces, scoped to this repo
    r.route(
      API_BASE,
      createApiApp((c) => {
        const repo = resolve(c);
        if (!repo?.ctx)
          throw new DomainError(
            "not_found",
            repo ? `repo unavailable: ${repo.missing}` : "unknown repo",
          );
        return repo.ctx;
      }),
    );
    mountMcp(r, (c) => resolve(c)?.ctx, "/mcp");
    return r;
  };

  app.route(
    "/r/:repo",
    repoApp((c) => hub.get(c.req.param("repo") ?? "")),
  );
  if (hub.mode === "single") {
    app.route(
      "/",
      repoApp(() => hub.single()),
    );
  } else {
    // hub mode: unscoped agent surfaces need a `repo` field; /board goes to the first repo
    app.get("/board", (c) => {
      const first = hub.live()[0];
      return first
        ? c.redirect(`${hub.base(first.name)}/board`)
        : c.text("no repos registered", 404);
    });
    app.route(
      API_BASE,
      createApiApp(
        (c) => {
          const name = c.req.query("repo") ?? c.get("repo");
          const repo = name ? hub.get(name) : undefined;
          if (!repo?.ctx) {
            throw new DomainError(
              "validation",
              `hub mode: pass "repo" (one of: ${
                hub
                  .live()
                  .map((r) => r.name)
                  .join(", ") || "none"
              }) or use /r/<name>/api/v1/...`,
            );
          }
          return repo.ctx;
        },
        { hub },
      ),
    );
    mountMcp(app, undefined, "/mcp", hub);
  }

  app.get("/openapi.json", (c) => c.json(openApiDocument(port, hub.mode === "hub")));
  app.get("/api/docs", (c) => c.html(docsPage(port, hub.mode === "hub")));

  // ---- SSE: one stream for everything ---------------------------------------
  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      let seq = 0;
      const send = (event: string, data: string) =>
        stream.writeSSE({ event, data, id: String(seq++) });
      const onChange = (e: { repo: string; kind: string; id: string }) => {
        void send(`${e.kind}-changed`, JSON.stringify(e)).then(() =>
          send("changed", `${e.repo}:${e.id}`),
        );
      };
      hub.on("changed", onChange);
      stream.onAbort(() => {
        hub.off("changed", onChange);
      });
      await send("hello", "longe");
      while (!stream.aborted) {
        await stream.sleep(15000);
        if (!stream.aborted) await stream.writeSSE({ event: "ping", data: "" });
      }
    }),
  );

  return app;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
