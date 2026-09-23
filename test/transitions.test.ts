import { describe, expect, it } from "vitest";
import { allowedTargets, checkTransition } from "../src/domain/transitions.js";
import { type Actor, ballHolder, TOPIC_STATUSES, type TopicStatus } from "../src/domain/types.js";

const ACTORS: Actor[] = ["human", "agent", "system"];

function expectOk(from: TopicStatus, to: TopicStatus, actor: Actor, note?: string) {
  const r = checkTransition(from, to, actor, note);
  expect(r.ok, `${from}→${to} by ${actor} should be allowed`).toBe(true);
}
function expectCode(from: TopicStatus, to: TopicStatus, actor: Actor, code: string, note?: string) {
  const r = checkTransition(from, to, actor, note);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code, `${from}→${to} by ${actor}`).toBe(code);
}

describe("§4 transition table", () => {
  it("backlog → active: human, agent", () => {
    expectOk("backlog", "active", "human");
    expectOk("backlog", "active", "agent");
    expectCode("backlog", "active", "system", "human_only");
  });

  it("active → review: human, agent", () => {
    expectOk("active", "review", "human");
    expectOk("active", "review", "agent");
  });

  it("review → done: human only", () => {
    expectOk("review", "done", "human");
    expectCode("review", "done", "agent", "human_only");
    const r = checkTransition("review", "done", "agent");
    if (!r.ok) expect(r.error.message).toMatch(/never approve their own work/);
    // the human's approve option in the inbox, applied by the system
    expectOk("review", "done", "system");
  });

  it("review → active: human, note required", () => {
    expectOk("review", "active", "human", "needs tests");
    expectCode("review", "active", "human", "note_required");
    expectCode("review", "active", "human", "note_required", "   ");
    expectCode("review", "active", "agent", "human_only", "note");
    // the human's reject option in the inbox, applied by the system
    expectOk("review", "active", "system", "rejected in q-x");
  });

  it("any non-terminal → cancelled: human only", () => {
    for (const from of ["backlog", "active", "needs-decision", "review"] as const) {
      expectOk(from, "cancelled", "human");
      expectCode(from, "cancelled", "agent", "human_only");
      expectCode(from, "cancelled", "system", "human_only");
    }
    expectCode("done", "cancelled", "human", "transition_not_allowed");
  });

  it("done/cancelled → active: human (reopen)", () => {
    expectOk("done", "active", "human");
    expectOk("cancelled", "active", "human");
    expectCode("done", "active", "agent", "human_only");
    expectCode("cancelled", "active", "agent", "human_only");
  });

  it("active ↔ needs-decision: system only", () => {
    expectOk("active", "needs-decision", "system");
    expectOk("needs-decision", "active", "system");
    expectCode("active", "needs-decision", "agent", "system_only");
    expectCode("active", "needs-decision", "human", "system_only");
    expectCode("needs-decision", "active", "human", "system_only");
    expectCode("needs-decision", "active", "agent", "system_only");
  });

  it("todo: the human queues, agent or human picks up", () => {
    expectOk("backlog", "todo", "human");
    expectCode("backlog", "todo", "agent", "human_only");
    expectOk("todo", "backlog", "human");
    expectCode("todo", "backlog", "agent", "human_only");
    expectOk("todo", "active", "agent");
    expectOk("todo", "active", "human");
    expectOk("todo", "cancelled", "human");
    expect(ballHolder("todo")).toBe("agent");
  });

  it("same status is rejected", () => {
    for (const s of TOPIC_STATUSES) expectCode(s, s, "human", "same_status");
  });

  it("every pair not in the table is rejected for every actor", () => {
    const allowed = new Set([
      "backlog>active",
      "backlog>todo",
      "todo>backlog",
      "todo>active",
      "todo>cancelled",
      "active>review",
      "review>done",
      "review>active",
      "backlog>cancelled",
      "active>cancelled",
      "needs-decision>cancelled",
      "review>cancelled",
      "done>active",
      "cancelled>active",
      "active>needs-decision",
      "needs-decision>active",
    ]);
    for (const from of TOPIC_STATUSES) {
      for (const to of TOPIC_STATUSES) {
        if (from === to || allowed.has(`${from}>${to}`)) continue;
        for (const actor of ACTORS) expectCode(from, to, actor, "transition_not_allowed");
      }
    }
  });

  it("allowedTargets reflects the table per actor", () => {
    expect(allowedTargets("review", "human").sort()).toEqual(["active", "cancelled", "done"]);
    expect(allowedTargets("review", "agent")).toEqual([]);
    expect(allowedTargets("active", "agent")).toEqual(["review"]);
    expect(allowedTargets("active", "system")).toEqual(["needs-decision"]);
    expect(allowedTargets("done", "human")).toEqual(["active"]);
  });

  it("ball holder is derived from status", () => {
    expect(ballHolder("backlog")).toBe("human");
    expect(ballHolder("needs-decision")).toBe("human");
    expect(ballHolder("review")).toBe("human");
    expect(ballHolder("active")).toBe("agent");
    expect(ballHolder("done")).toBe("none");
    expect(ballHolder("cancelled")).toBe("none");
  });
});
