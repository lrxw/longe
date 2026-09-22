import path from "node:path";
import {
  hasAiDir,
  pruneRegistry,
  readRegistry,
  registerRepo,
  registryPath,
  renameRepo,
  unregisterRepo,
} from "../store/registry.js";
import { CliError } from "./args.js";

/** `longe repos [list|add|remove|rename]` */
export async function runRepos(args: string[], name?: string): Promise<number> {
  const [sub = "list", a, b] = args;
  switch (sub) {
    case "list": {
      const repos = await readRegistry();
      if (repos.length === 0) {
        process.stdout.write(
          `No repos registered (${registryPath()}).\nRun \`longe init\` in a project or \`longe repos add <dir>\`.\n`,
        );
        return 0;
      }
      for (const r of repos) {
        const ok = await hasAiDir(r.path);
        process.stdout.write(
          `${(ok ? "ok" : "missing").padEnd(8)} ${r.name.padEnd(24)} ${r.path}\n`,
        );
      }
      return 0;
    }
    case "add": {
      if (!a) throw new CliError("usage: longe repos add <dir> [--name <name>]");
      const root = path.resolve(a);
      if (!(await hasAiDir(root)))
        throw new CliError(`${root} has no .ai/ folder. Run \`longe init --repo ${root}\` first.`);
      const entry = await registerRepo(root, name);
      process.stdout.write(`registered ${entry.name}  ${entry.path}\n`);
      return 0;
    }
    case "remove": {
      if (!a) throw new CliError("usage: longe repos remove <dir>");
      const removed = await unregisterRepo(path.resolve(a));
      process.stdout.write(
        removed ? `removed ${path.resolve(a)}\n` : `not registered: ${path.resolve(a)}\n`,
      );
      return removed ? 0 : 1;
    }
    case "prune": {
      const gone = await pruneRegistry();
      for (const r of gone) process.stdout.write(`removed ${r.name}  ${r.path}\n`);
      if (gone.length === 0) process.stdout.write("nothing to prune\n");
      return 0;
    }
    case "rename": {
      if (!a || !b) throw new CliError("usage: longe repos rename <dir> <name>");
      const entry = await renameRepo(path.resolve(a), b);
      if (!entry) throw new CliError(`not registered: ${path.resolve(a)}`);
      process.stdout.write(`renamed to ${entry.name}  ${entry.path}\n`);
      return 0;
    }
    default:
      throw new CliError(
        `unknown repos subcommand: ${sub}\nusage: longe repos [list | add <dir> [--name <n>] | remove <dir> | rename <dir> <name> | prune]`,
      );
  }
}
