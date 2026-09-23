import { describe, expect, it } from "vitest";
import { effectsForQuestionClosed, effectsForQuestionCreated } from "../src/domain/side-effects.js";
import type { QuestionFrontmatter, TopicFrontmatter, TopicStatus } from "../src/domain/types.js";

const topic = (status: TopicStatus): TopicFrontmatter => ({
  id: "t1",
  title: "Topic one",
  status,
  created: "2026-09-22T10:00:00+02:00",
  updated: "2026-09-22T10:00:00+02:00",
  links: [],
});
const q = (
  blocking: boolean,
  status: QuestionFrontmatter["status"] = "open",
): QuestionFrontmatter => ({
  id: "q-20260922-aaaa",
  topic: "t1",
  asked_by: "agent",
  asked_at: "2026-09-22T11:00:00+02:00",
  status,
  blocking,
  ...(blocking ? {} : { assumption: "x" }),
});

describe("§5 side effects", () => {
  it("blocking question on active topic → needs-decision + log + notify", () => {
    const fx = effectsForQuestionCreated(q(true), "Which DB?", {
      fm: topic("active"),
      openBlockingCount: 1,
    });
    expect(fx).toEqual([
      {
        kind: "set_topic_status",
        topic: "t1",
        from: "active",
        to: "needs-decision",
        note: "blocked on q-20260922-aaaa",
      },
      { kind: "notify", title: "Which DB?", body: "Blocking · Topic one" },
    ]);
  });

  it("blocking question on non-active topic → notify only", () => {
    for (const s of ["backlog", "review", "needs-decision", "done"] as const) {
      const fx = effectsForQuestionCreated(q(true), "Q", { fm: topic(s), openBlockingCount: 1 });
      expect(fx.map((e) => e.kind)).toEqual(["notify"]);
    }
  });

  it("project-wide blocking question → notify only", () => {
    const { topic: _omit, ...projectWide } = q(true);
    expect(effectsForQuestionCreated(projectWide, "Q", undefined)).toEqual([
      { kind: "notify", title: "Q", body: "Blocking · project-wide" },
    ]);
  });

  it("non-blocking question never changes status or notifies", () => {
    expect(
      effectsForQuestionCreated(q(false), "Q", { fm: topic("active"), openBlockingCount: 0 }),
    ).toEqual([]);
    expect(
      effectsForQuestionClosed(q(false, "answered"), {
        fm: topic("needs-decision"),
        openBlockingCount: 0,
      }),
    ).toEqual([]);
  });

  it("closing the last open blocking question returns topic to active", () => {
    const fx = effectsForQuestionClosed(q(true, "answered"), {
      fm: topic("needs-decision"),
      openBlockingCount: 0,
    });
    expect(fx).toEqual([
      {
        kind: "set_topic_status",
        topic: "t1",
        from: "needs-decision",
        to: "active",
        note: "q-20260922-aaaa answered, unblocked",
      },
    ]);
    const wd = effectsForQuestionClosed(q(true, "withdrawn"), {
      fm: topic("needs-decision"),
      openBlockingCount: 0,
    });
    expect(wd[0]).toMatchObject({ note: "q-20260922-aaaa withdrawn, unblocked" });
  });

  it("closing a blocking question while others remain open does nothing", () => {
    expect(
      effectsForQuestionClosed(q(true, "answered"), {
        fm: topic("needs-decision"),
        openBlockingCount: 1,
      }),
    ).toEqual([]);
  });

  it("closing a blocking question on a topic not in needs-decision does nothing", () => {
    expect(
      effectsForQuestionClosed(q(true, "answered"), { fm: topic("review"), openBlockingCount: 0 }),
    ).toEqual([]);
  });

  it("picking a reject option sends a review topic back to active", () => {
    const verify = {
      ...q(false, "answered"),
      options: ["Works", "Broken"],
      reject_options: ["Broken"],
    };
    const review = { fm: topic("review"), openBlockingCount: 0 };
    expect(effectsForQuestionClosed(verify, review, "Broken\n\nmenu never opens")).toEqual([
      {
        kind: "set_topic_status",
        topic: "t1",
        from: "review",
        to: "active",
        note: "rejected in q-20260922-aaaa: Broken menu never opens",
      },
    ]);
    // other options, free text, or a topic no longer in review: nothing happens
    expect(effectsForQuestionClosed(verify, review, "Works")).toEqual([]);
    expect(effectsForQuestionClosed(verify, review, "Broken, sort of")).toEqual([]);
    expect(
      effectsForQuestionClosed(verify, { fm: topic("active"), openBlockingCount: 0 }, "Broken"),
    ).toEqual([]);
    expect(effectsForQuestionClosed({ ...verify, status: "withdrawn" }, review, "Broken")).toEqual(
      [],
    );
  });

  it("picking an approve option moves a review topic to done", () => {
    const verify = {
      ...q(false, "answered"),
      options: ["Good", "Broken"],
      approve_options: ["Good"],
      reject_options: ["Broken"],
    };
    const review = { fm: topic("review"), openBlockingCount: 0 };
    expect(effectsForQuestionClosed(verify, review, "Good")).toEqual([
      {
        kind: "set_topic_status",
        topic: "t1",
        from: "review",
        to: "done",
        note: "approved in q-20260922-aaaa: Good",
      },
    ]);
    expect(
      effectsForQuestionClosed(verify, { fm: topic("active"), openBlockingCount: 0 }, "Good"),
    ).toEqual([]);
  });
});
