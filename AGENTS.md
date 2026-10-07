# Working on longe

Read `.longe/AGENT-INSTRUCTIONS.md` for the board protocol. Keep plans, decisions,
results, and human verification requests on the board; use its inbox for questions.

Every review request must say exactly where to inspect the work and what to check.
For local files, include their full paths and a copyable command to view them. Put
short review content directly in the inbox so the human can review it there.

## Checks and execution

- Run relevant checks yourself: `pnpm typecheck`, `pnpm lint`, and `pnpm test`.
  Use one plain command per tool call, without pipes, redirects, or command chains.
  This matches the headless Claude command allowlist and keeps failures visible.
  If the current harness blocks a check, record the exact failure in the topic.
- After server-side changes, run `pnpm build` yourself before requesting verification.
  The normal installed `longe` CLI uses `dist/`; tests do not rebuild it.
- For this repository's normal background hub, ask the human through `ask_question`
  to run `longe stop`, then `longe serve -d`. Restarting ends the running board chat.
  Add `--open` only when opening the browser is useful.
- Prefer the normal `longe` command in human instructions. Check `command -v longe`
  and its resolved path if unsure which installation it runs. Use `node bin/longe.js`
  only for an explicitly intended checkout-local run, explaining that choice.
- `pnpm dev serve --repo /path/to/project --open` is the source-development workflow,
  separate from the normal background hub. Changes only to `public/` need a browser
  reload because those files are served from disk.

## Shared instructions and permissions

Keep durable repository workflow here so provider switches retain it; do not leave it
only in one provider's private memory. `CLAUDE.md` imports this file for Claude Code.
Use `.longe/config.yml` (the former `.ai/` name is obsolete).

Claude receives `agent.allowed_tools` as `--allowedTools`; Codex uses its configured
sandbox and approval policy. These are different permission systems. Instruction
files do not grant permissions. Do not change permission settings to unblock yourself;
report any required human configuration change through the inbox.
