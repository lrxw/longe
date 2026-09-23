import { describe, expect, it, vi } from "vitest";
import { headline } from "../src/domain/side-effects.js";
import { coalescing } from "../src/notify/notifier.js";

describe("notifications", () => {
  it("a burst becomes one notification per repo; a single one goes out as it is", () => {
    vi.useFakeTimers();
    try {
      const sent: string[] = [];
      const notify = coalescing((t, b) => sent.push(`${t} | ${b}`), 5000);
      notify("longe · Which DB?", "Blocking · Billing");
      notify("longe · Tabs or spaces?", "Blocking · Style");
      notify("shop · Why?", "Blocking · project-wide");
      expect(sent).toEqual([]);
      vi.advanceTimersByTime(5000);
      expect(sent).toEqual([
        "longe · 2 blocking questions | Which DB?; Tabs or spaces?",
        "shop · Why? | Blocking · project-wide",
      ]);
      notify("longe · Deploy now?", "Blocking · Release");
      vi.advanceTimersByTime(5000);
      expect(sent.at(-1)).toBe("longe · Deploy now? | Blocking · Release");
    } finally {
      vi.useRealTimers();
    }
  });

  it("headline: the question's first sentence, without markdown", () => {
    expect(
      headline("**Should dragging a topic to Active wake the chat?** My view: yes.\n\nMore text."),
    ).toBe("Should dragging a topic to Active wake the chat?");
    expect(headline("Use `pnpm` or [npm](https://npmjs.com)?")).toBe("Use pnpm or npm?");
    expect(headline("Short? Then more words follow here.")).toBe(
      "Short? Then more words follow here.",
    );
    expect(headline("x".repeat(200))).toHaveLength(90);
    expect(headline("")).toBe("Question");
  });
});
