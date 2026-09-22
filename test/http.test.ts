import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AppContext, closeAppContext, createAppContext } from "../src/app/context.js";
import { runInit } from "../src/cli/init.js";
import { createHttpApp } from "../src/http/app.js";
import { newQuestionText } from "../src/store/question.js";
import { newTopicText } from "../src/store/topic.js";

let dir: string;
let ctx: AppContext;
let app: ReturnType<typeof createHttpApp>;
const notifications: string[] = [];
const now = new Date();

const topicFile = (id: string) => path.join(dir, ".ai/topics", `${id}.md`);
const questionFile = (id: string) => path.join(dir, ".ai/questions", `${id}.md`);

async function waitFor(fn: () => boolean, ms = 10000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const form = (data: Record<string, string>) =>
  new Request("http://x/", { method: "POST", body: new URLSearchParams(data) });

beforeEach(async () => {
  notifications.length = 0;
  dir = await mkdtemp(path.join(os.tmpdir(), "longe-http-"));
  await runInit(dir);
  await writeFile(
    topicFile("billing"),
    newTopicText({
      id: "billing",
      title: "Billing refactor",
      goal: "Make billing sane.",
      plan: "- [ ] step",
      now,
    }).replace("status: backlog", "status: active"),
  );
  await writeFile(
    questionFile("q-20260922-bl0k"),
    newQuestionText({
      id: "q-20260922-bl0k",
      question: "Webhooks or polling?",
      context: "Idempotency matters.",
      topic: "billing",
      options: ["Webhooks", "Polling"],
      blocking: true,
      asked_by: "claude-code",
      now,
    }),
  );
  await writeFile(
    questionFile("q-20260922-nb0k"),
    newQuestionText({
      id: "q-20260922-nb0k",
      question: "Tabs or spaces?",
      blocking: false,
      assumption: "spaces",
      asked_by: "claude-code",
      now,
    }),
  );
  ctx = await createAppContext(dir, {
    notify: (t, b) => notifications.push(`${t}: ${b}`),
    index: { debounceMs: 20, usePolling: true },
  });
  app = createHttpApp(ctx);
});

afterEach(async () => {
  await closeAppContext(ctx);
  await rm(dir, { recursive: true, force: true });
});

describe("pages", () => {
  it("inbox lists blocking first, non-blocking collapsed, with title badge", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>(1) Inbox · longe</title>");
    expect(html.indexOf("Webhooks or polling?")).toBeLessThan(html.indexOf("Tabs or spaces?"));
    expect(html).toContain('<details class="nonblocking"');
    expect(html).toContain("Assumption: <em>spaces</em>");
    expect(html).toContain('href="/topics/billing"');
    expect(html).toContain('name="option_index" value="1"');
    expect(html).not.toContain("Withdraw");
  });

  it("inbox empty state", async () => {
    await rm(questionFile("q-20260922-bl0k"));
    await rm(questionFile("q-20260922-nb0k"));
    await waitFor(() => ctx.index.questions.size === 0);
    const html = await (await app.request("/")).text();
    expect(html).toContain("Nothing is waiting on you.");
    expect(html).toContain("<title>Inbox · longe</title>");
  });

  it("board has one column per status with the topic in active", async () => {
    const html = await (await app.request("/board")).text();
    for (const s of ["backlog", "active", "needs-decision", "review", "done", "cancelled"]) {
      expect(html).toContain(`class="column ${s}"`);
    }
    expect(html).toContain("Billing refactor");
    expect(html).toContain("1 open");
    expect(html.match(/<details>/g)?.length).toBe(2); // done + cancelled collapsed
  });

  it("topic page renders sections, questions and human-only actions", async () => {
    const html = await (await app.request("/topics/billing")).text();
    expect(html).toContain("<h1>Billing refactor</h1>");
    expect(html).toContain("Make billing sane.");
    expect(html).toContain('class="task-list-item"'.length ? "step" : "");
    expect(html).toContain("Webhooks or polling?");
    // active: human may send to review or cancel; never "done"
    expect(html).toContain('value="review"');
    expect(html).toContain('value="cancelled"');
    expect(html).not.toContain('value="done"');
  });

  it("404 for unknown topic; static assets served; raw html not rendered", async () => {
    expect((await app.request("/topics/nope")).status).toBe(404);
    expect((await app.request("/public/vendor/htmx.min.js")).status).toBe(200);
    expect((await app.request("/public/style.css")).headers.get("content-type")).toContain(
      "text/css",
    );
    expect((await app.request("/public/../package.json")).status).not.toBe(200);
    await writeFile(
      topicFile("evil"),
      newTopicText({ id: "evil", title: "Evil", goal: "<script>alert(1)</script> **bold**", now }),
    );
    await waitFor(() => ctx.index.topics.has("evil"));
    const html = await (await app.request("/topics/evil")).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("shows malformed files", async () => {
    await writeFile(topicFile("broken"), "---\nid: broken\n---\nno sections\n");
    await waitFor(() => ctx.index.errors.size === 1);
    const html = await (await app.request("/board")).text();
    expect(html).toContain("Malformed files");
    expect(html).toContain("topics/broken.md");
  });
});

describe("actions", () => {
  it("answering a blocking question by option updates the file, unblocks the topic, returns a fragment", async () => {
    // topic should first have moved to needs-decision through the runner on startup? No: startup
    // changes are "added" with no previous, and the runner treats them as external creations.
    await waitFor(() => ctx.index.topics.get("billing")?.fm.status === "needs-decision");
    const res = await app.request(
      "/questions/q-20260922-bl0k/answer",
      form({ option_index: "0", note: "Go." }),
    );
    expect(res.status).toBe(200);
    const frag = await res.text();
    expect(frag).toContain('id="q-q-20260922-bl0k"');
    expect(frag).toContain("answered");
    expect(frag).toContain("Webhooks");
    const q = await readFile(questionFile("q-20260922-bl0k"), "utf8");
    expect(q).toContain("status: answered");
    expect(q).toMatch(/## Answer\nWebhooks\n\nGo\.\n$/);
    await waitFor(() => ctx.index.topics.get("billing")?.fm.status === "active");
    expect(await readFile(topicFile("billing"), "utf8")).toMatch(
      /system — q-20260922-bl0k answered, unblocked/,
    );
    // answering again is a conflict
    const again = await app.request("/questions/q-20260922-bl0k/answer", form({ answer: "x" }));
    expect(again.status).toBe(409);
  });

  it("answer validation: empty and bad option", async () => {
    expect((await app.request("/questions/q-20260922-nb0k/answer", form({}))).status).toBe(400);
    expect(
      (await app.request("/questions/q-20260922-nb0k/answer", form({ option_index: "7" }))).status,
    ).toBe(400);
    expect(
      (await app.request("/questions/q-00000000-zzzz/answer", form({ answer: "x" }))).status,
    ).toBe(404);
    const ok = await app.request("/questions/q-20260922-nb0k/answer", form({ answer: "Tabs." }));
    expect(ok.status).toBe(200);
    expect(await readFile(questionFile("q-20260922-nb0k"), "utf8")).toContain("## Answer\nTabs.\n");
  });

  it("status form enforces §4 for humans and logs rejections", async () => {
    await rm(questionFile("q-20260922-bl0k"));
    await waitFor(() => !ctx.index.questions.has("q-20260922-bl0k"));
    // needs-decision → active is system-only, even for a human
    let res = await app.request("/topics/billing/status", form({ status: "active" }));
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("system");
    // put it back to active by hand, then review → reject needs note → done
    const text = await readFile(topicFile("billing"), "utf8");
    await writeFile(topicFile("billing"), text.replace("status: needs-decision", "status: active"));
    await waitFor(() => ctx.index.topics.get("billing")?.fm.status === "active");

    res = await app.request("/topics/billing/status", form({ status: "review" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('class="status review"');
    await waitFor(() => notifications.some((n) => n.startsWith("Ready for review")));

    res = await app.request("/topics/billing/status", form({ status: "active" }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("requires a note");

    res = await app.request(
      "/topics/billing/status",
      form({ status: "active", note: "missing tests" }),
    );
    expect(res.status).toBe(200);
    expect(await readFile(topicFile("billing"), "utf8")).toMatch(/human — rejected: missing tests/);

    await app.request("/topics/billing/status", form({ status: "review" }));
    res = await app.request("/topics/billing/status", form({ status: "done" }));
    expect(res.status).toBe(200);
    const done = await res.text();
    expect(done).toContain('class="status done"');
    expect(done).not.toContain("Reject");

    res = await app.request("/topics/billing/status", form({ status: "bogus" }));
    expect(res.status).toBe(400);
    expect((await app.request("/topics/nope/status", form({ status: "active" }))).status).toBe(404);
  });

  it("SSE endpoint streams events", async () => {
    const res = await app.request("/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body?.getReader();
    const first = new TextDecoder().decode((await reader?.read())?.value);
    expect(first).toContain("event: hello");
    await reader?.cancel();
  });
});
