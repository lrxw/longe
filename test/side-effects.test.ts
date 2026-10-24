import { describe, expect, it } from "vitest";
import { type TopicView, topicEffects } from "../src/board/question-effects.js";
import type { TopicFrontmatter, TopicStatus } from "../src/domain/types.js";
import type { QuestionEvent } from "../src/inbox/events.js";
import { askedNotification } from "../src/inbox/notify.js";
import type { QuestionFrontmatter } from "../src/inbox/types.js";

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
const view = (status: TopicStatus, openBlockingCount = 0): TopicView => ({
  fm: topic(status),
  openBlockingCount,
});

const asked = (question: QuestionFrontmatter, text = "Q"): QuestionEvent => ({
  kind: "asked",
  question,
  text,
});
/** answered or withdrawn, from the question's status */
const closed = (question: QuestionFrontmatter, answer = ""): QuestionEvent =>
  question.status === "withdrawn"
    ? { kind: "withdrawn", question, text: "Q" }
    : { kind: "answered", question, text: "Q", answer };

describe("§5 the board as an inbox consumer", () => {
  it("blocking question on active topic → needs-decision (board) + notification (inbox)", () => {
    expect(topicEffects(asked(q(true), "Which DB?"), view("active", 1))).toEqual([
      {
        kind: "set_topic_status",
        topic: "t1",
        from: "active",
        to: "needs-decision",
        note: "blocked on q-20260922-aaaa",
      },
    ]);
    expect(askedNotification(q(true), "Which DB?", "Topic one")).toEqual({
      title: "Which DB?",
      body: "Blocking · Topic one",
    });
  });

  it("blocking question on non-active topic → no topic move", () => {
    for (const s of ["backlog", "review", "needs-decision", "done"] as const)
      expect(topicEffects(asked(q(true)), view(s, 1))).toEqual([]);
  });

  it("project-wide blocking question → notification only", () => {
    const { topic: _omit, ...projectWide } = q(true);
    expect(topicEffects(asked(projectWide), undefined)).toEqual([]);
    expect(askedNotification(projectWide, "Q", "project-wide")).toEqual({
      title: "Q",
      body: "Blocking · project-wide",
    });
  });

  it("non-blocking question never changes status or notifies", () => {
    expect(topicEffects(asked(q(false)), view("active"))).toEqual([]);
    expect(askedNotification(q(false), "Q", "Topic one")).toBeNull();
    expect(topicEffects(closed(q(false, "answered")), view("needs-decision"))).toEqual([]);
  });

  it("closing the last open blocking question returns topic to active", () => {
    expect(topicEffects(closed(q(true, "answered")), view("needs-decision"))).toEqual([
      {
        kind: "set_topic_status",
        topic: "t1",
        from: "needs-decision",
        to: "active",
        note: "q-20260922-aaaa answered, unblocked",
      },
    ]);
    expect(topicEffects(closed(q(true, "withdrawn")), view("needs-decision"))[0]).toMatchObject({
      note: "q-20260922-aaaa withdrawn, unblocked",
    });
  });

  it("closing a blocking question while others remain open does nothing", () => {
    expect(topicEffects(closed(q(true, "answered")), view("needs-decision", 1))).toEqual([]);
  });

  it("closing a blocking question on a topic not in needs-decision does nothing", () => {
    expect(topicEffects(closed(q(true, "answered")), view("review"))).toEqual([]);
  });

  it("picking a reject option sends a review topic back to active", () => {
    const verify = {
      ...q(false, "answered"),
      options: ["Works", "Broken"],
      reject_options: ["Broken"],
    };
    expect(topicEffects(closed(verify, "Broken\n\nmenu never opens"), view("review"))).toEqual([
      {
        kind: "set_topic_status",
        topic: "t1",
        from: "review",
        to: "active",
        note: "rejected in q-20260922-aaaa: Broken menu never opens",
      },
    ]);
    // an unmarked option or a topic no longer in review: nothing happens
    expect(topicEffects(closed(verify, "Works"), view("review"))).toEqual([]);
    expect(topicEffects(closed(verify, "Broken, sort of"), view("review"))[0]).toMatchObject({
      to: "active",
    });
    expect(topicEffects(closed(verify, "Broken"), view("active"))).toEqual([]);
    expect(topicEffects(closed({ ...verify, status: "withdrawn" }), view("review"))).toEqual([]);
  });

  it("picking an approve option moves a review topic to done", () => {
    const verify = {
      ...q(false, "answered"),
      options: ["Good", "Broken"],
      approve_options: ["Good"],
      reject_options: ["Broken"],
    };
    expect(topicEffects(closed(verify, "Good"), view("review"))).toEqual([
      {
        kind: "set_topic_status",
        topic: "t1",
        from: "review",
        to: "done",
        note: "approved in q-20260922-aaaa: Good",
      },
    ]);
    expect(topicEffects(closed(verify, "Good"), view("active"))).toEqual([]);
  });

  it("custom review feedback follows up even when it starts with an approval label", () => {
    const verify = {
      ...q(false, "answered"),
      options: ["Good", "Broken"],
      approve_options: ["Good"],
      selected_option: null,
    };
    const answer = "Good\n\nBut please change the layout.";
    expect(topicEffects(closed(verify, answer), view("review"))).toEqual([
      {
        kind: "set_topic_status",
        topic: "t1",
        from: "review",
        to: "active",
        note: "follow-up in q-20260922-aaaa: Good But please change the layout.",
      },
    ]);
    for (const status of ["active", "done", "cancelled", "needs-decision"] as const)
      expect(topicEffects(closed(verify, answer), view(status))).toEqual([]);
    expect(topicEffects(closed({ ...verify, status: "withdrawn" }), view("review"))).toEqual([]);
    // ordinary questions do not become review decisions
    expect(
      topicEffects(
        closed({ ...q(false, "answered"), selected_option: null }, answer),
        view("review"),
      ),
    ).toEqual([]);
  });

  it("a subject of another kind is not the board's", () => {
    const { topic: _omit, ...rest } = q(true);
    const issue = { ...rest, subject: { kind: "issue", id: "42" } };
    expect(topicEffects(asked(issue), undefined)).toEqual([]);
  });
});
