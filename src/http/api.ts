import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../app/context.js";
import type { Hub } from "../app/hub.js";
import { DomainError } from "../domain/errors.js";
import { ALL_TOOLS, invokeTool, type ToolDef, topicSummary } from "../tools/registry.js";
import { statusFor } from "./errors.js";

export const API_BASE = "/api/v1";

export type ResolveCtx = (c: Context) => AppContext;

export interface ApiOptions {
  /** Hub-mode extras: aggregate list_topics across repos, accept `repo` in the body. */
  hub?: Hub;
}

/** REST adapter over the registry (§7.3): POST /api/v1/<tool> with a JSON body. */
export function createApiApp(resolve: ResolveCtx, opts: ApiOptions = {}): Hono {
  const api = new Hono();

  api.onError((err, c) => {
    if (err instanceof DomainError)
      return c.json({ code: err.code, message: err.message }, statusFor(err) as 400);
    process.stderr.write(`${err.stack ?? err.message}\n`);
    return c.json({ code: "internal", message: err.message }, 500);
  });

  const parseBody = async (c: Context): Promise<Record<string, unknown>> => {
    const text = await c.req.text();
    if (!text.trim()) return {};
    try {
      const v = JSON.parse(text) as unknown;
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
      return v as Record<string, unknown>;
    } catch {
      throw new DomainError("validation", "request body must be a JSON object");
    }
  };

  /** Pulls `repo` out of the body (hub mode) and makes it visible to `resolve`. */
  const scoped = (
    c: Context,
    body: Record<string, unknown>,
  ): { ctx: AppContext; input: Record<string, unknown> } => {
    const { repo, ...input } = body;
    if (typeof repo === "string") c.set("repo", repo);
    return { ctx: resolve(c), input };
  };

  for (const tool of ALL_TOOLS) {
    api.post(`/${tool.name}`, async (c) => {
      const body = await parseBody(c);
      if (
        opts.hub &&
        tool.name === "list_topics" &&
        typeof body.repo !== "string" &&
        !c.req.query("repo")
      ) {
        return c.json(await aggregatedTopics(opts.hub, body));
      }
      const { ctx, input } = scoped(c, body);
      return c.json(await invokeTool(ctx, tool, input));
    });
  }
  for (const name of ["list_topics", "get_topic", "check_answers"]) {
    const tool = ALL_TOOLS.find((t) => t.name === name) as ToolDef;
    api.get(`/${name}`, async (c) => {
      const query = c.req.query();
      if (opts.hub && name === "list_topics" && !query.repo)
        return c.json(await aggregatedTopics(opts.hub, query));
      const { ctx, input } = scoped(c, query);
      return c.json(await invokeTool(ctx, tool, input));
    });
  }

  api.all("/*", (c) => c.json({ code: "not_found", message: `no such route ${c.req.path}` }, 404));
  return api;
}

async function aggregatedTopics(hub: Hub, input: Record<string, unknown>) {
  const status = typeof input.status === "string" ? input.status : undefined;
  const topics = hub.live().flatMap((r) => {
    const ctx = r.ctx as AppContext;
    return [...ctx.index.topics.values()]
      .filter((t) => !status || t.fm.status === status)
      .map((t) => ({ repo: r.name, ...topicSummary(ctx, t) }));
  });
  topics.sort((a, b) => b.updated.localeCompare(a.updated));
  return { topics };
}

