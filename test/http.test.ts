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

const topicFile = (id: string) => path.join(dir, ".longe/topics", `${id}.md`);
const questionFile = (id: string) => path.join(dir, ".longe/questions", `${id}.md`);

// below vitest's 5s test timeout, so a hang names the condition instead of the whole test
async function waitFor(fn: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${fn}`);
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
    // menu badges: Inbox counts questions, Board counts topics; both refresh over SSE
    // data-blocking keeps the tab title's "(1)" current after a refresh (app.js)
    expect(html).toContain('id="inbox-badge" class="state-badge attn" data-blocking="1"');
    expect(html).toContain("<i></i>1 blocking</span>");
    expect(html).toContain('hx-get="/fragments/inbox-badge" hx-trigger="sse:changed"');
    // the blocking question moves the topic to needs-decision as a side effect; timing varies
    expect(html).toMatch(
      /id="board-badge" class="state-badge (quiet|attn)"[^>]*><i><\/i>1 (active|to decide)<\/span>/,
    );
    expect(html).toContain('hx-get="/fragments/board-badge" hx-trigger="sse:changed"');
    expect(html.indexOf("Webhooks or polling?")).toBeLessThan(html.indexOf("Tabs or spaces?"));
    // the key names the newest non-blocking question: a new one reopens a closed box
    expect(html).toContain(
      '<details class="nonblocking" data-key="inbox:nonblocking:q-20260922-nb0k" data-default-open',
    );
    expect(html).toContain("Assumption: <em>spaces</em>");
    expect(html).toContain('href="/topics/billing"');
    expect(html).toContain('name="option_index" value="1"');
    expect(html).not.toContain("Withdraw");
  });

  it("inbox renders fenced code as a code block and opens a context that holds code", async () => {
    await writeFile(
      questionFile("q-20260922-c0de"),
      newQuestionText({
        id: "q-20260922-c0de",
        question: "Keep this guard?\n\n```ts\nif (x < 1) return;\n```",
        context: "Current version:\n\n```ts\nconst a = 1;\n```",
        blocking: true,
        asked_by: "claude-code",
        now,
      }),
    );
    await waitFor(() => ctx.index.questions.has("q-20260922-c0de"));
    const html = await (await app.request("/")).text();
    expect(html).toContain('<pre><code class="language-ts">if (x &lt; 1) return;\n</code></pre>');
    expect(html).toContain('<code class="language-ts">const a = 1;');
    expect(html).toMatch(
      /<details data-key="context:q-20260922-c0de" open="">\s*<summary>Context<\/summary>/,
    );
    // a context without code stays collapsed
    expect(html).toMatch(/<details data-key="context:q-20260922-bl0k">\s*<summary>Context/);
  });

  it("inbox empty state", async () => {
    await rm(questionFile("q-20260922-bl0k"));
    await rm(questionFile("q-20260922-nb0k"));
    await waitFor(() => ctx.index.questions.size === 0);
    const html = await (await app.request("/")).text();
    expect(html).toContain("Nothing is waiting on you.");
    expect(html).toContain("<title>Inbox · longe</title>");
    expect(html).toContain('id="inbox-badge" class="state-badge quiet" data-blocking="0"');
    expect(html).toContain("<i></i>empty</span>");
  });

  it("menu badges follow the questions and topics", async () => {
    // the blocking question moves billing to needs-decision on startup; let that write land
    // first, or it can overwrite the status this test writes below and the wait times out
    await waitFor(() => ctx.index.topics.get("billing")?.fm.status === "needs-decision");
    await rm(questionFile("q-20260922-bl0k"));
    await waitFor(() => ctx.index.blockingCount() === 0);
    const inbox = await (await app.request("/fragments/inbox-badge")).text();
    expect(inbox).toContain('class="state-badge busy"');
    expect(inbox).toContain("<i></i>1 open</span>");

    const moveTo = async (status: string) => {
      const text = await readFile(topicFile("billing"), "utf8");
      await writeFile(topicFile("billing"), text.replace(/^status: .*$/m, `status: ${status}`));
      await waitFor(() => ctx.index.topics.get("billing")?.fm.status === status);
    };
    await moveTo("review");
    const review = await (await app.request("/fragments/board-badge")).text();
    expect(review).toContain('class="state-badge busy"');
    expect(review).toContain("<i></i>1 to review</span>");
    await moveTo("needs-decision");
    const decide = await (await app.request("/fragments/board-badge")).text();
    expect(decide).toContain('class="state-badge attn"');
    expect(decide).toContain("<i></i>1 to decide</span>");
  });

  it("board has one column per status with the topic in active", async () => {
    const res = await app.request("/board");
    // never a stale copy on back/forward navigation
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    for (const s of ["backlog", "active", "needs-decision", "review", "done", "cancelled"]) {
      expect(html).toContain(`class="column ${s}"`);
    }
    expect(html).toContain("Billing refactor");
    expect(html).toContain("1 open");
    // cards are draggable; the card says which columns a human may drop it on (§4)
    expect(html).toContain('draggable="true" data-id="billing" data-status="');
    expect(html).toMatch(/data-status="(active|needs-decision)" data-targets="[a-z,-]+"/);
    expect(html).toContain('class="column active" data-status="active"');
    // ids let morph refreshes match cards and columns by identity, not position
    expect(html).toContain('<a id="card-billing" class="card topic"');
    expect(html).toContain('<section id="col-active" class="column active"');
    // done + cancelled collapsed; the key lets the browser remember a column you opened
    expect(html).toContain('<details data-key="column:done">');
    expect(html).toContain('<details data-key="column:cancelled">');
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
    // browser libraries come from node_modules; only the listed files are served
    for (const name of ["htmx.min.js", "sse.js", "idiomorph-ext.min.js"]) {
      const lib = await app.request(`/vendor/${name}`);
      expect(lib.status).toBe(200);
      expect(lib.headers.get("content-type")).toContain("text/javascript");
    }
    expect((await app.request("/vendor/package.json")).status).toBe(404);
    expect((await app.request("/public/style.css")).headers.get("content-type")).toContain(
      "text/css",
    );
    expect((await app.request("/public/../package.json")).status).not.toBe(200);
    // the logo: favicon linked from every page, SVGs served as images
    const icon = await app.request("/public/logo/favicon.svg");
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toContain("image/svg+xml");
    const page = await (await app.request("/")).text();
    expect(page).toContain('<link rel="icon" type="image/svg+xml" href="/public/logo/favicon.svg"');
    expect(page).toContain('<img src="/public/logo/wordmark.svg" alt="longe"');
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

  it("board cleanup archives or deletes done and cancelled topics with their questions", async () => {
    const finish = async (id: string, status: string) => {
      await writeFile(
        topicFile(id),
        newTopicText({ id, title: id, goal: "g", now }).replace(
          "status: backlog",
          `status: ${status}`,
        ),
      );
      await waitFor(() => ctx.index.topics.get(id)?.fm.status === status);
    };
    await finish("shipped", "done");
    await finish("dropped", "cancelled");
    await writeFile(
      questionFile("q-20260922-dn0q"),
      newQuestionText({
        id: "q-20260922-dn0q",
        question: "Which one?",
        topic: "shipped",
        blocking: false,
        assumption: "a",
        asked_by: "claude-code",
        now,
      }),
    );
    await waitFor(() => ctx.index.questions.has("q-20260922-dn0q"));
    const board = await (await app.request("/board")).text();
    expect(board).toContain("2 done and cancelled topics");
    expect(board).toContain('hx-vals="{&quot;mode&quot;:&quot;archive&quot;}"');
    expect(board).toContain('hx-vals="{&quot;mode&quot;:&quot;delete&quot;}"');

    expect((await app.request("/board/cleanup", form({ mode: "nope" }))).status).toBe(400);

    // archive: the files move to .longe/archive/, the topic in progress stays
    const res = await app.request("/board/cleanup", form({ mode: "archive" }));
    expect(res.status).toBe(200);
    const after = await res.text();
    expect(after).not.toContain("done and cancelled");
    expect(ctx.index.topics.has("shipped")).toBe(false);
    expect(ctx.index.topics.has("dropped")).toBe(false);
    expect(ctx.index.questions.has("q-20260922-dn0q")).toBe(false);
    expect(ctx.index.topics.has("billing")).toBe(true);
    const archive = path.join(dir, ".longe/archive");
    expect(await readFile(path.join(archive, "topics/shipped.md"), "utf8")).toContain(
      "status: done",
    );
    expect(await readFile(path.join(archive, "questions/q-20260922-dn0q.md"), "utf8")).toContain(
      "Which one?",
    );
    // the same id archived again gets a suffix instead of overwriting
    await finish("shipped", "done");
    await app.request("/board/cleanup", form({ mode: "archive" }));
    expect(await readFile(path.join(archive, "topics/shipped-2.md"), "utf8")).toContain(
      "status: done",
    );

    // delete: the file is gone, nothing lands in the archive
    await finish("gone", "cancelled");
    expect((await app.request("/board/cleanup", form({ mode: "delete" }))).status).toBe(200);
    expect(ctx.index.topics.has("gone")).toBe(false);
    await expect(readFile(topicFile("gone"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(archive, "topics/gone.md"), "utf8")).rejects.toThrow();
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
    // moving a topic to active wakes the chat; record instead of starting claude
    const woken: unknown[] = [];
    ctx.agent.notifyActivated = async (v) => {
      woken.push(v);
    };
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

    res = await app.request("/topics/billing/status", form({ status: "active" }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("requires a note");

    res = await app.request(
      "/topics/billing/status",
      form({ status: "active", note: "missing tests" }),
    );
    expect(res.status).toBe(200);
    expect(await readFile(topicFile("billing"), "utf8")).toMatch(/human — rejected: missing tests/);
    expect(woken).toEqual([
      { id: "billing", title: "Billing refactor", from: "review", note: "missing tests" },
    ]);

    await app.request("/topics/billing/status", form({ status: "review" }));
    res = await app.request("/topics/billing/status", form({ status: "done" }));
    expect(res.status).toBe(200);
    const done = await res.text();
    expect(done).toContain('class="status done"');
    expect(done).not.toContain("Reject");
    // refused moves and other targets do not wake it
    expect(woken).toHaveLength(1);

    res = await app.request("/topics/billing/status", form({ status: "bogus" }));
    expect(res.status).toBe(400);
    expect((await app.request("/topics/nope/status", form({ status: "active" }))).status).toBe(404);
  });

  it("a card shows answers the agent has not read yet", async () => {
    await app.request("/questions/q-20260922-bl0k/answer", form({ option_index: "0" }));
    await waitFor(() => ctx.index.questions.get("q-20260922-bl0k")?.fm.status === "answered");
    const board = await (await app.request("/fragments/board")).text();
    expect(board).toContain('class="tag unread"');
    expect(board).toContain("1 answer waiting");
  });

  it("the human adds a topic from the board, into backlog or todo, without the chat", async () => {
    const board = await (await app.request("/board")).text();
    expect(board).toContain('hx-post="/topics/new"');
    let res = await app.request("/topics/new", form({ title: "Parked idea", goal: "Later." }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Parked idea");
    expect(ctx.index.topics.get("parked-idea")?.fm.status).toBe("backlog");
    res = await app.request("/topics/new", form({ title: "Do next", status: "todo" }));
    expect(ctx.index.topics.get("do-next")?.fm.status).toBe("todo");
    res = await app.request("/topics/new", form({ title: "  " }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("needs a title");
    expect(await ctx.agent.messages()).toEqual([]); // the chat is not involved
  });

  it("about page shows the big logo, version and links; the footer links to it", async () => {
    const res = await app.request("/about");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<img class="about-logo" src="/public/logo/wordmark.svg" alt="longe"/>');
    expect(html).toMatch(/version <code>\d+\.\d+\.\d+<\/code>/);
    expect(html).toContain('href="/api/docs"');
    expect(await (await app.request("/board")).text()).toContain('<a href="/about">about</a>');
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

  it("SSE sends a burst of changes as fewer 'changed' events", async () => {
    const res = await app.request("/events");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    let text = "";
    const decoder = new TextDecoder();
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        text += decoder.decode(value);
      }
    })().catch(() => {});
    const count = (re: RegExp) => (text.match(re) ?? []).length;
    for (let i = 0; i < 5; i++)
      await writeFile(
        topicFile(`burst-${i}`),
        newTopicText({ id: `burst-${i}`, title: "b", goal: "g", now }),
      );
    await waitFor(() => count(/event: topic-changed\ndata: [^\n]*"burst-/g) === 5);
    await new Promise((r) => setTimeout(r, 300)); // let the last window close
    await reader.cancel();
    await pump;
    // every change still gets its own kind event (billing's startup move may add one)
    const perTopic = count(/event: topic-changed/g);
    const changed = count(/event: changed/g);
    expect(changed).toBeGreaterThanOrEqual(1);
    expect(changed).toBeLessThan(perTopic);
  });
});
