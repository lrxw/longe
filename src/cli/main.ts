import path from "node:path";
import { CliError, parseCli } from "./args.js";
import { initProject } from "./init.js";

async function main(argv: string[]): Promise<number> {
  const cli = parseCli(argv);
  const repo = path.resolve(cli.repo);

  switch (cli.command) {
    case "init": {
      const result = await initProject(repo, { local: cli.local });
      const { registerRepo } = await import("../store/registry.js");
      await registerRepo(repo).catch(() => undefined);
      for (const line of result.created) process.stdout.write(`created  ${line}\n`);
      for (const line of result.updated)
        process.stdout.write(
          `updated  ${line}: points to ${line === "CLAUDE.md" ? "AGENTS.md" : ".longe/AGENT-INSTRUCTIONS.md"}\n`,
        );
      for (const line of result.skipped) process.stdout.write(`exists   ${line}\n`);
      // ask_in_inbox (default on): terminal sessions send their questions to the inbox
      if (result.hook)
        process.stdout.write(
          `hook     .claude/${cli.local ? "settings.local.json" : "settings.json"}: Claude Code questions go to the inbox (ask_in_inbox; \`longe hooks remove${cli.local ? " --local" : ""}\` undoes it)\n`,
        );
      process.stdout.write(
        `\n.longe/ ready in ${repo}\n\nNext:\n` +
          "  1. Connect your agent, e.g.:  claude mcp add longe -- longe mcp --repo .\n" +
          "  2. Open the board:             longe serve --open\n" +
          "  Agents that do not read AGENTS.md (.cursorrules, GEMINI.md, …) need its line in their own file.\n",
      );
      return 0;
    }
    case "serve": {
      const { runServe } = await import("./serve.js");
      await runServe({ repo, port: cli.port, open: cli.open, daemon: cli.daemon });
      return new Promise(() => {}); // runs until SIGINT
    }
    case "status": {
      const { runStatus } = await import("./serve.js");
      return runStatus();
    }
    case "stop": {
      const { runStop } = await import("./serve.js");
      return runStop();
    }
    case "repos": {
      const { runRepos } = await import("./repos.js");
      return runRepos(cli.rest, cli.name);
    }
    case "answers": {
      const { collectAnswers, formatAnswersForAgent } = await import("./answers.js");
      const answers = await collectAnswers(repo);
      process.stdout.write(
        cli.json ? `${JSON.stringify(answers, null, 2)}\n` : formatAnswersForAgent(answers),
      );
      return 0;
    }
    case "hooks": {
      const { runHooks } = await import("./hooks.js");
      return runHooks(cli.rest, repo, cli.local);
    }
    case "mcp": {
      const { runMcpStdio } = await import("../mcp/stdio.js");
      await runMcpStdio(repo);
      return new Promise(() => {}); // runs until stdin closes
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
