import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HookName } from "../store/config.js";

export interface HookVars {
  question_id?: string;
  topic_id?: string;
  answer?: string;
  question?: string;
}

export interface HookRun {
  hook: HookName;
  command: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  vars: HookVars;
}

export interface HookStatus {
  configured: HookName[];
  running?: HookRun | undefined;
  last?: HookRun | undefined;
  queued: number;
  logFile: string;
}

export interface HookEvents {
  "hook:changed": [HookStatus];
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * `{answer}` becomes `"$LONGE_ANSWER"` etc. The value never passes through
 * shell parsing (it arrives via the environment), and the form works both as a
 * standalone argument and inside a double-quoted string.
 */
export function expandCommand(template: string): string {
  return template.replace(
    /\{(question_id|topic_id|answer|question)\}/g,
    (_, k: string) => `"$LONGE_${k.toUpperCase()}"`,
  );
}

export function hooksLogDir(): string {
  return path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
    "longe",
    "hooks",
  );
}

/**
 * Runs configured hook commands (§config `hooks:`). One run at a time per
 * runner; triggers that arrive during a run are coalesced into a single
 * follow-up run with the latest vars. Never throws into the caller.
 */
export class HookRunner extends EventEmitter<HookEvents> {
  private running: HookRun | undefined;
  private queued: { hook: HookName; vars: HookVars } | undefined;
  private last: HookRun | undefined;
  readonly logFile: string;

  constructor(
    private readonly root: string,
    private readonly commands: { [K in HookName]?: string | undefined },
    logName: string,
    private readonly spawnImpl: typeof spawn = spawn,
  ) {
    super();
    this.logFile = path.join(hooksLogDir(), `${logName}.log`);
  }

  status(): HookStatus {
    return {
      configured: (Object.keys(this.commands) as HookName[]).filter((k) => this.commands[k]),
      running: this.running,
      last: this.last,
      queued: this.queued ? 1 : 0,
      logFile: this.logFile,
    };
  }

  /** Fire-and-forget. Returns true if a run was started or queued. */
  trigger(hook: HookName, vars: HookVars): boolean {
    const template = this.commands[hook];
    if (!template) return false;
    if (this.running) {
      this.queued = { hook, vars };
      this.emit("hook:changed", this.status());
      return true;
    }
    void this.run(hook, template, vars);
    return true;
  }

  private async log(line: string): Promise<void> {
    try {
      await mkdir(path.dirname(this.logFile), { recursive: true });
      await appendFile(this.logFile, line);
    } catch {
      // logging must never break the hook
    }
  }

  private async run(hook: HookName, template: string, vars: HookVars): Promise<void> {
    const command = expandCommand(template);
    const run: HookRun = { hook, command, startedAt: new Date().toISOString(), vars };
    this.running = run;
    this.emit("hook:changed", this.status());
    await this.log(`\n=== ${run.startedAt} ${hook} ===\n$ ${command}\n`);
    const exitCode = await new Promise<number | null>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = this.spawnImpl(command, {
          shell: true,
          cwd: this.root,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            LONGE_HOOK: hook,
            LONGE_QUESTION_ID: vars.question_id ?? "",
            LONGE_TOPIC_ID: vars.topic_id ?? "",
            LONGE_ANSWER: vars.answer ?? "",
            LONGE_QUESTION: vars.question ?? "",
          },
        });
      } catch (err) {
        void this.log(`spawn failed: ${err instanceof Error ? err.message : String(err)}\n`);
        resolve(null);
        return;
      }
      child.stdout?.on("data", (d: Buffer) => void this.log(d.toString()));
      child.stderr?.on("data", (d: Buffer) => void this.log(d.toString()));
      child.on("error", (err) => {
        void this.log(`error: ${err.message}\n`);
        resolve(null);
      });
      child.on("close", (code) => resolve(code));
    });
    run.finishedAt = new Date().toISOString();
    run.exitCode = exitCode;
    await this.log(`=== exit ${exitCode ?? "?"} ===\n`);
    this.last = run;
    this.running = undefined;
    this.emit("hook:changed", this.status());
    const next = this.queued;
    this.queued = undefined;
    if (next) {
      const t = this.commands[next.hook];
      if (t) await this.run(next.hook, t, next.vars);
    }
  }
}
