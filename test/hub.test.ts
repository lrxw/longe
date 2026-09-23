import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMultiHub, createRegistryHub, type Hub } from "../src/app/hub.js";
import { runInit } from "../src/cli/init.js";
import { createHttpApp } from "../src/http/app.js";
import { newQuestionText } from "../src/store/question.js";
import { readRegistry, registerRepo, renameRepo, unregisterRepo } from "../src/store/registry.js";
import { newTopicText } from "../src/store/topic.js";

const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;

let base: string;
let shop: string;
let blog: string;
let hub: Hub;
const now = new Date();

async function mkRepo(name: string, project: string): Promise<string> {
  const dir = path.join(base, name);
  await runInit(dir);
  await writeFile(path.join(dir, ".ai/config.yml"), `version: 1\nproject: ${project}\n`);
  await writeFile(
    path.join(dir, ".ai/topics/t1.md"),
    newTopicText({ id: "t1", title: `${project} topic`, goal: "g", now }).replace(
      "status: backlog",
      "status: active",
    ),
  );
  return dir;
}

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), "longe-hub-"));
  process.env.XDG_CONFIG_HOME = path.join(base, "config");
  process.env.XDG_CACHE_HOME = path.join(base, "cache");
  shop = await mkRepo("shop", "Shop");
  blog = await mkRepo("blog", "Blog");
  await writeFile(
    path.join(blog, ".ai/questions/q-20260922-blog.md"),
    newQuestionText({
      id: "q-20260922-blog",
      question: "Blog Q?",
      blocking: true,
      topic: "t1",
      asked_by: "a",
      now,
    }),
  );
});

afterEach(async () => {
  await hub?.close();
  await rm(base, { recursive: true, force: true });
});

describe("registry", () => {
  it("registers, dedupes, renames and removes", async () => {
    const a = await registerRepo(shop);
    expect(a.name).toBe("shop");
    const b = await registerRepo(blog, "Shop"); // name clash → suffix
    expect(b.name).toBe("shop-2");
    expect((await registerRepo(shop)).name).toBe("shop"); // touch keeps name
    expect((await readRegistry()).map((r) => r.name)).toEqual(["shop", "shop-2"]);
    expect((await renameRepo(blog, "The Blog"))?.name).toBe("the-blog");
    expect(await unregisterRepo(shop)).toBe(true);
    expect(await unregisterRepo(shop)).toBe(false);
    expect((await readRegistry()).map((r) => r.name)).toEqual(["the-blog"]);
    expect(await readFile(path.join(base, "config/longe/repos.yml"), "utf8")).toContain("the-blog");
  });
});

