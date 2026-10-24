import { describe, expect, it } from "vitest";
import * as mod from "../mods/longe-inbox/hooks/tokens.js";
import {
  buildInboxView,
  INBOX_TOKENS,
  INBOX_VIEW_VERSION,
  type InboxSource,
} from "../src/inbox/view.js";

const repo = { name: "shop", title: "Shop", color: "#123456" };
const src = (over: Partial<InboxSource>): InboxSource => ({
  id: "q-20261018-aaaa",
  repo,
  subject: null,
  links: { project: "/r/shop/board", subject: null },
  blocking: false,
  askedBy: "claude",
  askedAt: "2026-10-18T10:00:00+02:00",
  question: "Q?",
  context: "",
  options: [],
  approveOptions: [],
  rejectOptions: [],
  ...over,
});

describe("inbox view model", () => {
  it("orders blocking first, then oldest; option roles, context and links", () => {
    const view = buildInboxView([
      src({ id: "q-20261018-late", askedAt: "2026-10-18T12:00:00+02:00" }),
      src({
        id: "q-20261018-revw",
        options: ["Works", "Broken", "Later"],
        approveOptions: ["Works"],
        rejectOptions: ["Broken"],
        subject: { kind: "topic", id: "export" },
        links: { project: "/r/shop/board", subject: "/r/shop/topics/export" },
        context: "```ts\nx\n```",
      }),
      src({ id: "q-20261018-blok", blocking: true, askedAt: "2026-10-18T13:00:00+02:00" }),
    ]);
    expect(view.version).toBe(INBOX_VIEW_VERSION);
    expect(view.questions.map((q) => q.id)).toEqual([
      "q-20261018-blok",
      "q-20261018-revw",
      "q-20261018-late",
    ]);
    expect(view.counts).toEqual({ total: 3, blocking: 1, nonBlocking: 2, projects: 1 });
    const review = view.questions[1];
    expect(review?.options.map((o) => o.role)).toEqual(["approve", "reject", "neutral"]);
    expect(review?.review).toBe(true);
    expect(review?.contextOpen).toBe(true);
    expect(review?.links).toEqual({ board: "/r/shop/board", topic: "/r/shop/topics/export" });
    expect(review?.subject).toEqual({ kind: "topic", id: "export" });
    expect(review?.topic).toBe("export");
    expect(view.questions[0]?.kind).toBe("blocking");
    expect(view.questions[2]?.topic).toBeNull();
  });

  it("the mod's copy of the tokens matches longe's", () => {
    expect(mod.INBOX_VIEW_VERSION).toBe(INBOX_VIEW_VERSION);
    expect(mod.INBOX_TOKENS).toEqual(INBOX_TOKENS);
    // every role has a theme key in the mod
    expect(Object.keys(mod.THEME).sort()).toEqual(Object.keys(INBOX_TOKENS.roles).sort());
    expect(mod.optionRole("x", { approveOptions: ["x"], rejectOptions: ["x"] })).toBe("reject");
  });
});
