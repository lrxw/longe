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
      daemon: false,
      repoGiven: false,
      rest: [],
    });
  });

  it("parses serve with port and open", () => {
    expect(parseCli(["serve", "--repo", "/tmp/x", "--port", "8080", "--open"])).toEqual({
      command: "serve",
      repo: "/tmp/x",
      port: 8080,
      open: true,
      json: false,
      daemon: false,
      repoGiven: true,
      rest: [],
    });
  });

  it("parses mcp and answers", () => {
    expect(parseCli(["mcp"]).command).toBe("mcp");
    expect(parseCli(["answers", "--json"])).toMatchObject({ command: "answers", json: true });
    expect(parseCli(["serve", "-d"])).toMatchObject({ command: "serve", daemon: true });
    expect(parseCli(["stop"]).command).toBe("stop");
    expect(parseCli(["status"]).command).toBe("status");
    expect(parseCli(["repos", "add", "/x", "--name", "X"])).toMatchObject({
      command: "repos",
      rest: ["add", "/x"],
      name: "X",
    });
  });

  it("reports missing option values and unknown flags with usage", () => {
    expect(() => parseCli(["serve", "--repo"])).toThrow(/argument missing[\s\S]*Usage:/);
    expect(() => parseCli(["serve", "--bogus"])).toThrow(/Unknown option[\s\S]*Usage:/);
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

  it("--version and -v print the package version and exit 0", () => {
    for (const flag of ["--version", "-v"]) {
      try {
        parseCli([flag]);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(CliError);
        expect((e as CliError).exitCode).toBe(0);
        expect((e as CliError).message).toMatch(/^longe \d+\.\d+\.\d+/);
      }
    }
  });
});
