import path from "node:path";
import { parseArgs } from "node:util";
import { closeAppContext, createAppContext } from "../app/context.js";
import { DomainError } from "../domain/errors.js";
import { INBOX_ONLY_TOOLS } from "../tools/inbox-tools.js";
import { invokeTool, type ToolDef } from "../tools/registry.js";
import { CliError } from "./args.js";

/**
 * `longe ask "question"`: puts a question into the inbox from a shell, a script or CI,
 * without the board. Prints the question id; with `--wait` it waits for the answer and
 * prints it, so a script can branch on what the human chose.
 */

export const ASK_USAGE = `Usage: longe ask "<question>" [options]

Puts a question into longe's inbox (web and Claude Code). Blocking unless --assumption
is given. Prints the question id, or with --wait the answer.

  --option <label>     An answer to pick with one click; repeat 2–4 times
  --context <text>     Why it matters (markdown)
  --assumption <text>  Non-blocking: what you go on with meanwhile
  --subject <kind:id>  What it is about, e.g. issue:42 or topic:<topic id>
  --subject-url <url>  Where the subject can be seen
  --asked-by <name>    Who asks (default: cli)
  --wait <seconds>     Wait for the answer and print it (exit 3 when none came, 4 when withdrawn)
  --json               Print JSON instead of plain text
  --repo <dir>         Repository with .longe/ (default: .)
`;

export interface AskArgs {
  repo: string;
  question: string;
  options: string[];
  context?: string | undefined;
  assumption?: string | undefined;
  subject?: { kind: string; id: string; url?: string } | undefined;
  askedBy: string;
  wait?: number | undefined;
  json: boolean;
}

const ASK_OPTIONS = {
  repo: { type: "string", default: "." },
  option: { type: "string", multiple: true },
  context: { type: "string" },
  assumption: { type: "string" },
  subject: { type: "string" },
  "subject-url": { type: "string" },
  "asked-by": { type: "string", default: "cli" },
  wait: { type: "string" },
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const;

export function parseAskArgs(argv: string[]): AskArgs {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof ASK_OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: ASK_OPTIONS });
  } catch (err) {
    throw new CliError(`${err instanceof Error ? err.message : String(err)}\n\n${ASK_USAGE}`);
  }
  const { values, positionals } = parsed;
  if (values.help) throw new CliError(ASK_USAGE, 0);
  const question = positionals.join(" ").trim();
  if (!question) throw new CliError(`The question is missing.\n\n${ASK_USAGE}`);

  let subject: AskArgs["subject"];
  if (values.subject !== undefined) {
    const at = values.subject.indexOf(":");
    if (at <= 0 || at === values.subject.length - 1)
      throw new CliError(`--subject must look like kind:id, e.g. issue:42 (got ${values.subject})`);
    subject = { kind: values.subject.slice(0, at), id: values.subject.slice(at + 1) };
    if (values["subject-url"]) subject.url = values["subject-url"];
  } else if (values["subject-url"]) {
    throw new CliError("--subject-url needs --subject");
  }

  let wait: number | undefined;
  if (values.wait !== undefined) {
    wait = Number(values.wait);
    if (!Number.isInteger(wait) || wait < 1) throw new CliError(`Invalid --wait: ${values.wait}`);
  }

  return {
    repo: values.repo,
    question,
    options: values.option ?? [],
    context: values.context,
    assumption: values.assumption,
    subject,
    askedBy: values["asked-by"],
    wait,
    json: values.json,
  };
}

const tool = (name: string): ToolDef => INBOX_ONLY_TOOLS.find((t) => t.name === name) as ToolDef;

interface WaitResult {
  status: string;
  question?: { answer?: string };
}

/** Runs `longe ask`; returns the exit code. */
export async function runAsk(
  args: AskArgs,
  out: (text: string) => void = (t) => process.stdout.write(t),
): Promise<number> {
  // no desktop notifications here: a running `longe serve` sees the new file and sends one
  const ctx = await createAppContext(path.resolve(args.repo));
  try {
    const asked = (await invokeTool(ctx, tool("ask_question"), {
      question: args.question,
      ...(args.context !== undefined ? { context: args.context } : {}),
      ...(args.subject ? { subject: args.subject } : {}),
      ...(args.options.length > 0 ? { options: args.options } : {}),
      ...(args.assumption !== undefined ? { assumption: args.assumption } : {}),
      blocking: args.assumption === undefined,
      asked_by: args.askedBy,
    })) as { id: string };
    if (args.wait === undefined) {
      out(args.json ? `${JSON.stringify({ id: asked.id })}\n` : `${asked.id}\n`);
      return 0;
    }
    // wait_for_answer waits at most 300 s per call; longer waits take several
    let result: WaitResult = { status: "timeout" };
    for (let left = args.wait; left > 0 && result.status === "timeout"; left -= 300) {
      result = (await invokeTool(ctx, tool("wait_for_answer"), {
        id: asked.id,
        timeout_seconds: Math.min(left, 300),
      })) as WaitResult;
    }
    const answer = result.question?.answer ?? "";
    if (args.json) out(`${JSON.stringify({ id: asked.id, status: result.status, answer })}\n`);
    else if (result.status === "answered") out(`${answer}\n`);
    else
      out(
        result.status === "timeout"
          ? `${asked.id}: no answer yet\n`
          : `${asked.id}: ${result.status}\n`,
      );
    return result.status === "answered" ? 0 : result.status === "timeout" ? 3 : 4;
  } catch (err) {
    if (err instanceof DomainError) throw new CliError(err.message);
    throw err;
  } finally {
    await closeAppContext(ctx);
  }
}
