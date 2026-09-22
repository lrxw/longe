import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addDecision, appendLog, setPlan, transitionTopic } from "../src/domain/topic-ops.js";
import { newTopicText, parseTopic, serializeTopic, topicSections } from "../src/store/topic.js";

const fixture = (name: string) => readFile(path.join(import.meta.dirname, "fixtures", name), "utf8");
const now = new Date(2026, 8, 22, 15, 2, 0);

describe("topic store", () => {
  it("parses the odd fixture with unknown fields and sections", async () => {
    const t = parseTopic(await fixture("topic-odd.md"), { expectedId: "odd-topic" });
    expect(t.fm.id).toBe("odd-topic");
    expect(t.fm.title).toBe("Odd: topic");
    expect(t.fm.status).toBe("active");
    expect(t.fm.links).toEqual(["https://github.com/org/repo/pull/42"]);
    expect(t.fm.branch).toBeNull();
    expect(t.fm.custom_field).toBe("keep me");
    expect(topicSections(t).Plan).toBe("- [x] Step one\n- [ ] Step two");
  });

  it("rejects id/filename mismatch, bad status, missing sections", async () => {
    const text = await fixture("topic-odd.md");
    expect(() => parseTopic(text, { expectedId: "other" })).toThrow(/does not match filename/);
    expect(() => parseTopic(text.replace("status: active", "status: bogus"))).toThrow(/status/);
    expect(() => parseTopic(text.replace("## Decisions", "## Nope"))).toThrow(/## Decisions/);
    expect(() => parseTopic(text.replace("updated: 2026-09-22T14:10:00+02:00", "updated: yesterday"))).toThrow(
      /updated/,
    );
  });

  it("creates a new topic file that parses back", () => {
    const text = newTopicText({ id: "new-one", title: "New: one", goal: "Do it.", plan: "- [ ] a", now });
    const t = parseTopic(text, { expectedId: "new-one" });
    expect(t.fm.status).toBe("backlog");
    expect(t.fm.title).toBe("New: one");
    expect(t.fm.created).toBe(t.fm.updated);
    expect(topicSections(t)).toEqual({ Goal: "Do it.", Plan: "- [ ] a", Decisions: "", Log: "" });
    expect(text.endsWith("## Log\n")).toBe(true);
    // stable through the editor
    expect(serializeTopic(parseTopic(text))).toBe(text);
  });

  it("setPlan / addDecision / appendLog edit only their sections and bump updated", () => {
    const t = parseTopic(newTopicText({ id: "t", title: "T", goal: "G", now: new Date(2026, 0, 1) }));
    const before = t.fm.updated;
    setPlan(t, "- [x] one\n- [ ] two", now);
    addDecision(t, "Chose A over B.", now);
    appendLog(t, "Did one.", "agent", now);
    appendLog(t, "Looks good.", "human", now);
    const s = topicSections(t);
    expect(s.Goal).toBe("G");
    expect(s.Plan).toBe("- [x] one\n- [ ] two");
    expect(s.Decisions).toBe("- 2026-09-22 — Chose A over B.");
    expect(s.Log).toBe("- 2026-09-22 15:02 agent — Did one.\n- 2026-09-22 15:02 human — Looks good.");
    expect(t.fm.updated).not.toBe(before);
    expect(t.fm.created).toBe("2026-01-01T00:00:00" + t.fm.created.slice(19));
    // serialized output re-parses identically
    const out = serializeTopic(t);
    expect(serializeTopic(parseTopic(out))).toBe(out);
  });

  it("transitionTopic writes status and log entries", () => {
    const t = parseTopic(newTopicText({ id: "t", title: "T", goal: "G", now }));
    transitionTopic(t, "active", "agent", now);
    expect(t.fm.status).toBe("active");
    transitionTopic(t, "review", "agent", now, "done with it");
    transitionTopic(t, "active", "human", now, "needs tests");
    expect(topicSections(t).Log).toBe(
      "- 2026-09-22 15:02 agent — done with it\n- 2026-09-22 15:02 human — rejected: needs tests",
    );
    transitionTopic(t, "review", "agent", now);
    expect(() => transitionTopic(t, "done", "agent", now)).toThrow(/human-only/);
    expect(t.fm.status).toBe("review");
  });
});
