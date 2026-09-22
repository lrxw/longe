import { describe, expect, it } from "vitest";
import { dateStamp, isIsoTimestamp, minuteStamp, toLocalIso } from "../src/domain/time.js";

describe("time", () => {
  const d = new Date(2026, 8, 22, 14, 10, 5);

  it("formats ISO with local offset", () => {
    const s = toLocalIso(d);
    expect(s).toMatch(/^2026-09-22T14:10:05[+-]\d{2}:\d{2}$/);
    expect(isIsoTimestamp(s)).toBe(true);
    expect(new Date(s).getTime()).toBe(d.getTime());
  });

  it("formats stamps", () => {
    expect(dateStamp(d)).toBe("2026-09-22");
    expect(minuteStamp(d)).toBe("2026-09-22 14:10");
  });

  it("validates timestamps", () => {
    expect(isIsoTimestamp("2026-09-22T14:10:00+02:00")).toBe(true);
    expect(isIsoTimestamp("2026-09-22T14:10:00Z")).toBe(true);
    expect(isIsoTimestamp("2026-09-22 14:10")).toBe(false);
    expect(isIsoTimestamp("2026-13-99T14:10:00+02:00")).toBe(false);
    expect(isIsoTimestamp(42)).toBe(false);
  });
});
