import { readFile } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppContext } from "../app/context.js";
import { DomainError } from "../domain/errors.js";
import { TOPIC_STATUSES, type TopicStatus } from "../domain/types.js";
import { answerQuestion, human, setTopicStatus } from "../tools/ops.js";
import { API_BASE, createApiApp, docsPage, openApiDocument } from "./api.js";
import { statusFor } from "./errors.js";
import { mountMcp } from "./mcp.js";
import { BoardFragment } from "./views/board.js";
import { AnsweredStub, InboxFragment, QuestionCard } from "./views/inbox.js";
import { Badge, Layout } from "./views/layout.js";
import { StatusActions, TopicFragment } from "./views/topic.js";

export const PUBLIC_DIR = path.resolve(import.meta.dirname, "../../public");

export interface HttpOptions {
  /** Port the server listens on; only used for the OpenAPI `servers` entry. */
  port?: number;
}

export function createHttpApp(ctx: AppContext, opts: HttpOptions = {}): Hono {
  const app = new Hono();
  const port = opts.port ?? 7311;
  const project = () => ctx.config.project ?? path.basename(ctx.root);
  const errors = () => [...ctx.index.errors.values()];

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

  // ---- pages ---------------------------------------------------------------
  app.get("/", (c) =>
    c.html(
      <Layout title="Inbox" project={project()} blocking={ctx.index.blockingCount()} active="inbox">
        <InboxFragment questions={ctx.index.inbox()} now={ctx.now()} errors={errors()} />
      </Layout>,
    ),
  );

  app.get("/board", (c) =>
    c.html(
      <Layout title="Board" project={project()} blocking={ctx.index.blockingCount()} active="board">
        <BoardFragment index={ctx.index} now={ctx.now()} />
      </Layout>,
    ),
  );

  app.get("/topics/:id", (c) => {
    const t = ctx.index.topics.get(c.req.param("id"));
    if (!t) return c.text("topic not found", 404);
    return c.html(
      <Layout
        title={t.fm.title}
        project={project()}
        blocking={ctx.index.blockingCount()}
        active="topic"
      >
        <TopicFragment t={t} index={ctx.index} now={ctx.now()} />
      </Layout>,
    );
  });

  // ---- fragments (SSE-triggered refresh) -----------------------------------
  app.get("/fragments/badge", (c) => c.html(<Badge blocking={ctx.index.blockingCount()} />));
  app.get("/fragments/inbox", (c) =>
    c.html(<InboxFragment questions={ctx.index.inbox()} now={ctx.now()} errors={errors()} />),
  );
  app.get("/fragments/board", (c) => c.html(<BoardFragment index={ctx.index} now={ctx.now()} />));
  app.get("/fragments/topics/:id", (c) => {
    const t = ctx.index.topics.get(c.req.param("id"));
    if (!t) return c.html(<p class="error">Topic was removed.</p>, 404);
    return c.html(<TopicFragment t={t} index={ctx.index} now={ctx.now()} />);
  });

  // ---- actions (htmx forms; same handlers as REST) -------------------------
  app.post("/questions/:id/answer", async (c) => {
    const id = c.req.param("id");
    const form = await c.req.parseBody();
    const optionRaw = str(form.option_index);
    const input = {
      answer: str(form.answer),
      option_index: optionRaw !== undefined && optionRaw !== "" ? Number(optionRaw) : undefined,
      note: str(form.note),
    };
    try {
      await answerQuestion(ctx, id, input);
      const q = ctx.index.questions.get(id);
      return c.html(q ? <AnsweredStub q={q} /> : <p class="ok">Answered.</p>);
    } catch (err) {
      const q = ctx.index.questions.get(id);
      const msg = err instanceof Error ? err.message : String(err);
      return c.html(
        <>
          {q ? <QuestionCard q={q} now={ctx.now()} /> : null}
          <p class="error">{msg}</p>
        </>,
        statusFor(err) as 400,
      );
    }
  });

  app.post("/topics/:id/status", async (c) => {
    const id = c.req.param("id");
    const form = await c.req.parseBody();
    const to = str(form.status) as TopicStatus;
    const note = str(form.note);
    try {
      if (!TOPIC_STATUSES.includes(to)) throw new DomainError("validation", `unknown status ${to}`);
      if (to === "done") await human.approve(ctx, id);
      else if (to === "cancelled") await human.cancel(ctx, id, note);
      else await setTopicStatus(ctx, id, to, "human", note);
      const t = ctx.index.topics.get(id);
      if (!t) return c.html(<p class="error">Topic was removed.</p>, 404);
      return c.html(<StatusActions t={t} />);
    } catch (err) {
      const t = ctx.index.topics.get(id);
      const msg = err instanceof Error ? err.message : String(err);
      if (!t) return c.html(<p class="error">{msg}</p>, 404);
      return c.html(<StatusActions t={t} error={msg} />, statusFor(err) as 400);
    }
  });

  // ---- agent + REST surfaces ---------------------------------------------
  app.route(API_BASE, createApiApp(ctx));
  app.get("/openapi.json", (c) => c.json(openApiDocument(port)));
  app.get("/api/docs", (c) => c.html(docsPage(port)));
  mountMcp(app, ctx, "/mcp");

  // ---- SSE -----------------------------------------------------------------
  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      let seq = 0;
      const send = (event: string, data: string) =>
        stream.writeSSE({ event, data, id: String(seq++) });
      const onTopic = (ch: { id: string; type: string }) => {
        void send("topic-changed", JSON.stringify(ch)).then(() => send("changed", ch.id));
      };
      const onQuestion = (ch: { id: string; type: string }) => {
        void send("question-changed", JSON.stringify(ch)).then(() => send("changed", ch.id));
      };
      const onError = (ch: { file: string }) => {
        void send("changed", ch.file);
      };
      ctx.index.on("topic:changed", onTopic);
      ctx.index.on("question:changed", onQuestion);
      ctx.index.on("error:changed", onError);
      stream.onAbort(() => {
        ctx.index.off("topic:changed", onTopic);
        ctx.index.off("question:changed", onQuestion);
        ctx.index.off("error:changed", onError);
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
