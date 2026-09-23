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
  it("colors of a set: handed out in registry order, the most different first", () => {
    const names = ["longe", "business-card", "shop", "blog"];
    const colors = repoColors(names.map((name) => ({ name })));
    expect([...colors.values()]).toEqual(PALETTE.slice(0, 4));
    expect(colors.get("longe")).toBe("hsl(214 70% 48%)"); // blue
    expect(colors.get("business-card")).toBe("hsl(28 88% 48%)"); // orange
    // a repo added later is appended: the others keep their colors
    const more = repoColors([...names, "new"].map((name) => ({ name })));
    for (const n of names) expect(more.get(n)).toBe(colors.get(n));
    // an override keeps its color and takes no slot
    const o = repoColors([{ name: "shop", override: "#0af" }, { name: "blog" }]);
    expect(o.get("shop")).toBe("#0af");
    expect(o.get("blog")).toBe(PALETTE[0]);
    // past the palette the colors repeat
    const many = repoColors(Array.from({ length: 10 }, (_, i) => ({ name: `r${i}` })));
    expect(many.get("r8")).toBe(PALETTE[0]);
  });
});
