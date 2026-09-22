import { parseArgs } from "node:util";

export type Command = "init" | "serve" | "mcp" | "answers" | "status" | "stop" | "repos";

export interface ParsedCli {
  command: Command;
  repo: string;
  port: number;
  open: boolean;
  json: boolean;
  daemon: boolean;
  all: boolean;
  /** `--repo` was given explicitly (serve: single mode even without .ai/ in cwd). */
  repoGiven: boolean;
  /** Positional arguments after the command (repos add <path> …). */
  rest: string[];
  name?: string;
}

export const DEFAULT_PORT = 7311;

const USAGE = `Usage:
  longe init   [--repo <dir>]
  longe serve  [--repo <dir>] [--port <n>] [--open] [--daemon|-d]
               # no --repo and no .ai/ in cwd: hub mode, serves every registered repo
  longe repos  [list | add <dir> [--name <n>] | remove <dir> | rename <dir> <name> | prune]
  longe status                              # background servers
  longe stop   [--repo <dir>] [--all]       # stop a background server
  longe mcp    [--repo <dir>]

Options:
  --repo   Repository root containing (or to receive) .ai/  (default: .)
  --port   HTTP port for serve                                (default: ${DEFAULT_PORT})
  --open   Open the browser after serve starts
  --daemon, -d   Run serve in the background (log in ~/.cache/longe/serve/)
  --all    With stop: stop every recorded server. With serve: force hub mode
  --name   With repos add: display name
  -h, --help
`;

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
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      repo: { type: "string", default: "." },
      port: { type: "string", default: String(DEFAULT_PORT) },
      open: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      daemon: { type: "boolean", short: "d", default: false },
      all: { type: "boolean", default: false },
      name: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) throw new CliError(USAGE, 0);

  const command = positionals[0];
  const commands: Command[] = ["init", "serve", "mcp", "answers", "status", "stop", "repos"];
  if (!commands.includes(command as Command)) {
    throw new CliError(`Unknown or missing command: ${command ?? "(none)"}\n\n${USAGE}`);
  }
  if (positionals.length > 1 && command !== "repos") {
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
    all: values.all,
    repoGiven: argv.includes("--repo") || argv.some((a) => a.startsWith("--repo=")),
    rest: positionals.slice(1),
    ...(values.name !== undefined ? { name: values.name } : {}),
  } as ParsedCli;
}
