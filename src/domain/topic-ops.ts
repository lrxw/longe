import { appendLine, replaceSection, setField } from "../store/markdown.js";
import { refreshTopic, type Topic } from "../store/topic.js";
import { dateStamp, minuteStamp, toLocalIso } from "./time.js";
import { assertTransition } from "./transitions.js";
import type { Actor, TopicStatus } from "./types.js";

/** In-place mutations of a parsed topic. All bump `updated`. Callers persist via modifyFile. */

function touch(topic: Topic, now: Date): void {
  setField(topic.doc, "updated", toLocalIso(now));
  refreshTopic(topic);
}

export function setPlan(topic: Topic, plan: string, now: Date): void {
  replaceSection(topic.doc, "Plan", plan);
  touch(topic, now);
}

export function decisionLine(text: string, now: Date): string {
  return `- ${dateStamp(now)} — ${text.trim()}`;
}

export function addDecision(topic: Topic, text: string, now: Date): void {
  appendLine(topic.doc, "Decisions", decisionLine(text, now));
  touch(topic, now);
}

export function logLine(text: string, actor: string, now: Date): string {
  return `- ${minuteStamp(now)} ${actor} — ${text.trim()}`;
}

export function appendLog(topic: Topic, text: string, actor: string, now: Date): void {
  appendLine(topic.doc, "Log", logLine(text, actor, now));
  touch(topic, now);
}

/**
 * Applies a §4 transition after checking it. Writes a Log entry when a note is
 * given; a reject (`review → active` by a human) is logged as `human — rejected: <note>`.
 */
export function transitionTopic(
  topic: Topic,
  to: TopicStatus,
  actor: Actor,
  now: Date,
  note?: string | null,
): void {
  const from = topic.fm.status;
  assertTransition(from, to, actor, note);
  setField(topic.doc, "status", to);
  const trimmed = note?.trim();
  if (trimmed) {
    const text =
      from === "review" && to === "active" && actor === "human" ? `rejected: ${trimmed}` : trimmed;
    appendLine(topic.doc, "Log", logLine(text, actor, now));
  }
  touch(topic, now);
}
