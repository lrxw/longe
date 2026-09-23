import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { CONTINUE_PROMPT, WORK_PROMPT } from "../app/agent.js";
import type { AppContext } from "../app/context.js";
import { Hub, type HubRepo } from "../app/hub.js";
import { createProject } from "../app/new-project.js";
import { DomainError } from "../domain/errors.js";
import { TOPIC_STATUSES, type TopicStatus } from "../domain/types.js";
import { answerQuestion, deleteQuestion, human, setTopicStatus } from "../tools/ops.js";
import { API_BASE, createApiApp, docsPage, openApiDocument } from "./api.js";
import { statusFor } from "./errors.js";
import { monogram, repoColor, repoColors } from "./identity.js";
import { mountMcp } from "./mcp.js";
import { vendorPath } from "./vendor.js";
import { AboutPage } from "./views/about.js";
import { AgentBadge, AgentPanel, AgentSection, TopicPrompt } from "./views/agent.js";
import { BoardBadge, type BoardCounts, InboxBadge, type InboxCounts } from "./views/badge.js";
import { BoardFragment } from "./views/board.js";
import { AnsweredStub, InboxFragment, type InboxItem, QuestionCard } from "./views/inbox.js";
import { Layout, type RepoNav, ReposNav } from "./views/layout.js";
import { NewProjectForm, OverviewStrip, type RepoOverview } from "./views/overview.js";
import { StatusActions, TopicFragment } from "./views/topic.js";

export const PUBLIC_DIR = path.resolve(import.meta.dirname, "../../public");

/** SSE "changed" events within this window go out as one (see /events). */
export const CHANGED_WINDOW_MS = 100;

export interface HttpOptions {
  /** Port the server listens on; only used for the OpenAPI `servers` entry. */
  port?: number;
  /** "New project" only creates folders in here (default: the home folder). */
  home?: string;
}

function nav(hub: Hub, r: HubRepo): RepoNav {
  // assigned over all repos, so no two share a color (up to the palette size)
  const colors = repoColors(
    hub.list().map((x) => ({ name: x.name, override: x.ctx?.config.color })),
  );
  return {
    name: r.name,
    title: r.title,
    base: hub.base(r.name),
    color: colors.get(r.name) ?? repoColor(r.name, r.ctx?.config.color),
    mono: monogram(r.title),
    blocking: r.ctx?.index.blockingCount() ?? 0,
    missing: r.missing,
  };
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
  ctx.agent.on("agent:changed", () =>
    hub.emit("changed", { repo: entry.name, kind: "agent", id: "" }),
  );
  return buildApp(hub, opts);
}

