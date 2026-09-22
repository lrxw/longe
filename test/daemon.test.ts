import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isAlive,
  listRecords,
  probeHealth,
  startDaemon,
  stopDaemon,
  writeRecord,
} from "../src/cli/daemon.js";
import { runInit } from "../src/cli/init.js";

let dir: string;
async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "longe-daemon-"));
  process.env.XDG_CACHE_HOME = path.join(dir, "cache");
  await runInit(dir);
});
afterEach(async () => {
  for (const r of await listRecords()) await stopDaemon(r);
  await rm(dir, { recursive: true, force: true });
});

describe("serve --daemon", () => {
  it("starts detached, answers /health, is listed, and stops", async () => {
    const port = await freePort();
    const rec = await startDaemon({
      root: dir,
      port,
      script: path.resolve("src/cli/main.ts"),
      execArgv: ["--import", "tsx"],
    });
    await writeRecord(rec);
    expect(isAlive(rec.pid)).toBe(true);
    const h = await probeHealth(port);
    expect(h?.root).toBe(dir);
    expect(h?.pid).toBe(rec.pid);
    expect((await listRecords()).map((r) => r.root)).toEqual([dir]);
    expect(await readFile(rec.log, "utf8")).toContain("longe serving");

    expect(await stopDaemon(rec)).toBe(true);
    expect(isAlive(rec.pid)).toBe(false);
    expect(await probeHealth(port)).toBeUndefined();
    expect(await listRecords()).toEqual([]);
  }, 20000);

  it("stopDaemon on a dead record just cleans up", async () => {
    const rec = { pid: 999999, port: 1, root: dir, startedAt: "", log: "" };
    await writeRecord(rec);
    expect(await stopDaemon(rec)).toBe(false);
    expect(await listRecords()).toEqual([]);
  });
});
