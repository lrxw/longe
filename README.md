<p align="center">
  <img src="public/logo/wordmark.svg" alt="longe" height="72">
</p>

<p align="center">
  <strong>A local-first work board for AI coding agents.</strong><br>
  Topics, decisions and a question inbox, stored as markdown in your repository.
</p>

---

AI coding agents do a lot of work, but it is hard to keep track of what they did and why, and
what they are waiting on. longe gives every repository a small board that agents keep up to date
themselves:

- **Topics** hold the work: a goal, a plan, the decisions taken and a log. Each one is a markdown
  file in `.longe/topics/`, committed together with the code it describes.
- **The inbox** collects the questions agents ask you, with blocking ones first. You answer with
  one click, and the answer goes back to the agent.
- **The chat** lets you talk to Claude Code from the board and send it through the open work.

Agents reach longe through **MCP**, **REST** or by editing the files directly. longe runs
entirely on your machine: it binds to `127.0.0.1`, has no database, no account and no telemetry.
The files are the source of truth.

## Features

- **Live board.** Columns for backlog, todo, active, needs-decision, review, done and cancelled. It
  updates as agents write, and you move cards by drag and drop.
- **Question inbox.** Agents ask with options you can pick in one click. Blocking questions stop
  the topic until you answer; non-blocking ones state the assumption the agent works on
  meanwhile. Markdown and code blocks are rendered.
- **Review flow.** Agents submit topics for review; only you approve, reject (with a note),
  cancel or reopen.
- **Chat with Claude Code.** One conversation per repository, with streaming output, model
  choice, context and cost display. "Work on board" sends the agent through the active topics,
  then the todo queue.
- **One server, many repositories.** A single `longe serve` shows every registered repository:
  one shared inbox, one board and chat per repository. "+ New project" on the inbox creates a
  folder under your home folder (or takes an existing one), adds `.longe/` and opens its board.
- **Any agent.** A standard MCP server (stdio and Streamable HTTP) plus a REST API with an
  OpenAPI document. Works with Claude Code, Codex CLI, Gemini CLI, Cursor, Cline and others.
- **Wake-up hooks.** Run a command when you answer a question, or feed new answers into the
  next Claude Code prompt.
- **Desktop notifications** for new blocking questions, naming the repo; bursts are grouped.
- **Cleanup.** Archive or delete finished topics in one go.

## Requirements

