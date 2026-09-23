import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AppContext, closeAppContext, createAppContext } from "../src/app/context.js";
import { runInit } from "../src/cli/init.js";
import { createHttpApp } from "../src/http/app.js";

let dir: string;
let ctx: AppContext;
let app: ReturnType<typeof createHttpApp>;
const notifications: string[] = [];

const post = (name: string, body: unknown) =>
  app.request(`/api/v1/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const json = async (res: Response) => ({
  status: res.status,
  body: (await res.json()) as Record<string, unknown>,
});

beforeEach(async () => {
  notifications.length = 0;
  dir = await mkdtemp(path.join(os.tmpdir(), "longe-api-"));
  await runInit(dir);
  ctx = await createAppContext(dir, {
    notify: (t, b) => notifications.push(`${t}: ${b}`),
    index: { debounceMs: 20, usePolling: true },
  });
  app = createHttpApp(ctx, { port: 7311 });
});

afterEach(async () => {
  await closeAppContext(ctx);
  await rm(dir, { recursive: true, force: true });
});

describe("REST /api/v1", () => {
  it("runs the full agent scenario end to end", async () => {
    // create + pick up
    let r = await json(
      await post("create_topic", {
        title: "Billing refactor",
        goal: "Make it sane.",
        plan: "- [ ] a",
      }),
    );
    expect(r.status).toBe(200);
    expect(r.body.id).toBe("billing-refactor");
    r = await json(await post("create_topic", { title: "Billing refactor", goal: "again" }));
    expect(r.body.id).toBe("billing-refactor-2");
    // agents create ready work: todo, never the human's backlog
    expect(ctx.index.topics.get("billing-refactor")?.fm.status).toBe("todo");
    r = await json(await post("set_status", { id: "billing-refactor", status: "active" }));
    expect(r.body).toEqual({ id: "billing-refactor", status: "active" });

    // plan / decision / log
    expect(
      (await post("set_plan", { id: "billing-refactor", plan: "- [x] a\n- [ ] b" })).status,
    ).toBe(200);
    expect(
      (await post("add_decision", { id: "billing-refactor", text: "Webhooks over polling." }))
        .status,
    ).toBe(200);
    expect(
      (await post("append_log", { id: "billing-refactor", text: "Step a done." })).status,
    ).toBe(200);
    r = await json(await app.request("/api/v1/get_topic?id=billing-refactor"));
    expect(r.body.plan).toBe("- [x] a\n- [ ] b");
    expect(r.body.decisions).toMatch(/— Webhooks over polling\.$/);
    expect(r.body.log).toMatch(/agent — Step a done\.$/);

    // non-blocking without assumption → 400
    r = await json(
      await post("ask_question", { question: "Tabs?", blocking: false, topic: "billing-refactor" }),
    );
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("validation");
    expect(String(r.body.message)).toMatch(/assumption/);

    // blocking → topic needs-decision, notification
    r = await json(
      await post("ask_question", {
        question: "Webhooks or polling?",
        context: "Idempotency.",
        topic: "billing-refactor",
        options: ["Webhooks", "Polling"],
        blocking: true,
        asked_by: "test-agent",
      }),
    );
    expect(r.status).toBe(200);
    const qid = r.body.id as string;
    expect(qid).toMatch(/^q-\d{8}-[0-9a-z]{4}$/);
    expect(r.body.topic_status).toBe("needs-decision");
    // the title names the repo (its folder here), the body the topic and the question
    expect(notifications).toEqual([
      `${path.basename(dir)} · Blocking question: Billing refactor: Webhooks or polling?`,
    ]);
    expect(await readFile(path.join(dir, ".ai/topics/billing-refactor.md"), "utf8")).toMatch(
      /system — blocked on q-/,
    );

    // agent cannot leave needs-decision itself
    r = await json(await post("set_status", { id: "billing-refactor", status: "active" }));
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("system_only");

    // inbox ordering via list; human answers via REST
    r = await json(await app.request("/api/v1/list_topics?status=needs-decision"));
    expect((r.body.topics as unknown[]).length).toBe(1);
    r = await json(await post("answer_question", { id: qid, option_index: 0, note: "Go." }));
    expect(r.body).toEqual({ id: qid, status: "answered" });
    expect(ctx.index.topics.get("billing-refactor")?.fm.status).toBe("active");

    // agent reads + acknowledges
    r = await json(await post("check_answers", {}));
    const answered = r.body.questions as { id: string; answer: string }[];
    expect(answered.map((q) => q.id)).toEqual([qid]);
    expect(answered[0]?.answer).toBe("Webhooks\n\nGo.");
    r = await json(await post("acknowledge_answers", { ids: [qid] }));
    expect(r.body).toEqual({ acknowledged: [qid] });
    r = await json(await post("check_answers", {}));
    expect(r.body.questions).toEqual([]);

    // submit for review; agent may not approve
    r = await json(
      await post("set_status", { id: "billing-refactor", status: "review", note: "Ready." }),
    );
    expect(r.status).toBe(200);
    expect(notifications).toHaveLength(1); // review is not notified, only blocking questions
    r = await json(await post("set_status", { id: "billing-refactor", status: "done" }));
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("human_only");
    expect(String(r.body.message)).toMatch(/never approve their own work/);

    // human reject requires note, then approve
    r = await json(await post("reject", { id: "billing-refactor" }));
    expect(r.status).toBe(400);
    r = await json(await post("reject", { id: "billing-refactor", note: "tests missing" }));
    expect(r.body.status).toBe("active");
    await post("set_status", { id: "billing-refactor", status: "review" });
    r = await json(await post("approve", { id: "billing-refactor" }));
    expect(r.body.status).toBe("done");
    r = await json(await post("reopen", { id: "billing-refactor" }));
    expect(r.body.status).toBe("active");
    r = await json(await post("cancel", { id: "billing-refactor", note: "nah" }));
    expect(r.body.status).toBe("cancelled");
  });

  it("withdraw unblocks; wait_for_answer resolves and times out", async () => {
    await post("create_topic", { title: "T", goal: "g" });
    await post("set_status", { id: "t", status: "active" });
    const q1 = (
      (await (
        await post("ask_question", { question: "A?", blocking: true, topic: "t" })
      ).json()) as { id: string }
    ).id;
    const q2 = (
      (await (
        await post("ask_question", { question: "B?", blocking: true, topic: "t" })
      ).json()) as { id: string }
    ).id;
    expect(ctx.index.topics.get("t")?.fm.status).toBe("needs-decision");

    await post("withdraw_question", { id: q1, reason: "found it" });
    expect(ctx.index.topics.get("t")?.fm.status).toBe("needs-decision"); // q2 still open
    expect(await readFile(path.join(dir, ".ai/questions", `${q1}.md`), "utf8")).toMatch(
      /Withdrawn .* — found it/,
    );

    const timeout = await json(await post("wait_for_answer", { id: q2, timeout_seconds: 1 }));
    expect(timeout.body).toEqual({ status: "timeout" });

    const waiting = post("wait_for_answer", { id: q2, timeout_seconds: 10 });
    await new Promise((r) => setTimeout(r, 50));
    await post("answer_question", { id: q2, answer: "B it is." });
    const r = await json(await waiting);
    expect(r.body.status).toBe("answered");
    expect((r.body.question as { answer: string }).answer).toBe("B it is.");
    expect(ctx.index.topics.get("t")?.fm.status).toBe("active");
  });

  it("a reject option answered in the inbox sends a review topic back to active", async () => {
    await post("create_topic", { title: "T", goal: "g" });
    await post("set_status", { id: "t", status: "active" });
    await post("set_status", { id: "t", status: "review" });
    const ask = (reject_options: string[]) =>
      post("ask_question", {
        question: "Does it work?",
        topic: "t",
        options: ["Works", "Broken"],
        reject_options,
        blocking: false,
        assumption: "it works",
      });
    let r = await json(await ask(["Kaputt"]));
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toMatch(/reject_options/);

    r = await json(await ask(["Broken"]));
    const qid = r.body.id as string;
    expect(r.body.topic_status).toBe("review");
    r = await json(await app.request(`/api/v1/get_topic?id=t`));
    expect((r.body.questions as { reject_options: string[] }[])[0]?.reject_options).toEqual([
      "Broken",
    ]);

    await post("answer_question", { id: qid, option_index: 1, note: "menu never opens" });
    expect(ctx.index.topics.get("t")?.fm.status).toBe("active");
    expect(await readFile(path.join(dir, ".ai/topics/t.md"), "utf8")).toMatch(
      /system — rejected in q-.*: Broken menu never opens/,
    );
  });

  it("errors: 404 unknown id, 400 bad json, 404 unknown route", async () => {
    let r = await json(await post("get_topic", { id: "nope" }));
    expect(r).toMatchObject({ status: 404, body: { code: "not_found" } });
    r = await json(await post("set_status", { id: "nope", status: "active" }));
    expect(r.status).toBe(404);
    r = await json(await app.request("/api/v1/set_plan", { method: "POST", body: "{not json" }));
    expect(r).toMatchObject({ status: 400, body: { code: "validation" } });
    r = await json(await post("frobnicate", {}));
    expect(r.status).toBe(404);
    r = await json(await post("acknowledge_answers", { ids: ["q-20260101-zzzz"] }));
    expect(r.status).toBe(404);
  });

  it("serves openapi.json and docs", async () => {
    const doc = (await (await app.request("/openapi.json")).json()) as {
      paths: Record<string, unknown>;
    };
    expect(Object.keys(doc.paths)).toContain("/api/v1/ask_question");
    expect(Object.keys(doc.paths)).toContain("/api/v1/approve");
    const ask = doc.paths["/api/v1/ask_question"] as {
      post: {
        requestBody: { content: { "application/json": { schema: { required: string[] } } } };
      };
    };
    expect(ask.post.requestBody.content["application/json"].schema.required).toEqual([
      "question",
      "blocking",
    ]);
    const docs = await app.request("/api/docs");
    expect(docs.status).toBe(200);
    expect(await docs.text()).toContain("POST /api/v1/ask_question");
  });
});
