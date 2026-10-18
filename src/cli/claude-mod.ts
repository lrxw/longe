import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * The longe-inbox mod: longe's question inbox inside Claude Code (a band above the
 * prompt, a pane, `/longe`). It ships in `mods/` next to `dist/` and is installed the
 * way Claude Code installs plugins from settings: `mods/` becomes a known marketplace
 * (`longe-mods`) and the plugin is enabled. It reads every registered repo, so it goes
 * into the user's own Claude settings (`~/.claude/settings.json`, or
 * `$CLAUDE_CONFIG_DIR`), never into a repo: the path is this machine's.
 */

export const MOD_MARKETPLACE = "longe-mods";
export const MOD_PLUGIN = `longe-inbox@${MOD_MARKETPLACE}`;

interface Settings {
  extraKnownMarketplaces?: Record<string, unknown>;
  enabledPlugins?: Record<string, unknown>;
  [key: string]: unknown;
}

/** `mods/` of this longe, two levels up from this file in src/ and in dist/ alike. */
export function modsDir(): string {
  return path.resolve(import.meta.dirname, "../../mods");
}

/** False for a longe that does not ship the mod (an older or partial install). */
export function modAvailable(): boolean {
  return existsSync(path.join(modsDir(), ".claude-plugin", "marketplace.json"));
}

/** The user's own Claude Code settings file. */
export function claudeUserSettingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(dir, "settings.json");
}

async function readSettings(file: string): Promise<Settings> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`${file} is not valid JSON; fix it first (${String(err)})`);
  }
  const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isObject(parsed)) throw new Error(`${file} must contain a JSON object; fix it first`);
  for (const key of ["extraKnownMarketplaces", "enabledPlugins"])
    if (parsed[key] !== undefined && !isObject(parsed[key]))
      throw new Error(`${file}: ${key} must be a JSON object; fix it first`);
  return parsed as Settings;
}

const marketplace = () => ({ source: { source: "directory", path: modsDir() } });

/** Adds the marketplace and enables the mod; keeps everything else. False when it was there. */
export async function installMod(): Promise<boolean> {
  if (!modAvailable())
    throw new Error(`the longe-inbox mod is not part of this install (${modsDir()})`);
  const file = claudeUserSettingsPath();
  const settings = await readSettings(file);
  const known = settings.extraKnownMarketplaces?.[MOD_MARKETPLACE];
  if (
    JSON.stringify(known) === JSON.stringify(marketplace()) &&
    settings.enabledPlugins?.[MOD_PLUGIN] === true
  )
    return false;
  settings.extraKnownMarketplaces = {
    ...settings.extraKnownMarketplaces,
    [MOD_MARKETPLACE]: marketplace(),
  };
  settings.enabledPlugins = { ...settings.enabledPlugins, [MOD_PLUGIN]: true };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
  return true;
}

/** Takes the mod and its marketplace out again. False when neither was there. */
export async function removeMod(): Promise<boolean> {
  const file = claudeUserSettingsPath();
  const settings = await readSettings(file);
  const had =
    settings.extraKnownMarketplaces?.[MOD_MARKETPLACE] !== undefined ||
    settings.enabledPlugins?.[MOD_PLUGIN] !== undefined;
  if (!had) return false;
  for (const key of ["extraKnownMarketplaces", "enabledPlugins"] as const) {
    const map = { ...settings[key] };
    delete map[key === "enabledPlugins" ? MOD_PLUGIN : MOD_MARKETPLACE];
    if (Object.keys(map).length > 0) settings[key] = map;
    else delete settings[key];
  }
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
  return true;
}