describe("hub mode", () => {
  beforeEach(async () => {
    hub = await createMultiHub(
      [
        { name: "shop", root: shop },
        { name: "blog", root: blog },
        { name: "gone", root: path.join(base, "nope") },
      ],
      { index: { debounceMs: 20, usePolling: true } },
    );
  });

  it("merged inbox with repo tags, missing repos listed, board redirects, prefixed pages", async () => {
    const app = createHttpApp(hub, { port: 1 });
    await new Promise((r) => setTimeout(r, 200)); // let the blog watcher apply the blocking effect
    const inbox = await (await app.request("/")).text();
    expect(inbox).toContain("<title>(1) Inbox · longe</title>");
    expect(inbox).toContain("Blog Q?");
    expect(inbox).toContain('href="/r/blog/board"'); // repo tag on the card
    expect(inbox).toContain('hx-post="/r/blog/questions/q-20260922-blog/answer"');
    expect(inbox).toContain("Unavailable repos");
    expect(inbox).toContain('class="repos"'); // switcher

    const redirect = await app.request("/board");
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/r/shop/board");

    const boardRes = await app.request("/r/shop/board");
    const board = await boardRes.text();
    expect(board).toContain("Shop topic");
    expect(board).not.toContain("Blog topic");
    expect(board).toContain('href="/r/shop/topics/t1"');
    // header on every page: Inbox, then one avatar per repo (its board link); the current one lit
    expect(board).toContain('class="repos"');
    expect(board).toMatch(
      /<a href="\/r\/shop\/board" class="on ".*?<span class="avatar">SH<\/span>/s,
    );
    expect(board).toContain('data-n="2"');
    // the strip is a live fragment: counts refresh on SSE, the current repo stays lit
    expect(board).toContain('id="repos" class="repos"');
    const strip = await (await app.request("/fragments/repos?current=shop")).text();
    expect(strip).toContain('hx-get="/fragments/repos?current=shop" hx-trigger="sse:changed"');
    expect(strip).toMatch(/<a href="\/r\/shop\/board" class="on "/);
    expect(strip).toMatch(
      /<a href="\/r\/blog\/board" class=" "[^>]*>.*?<span class="count">1<\/span>/s,
    );
    expect(inbox).toContain('href="/r/blog/board"');
    expect(inbox).not.toContain('class="tabs"');

    // the board you visited last is remembered; /board follows it
    const cookie = boardRes.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^longe_repo=shop/);
    const blogRes = await app.request("/r/blog/board");
    const blogCookie = (blogRes.headers.get("set-cookie") ?? "").split(";")[0];
    const followed = await app.request("/board", { headers: { cookie: blogCookie } });
    expect(followed.headers.get("location")).toBe("/r/blog/board");
    const stale = await app.request("/board", { headers: { cookie: "longe_repo=nope" } });
    expect(stale.headers.get("location")).toBe("/r/shop/board");
    // the "c" key on the inbox goes to /chat: the same redirect, to that repo's chat
    const chat = await app.request("/chat", { headers: { cookie: blogCookie } });
    expect(chat.status).toBe(302);
    expect(chat.headers.get("location")).toBe("/r/blog/chat");

    // the inbox is global; cards carry the repo's avatar and color
    expect(inbox).toMatch(/<a class="repo" href="\/r\/blog\/board" style="--repo:hsl\([^)]+\)">/);
    // every repo gets its own color
    const colors = [
      ...inbox.matchAll(
        /<a href="\/[^"]*" class="[^"]*" title="[^"]*" data-n="\d" style="--repo:([^"]+)"/g,
      ),
    ].map((m) => m[1]);
    expect(colors).toHaveLength(3);
    expect(new Set(colors).size).toBe(3);
    expect(inbox).toContain('title="Blog">BL</span>');
    expect((await app.request("/r/shop/inbox")).status).toBe(404);

    // a topic page keeps the repo prefix: live refresh and the Reject form
    const t1 = path.join(shop, ".ai/topics/t1.md");
    await writeFile(t1, (await readFile(t1, "utf8")).replace("status: active", "status: review"));
    let topicPage = "";
    for (let i = 0; i < 80 && !topicPage.includes('class="reject"'); i++) {
      await new Promise((r) => setTimeout(r, 25));
      topicPage = await (await app.request("/r/shop/topics/t1")).text();
    }
    expect(topicPage).toContain('hx-get="/r/shop/fragments/topics/t1"');
    expect(topicPage).toMatch(/<form hx-post="\/r\/shop\/topics\/t1\/status"[^>]*class="reject"/);
  });

  it("REST: repo param, prefixed routes, aggregated list_topics", async () => {
    const app = createHttpApp(hub, { port: 1 });
    const post = (p: string, body: unknown) =>
      app.request(p, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    let r = await post("/api/v1/get_topic", { id: "t1" });
    expect(r.status).toBe(400);
    expect((await json(r)).message).toMatch(/hub mode/);

    r = await post("/api/v1/get_topic", { id: "t1", repo: "shop" });
    expect((await json(r)).title).toBe("Shop topic");
    r = await post("/r/blog/api/v1/get_topic", { id: "t1" });
    expect((await json(r)).title).toBe("Blog topic");

    r = await app.request("/api/v1/list_topics");
    const all = (await json(r)).topics as { repo: string; id: string }[];
    expect(all.map((t) => `${t.repo}/${t.id}`).sort()).toEqual(["blog/t1", "shop/t1"]);
    r = await app.request("/api/v1/list_topics?repo=shop");
    expect(((await json(r)).topics as unknown[]).length).toBe(1);

    r = await post("/api/v1/create_topic", { repo: "shop", title: "Via hub", goal: "g" });
    expect((await json(r)).id).toBe("via-hub");
    expect(await readFile(path.join(shop, ".ai/topics/via-hub.md"), "utf8")).toContain(
      "title: Via hub",
    );

    const doc = (await (await app.request("/openapi.json")).json()) as {
      paths: Record<
        string,
        {
          post: {
            requestBody: {
              content: { "application/json": { schema: { properties: Record<string, unknown> } } };
            };
          };
        }
      >;
    };
    expect(
      doc.paths["/api/v1/get_topic"]?.post.requestBody.content["application/json"].schema.properties
        .repo,
    ).toBeDefined();

    // answering through the prefixed form endpoint unblocks blog/t1
    await new Promise((r) => setTimeout(r, 200));
    const form = await app.request("/r/blog/questions/q-20260922-blog/answer", {
      method: "POST",
      body: new URLSearchParams({ answer: "yes" }),
    });
    expect(form.status).toBe(200);
    expect(hub.get("blog")?.ctx?.index.topics.get("t1")?.fm.status).toBe("active");
  });

  it("MCP: hub server takes repo on every tool and lists repos", async () => {
    const app = createHttpApp(hub, { port: 1 });
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise<void>((r) => server.once("listening", () => r()));
    const port = (server.address() as { port: number }).port;
    const client = new Client({ name: "t", version: "0" });
    try {
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
      await client.connect(transport as never);
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("list_repos");
      const lt = tools.tools.find((t) => t.name === "list_topics") as {
        inputSchema: { required?: string[] };
      };
      expect(lt.inputSchema.required).toContain("repo");
      const repos = (await client.callTool({ name: "list_repos", arguments: {} })) as {
        content: { text: string }[];
      };
      expect(
        JSON.parse(repos.content[0]?.text ?? "").repos.map((r: { name: string }) => r.name),
      ).toEqual(["shop", "blog", "gone"]);
      const t = (await client.callTool({
        name: "get_topic",
        arguments: { repo: "blog", id: "t1" },
      })) as { content: { text: string }[] };
      expect(JSON.parse(t.content[0]?.text ?? "").title).toBe("Blog topic");
      const bad = (await client.callTool({
        name: "get_topic",
        arguments: { repo: "zzz", id: "t1" },
      })) as { isError?: boolean };
      expect(bad.isError).toBe(true);
      // per-repo endpoint still plain
      const c2 = new Client({ name: "t2", version: "0" });
      await c2.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/r/shop/mcp`)) as never,
      );
      const t2 = await c2.listTools();
      expect(t2.tools.map((t) => t.name)).not.toContain("list_repos");
      await c2.close();
    } finally {
      await client.close();
      server.close();
    }
  }, 20000);
});

describe("registry hub", () => {
  it("follows the registry file live and shows an overview", async () => {
    await registerRepo(shop);
    hub = await createRegistryHub({ index: { debounceMs: 20, usePolling: true } });
    expect(hub.list().map((r) => r.name)).toEqual(["shop"]);
    const app = createHttpApp(hub, { port: 1 });
    let html = await (await app.request("/")).text();
    expect(html).toContain('class="overview"');
    expect(html).toContain("1 active");

    await registerRepo(blog);
    const start = Date.now();
    while (!hub.get("blog") && Date.now() - start < 8000)
      await new Promise((r) => setTimeout(r, 50));
    expect(hub.get("blog")?.ctx).toBeDefined();
    html = await (await app.request("/")).text();
    expect(html).toContain("Blog Q?");

    await unregisterRepo(shop);
    const s2 = Date.now();
    while (hub.get("shop") && Date.now() - s2 < 8000) await new Promise((r) => setTimeout(r, 50));
    expect(hub.get("shop")).toBeUndefined();
  }, 20000);

  it("New project: creates the folder with .ai/, registers it, opens its board", async () => {
    await registerRepo(shop);
    hub = await createRegistryHub({ index: { debounceMs: 20, usePolling: true } });
    const home = path.join(base, "home");
    await mkdir(home);
    const app = createHttpApp(hub, { port: 1, home });
    expect(await (await app.request("/")).text()).toContain('href="/repos/new"');
    expect(await (await app.request("/repos/new")).text()).toContain('action="/repos/new"');

    const post = (data: Record<string, string>, origin: string | null = "http://localhost") =>
      app.request("http://localhost/repos/new", {
        method: "POST",
        body: new URLSearchParams(data),
        headers: origin ? { origin } : {},
      });
    // another site, or no origin: refused
    expect((await post({ path: "~/a" }, "http://evil.example")).status).toBe(403);
    expect((await post({ path: "~/a" }, null)).status).toBe(403);
    // outside home, relative, home itself, or a symlink that leads out: refused
    for (const p of [path.join(base, "elsewhere"), "projects/x", "~", "~/../escape"]) {
      const res = await post({ path: p });
      expect(res.status, p).toBe(400);
      expect(await res.text()).toMatch(/class="error">(Use an absolute path|The folder must be)/);
    }
    await symlink(base, path.join(home, "link"));
    expect((await post({ path: "~/link/out" })).status).toBe(400);
    await expect(stat(path.join(base, "out"))).rejects.toThrow();

    const res = await post({ path: "~/code/fresh", name: "Fresh Idea" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/r/fresh-idea/board");
    const root = path.join(home, "code/fresh");
    expect(await readFile(path.join(root, ".ai/config.yml"), "utf8")).toContain(
      'project: "Fresh Idea"',
    );
    expect((await readRegistry()).map((r) => r.name)).toContain("fresh-idea");
    expect(hub.get("fresh-idea")?.ctx).toBeDefined();
    expect((await app.request("/r/fresh-idea/board")).status).toBe(200);
    // an existing folder with .ai/ already: kept, same entry
    expect((await post({ path: "~/code/fresh" })).status).toBe(303);
    expect(hub.list().filter((r) => r.root.endsWith("fresh"))).toHaveLength(1);
  }, 20000);
});
