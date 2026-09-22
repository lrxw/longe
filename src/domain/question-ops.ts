import { appendLine, replaceSection, setField } from "../store/markdown.js";
import { type Question, refreshQuestion } from "../store/question.js";
import { DomainError } from "./errors.js";
import { minuteStamp, toLocalIso } from "./time.js";

export interface AnswerInput {
  answer?: string | undefined;
  option_index?: number | undefined;
  note?: string | undefined;
}

/** Resolves `answer` / `option_index` / `note` into the text stored under `## Answer`. */
export function resolveAnswerText(q: Question, input: AnswerInput): string {
  let base: string | undefined;
  if (input.option_index !== undefined) {
    const options = q.fm.options ?? [];
    const chosen = options[input.option_index];
    if (chosen === undefined) {
      throw new DomainError(
        "validation",
        `option_index ${input.option_index} out of range (question has ${options.length} options)`,
      );
    }
    base = chosen;
  } else if (input.answer?.trim()) {
    base = input.answer.trim();
  }
  if (base === undefined)
    throw new DomainError("validation", "answer text or option_index is required");
  const note = input.note?.trim();
  return note ? `${base}\n\n${note}` : base;
}

export function answerQuestion(q: Question, input: AnswerInput, now: Date): void {
  if (q.fm.status !== "open") {
    throw new DomainError(
      "transition_not_allowed",
      `question ${q.fm.id} is ${q.fm.status}, not open`,
    );
  }
  const text = resolveAnswerText(q, input);
  replaceSection(q.doc, "Answer", text);
  setField(q.doc, "status", "answered");
  setField(q.doc, "answered_at", toLocalIso(now));
  refreshQuestion(q);
}

export function acknowledgeQuestion(q: Question, now: Date): void {
  if (q.fm.status !== "answered") {
    throw new DomainError(
      "transition_not_allowed",
      `question ${q.fm.id} is ${q.fm.status}, not answered`,
    );
  }
  setField(q.doc, "status", "acknowledged");
  setField(q.doc, "acknowledged_at", toLocalIso(now));
  refreshQuestion(q);
}

export function withdrawQuestion(q: Question, reason: string, now: Date): void {
  if (q.fm.status !== "open") {
    throw new DomainError(
      "transition_not_allowed",
      `question ${q.fm.id} is ${q.fm.status}, not open`,
    );
  }
  const r = reason.trim();
  if (!r) throw new DomainError("validation", "withdraw requires a reason");
  appendLine(q.doc, "Context", `Withdrawn ${minuteStamp(now)} — ${r}`);
  setField(q.doc, "status", "withdrawn");
  refreshQuestion(q);
}
