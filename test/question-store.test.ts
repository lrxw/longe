import { describe, expect, it } from "vitest";
import {
  acknowledgeQuestion,
  answerQuestion,
  withdrawQuestion,
} from "../src/domain/question-ops.js";
import { askQuestionInputSchema } from "../src/domain/schemas.js";
import {
  newQuestionText,
  parseQuestion,
  questionSections,
  serializeQuestion,
} from "../src/store/question.js";

const now = new Date(2026, 8, 22, 15, 2, 0);
const later = new Date(2026, 8, 22, 16, 30, 0);

const sample = `---
id: q-20260922-3f9a
topic: billing-refactor         # optional
asked_by: claude-code
asked_at: 2026-09-22T15:02:00+02:00
status: open
blocking: false
options:
  - Keep Stripe webhooks
  - Poll Stripe API
assumption: Keep Stripe webhooks
answered_at:
acknowledged_at:
---
## Question
Should refunds be handled via webhooks or by polling the Stripe API?

## Context
Determines whether I need to add an idempotency table.

## Answer
`;

describe("question store", () => {
  it("parses the spec sample and round-trips", () => {
    const q = parseQuestion(sample, { expectedId: "q-20260922-3f9a" });
    expect(q.fm.topic).toBe("billing-refactor");
    expect(q.fm.blocking).toBe(false);
    expect(q.fm.options).toEqual(["Keep Stripe webhooks", "Poll Stripe API"]);
    expect(q.fm.answered_at).toBeNull();
    expect(questionSections(q).Answer).toBe("");
    expect(serializeQuestion(q)).toBe(sample);
  });

  it("enforces blocking:false ⇒ assumption", () => {
    const noAssumption = sample.replace("assumption: Keep Stripe webhooks\n", "");
    expect(() => parseQuestion(noAssumption)).toThrow(/assumption/);
    expect(() =>
      parseQuestion(noAssumption.replace("blocking: false", "blocking: true")),
    ).not.toThrow();
    expect(askQuestionInputSchema.safeParse({ question: "Q?", blocking: false }).success).toBe(
      false,
    );
    expect(
      askQuestionInputSchema.safeParse({ question: "Q?", blocking: false, assumption: "A" })
        .success,
    ).toBe(true);
    expect(askQuestionInputSchema.safeParse({ question: "Q?", blocking: true }).success).toBe(true);
  });

  it("rejects bad option counts and ids", () => {
    expect(() => parseQuestion(sample.replace("  - Poll Stripe API\n", ""))).toThrow(/options/);
    expect(() => parseQuestion(sample.replace("q-20260922-3f9a", "q-1"))).toThrow(/id/);
  });

  it("creates new question text that parses back", () => {
    const text = newQuestionText({
      id: "q-20260922-ab12",
      question: "Webhooks or polling?",
      context: "Because reasons.",
      topic: "billing-refactor",
      options: ["Webhooks", "Polling: slow"],
      assumption: "Webhooks",
      blocking: false,
      asked_by: "claude-code",
      now,
    });
    const q = parseQuestion(text, { expectedId: "q-20260922-ab12" });
    expect(q.fm.options).toEqual(["Webhooks", "Polling: slow"]);
    expect(q.fm.status).toBe("open");
    expect(questionSections(q)).toEqual({
      Question: "Webhooks or polling?",
      Context: "Because reasons.",
      Answer: "",
    });
    expect(serializeQuestion(parseQuestion(text))).toBe(text);

    const minimal = newQuestionText({
      id: "q-20260922-ab13",
      question: "Q?",
      blocking: true,
      asked_by: "x",
      now,
    });
    expect(parseQuestion(minimal).fm.topic).toBeUndefined();
  });

  it("answer by option, then acknowledge", () => {
    const q = parseQuestion(sample);
    answerQuestion(q, { option_index: 1, note: "Polling is fine for now." }, later);
    expect(q.fm.status).toBe("answered");
    expect(q.fm.answered_at).toMatch(/^2026-09-22T16:30:00/);
    expect(questionSections(q).Answer).toBe("Poll Stripe API\n\nPolling is fine for now.");
    expect(() => answerQuestion(q, { answer: "again" }, later)).toThrow(/not open/);
    acknowledgeQuestion(q, later);
    expect(q.fm.status).toBe("acknowledged");
    expect(q.fm.acknowledged_at).toMatch(/^2026-09-22T16:30:00/);
    const out = serializeQuestion(q);
    expect(out).toContain("# optional"); // comment kept
    expect(serializeQuestion(parseQuestion(out))).toBe(out);
  });

  it("answer by free text; rejects empty and out-of-range", () => {
    const q = parseQuestion(sample);
    expect(() => answerQuestion(q, {}, later)).toThrow(/required/);
    expect(() => answerQuestion(q, { option_index: 5 }, later)).toThrow(/out of range/);
    answerQuestion(q, { answer: "  Neither, use both.  " }, later);
    expect(questionSections(q).Answer).toBe("Neither, use both.");
  });

  it("withdraw appends reason to Context", () => {
    const q = parseQuestion(sample);
    expect(() => withdrawQuestion(q, "  ", later)).toThrow(/reason/);
    withdrawQuestion(q, "Found it in the docs.", later);
    expect(q.fm.status).toBe("withdrawn");
    expect(questionSections(q).Context).toBe(
      "Determines whether I need to add an idempotency table.\nWithdrawn 2026-09-22 16:30 — Found it in the docs.",
    );
    expect(() => acknowledgeQuestion(q, later)).toThrow(/not answered/);
  });
});
