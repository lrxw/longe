import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOD_MARKETPLACE, MOD_PLUGIN, modsDir } from "../src/cli/claude-mod.js";
import {
  CODEX_ASK_PROMPT,
  CODEX_STOP_COMMAND,
  codexHooksPath,
  codexStop,
} from "../src/cli/codex-hooks.js";
import {
  chooseIntegrations,
  deepIntegrate,
  deepIntegrationItems,
  promptedChoice,
  removeDeepIntegration,
  runProvider,
} from "../src/cli/deep-integrate.js";
import { runInit } from "../src/cli/init.js";

let dir: string;
const claudeUserSettings = () =>
  path.join(process.env.CLAUDE_CONFIG_DIR as string, "settings.json");

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "longe-deep-integrate-"));
  await rm(path.join(process.env.CODEX_HOME as string, "hooks.json"), { force: true });
  await rm(claudeUserSettings(), { force: true });
  await runInit(dir);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const json = async (file: string) => JSON.parse(await readFile(file, "utf8"));

describe("longe provider deep-integrate", () => {
  it("each provider gets what it supports, in the user's own files; --remove clears them", async () => {
    const results = await deepIntegrate(dir);
    expect(results.map((r) => [r.key, r.changed])).toEqual([
      ["claude:hook", true],
      ["claude:mod", true],
      ["codex:hook", true],
    ]);
    const codexFile = codexHooksPath(dir);
    expect(codexFile).toBe(path.join(process.env.CODEX_HOME as string, "hooks.json"));
    expect((await json(codexFile)).hooks.Stop).toEqual([
      { hooks: [{ type: "command", command: CODEX_STOP_COMMAND, timeout: 10 }] },
    ]);
    expect(
      (await json(path.join(dir, ".claude/settings.local.json"))).hooks.PreToolUse,
    ).toHaveLength(1);
    expect((await deepIntegrate(dir)).every((r) => !r.changed)).toBe(true);

    const removed = await removeDeepIntegration(dir);
    expect(removed.map((r) => r.key)).toEqual(["claude:hook", "claude:mod", "codex:hook"]);
    expect(await json(codexFile)).toEqual({});
    expect(await json(claudeUserSettings())).toEqual({});
    expect(await removeDeepIntegration(dir)).toEqual([]);
  });

  it("the Claude mod: mods/ as a known marketplace, the plugin enabled, other settings kept", async () => {
    await writeFile(
      claudeUserSettings(),
      JSON.stringify({ model: "opus", enabledPlugins: { "other@x": true } }),
    );
    const [mod] = await deepIntegrate(dir, { only: ["claude:mod"] });
    expect(mod?.key).toBe("claude:mod");
    const settings = await json(claudeUserSettings());
    expect(settings.model).toBe("opus");
    expect(settings.enabledPlugins).toEqual({ "other@x": true, [MOD_PLUGIN]: true });
    expect(settings.extraKnownMarketplaces[MOD_MARKETPLACE]).toEqual({
      source: { source: "directory", path: modsDir() },
    });
    // the marketplace the settings point at is the one in the repo
    const market = await json(path.join(modsDir(), ".claude-plugin/marketplace.json"));
    expect(`longe-inbox@${market.name}`).toBe(MOD_PLUGIN);
    await removeDeepIntegration(dir, { providers: ["claude"] });
    expect(await json(claudeUserSettings())).toEqual({
      model: "opus",
      enabledPlugins: { "other@x": true },
    });
  });

  it("explicit flags install and remove only their selection, including shared hooks", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runProvider(["deep-integrate"], dir, { shared: false, remove: false, hook: true });
    await expect(stat(claudeUserSettings())).rejects.toThrow();
    await runProvider(["deep-integrate"], dir, { shared: true, remove: false, hook: true });
    await runProvider(["deep-integrate"], dir, { shared: false, remove: false, mod: true });
    await runProvider(["deep-integrate"], dir, { shared: false, remove: true, mod: true });
    expect(await json(claudeUserSettings())).toEqual({});
    expect(
      (await json(path.join(dir, ".claude/settings.local.json"))).hooks.PreToolUse,
    ).toHaveLength(1);
    expect((await json(path.join(dir, ".claude/settings.json"))).hooks.PreToolUse).toHaveLength(1);
    await runProvider(["deep-integrate"], dir, { shared: false, remove: false, mod: true });
    await runProvider(["deep-integrate", "claude"], dir, {
      shared: false,
      remove: true,
      hook: true,
    });
    expect(await json(path.join(dir, ".claude/settings.local.json"))).toEqual({});
    expect(await json(path.join(dir, ".claude/settings.json"))).toEqual({});
    expect((await json(claudeUserSettings())).enabledPlugins[MOD_PLUGIN]).toBe(true);
    expect((await json(codexHooksPath(dir))).hooks.Stop).toHaveLength(1);
  });

  it("flags bypass even a terminal prompt; noninteractive default and --all select everything", async () => {
    const inputTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const outputTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      expect(await promptedChoice(dir, { shared: false, hook: true })).toEqual([
        "claude:hook",
        "codex:hook",
      ]);
      expect(await promptedChoice(dir, { shared: false, mod: true })).toEqual(["claude:mod"]);
      expect(await promptedChoice(dir, { shared: false, hook: true, mod: true })).toHaveLength(3);
      expect(
        await promptedChoice(dir, { shared: false, providers: ["claude"], hook: true }),
      ).toEqual(["claude:hook"]);
      expect(await promptedChoice(dir, { shared: false, all: true })).toBeUndefined();
      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
      expect(await promptedChoice(dir, { shared: false })).toBeUndefined();
    } finally {
      if (inputTTY) Object.defineProperty(process.stdin, "isTTY", inputTTY);
      else Reflect.deleteProperty(process.stdin, "isTTY");
      if (outputTTY) Object.defineProperty(process.stdout, "isTTY", outputTTY);
      else Reflect.deleteProperty(process.stdout, "isTTY");
    }
  });

  it("unsupported selections fail before touching settings", async () => {
    for (const remove of [false, true]) {
      await expect(
        runProvider(["deep-integrate", "codex"], dir, { shared: false, remove, mod: true }),
      ).rejects.toThrow(/--mod is not available/);
      await expect(
        runProvider(["deep-integrate"], dir, { shared: true, remove, mod: true }),
      ).rejects.toThrow(/user settings/);
      await expect(
        runProvider(["deep-integrate"], dir, { shared: false, remove, hook: true, all: true }),
      ).rejects.toThrow(/Use --all or/);
    }
    await expect(stat(codexHooksPath(dir))).rejects.toThrow();
    await expect(stat(claudeUserSettings())).rejects.toThrow();
  });

  it.each(["{broken", "null", "[]", '{"enabledPlugins":[]}', '{"extraKnownMarketplaces":null}'])(
    "does not overwrite invalid mod settings: %s",
    async (original) => {
      await writeFile(claudeUserSettings(), original);
      await expect(deepIntegrate(dir, { only: ["claude:mod"] })).rejects.toThrow(/fix it first/);
      await expect(removeDeepIntegration(dir, { only: ["claude:mod"] })).rejects.toThrow(
        /fix it first/,
      );
      expect(await readFile(claudeUserSettings(), "utf8")).toBe(original);
    },
  );

  it("the prompt: Enter takes everything; 'n' asks for each one", async () => {
    const items = deepIntegrationItems();
    const lines: string[] = [];
    const answers = (list: string[]) => async () => list.shift() ?? "";
    const write = (t: string) => {
      lines.push(t);
    };
    expect(await chooseIntegrations(dir, items, false, answers([""]), write)).toEqual([
      "claude:hook",
      "claude:mod",
      "codex:hook",
    ]);
    expect(lines.join("")).toContain("inbox mod");
    expect(
      await chooseIntegrations(dir, items, false, answers(["n", "no", "", "y"]), write),
    ).toEqual(["claude:mod", "codex:hook"]);
    expect(
      await chooseIntegrations(dir, items, false, answers(["maybe", "n", "n", "n", "n"]), write),
    ).toEqual([]);
    expect(lines.join("")).toContain("Please answer y or n");
    // --shared: the mod is not offered
    expect(deepIntegrationItems({ shared: true }).map((i) => i.key)).toEqual([
      "claude:hook",
      "codex:hook",
    ]);
  });

  it("a named provider only; other hooks in the file stay; --shared uses the repo's files", async () => {
    await mkdir(path.join(dir, ".codex"));
    await writeFile(
      path.join(dir, ".codex/hooks.json"),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] } }),
    );
    const results = await deepIntegrate(dir, { providers: ["codex"], shared: true });
    expect(results.map((r) => r.file)).toEqual([".codex/hooks.json"]);
    await expect(stat(claudeUserSettings())).rejects.toThrow();
    const stop = (await json(path.join(dir, ".codex/hooks.json"))).hooks.Stop;
    expect(stop).toHaveLength(2);
    await expect(stat(path.join(dir, ".claude/settings.json"))).rejects.toThrow();
    await removeDeepIntegration(dir, { providers: ["codex"], shared: true });
    expect((await json(path.join(dir, ".codex/hooks.json"))).hooks.Stop).toEqual([
      { hooks: [{ type: "command", command: "mine" }] },
    ]);
    await expect(deepIntegrate(dir, { providers: ["gemini"] })).rejects.toThrow(/unknown provider/);
  });
});

describe("Codex Stop hook", () => {
  it("sends the turn on once when the reply ends with a question, inside a longe repo", async () => {
    const out = await codexStop({ cwd: dir, last_assistant_message: "Done.\n\nShould I commit?" });
    expect(JSON.parse(out ?? "{}")).toEqual({ decision: "block", reason: CODEX_ASK_PROMPT });
    // already continued once, no question, or no .longe/ above: let it stop
    expect(
      await codexStop({ cwd: dir, stop_hook_active: true, last_assistant_message: "Ok?" }),
    ).toBeUndefined();
    expect(await codexStop({ cwd: dir, last_assistant_message: "All done." })).toBeUndefined();
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), "longe-no-board-"));
    try {
      expect(await codexStop({ cwd: elsewhere, last_assistant_message: "Ok?" })).toBeUndefined();
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
    await writeFile(path.join(dir, ".longe/config.yml"), "version: 1\nask_in_inbox: false\n");
    expect(await codexStop({ cwd: dir, last_assistant_message: "Ok?" })).toBeUndefined();
  });
});
