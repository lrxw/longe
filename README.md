# longe

> Working name was `aiboard`; the repository folder may still carry that name until you `mv` it.

Local-first, single-user board for tracking work done by AI coding agents in one repository.
The repository's `.ai/` folder is the source of truth; longe is a viewer plus a validated
write layer reachable through MCP, REST, or direct file edits.

Full specification: [SPEC.md](./SPEC.md).

## Status

Phases 0–4 complete: scaffold, store, domain, index, HTML UI, MCP (stdio + Streamable HTTP), REST + OpenAPI. Phase 5 (docs, publish) pending.

## Development

```sh
pnpm install
pnpm test          # vitest
pnpm typecheck
pnpm lint
pnpm dev init --repo /path/to/project
```

## Using in another project

```sh
pnpm build
pnpm link --global          # exposes `longe` on PATH
cd /path/to/project
longe init                # creates .ai/
```

## Waking the agent when you answer

The board is pull-based: agents pick answers up with `check_answers` (next session) or
`wait_for_answer` (same session). Two ways to close the loop automatically:

### 1. `hooks.on_answer` in `.ai/config.yml` (any agent)

longe runs a shell command every time a human answers a question (via UI, REST, or by
editing the file). Runs are serialized per repo; triggers that arrive during a run are
coalesced into one follow-up run.

```yaml
hooks:
  on_answer: >-
    claude -p --permission-mode acceptEdits
    "Question {question_id} on topic {topic_id} was answered: {answer}.
     Call check_answers, acknowledge_answers, then continue that topic."
```

Placeholders `{question_id}` `{topic_id}` `{answer}` `{question}` expand to the matching
`LONGE_*` environment variables (safe to use inside double quotes). Output is appended to
`~/.cache/longe/hooks/<project>.log`; the inbox shows running/last status.

Headless agents need explicit permissions (`--permission-mode acceptEdits`, an allowlist,
or `--dangerously-skip-permissions`). A hook run works in the same checkout as any
interactive session you have open — point it at a worktree if that is a problem.

### 2. Claude Code prompt hook (inject answers into your next prompt)

`longe answers` prints answered-but-unacknowledged questions from the files (no server
needed) and nothing when there are none. As a `UserPromptSubmit` hook its output becomes
context for the next turn, so the agent sees the answers as soon as you type anything:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "longe answers" } ] }
    ]
  }
}
```

Put that in `.claude/settings.json` of the project (or `~/.claude/settings.json`).
