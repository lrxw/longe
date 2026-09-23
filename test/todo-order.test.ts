import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AppContext, closeAppContext, createAppContext } from "../src/app/context.js";
import { runInit } from "../src/cli/init.js";
import { todoOrder } from "../src/domain/topic-ops.js";
import { createHttpApp } from "../src/http/app.js";
import { human, setTopicStatus } from "../src/tools/ops.js";

const t = (id: string, updated: string, rank?: number) => ({
  id,
  fm: { updated, ...(rank !== undefined ? { rank } : {}) },
});

describe("todo order", () => {
  it("ranked topics first by rank, the rest by when they entered todo", () => {
    const order = todoOrder([
      t("new", "2026-09-23T12:00:00+02:00"),
      t("second", "2026-09-23T09:00:00+02:00", 2),
      t("old", "2026-09-23T08:00:00+02:00"),
      t("first", "2026-09-23T11:00:00+02:00", 1),
    ]).map((x) => x.id);
    expect(order).toEqual(["first", "second", "old", "new"]);
  });
});

describe("reordering the todo queue", () => {
  let dir: string;
  let ctx: AppContext;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "longe-order-"));
    await runInit(dir);
    ctx = await createAppContext(dir, { index: { debounceMs: 20, usePolling: true } });
  });
  afterEach(async () => {
    await closeAppContext(ctx);
    await rm(dir, { recursive: true, force: true });
  });

  it("the board shows the queue order; dragging saves ranks; re-entering todo goes last", async () => {
    for (const title of ["Alpha", "Beta", "Gamma"])
      await human.addTopic(ctx, { title, status: "todo" });
    const app = createHttpApp(ctx);
    const column = async () => {
      const html = await (await app.request("/fragments/board")).text();
      const todo = html.slice(html.indexOf('id="col-todo"'), html.indexOf('id="col-active"'));
      return [...todo.matchAll(/data-id="([a-z-]+)"/g)].map((m) => m[1]);
    };
    expect(await column()).toEqual(["alpha", "beta", "gamma"]);

    // drag Gamma to the top
    const res = await app.request("/topics/order", {
      method: "POST",
      body: new URLSearchParams({ ids: "gamma,alpha,beta" }),
    });
    expect(res.status).toBe(200);
    expect(await column()).toEqual(["gamma", "alpha", "beta"]);
    expect(await readFile(path.join(dir, ".longe/topics/gamma.md"), "utf8")).toContain("rank: 1");

    // Gamma leaves todo and comes back: it joins at the end, without its old rank
    await setTopicStatus(ctx, "gamma", "backlog", "human");
    await setTopicStatus(ctx, "gamma", "todo", "human");
    expect(await column()).toEqual(["alpha", "beta", "gamma"]);
    expect(await readFile(path.join(dir, ".longe/topics/gamma.md"), "utf8")).not.toContain("rank:");
  });
});
