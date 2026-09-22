import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface DaemonRecord {
  pid: number;
  port: number;
  root: string;
  startedAt: string;
  log: string;
}

export interface HealthInfo {
  ok: true;
  root: string;
  project: string;
  pid: number;
  port: number;
}

export function serveStateDir(): string {
  return path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
    "longe",
    "serve",
  );
}

function recordName(root: string): string {
  if (root === "*") return "hub";
  const hash = createHash("sha1").update(root).digest("hex").slice(0, 8);
  return `${path.basename(root).replace(/[^a-zA-Z0-9_-]+/g, "-") || "repo"}-${hash}`;
}

export function pidFile(root: string): string {
  return path.join(serveStateDir(), `${recordName(root)}.json`);
}

export function logFile(root: string): string {
  return path.join(serveStateDir(), `${recordName(root)}.log`);
}

export async function writeRecord(rec: DaemonRecord): Promise<void> {
  await mkdir(serveStateDir(), { recursive: true });
  await writeFile(pidFile(rec.root), `${JSON.stringify(rec, null, 2)}\n`);
}

export async function removeRecord(root: string): Promise<void> {
  await rm(pidFile(root), { force: true });
}

export async function listRecords(): Promise<DaemonRecord[]> {
  let names: string[];
  try {
    names = await readdir(serveStateDir());
  } catch {
    return [];
  }
  const out: DaemonRecord[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(await readFile(path.join(serveStateDir(), n), "utf8")) as DaemonRecord);
    } catch {
      // ignore broken records
    }
  }
  return out.sort((a, b) => a.root.localeCompare(b.root));
}

/** GET /health on a port; undefined when nothing (or something else) answers. */
export async function probeHealth(port: number, timeoutMs = 800): Promise<HealthInfo | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as Partial<HealthInfo>;
    return body.ok === true && typeof body.root === "string" ? (body as HealthInfo) : undefined;
  } catch {
    return undefined;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface StartDaemonOptions {
  root: string;
  port: number;
  /** Entry script to run; defaults to the current one. */
  script?: string;
  execArgv?: string[];
  extraArgs?: string[];
}

/** Spawns a detached `longe serve` and waits until it answers /health. */
export async function startDaemon(opts: StartDaemonOptions): Promise<DaemonRecord> {
  const log = logFile(opts.root);
  await mkdir(serveStateDir(), { recursive: true });
  const fd = await open(log, "a");
  const script = opts.script ?? process.argv[1] ?? "";
  const child = spawn(
    process.execPath,
    [
      ...(opts.execArgv ?? process.execArgv),
      script,
      "serve",
      ...(opts.root === "*" ? [] : ["--repo", opts.root]),
      ...(opts.extraArgs ?? []),
      "--port",
      String(opts.port),
    ],
    { detached: true, stdio: ["ignore", fd.fd, fd.fd], env: { ...process.env, LONGE_DAEMON: "1" } },
  );
  child.unref();
  await fd.close();
  const pid = child.pid ?? -1;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const h = await probeHealth(opts.port, 400);
    if (h && h.root === opts.root) {
      return {
        pid: h.pid,
        port: opts.port,
        root: opts.root,
        startedAt: new Date().toISOString(),
        log,
      };
    }
    if (!isAlive(pid)) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const tail = (await readFile(log, "utf8").catch(() => "")).split("\n").slice(-5).join("\n");
  throw new Error(
    `longe serve did not come up on port ${opts.port}.\nLast log lines (${log}):\n${tail}`,
  );
}

export async function stopDaemon(rec: DaemonRecord, waitMs = 5000): Promise<boolean> {
  if (!isAlive(rec.pid)) {
    await removeRecord(rec.root);
    return false;
  }
  try {
    process.kill(rec.pid, "SIGTERM");
  } catch {
    await removeRecord(rec.root);
    return false;
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && isAlive(rec.pid)) await new Promise((r) => setTimeout(r, 100));
  if (isAlive(rec.pid)) process.kill(rec.pid, "SIGKILL");
  await removeRecord(rec.root);
  return true;
}
