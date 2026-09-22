import { describe, expect, it } from "vitest";
import { QUESTION_ID_RE, newQuestionId, slugify, uniqueQuestionId, uniqueSlug } from "../src/store/ids.js";

describe("slugify", () => {
  it("normalizes titles", () => {
    expect(slugify("Billing refactor")).toBe("billing-refactor");
    expect(slugify("  Ünïcode & symbols!! ")).toBe("unicode-symbols");
    expect(slugify("---")).toBe("topic");
    expect(slugify("a".repeat(100)).length).toBe(64);
  });

  it("suffixes on collision", () => {
    expect(uniqueSlug("x", [])).toBe("x");
    expect(uniqueSlug("x", ["x"])).toBe("x-2");
    expect(uniqueSlug("x", ["x", "x-2", "x-3"])).toBe("x-4");
  });
});

describe("question ids", () => {
  const now = new Date(2026, 8, 22, 15, 2, 0);

  it("match q-YYYYMMDD-xxxx", () => {
    const id = newQuestionId(now);
    expect(id).toMatch(QUESTION_ID_RE);
    expect(id.startsWith("q-20260922-")).toBe(true);
  });

  it("use the injected rng and avoid collisions", () => {
    let calls = 0;
    const rng = () => calls++ % 36;
    const first = newQuestionId(now, rng);
    expect(first).toBe("q-20260922-0123");
    calls = 0;
    expect(uniqueQuestionId(now, [first], rng)).toBe("q-20260922-4567");
  });
});