function buildApp(hub: Hub, opts: HttpOptions): Hono {
  const app = new Hono();
  const port = opts.port ?? 7311;
  const now = () => new Date();
  const repoNavs = () => hub.list().map((r) => nav(hub, r));
  // every repo's agent gets this server's MCP endpoint, also repos that appear later
  const wireAgents = () => {
    for (const r of hub.live())
      (r.ctx as AppContext).agent.mcpUrl = `http://127.0.0.1:${port}${hub.base(r.name)}/mcp`;
  };
  wireAgents();
  hub.on("changed", (e) => {
    if (e.kind === "repos") wireAgents();
  });

  // Pages must not be served from the browser's HTTP cache on back/forward navigation
  // (browsers reuse a stale copy there without asking), else the board you return to
  // still shows the topic where it was. Static files under /public set their own header.
  app.use("*", async (c, next) => {
    await next();
    const type = c.res.headers.get("content-type") ?? "";
    if (type.startsWith("text/html")) c.res.headers.set("cache-control", "no-store");
  });

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

  // htmx, its SSE extension and idiomorph, from node_modules (see vendor.ts)
  app.get("/vendor/:name", async (c) => {
    try {
      const file = await vendorPath(c.req.param("name"));
      if (!file) return c.text("not found", 404);
      return c.body(await readFile(file), 200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-cache",
      });
    } catch (err) {
      return c.text(err instanceof Error ? err.message : String(err), 500);
    }
  });

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
          : file.endsWith(".svg")
            ? "image/svg+xml"
            : file.endsWith(".html")
              ? "text/html"
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
  const overview = (): RepoOverview[] =>
    hub.list().map((r) => {
      const counts: Record<string, number> = {};
      let blocking = 0;
      let open = 0;
      if (r.ctx) {
        for (const t of r.ctx.index.topics.values())
          counts[t.fm.status] = (counts[t.fm.status] ?? 0) + 1;
        blocking = r.ctx.index.blockingCount();
        open = r.ctx.index.inbox().length;
      }
      return { nav: nav(hub, r), counts, blocking, open };
    });
  /** The one inbox: everything waiting on you, across repos. */
  const inboxFragment = () => (
    <InboxFragment
      items={inboxItems()}
      now={now()}
      errors={inboxErrors()}
      hooks={inboxHooks()}
      missing={inboxMissing()}
      overview={hub.mode === "hub" ? <OverviewStrip repos={overview()} /> : null}
    />
  );
  const projectLabel = () =>
    hub.mode === "single" ? (hub.single()?.title ?? "") : `${hub.live().length} repos`;
  /** Hub mode: the switcher lists every repo. Single mode: no switcher. */
  const switcher = () => (hub.mode === "hub" ? repoNavs() : undefined);
  /** Numbers behind the Inbox badge (and the title prefix). */
  const inboxCounts = (): InboxCounts => ({
    blocking: hub.blockingCount(),
    open: hub.openCount(),
  });
  /** Numbers behind a repo's Board badge. */
  const boardCounts = (ctx: AppContext): BoardCounts => ({
    active: ctx.index.topicsByStatus("active").length,
    needsDecision: ctx.index.topicsByStatus("needs-decision").length,
    review: ctx.index.topicsByStatus("review").length,
  });
  /** Single mode: the one repo's board is in the header, also on the inbox page. */
  const singleBoard = (): BoardCounts | undefined => {
    const r = hub.mode === "single" ? hub.single() : undefined;
    return r?.ctx ? boardCounts(r.ctx) : undefined;
  };

  // ---- last visited repo (hub mode): drives `/board` and the `b` key on the home ---
  const LAST = "longe_repo";
  const remember = (c: Context, r: HubRepo) => {
    if (hub.mode === "hub")
      setCookie(c, LAST, r.name, { path: "/", sameSite: "Lax", maxAge: 60 * 60 * 24 * 365 });
  };
  const lastRepo = (c: Context): HubRepo | undefined => {
    const name = getCookie(c, LAST);
    const r = name ? hub.get(name) : undefined;
    return r?.ctx ? r : hub.live()[0];
  };

  app.get("/", (c) =>
    c.html(
      <Layout
        title="Inbox"
        project={projectLabel()}
        inbox={inboxCounts()}
        active="inbox"
        repos={switcher()}
        board={singleBoard()}
      >
        {inboxFragment()}
      </Layout>,
    ),
  );
  // ---- about: the big logo, version and links ---------------------------------
  let pkg: Promise<{ version?: string; description?: string; homepage?: string }> | undefined;
  app.get("/about", async (c) => {
    pkg ??= readFile(path.join(PUBLIC_DIR, "..", "package.json"), "utf8")
      .then((t) => JSON.parse(t) as { version?: string; description?: string; homepage?: string })
      .catch(() => ({}));
    const p = await pkg;
    return c.html(
      <Layout
        title="About"
        project={projectLabel()}
        inbox={inboxCounts()}
        active="about"
        repos={switcher()}
        board={singleBoard()}
      >
        <AboutPage
          version={p.version ?? "?"}
          description={p.description ?? "A local-first board for work done by AI coding agents."}
          homepage={p.homepage}
        />
      </Layout>,
    );
  });

  // ---- new project (hub mode): folder + .longe/ + registry, then its board ---------
  const home = opts.home ?? os.homedir();
  const newProjectPage = (
    c: Context,
    form: { path?: string; name?: string | undefined; error?: string } = {},
    status: 200 | 400 | 403 = 200,
  ) =>
    c.html(
      <Layout
        title="New project"
        project={projectLabel()}
        inbox={inboxCounts()}
        active="inbox"
        repos={switcher()}
      >
        <NewProjectForm home={home} {...form} />
      </Layout>,
      status,
    );
  if (hub.mode === "hub") {
    app.get("/repos/new", (c) => newProjectPage(c));
    app.post("/repos/new", async (c) => {
      const form = await c.req.parseBody();
      const values = { path: str(form.path) ?? "", name: str(form.name) };
      // any page open in the browser can post to 127.0.0.1: only accept our own
      const origin = c.req.header("origin");
      if (!origin || safeHost(origin) !== new URL(c.req.url).host)
        return newProjectPage(c, { ...values, error: "Refused: not sent from this page." }, 403);
      try {
        const { entry, repo } = await createProject(hub, values, home);
        if (repo?.missing) throw new Error(repo.missing);
        return c.redirect(`${hub.base(entry.name)}/board`, 303);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return newProjectPage(c, { ...values, error: msg }, 400);
      }
    });
  }

  app.get("/fragments/inbox", (c) => c.html(inboxFragment()));
  app.get("/fragments/inbox-badge", (c) => c.html(<InboxBadge counts={inboxCounts()} />));
  app.get("/fragments/repos", (c) =>
    c.html(<ReposNav repos={repoNavs()} current={c.req.query("current")} />),
  );

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
      remember(c, w.repo);
      return c.html(
        <Layout
          title={`Board · ${w.repo.title}`}
          project={w.repo.title}
          inbox={inboxCounts()}
          active="board"
          repos={switcher()}
          current={w.view}
          board={boardCounts(w.ctx)}
          agent={w.ctx.agent.status()}
        >
          <BoardFragment index={w.ctx.index} now={now()} base={w.view.base} />
        </Layout>,
      );
    });
    // the repo's one conversation with the agent
    r.get("/chat", async (c) => {
      const w = withRepo(c);
      if (isResponse(w)) return w;
      remember(c, w.repo);
      const status = w.ctx.agent.status();
      return c.html(
        <Layout
          title={`Chat · ${w.repo.title}`}
          project={w.repo.title}
          inbox={inboxCounts()}
          active="chat"
          repos={switcher()}
          current={w.view}
          board={boardCounts(w.ctx)}
          agent={status}
        >
          <AgentSection
            status={status}
            messages={await w.ctx.agent.messages()}
            base={w.view.base}
            now={now()}
          />
        </Layout>,
      );
    });
    r.get("/fragments/board", (c) => {
      const w = withRepo(c);
      if (isResponse(w)) return w;
      return c.html(<BoardFragment index={w.ctx.index} now={now()} base={w.view.base} />);
    });
    r.get("/fragments/board-badge", (c) => {
      const w = withRepo(c);
      if (isResponse(w)) return w;
      return c.html(<BoardBadge counts={boardCounts(w.ctx)} base={w.view.base} />);
    });
    r.get("/topics/:id", (c) => {
      const w = withRepo(c);
      if (isResponse(w)) return w;
      const t = w.ctx.index.topics.get(c.req.param("id"));
      if (!t) return c.text("topic not found", 404);
      remember(c, w.repo);
      return c.html(
        <Layout
          title={t.fm.title}
          project={w.repo.title}
          inbox={inboxCounts()}
          active="topic"
          repos={switcher()}
          current={w.view}
          board={boardCounts(w.ctx)}
          agent={w.ctx.agent.status()}
        >
          <TopicFragment t={t} index={w.ctx.index} now={now()} repo={w.view} />
          <TopicPrompt base={w.view.base} topicId={t.id} title={t.fm.title} />
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
    // the card is replaced by nothing: the question is gone
    r.post("/questions/:id/delete", async (c) => {
      const w = withRepo(c);
      if (isResponse(w)) return w;
      try {
        await deleteQuestion(w.ctx, c.req.param("id"));
        return c.html("");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.html(<p class="error">{msg}</p>, statusFor(err) as 400);
      }
    });

    // archive or delete every done and cancelled topic, with its questions
    // the human adds a topic without the chat; the board comes back with it
    r.post("/topics/new", async (c) => {
      const w = withRepo(c);
      if (isResponse(w)) return w;
      const form = await c.req.parseBody();
      try {
        await human.addTopic(w.ctx, {
          title: str(form.title) ?? "",
          goal: str(form.goal),
          status: str(form.status) === "todo" ? "todo" : "backlog",
        });
        return c.html(<BoardFragment index={w.ctx.index} now={now()} base={w.view.base} />);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.html(
          <BoardFragment index={w.ctx.index} now={now()} base={w.view.base} error={msg} />,
          statusFor(err) as 400,
        );
      }
    });

    // drag within the Todo column: the new order, top to bottom
    r.post("/topics/order", async (c) => {
      const w = withRepo(c);
      if (isResponse(w)) return w;
      const ids = (str((await c.req.parseBody()).ids) ?? "").split(",").filter(Boolean);
      await human.reorderTodo(w.ctx, ids);
      return c.html(<BoardFragment index={w.ctx.index} now={now()} base={w.view.base} />);
    });

    r.post("/board/cleanup", async (c) => {
      const w = withRepo(c);
      if (isResponse(w)) return w;
      const mode = str((await c.req.parseBody()).mode);
      if (mode !== "archive" && mode !== "delete") return c.text(`unknown mode ${mode}`, 400);
      await human.cleanup(w.ctx, mode);
      return c.html(<BoardFragment index={w.ctx.index} now={now()} base={w.view.base} />);
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
        const from = w.ctx.index.topics.get(id)?.fm.status;
        if (to === "done") await human.approve(w.ctx, id);
        else if (to === "cancelled") await human.cancel(w.ctx, id, note);
        else await setTopicStatus(w.ctx, id, to, "human", note);
        const t = w.ctx.index.topics.get(id);
        if (!t) return c.html(<p class="error">Topic was removed.</p>, 404);
        // pick up, reject or reopen: the human wants work on it now, so wake the chat
        if (to === "active" && from && from !== "active") {
          void w.ctx.agent.notifyActivated({ id, title: t.fm.title, from, note });
        }
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

    // ---- the chat: messages in, live transcript out, stop, reset, badge ---------
    const panel = async (w: { ctx: AppContext; view: RepoNav }, error?: string) => (
      <AgentPanel
        status={w.ctx.agent.status()}
        messages={await w.ctx.agent.messages()}
        base={w.view.base}
        now={now()}
        error={error}
      />
    );
    r.get("/fragments/agent", async (c) => {
      const w = withRepo(c);
      if (isResponse(w)) return w;
      return c.html(await panel(w));
    });
    r.get("/fragments/agent-badge", (c) => {
      const w = withRepo(c);
      if (isResponse(w)) return w;
      return c.html(<AgentBadge status={w.ctx.agent.status()} base={w.view.base} />);
    });
    // for autocomplete in the prompt boxes; internal names (`__x`) are left out
    r.get("/agent/commands", (c) => {
      const w = withRepo(c);
      if (isResponse(w)) return w;
      const all = w.ctx.agent.status().slashCommands ?? [];
      return c.json(all.filter((n) => !n.startsWith("_")));
    });
    r.post("/agent/prompt", async (c) => {
      const w = withRepo(c);
      if (isResponse(w)) return w;
      const form = await c.req.parseBody();
      const prompt = str(form.prompt)?.trim();
      const topicId = str(form.topic)?.trim();
      const topic = topicId ? w.ctx.index.topics.get(topicId) : undefined;
      if (!prompt) return c.html(await panel(w, "Message is empty."), 400);
      if (topicId && !topic) return c.html(await panel(w, `unknown topic ${topicId}`), 404);
      await w.ctx.agent.say("human", prompt, {
        topic: topic ? { id: topic.id, title: topic.fm.title } : undefined,
      });
      // a plain form post (topic page) lands on the chat; htmx gets the panel
      if (!c.req.header("hx-request")) return c.redirect(`${w.view.base}/chat`, 303);
      return c.html(await panel(w));
    });
    r.post("/agent/continue", async (c) => {
      const w = withRepo(c);
      if (isResponse(w)) return w;
      await w.ctx.agent.say("human", CONTINUE_PROMPT);
      return c.html(await panel(w));
    });
    r.post("/agent/work", async (c) => {
      const w = withRepo(c);
      if (isResponse(w)) return w;
      await w.ctx.agent.say("human", WORK_PROMPT);
      return c.html(await panel(w));
    });
    r.post("/agent/model", async (c) => {
      const w = withRepo(c);
      if (isResponse(w)) return w;
      const form = await c.req.parseBody();
      await w.ctx.agent.setModel(str(form.model));
      return c.html(await panel(w));
    });
    r.post("/agent/stop", async (c) => {
      const w = withRepo(c);
      if (isResponse(w)) return w;
      w.ctx.agent.stop();
      return c.html(await panel(w));
    });
    r.post("/agent/reset", async (c) => {
      const w = withRepo(c);
      if (isResponse(w)) return w;
      await w.ctx.agent.reset();
      return c.html(await panel(w));
    });
    r.post("/agent/clear", async (c) => {
      const w = withRepo(c);
      if (isResponse(w)) return w;
      await w.ctx.agent.clearHistory();
      return c.html(await panel(w));
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
    // hub mode: unscoped agent surfaces need a `repo` field; /board and /chat (the "b" and
    // "c" keys on the inbox, which belongs to no repo) go to the last visited repo
    // (cookie), else the first one
    for (const page of ["board", "chat"]) {
      app.get(`/${page}`, (c) => {
        const r = lastRepo(c);
        return r ? c.redirect(`${hub.base(r.name)}/${page}`) : c.text("no repos registered", 404);
      });
    }
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
      // "changed" makes every open page fetch a fresh fragment. A burst (a cleanup that
      // moves 40 files, an agent writing several) is sent as one event per window, so
      // pages do not fetch dozens of in-between states whose late answers overwrite the
      // final one. Every change still leads to an event at or after it.
      let changedData: string | undefined;
      let changedTimer: NodeJS.Timeout | undefined;
      const flushChanged = () => {
        changedTimer = undefined;
        const data = changedData ?? "";
        changedData = undefined;
        void send("changed", data);
      };
      const onChange = (e: { repo: string; kind: string; id: string }) => {
        // agent output streams often; it only refreshes agent panels. The files the
        // agent changes reach the pages through the index watcher as usual.
        void send(`${e.kind}-changed`, JSON.stringify(e));
        if (e.kind === "agent") return;
        // one change names its card (the page flashes it); several name none
        const key = `${e.repo}:${e.id}`;
        changedData = changedData === undefined || changedData === key ? key : `${e.repo}:`;
        changedTimer ??= setTimeout(flushChanged, CHANGED_WINDOW_MS);
      };
      hub.on("changed", onChange);
      stream.onAbort(() => {
        hub.off("changed", onChange);
        if (changedTimer) clearTimeout(changedTimer);
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

/** `host[:port]` of an Origin header; undefined when it does not parse. */
function safeHost(origin: string): string | undefined {
  try {
    return new URL(origin).host;
  } catch {
    return undefined;
  }
}
