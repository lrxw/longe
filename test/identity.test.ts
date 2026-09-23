import { describe, expect, it } from "vitest";
import { monogram, repoColor } from "../src/http/identity.js";

describe("repo identity", () => {
  it("monogram: initials of two words, else first two letters, upper-case", () => {
    expect(monogram("My Shop")).toBe("MS");
    expect(monogram("shop")).toBe("SH");
    expect(monogram("api-gateway")).toBe("AG");
    expect(monogram("x")).toBe("X");
    expect(monogram("")).toBe("?");
  });
  it("color: stable per name, override wins when it is a color", () => {
    expect(repoColor("shop")).toBe(repoColor("shop"));
    expect(repoColor("shop")).toMatch(/^hsl\(\d+ 55% 46%\)$/);
    expect(repoColor("shop")).not.toBe(repoColor("blog"));
    expect(repoColor("shop", "#0af")).toBe("#0af");
    expect(repoColor("shop", "not a color!")).toBe(repoColor("shop"));
  });
});
