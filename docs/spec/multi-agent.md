# Multi-agent longe: plan and message-system spec

Status: **draft for review**. Scope of this document: what it takes to run several agents on one
repository, the phases to get there, and the spec of the first piece, the **core message
system**. The UI gets its own spec afterwards.

## 1. Where longe is today

- **One chat per repository.** `AgentRunner` owns one provider process at a time; each provider
  keeps one session. Switching provider hands the open work over (handoff message).
- **Messages are unaddressed.** `messages/m-*.md` has `from: human | board`; everything goes to
  the one chat.
- **Answers are broadcast.** `check_answers` returns every answered, unacknowledged question.
  `asked_by` is free text (`"agent"`, `"Codex"`, `"claude-code abcd1234"`) and routes nothing.
- **Topics have no owner.** Any agent may pick up any active topic. The protocol says "active
  topics are what you own", which only works with one agent.
- **The chat queue** (`todo-queue.ts`) hands the one chat its unread answers first, then the top
  todo topic when no topic is active.
- **Terminal and IDE agents** reach the same board over MCP but are anonymous to it.

## 2. Goal

Several agents work on one repository at the same time, for example two Claude Code sessions
and one Codex session, plus agents in your terminal. Each works on its own topic. You can talk
to one agent specifically. The answer to a question reaches the agent that asked it. Two agents
never work on the same topic, and their changes do not collide in the working tree.

## 3. Plan

| Phase | What | Depends on |
| --- | --- | --- |
| 1 | **Agent identity:** agents as records on the board; every tool call knows its caller | – |
| 2 | **Message system** (this spec): addressed messages, per-agent delivery, answer routing | 1 |
| 3 | **Topic ownership:** `owner` on topics, claim on pickup, release and reassignment | 1 |
| 4 | **Dispatcher:** the chat queue for N agents (answers, messages, todo to a free agent) | 2, 3 |
| 5 | **Runners:** N `AgentRunner`s per repository, created and removed at runtime | 1, 4 |
| 6 | **Workspaces:** one git worktree per managed agent, so parallel edits do not collide | 5 |
| 7 | **UI:** agent list, one chat per agent, owner on cards, inbox by agent | 2–5 |

Phases 1–4 also help today's single chat plus terminal agents, so they ship before N runners.
Phase 6 is the one with the most unknowns (merging, tests per worktree, `.longe/` in each
worktree) and gets its own spec.

## 4. Core message system spec

### 4.1 Agents

An agent is a participant that works on the board.

```yaml
# ~/.longe/projects/<project-id>/agents/a-reviewer.yml
id: a-reviewer               # a-<slug>, unique in the project
name: Reviewer               # shown in the UI
kind: managed                # managed: longe runs it; external: connects by itself (terminal, IDE)
provider: claude             # managed only: claude | codex | …
model: sonnet                # optional
created: 2026-10-01T09:00:00+02:00
```

- Every project has one managed agent from the start, `a-chat`: today's chat. A repository that
  never adds a second agent behaves exactly as now.
- Runtime state (session ids, process, busy/idle) stays in `~/.cache/longe/agent/`, one file per
  agent, like today's sessions file. The record above is only who the agent is.
- **External agents** register themselves on their first tool call (§4.2) and appear with
  `kind: external`. An external agent that has not called a tool for 7 days is shown as gone.

### 4.2 Knowing who is calling

Every tool call is made by an agent; the server resolves which one:

| Transport | How the agent is named |
| --- | --- |
| Managed agent (HTTP MCP) | its own endpoint: `/r/<repo>/agents/<agent-id>/mcp`, set by the runner |
| `longe mcp --agent <name>` (stdio) | the flag; without it `external` plus the MCP client name |
| HTTP MCP without agent path | the MCP client's `clientInfo.name` + session id → `a-ext-<slug>` |
| REST | header `X-Longe-Agent: <agent-id>`; without it `human` for UI actions |

The resolved id is written wherever the board records an actor: `asked_by`, Log entries
(`agent` becomes `a-reviewer`), `acknowledged_by`, topic `owner`. Tools no longer take an
`asked_by` argument; it stays accepted and ignored for compatibility.

### 4.3 Messages

A message is a request to one agent. Files stay flat in `messages/`; the address is in the
frontmatter:

