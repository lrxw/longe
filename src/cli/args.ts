import { parseArgs } from "node:util";

export type Command = "init" | "serve" | "mcp";

export interface ParsedCli {
  command: Command;
  repo: string;
  port: number;
  open: boolean;
}

export const DEFAULT_PORT = 7311;

const USAGE = `Usage:
  longe init   [--repo <dir>]
  longe serve  [--repo <dir>] [--port <n>] [--open]
  longe mcp    [--repo <dir>]

Options:
  --repo   Repository root containing (or to receive) .ai/  (default: .)
  --port   HTTP port for serve                                (default: ${DEFAULT_PORT})
  --open   Open the browser after serve starts
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
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) throw new CliError(USAGE, 0);

  const command = positionals[0];
  if (command !== "init" && command !== "serve" && command !== "mcp") {
    throw new CliError(`Unknown or missing command: ${command ?? "(none)"}\n\n${USAGE}`);
  }
  if (positionals.length > 1) {
    throw new CliError(`Unexpected argument: ${positionals[1]}\n\n${USAGE}`);
  }

  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError(`Invalid --port: ${values.port}`);
  }

  return { command, repo: values.repo, port, open: values.open };
}