export function openApiDocument(port: number, hub = false): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  const errorResponse = (description: string) => ({
    description,
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: { code: { type: "string" }, message: { type: "string" } },
        },
      },
    },
  });
  for (const tool of ALL_TOOLS) {
    const schema = z.toJSONSchema(tool.input, { target: "draft-2020-12" }) as Record<
      string,
      unknown
    >;
    delete schema.$schema;
    if (hub) {
      const props = (schema.properties ?? {}) as Record<string, unknown>;
      props.repo = {
        type: "string",
        description: "Registered repo name (hub mode). Alternatively call /r/<name>/api/v1/…",
      };
      schema.properties = props;
    }
    paths[`${API_BASE}/${tool.name}`] = {
      post: {
        operationId: tool.name,
        summary: tool.description.split(". ")[0],
        description: tool.description,
        tags: [tool.surface === "agent" ? "agent" : "human"],
        requestBody: { required: true, content: { "application/json": { schema } } },
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { type: "object" } } },
          },
          "400": errorResponse("Validation error"),
          "404": errorResponse("Unknown id"),
          "409": errorResponse("Disallowed transition"),
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "longe",
      version: "0.1.0",
      description: hub
        ? "Hub mode: every operation takes `repo`, or use the per-repo prefix /r/<name>/api/v1/. Human-facing operations are REST-only."
        : "Local board for AI coding agents. Same operations as the MCP tools; human-facing operations are REST-only.",
    },
    servers: [{ url: `http://127.0.0.1:${port}` }],
    paths,
  };
}

/** Dependency-free docs page: lists every route with its schema and a try-it form. */
export function docsPage(port: number, hub = false): string {
  const doc = openApiDocument(port, hub);
  const paths = doc.paths as Record<
    string,
    {
      post: {
        description: string;
        tags: string[];
        requestBody: { content: { "application/json": { schema: unknown } } };
      };
    }
  >;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const sections = Object.entries(paths)
    .map(([p, { post }]) => {
      const schema = JSON.stringify(post.requestBody.content["application/json"].schema, null, 2);
      const example = JSON.stringify(
        exampleFor(post.requestBody.content["application/json"].schema as never),
        null,
        2,
      );
      return `<section>
<h2><code>POST ${esc(p)}</code> <span class="tag">${post.tags[0]}</span></h2>
<p>${esc(post.description)}</p>
<details><summary>Schema</summary><pre>${esc(schema)}</pre></details>
<form data-path="${esc(p)}"><textarea rows="4">${esc(example)}</textarea><button>Send</button><pre class="out"></pre></form>
</section>`;
    })
    .join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>longe API</title>
<link rel="stylesheet" href="/public/style.css">
<style>main{max-width:900px}section{border:1px solid var(--line);border-radius:6px;padding:.5rem 1rem;margin:.75rem 0}pre{background:color-mix(in srgb,var(--fg) 6%,transparent);padding:.5rem;overflow:auto;font-size:.85em}textarea{width:100%;font-family:ui-monospace,monospace}h2{font-size:1em;margin:.3rem 0}</style>
</head><body><header class="top"><a class="brand" href="/">longe</a><span class="project">REST API · <a href="/openapi.json">openapi.json</a> · MCP at <code>/mcp</code>${hub ? " · hub mode: add <code>repo</code> or use <code>/r/&lt;name&gt;/…</code>" : ""}</span></header>
<main>${sections}</main>
<script>
document.querySelectorAll("form[data-path]").forEach(f=>f.addEventListener("submit",async e=>{e.preventDefault();const out=f.querySelector(".out");try{const r=await fetch(f.dataset.path,{method:"POST",headers:{"content-type":"application/json"},body:f.querySelector("textarea").value});out.textContent=r.status+"\\n"+JSON.stringify(await r.json(),null,2)}catch(err){out.textContent=String(err)}}));
</script></body></html>`;
}

function exampleFor(schema: {
  properties?: Record<string, { type?: string; enum?: string[]; items?: { type?: string } }>;
  required?: string[];
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of schema.required ?? []) {
    const p = schema.properties?.[key];
    if (!p) continue;
    if (p.enum) out[key] = p.enum[0];
    else if (p.type === "string") out[key] = "";
    else if (p.type === "boolean") out[key] = false;
    else if (p.type === "number" || p.type === "integer") out[key] = 0;
    else if (p.type === "array") out[key] = [];
  }
  return out;
}