```yaml
---
id: m-20261001-4k2p
from: human                  # human | board | a-<agent id>
to: a-reviewer               # the agent it is for; `any` = whichever agent the dispatcher picks
at: 2026-10-01T09:12:00+02:00
topic: billing               # optional: the topic it is about
reply_to: m-20261001-3x9c    # optional: the message it answers (agent → agent, later)
delivered_at: 2026-10-01T09:12:03+02:00
---
## Message
Look at the refund path too.
```

Rules:

- `to` is required for new messages. Old messages without `to` belong to `a-chat` (read-time
  default, no rewrite).
- A message is **delivered** to exactly one agent: its `to`, or for `to: any` the agent the
  dispatcher chose, which is then written into `to` before delivery.
- A managed agent gets its messages pushed (as today). An external agent pulls them with a new
  tool, `check_messages`, which returns undelivered messages to the caller and marks them
  delivered. `check_answers` stays the tool for answers.
- A message to an agent that no longer exists goes to the owner of its `topic`, else to
  `a-chat`, with a board note saying it was forwarded.

### 4.4 Questions and answers

The question file keeps its format. Changed meaning:

- `asked_by` holds the agent id of the caller (§4.2).
- New optional `acknowledged_by: <agent id>`.
- **Routing.** An answer belongs to the agent that asked. If that agent is gone, to the owner
  of the question's topic; if the topic has no owner, to any agent.
- **`check_answers`** returns, for the calling agent: answers to its own questions, answers to
  questions on topics it owns, and answers nobody is left to receive. Other agents' answers are
  not in its list. `check_answers(all: true)` keeps today's behaviour for tools and scripts.
- **Push to managed agents** (today's chat queue) follows the same routing: each answer is told
  to exactly one agent, once.

### 4.5 Topic ownership

Topics get two optional frontmatter fields:

```yaml
owner: a-reviewer            # the agent working on it
claimed_at: 2026-10-01T09:20:00+02:00
```

- `set_status active` by an agent claims the topic: `owner` is set to the caller. Claiming a
  topic another live agent owns is refused (`conflict`), with the owner named.
- The owner stays through `needs-decision` and `review`, so answers and a rejection come back
  to the same agent. `done` and `cancelled` clear it.
- The human can reassign (UI or REST); the new owner gets a handoff message (§4.6).
- "Active topics are what you own" in the protocol becomes literal: `list_topics(status:
  active)` shows owner, and an agent works only on its own topics and unowned ones it claims.

### 4.6 Handoff

Today's provider-switch handoff becomes the general case. Whenever work moves from one agent to
another (provider switch, agent removed, topic reassigned), the receiving agent gets one board
message listing: the topics now owned, the unacknowledged answers now routed to it, and a
reminder to check `git status` in its workspace for work in progress.

### 4.7 Dispatcher

Replaces `attachChatQueue` for N agents. A managed agent is **free** when no turn runs and
nothing is on its way (today's `busy()`). For each free agent, in this order, at most one
message per turn end:

1. unacknowledged answers routed to it (§4.4), all in one message;
2. undelivered messages addressed to it (§4.3);
3. a topic the human moved to active and assigned to it;
4. if it owns no active topic: the top todo topic nobody has claimed, which it then claims.
   With several free agents, the one idle longest gets it.

`to: any` messages and todo topics are therefore never handed to two agents. External agents
are never pushed to; they pull with `check_answers` / `check_messages`.

### 4.8 Compatibility

- One agent (`a-chat`) = today's behaviour; no config needed.
- Board files without `to`, `owner` or agent-shaped `asked_by` are valid and read with the
  defaults above. No migration rewrites files.
- The MCP tool list only grows (`check_messages`; later `send_message`); existing arguments keep
  working.

## 5. Out of scope for this spec

Agent-to-agent messages (`send_message`, `reply_to`) beyond the field reservation; workspaces
and merging (phase 6); the UI (phase 7); agents across repositories; access control between
agents.

## 6. Open questions

1. **Workspaces first or later?** Without phase 6, parallel managed agents share one working
   tree and can overwrite each other's edits. Option: allow N agents only once worktrees exist,
   and ship phases 1–4 for the single chat plus terminal agents first.
2. **Where agent records live:** in the project's board folder (proposed, per machine) or in
   `.longe/config.yml` (shared with the team, but machine-specific providers do not fit there).
3. **External agents:** register automatically on first call (proposed) or only when the human
   adds them in the UI.
4. **Todo dispatch:** longest-idle agent (proposed), or topics carry a preferred agent/provider.