- Node.js 22 or later
- For the chat: [Claude Code](https://claude.com/claude-code) (`claude`) on your `PATH`

## Install

```sh
npm install -g github:lrxw/longe
```

npm clones the repository, builds it (the `prepare` script runs `tsc`) and installs the result.

Or from a clone:

```sh
git clone https://github.com/lrxw/longe && cd longe
pnpm install && pnpm build
npm link
```

## Quick start

```sh
cd /path/to/your/project
longe init                     # creates .longe/ with config, topics/, questions/ and the agent protocol
longe serve -d --open          # starts the server in the background and opens the board
```

The board runs at <http://127.0.0.1:7311>. Commit `.longe/` with your code.

Then point your agent at the protocol. Add this line to `CLAUDE.md`, `AGENTS.md`, `.cursorrules`
or your agent's equivalent:

```
Follow .longe/AGENT-INSTRUCTIONS.md for tracking work and asking questions.
```

`longe init` is idempotent and never overwrites existing files.

## Connect your agent

longe speaks MCP over two transports:

- **stdio:** the agent starts `longe mcp` itself. No server needed.
- **HTTP:** the agent talks to a running `longe serve` at `http://127.0.0.1:7311/r/<name>/mcp`.
  `<name>` is the repository's name as listed by `longe repos`.

**Claude Code**

```sh
claude mcp add longe -- longe mcp --repo .
# or, over HTTP:
claude mcp add --transport http longe http://127.0.0.1:7311/r/<name>/mcp
```

**Codex CLI** (`~/.codex/config.toml`)

```toml
[mcp_servers.longe]
command = "longe"
args = ["mcp", "--repo", "."]
```

**Gemini CLI** (`.gemini/settings.json`)

```json
{ "mcpServers": { "longe": { "command": "longe", "args": ["mcp", "--repo", "."] } } }
```

**Cursor** (`.cursor/mcp.json`) and **Cline**

```json
{ "mcpServers": { "longe": { "command": "longe", "args": ["mcp", "--repo", "."] } } }
```

HTTP variants: Gemini CLI uses `"httpUrl"`, Cursor uses `"url"`, with the address above.

The MCP server also offers the protocol as the resource `longe://agent-instructions`.

**Questions go to the inbox, also from the terminal** (`ask_in_inbox`, on by default).
Claude Code has its own way to ask you, the AskUserQuestion tool. With the option on:

- The chat in the web UI may not use AskUserQuestion. When it leaves a question in its
  reply text, longe reminds it once to use the inbox.
- `longe init` adds a PreToolUse hook to the repository's `.claude/settings.json`. For
  repositories set up before this, run `longe hooks install`; `longe hooks remove`
  takes the hook out again. When a terminal session wants to ask you something, the
  question lands in the inbox (blocking, with its options) instead of the terminal. The
  agent is told the question id, so it can wait for the answer or continue on an
  assumption. The hook calls `longe`, so it must be on your PATH.

To turn it all off, set this in `.longe/config.yml`; the hook then lets questions through:

```yaml
ask_in_inbox: false
```

## How it works

Everything lives in the repository's `.longe/` folder:

```
.longe/
  config.yml                     # project name, color, hooks, chat settings
  AGENT-INSTRUCTIONS.md          # the protocol agents follow (kept current by longe; do not edit)
  topics/<slug>.md               # one topic: frontmatter + Goal, Plan, Decisions, Log
  questions/q-YYYYMMDD-xxxx.md   # one question and its answer
  messages/m-YYYYMMDD-xxxx.md    # messages you sent in the chat
  archive/                       # archived topics and their questions
```

You and your agents may edit these files directly. longe watches them, validates them, shows
errors in the UI and applies the rules below.

**Statuses.** `backlog → todo → active → review → done`, plus `needs-decision` and `cancelled`.
The backlog is parked; agents never pick it up on their own. Todo is your queue: whenever the
chat is free and no topic is active, longe hands it the top card of the Todo column. Drag
todo cards up and down to set the order; new ones join at the bottom.

| Who | May do |
|---|---|
| Agent | pick up (`todo → active`, or `backlog → active` for a topic it just created), submit (`active → review`) |
| Human | queue (`backlog ↔ todo`), approve, reject with a note, cancel, reopen |
| longe | `active → needs-decision` while a blocking question is open, and back when it is answered; `review → active` when you pick a reject option |

**Tools.** Agents use `list_topics`, `get_topic`, `create_topic`, `set_plan`, `set_status`,
`add_decision`, `append_log`, `ask_question`, `check_answers`, `acknowledge_answers`,
`wait_for_answer` and `withdraw_question`. Humans answer, approve, reject, cancel and reopen
through the UI or REST.

## Using the board

- **Inbox** (`/`): everything waiting on you across repositories, blocking questions first, with
  an overview of each repository on top.
- **Board** (`/r/<name>/board`): one per repository. Drag a card to change its status; only the
  columns you may move it to light up. Done and cancelled topics can be archived or deleted in
  one go.
- **Topic page:** goal, plan with progress, decisions, log, questions and the actions for its
  current status.
- **Chat** (`/r/<name>/chat`): see below.

Keyboard: `i` inbox, `b` board, `c` chat, `1`–`9` a repository's board, `/` jumps into the
prompt box, `Esc` leaves it (or goes back from a topic), `⌘↩` / `Ctrl+Enter` sends the form you
are typing in.

## Chat

Each repository has one conversation with Claude Code. longe keeps a `claude` process running in
stream-JSON mode and hands it longe's MCP endpoint, so the agent can use the board without any
setup. You can send messages at any time, also while it works.

- **Continue** resumes the conversation where it stopped. **Work on board** sends the agent
  through the active topics, then the todo queue, until each is in review or waiting on you.
- When you answer a question, the answer waits until the chat is free, never cutting into a
  running turn, and then goes to the agent (several at once in one message). The board
  marks answers the agent has not read yet with "answer waiting".
- When you move a topic to active on the board, the chat is told to work on it, and starts if
  needed. A topic you queue as todo starts once the chat is free and nothing is active.
- The process closes after a period without work and resumes the session with the next message.
  **New session** starts fresh, **Clear history** empties the page, **Copy resume command**
  continues the same session in a terminal.
- Messages are stored as files in `.longe/messages/`, so the chat survives restarts.
- A small prompt box on each topic page sends a message about that topic.

Headless runs cannot answer permission prompts. Edits are allowed by default
(`--permission-mode acceptEdits`); list everything else the chat may run, such as tests or
commits, under `agent.allowed_tools`.

## Configuration

`.longe/config.yml`:

```yaml
version: 1
project: "My project"            # display name; default: the folder name
color: "#2563eb"                 # optional; default: by registry order
ask_in_inbox: true               # default; agents' questions go to the inbox (see above)

hooks:
  on_answer: >-                  # optional; runs when you answer a question
    claude -p --permission-mode acceptEdits
    "Question {question_id} on topic {topic_id} was answered: {answer}.
     Call check_answers, acknowledge_answers, then continue that topic."

agent:                           # the chat
  command: claude                # default
  model: sonnet                  # optional; can also be picked in the chat
  permission_mode: acceptEdits   # default
  allowed_tools:                 # Claude Code permission rules
    - "Bash(pnpm test:*)"
    - "Bash(git commit:*)"
  idle_minutes: 30               # default; 0 keeps the process open
  args: []                       # extra arguments, appended as given
```

### Waking your agent when you answer

- **`hooks.on_answer`** runs a shell command for every answer, from the UI, REST or a file edit.
  The placeholders `{question_id}`, `{topic_id}`, `{answer}` and `{question}` are passed safely
  as `LONGE_*` environment variables. Runs are serialized per repository; output goes to
  `~/.cache/longe/hooks/`.
- **`longe answers`** prints answered questions the agent has not picked up yet, straight from
  the files. As a Claude Code `UserPromptSubmit` hook, new answers arrive with your next prompt:

  ```json
  { "hooks": { "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "longe answers" } ] } ] } }
  ```

## REST API

```sh
curl -s -X POST http://127.0.0.1:7311/r/<name>/api/v1/create_topic \
  -H 'content-type: application/json' \
  -d '{"title":"Billing refactor","goal":"Move invoices to Stripe."}'

curl -s 'http://127.0.0.1:7311/r/<name>/api/v1/list_topics?status=active'
```

Every tool is available as `POST /api/v1/<tool>` with a JSON body. Errors are `400`
(validation), `404` (unknown id) and `409` (transition not allowed), each with
`{ "code", "message" }`. Without the `/r/<name>` prefix, pass `repo` in the body or as `?repo=`;
`list_topics` without it lists all repositories. The OpenAPI
document is at `/openapi.json`, a try-it page at `/api/docs`.

## CLI

```
longe init    [--repo <dir>]                         set up .longe/ in a repository
longe serve   [--repo <dir>] [--port 7311] [--open] [-d]   start the server (one per machine)
longe status                                         is it running, which repositories
longe stop                                           stop the background server
longe repos   [list | add <dir> [--name <n>] | remove <dir> | rename <dir> <name> | prune]
longe mcp     [--repo <dir>]                         MCP server over stdio
longe answers [--repo <dir>] [--json]                answers not yet picked up
```

Repositories register themselves when you run `longe init`, `longe serve` or `longe mcp` in
them. The list lives in `~/.config/longe/repos.yml`, and a running server follows it live.

## Security

longe is a single-user tool for your own machine. It listens on `127.0.0.1` only and has no
authentication, so do not expose its port. It sends nothing anywhere; notifications are local.

## Development

```sh
pnpm install
pnpm dev serve --repo /path/to/project --open
pnpm test          # vitest: unit and integration, MCP over stdio and HTTP included
pnpm typecheck
pnpm lint          # biome
```

The server is TypeScript on Node with [Hono](https://hono.dev). Pages are rendered on the server
with JSX and updated live over server-sent events with [htmx](https://htmx.org) and
[idiomorph](https://github.com/bigskysoftware/idiomorph); there is no client build step. The
full design is in [SPEC.md](./SPEC.md).

## Roadmap

Planned or under consideration:

- A release on the npm registry (`npm install -g longe`)
- Editing topic text directly in the UI
- Search and an archive view
- Chat with other coding agents besides Claude Code
- Awareness of git worktrees, so parallel agents keep their work apart

Ideas and bug reports are welcome in the [issues](https://github.com/lrxw/longe/issues).

## License

[MIT](./LICENSE)
