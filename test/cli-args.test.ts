import { describe, expect, it } from "vitest";
import { CliError, DEFAULT_PORT, parseCli } from "../src/cli/args.js";

describe("parseCli", () => {
  it("parses init with defaults", () => {
    expect(parseCli(["init"])).toEqual({
      command: "init",
      repo: ".",
      port: DEFAULT_PORT,
      open: false,
      json: false,
    });
  });

  it("parses serve with port and open", () => {
    expect(parseCli(["serve", "--repo", "/tmp/x", "--port", "8080", "--open"])).toEqual({
      command: "serve",
      repo: "/tmp/x",
      port: 8080,
      open: true,
      json: false,
    });
  });

  it("parses mcp and answers", () => {
    expect(parseCli(["mcp"]).command).toBe("mcp");
    expect(parseCli(["answers", "--json"])).toMatchObject({ command: "answers", json: true });
  });

  it("rejects unknown command", () => {
    expect(() => parseCli(["frobnicate"])).toThrow(CliError);
  });

  it("rejects missing command", () => {
    expect(() => parseCli([])).toThrow(/missing command/);
  });

  it("rejects invalid port", () => {
    expect(() => parseCli(["serve", "--port", "abc"])).toThrow(/Invalid --port/);
    expect(() => parseCli(["serve", "--port", "70000"])).toThrow(/Invalid --port/);
  });

  it("help exits 0", () => {
    try {
      parseCli(["--help"]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).exitCode).toBe(0);
    }
  });
});
