import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

export type Command = "init" | "serve" | "mcp" | "answers" | "status" | "stop" | "repos" | "hooks";

export interface ParsedCli {
  command: Command;
  repo: string;
  port: number;
  open: boolean;
  json: boolean;
  daemon: boolean;
  /** init, hooks: the Claude Code hook goes into `.claude/settings.local.json`. */
  local: boolean;
  /** `--repo` was given explicitly (serve: single mode even without .longe/ in cwd). */
  repoGiven: boolean;
  /** Positional arguments after the command (repos add <path> …). */
  rest: string[];
  name?: string;
}

export const DEFAULT_PORT = 7311;

const USAGE = `Usage:
  longe init   [--repo <dir>] [--local]
  longe serve  [--repo <dir>] [--port <n>] [--open] [--daemon|-d]
               # one server for every registered repo; run inside a project to register it
  longe repos  [list | add <dir> [--name <n>] | remove <dir> | rename <dir> <name> | prune]
  longe status                              # is the server running, which repos
  longe stop                                # stop the background server
  longe mcp    [--repo <dir>]
  longe hooks  [install | remove] [--repo <dir>] [--local]
               # Claude Code sessions in the repo ask through the longe inbox

Options:
  --repo   Repository root containing (or to receive) .longe/  (default: .)
  --port   HTTP port for serve                                (default: ${DEFAULT_PORT})
  --open   Open the browser after serve starts
  --daemon, -d   Run serve in the background (log in ~/.cache/longe/serve/)
  --name   With repos add: display name
  --local  With init and hooks: put the Claude Code hook into .claude/settings.local.json
           (your own, git-ignored) instead of the shared .claude/settings.json
  -h, --help
  -v, --version
`;

const OPTIONS = {
  repo: { type: "string", default: "." },
  port: { type: "string", default: String(DEFAULT_PORT) },
  open: { type: "boolean", default: false },
  json: { type: "boolean", default: false },
  daemon: { type: "boolean", short: "d", default: false },
  all: { type: "boolean", default: false },
  name: { type: "string" },
  local: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "v", default: false },
} as const;

/** The version from package.json, two levels up from this file in src/ and in dist/ alike. */
export function packageVersion(): string {
  try {
    const text = readFileSync(path.resolve(import.meta.dirname, "../../package.json"), "utf8");
    return (JSON.parse(text) as { version?: string }).version ?? "?";
  } catch {
    return "?";
  }
}

export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode = 2,
  ) {
    super(message);
  }
}

export function usage(): string {
  return USAGE;
}

export function parseCli(argv: string[]): ParsedCli {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: OPTIONS,
    });
  } catch (err) {
    throw new CliError(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
  }
  const { values, positionals } = parsed;

  if (values.help) throw new CliError(USAGE, 0);
  if (values.version) throw new CliError(`longe ${packageVersion()}`, 0);

  const command = positionals[0];
  const commands: Command[] = [
    "init",
    "serve",
    "mcp",
    "answers",
    "status",
    "stop",
    "repos",
    "hooks",
  ];
  if (!commands.includes(command as Command)) {
    throw new CliError(`Unknown or missing command: ${command ?? "(none)"}\n\n${USAGE}`);
  }
  if (positionals.length > 1 && command !== "repos" && command !== "hooks") {
    throw new CliError(`Unexpected argument: ${positionals[1]}\n\n${USAGE}`);
  }

  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError(`Invalid --port: ${values.port}`);
  }

  return {
    command: command as Command,
    repo: values.repo,
    port,
    open: values.open,
    json: values.json,
    daemon: values.daemon,
    local: values.local,
    repoGiven: argv.includes("--repo") || argv.some((a) => a.startsWith("--repo=")),
    rest: positionals.slice(1),
    ...(values.name !== undefined ? { name: values.name } : {}),
  } as ParsedCli;
}
