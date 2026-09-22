import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../app/context.js";
import { DomainError } from "../domain/errors.js";
import { ALL_TOOLS, invokeTool, type ToolDef } from "../tools/registry.js";
import { statusFor } from "./errors.js";

export const API_BASE = "/api/v1";

/** REST adapter over the registry (§7.3): POST /api/v1/<tool> with a JSON body. */
export function createApiApp(ctx: AppContext): Hono {
  const api = new Hono();

  api.onError((err, c) => {
    if (err instanceof DomainError)
      return c.json({ code: err.code, message: err.message }, statusFor(err) as 400);
    process.stderr.write(`${err.stack ?? err.message}\n`);
    return c.json({ code: "internal", message: err.message }, 500);
  });

  for (const tool of ALL_TOOLS) {
    api.post(`/${tool.name}`, async (c) => {
      let body: unknown = {};
      const text = await c.req.text();
      if (text.trim()) {
        try {
          body = JSON.parse(text);
        } catch {
          throw new DomainError("validation", "request body must be JSON");
        }
      }
      return c.json(await invokeTool(ctx, tool, body));
    });
  }
  // read-only convenience: GET with query params
  for (const name of ["list_topics", "get_topic", "check_answers"]) {
    const tool = ALL_TOOLS.find((t) => t.name === name) as ToolDef;
    api.get(`/${name}`, async (c) => c.json(await invokeTool(ctx, tool, c.req.query())));
  }

  api.all("/*", (c) => c.json({ code: "not_found", message: `no such route ${c.req.path}` }, 404));
  return api;
}

export function openApiDocument(port: number): Record<string, unknown> {
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
      description:
        "Local board for AI coding agents. Same operations as the MCP tools; human-facing operations are REST-only.",
    },
    servers: [{ url: `http://127.0.0.1:${port}` }],
    paths,
  };
}

/** Dependency-free docs page: lists every route with its schema and a try-it form. */
export function docsPage(port: number): string {
  const doc = openApiDocument(port);
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
</head><body><header class="top"><a class="brand" href="/">longe</a><span class="project">REST API · <a href="/openapi.json">openapi.json</a> · MCP at <code>/mcp</code></span></header>
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
