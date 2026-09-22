import path from "node:path";
import { CliError, parseCli } from "./args.js";
import { runInit } from "./init.js";

async function main(argv: string[]): Promise<number> {
  const cli = parseCli(argv);
  const repo = path.resolve(cli.repo);

  switch (cli.command) {
    case "init": {
      const result = await runInit(repo);
      for (const line of result.created) process.stdout.write(`created  ${line}\n`);
      for (const line of result.skipped) process.stdout.write(`exists   ${line}\n`);
      process.stdout.write(`\n.ai/ ready in ${repo}\n`);
      return 0;
    }
    case "serve": {
      // Phase 3/4: start Hono HTTP server + Streamable HTTP MCP at /mcp.
      process.stdout.write(
        `[not yet implemented] serve: repo=${repo} port=${cli.port} open=${cli.open}\n`,
      );
      return 0;
    }
    case "mcp": {
      // Phase 4: MCP over stdio.
      process.stdout.write(`[not yet implemented] mcp: repo=${repo}\n`);
      return 0;
    }
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof CliError) {
      (err.exitCode === 0 ? process.stdout : process.stderr).write(`${err.message}\n`);
      process.exit(err.exitCode);
    }
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  },
);
