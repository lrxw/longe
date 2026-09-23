import { describe, expect, it, vi } from "vitest";
import { coalescing } from "../src/notify/notifier.js";

describe("coalescing notifier", () => {
  it("sends a burst as one notification per title, with a count", () => {
    vi.useFakeTimers();
    try {
      const sent: string[] = [];
      const notify = coalescing((t, b) => sent.push(`${t} | ${b}`), 5000);
      notify("longe · Blocking question", "A: which DB?");
      notify("longe · Blocking question", "B: tabs?");
      notify("shop · Blocking question", "C: why?");
      expect(sent).toEqual([]);
      vi.advanceTimersByTime(5000);
      expect(sent).toEqual([
        "longe · Blocking question (2) | A: which DB?; B: tabs?",
        "shop · Blocking question | C: why?",
      ]);
      notify("longe · Blocking question", "D");
      vi.advanceTimersByTime(5000);
      expect(sent.at(-1)).toBe("longe · Blocking question | D");
    } finally {
      vi.useRealTimers();
    }
  });
});
