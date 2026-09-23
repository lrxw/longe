import { describe, expect, it } from "vitest";
import { monogram, PALETTE, repoColor, repoColors } from "../src/http/identity.js";

describe("repo identity", () => {
  it("monogram: initials of two words, else first two letters, upper-case", () => {
    expect(monogram("My Shop")).toBe("MS");
    expect(monogram("shop")).toBe("SH");
    expect(monogram("api-gateway")).toBe("AG");
    expect(monogram("x")).toBe("X");
    expect(monogram("")).toBe("?");
  });
  it("color: stable per name, from the palette; override wins when it is a color", () => {
    expect(repoColor("shop")).toBe(repoColor("shop"));
    expect(PALETTE).toContain(repoColor("shop"));
    expect(repoColor("shop", "#0af")).toBe("#0af");
    expect(repoColor("shop", "not a color!")).toBe(repoColor("shop"));
  });
  it("colors of a set: distinct up to the palette size, independent of order", () => {
    const names = ["shop", "blog", "api", "docs", "infra", "web", "app", "longe"];
    const colors = repoColors(names.map((name) => ({ name })));
    expect(new Set(colors.values()).size).toBe(PALETTE.length);
    const reversed = repoColors([...names].reverse().map((name) => ({ name })));
    expect([...reversed.entries()].sort()).toEqual([...colors.entries()].sort());
    // alone, a repo keeps its own slot
    expect(repoColors([{ name: "shop" }]).get("shop")).toBe(repoColor("shop"));
    // an override keeps its color and takes no slot
    const o = repoColors([{ name: "shop", override: "#0af" }, { name: "blog" }]);
    expect(o.get("shop")).toBe("#0af");
    expect(o.get("blog")).toBe(repoColor("blog"));
    // more repos than slots: every repo still gets a palette color
    const many = repoColors(Array.from({ length: 10 }, (_, i) => ({ name: `r${i}` })));
    expect(many.size).toBe(10);
  });
});
