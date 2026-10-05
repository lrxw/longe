# Multi-agent longe: UI spec

Status: **draft for review**. Builds on the approved core message-system spec
(`docs/spec/multi-agent.md`, revision approved 2026-10-05; currently in `stash@{0}`) and its
workflow assessment (`docs/spec/multi-agent-use-cases.md`, same stash). Section numbers like
§4.3 refer to that core spec. Nothing here is implemented.

## 1. Principles

1. **One agent looks like today.** A project with only `a-chat` shows today's Chat, Board and
   Inbox with no new controls. Agent UI appears when a second participant exists
   (progressive disclosure).
2. **Responsibility is always visible.** Wherever work appears (card, topic, question,
   message), it shows who owns it or who will receive it.
3. **Nothing moves silently.** Reassigning, retiring and routing problems open an explicit
   choice; the UI never forwards work to whoever is idle (§4.3, §4.6).
4. **The user chooses the workflow.** Reviewers, parallel writers and todo pickup are per
   project and per agent settings, off unless enabled (core §2).
5. **State over spinners.** Paused, failed, stopping-uncertain and offline are distinct, named
   states with their own next action (§4.1a).

## 2. Where things live

| Place | Today | With several agents |
| --- | --- | --- |
| Side menu | Inbox · Board · Chat (state badge) | Inbox · Board · **Agents** (one badge per state, e.g. "1 working · 1 paused") · Chat |
| Chat | `/r/<repo>/chat` | `/r/<repo>/chat` = `a-chat`; `/r/<repo>/chat/<agent-id>` per agent; tab strip on top |
| Agents | – | `/r/<repo>/agents`: list, add, lifecycle actions, project settings |
| Board card | title, status | + owner chip; filter "owner: …" |
| Topic page | goal, plan, log, questions, actions | + owner line with Reassign; linked topics (e.g. review) |
| Inbox question | question, options, answer | + "asked by" and "goes to" (if different); routing problems on top |

## 3. Agents page

```
Agents · shop                                            [+ Agent]

 NAME        PROVIDER        STATE        WORK                 
 Chat        Claude · sonnet  ● working   billing (owner)       [Pause] [Stop] [⋯]
 Reviewer    Claude · opus    ○ idle      billing-review         [Pause] [⋯]
 Codex term. external         ◌ offline   search (owner) · 2h    [Pause] [⋯]
 Writer B    Codex            ⏸ paused   –  · 1 answer waiting   [Resume] [⋯]

 Project settings
   Concurrent managed turns   [1 ▾]     (more than 1 needs workspaces, phase 6)
   Agent review               ( ) off   ( ) ask per task   ( ) after every topic
   Todo pickup                ☑ Chat  ☐ Reviewer  ☐ Writer B
```

- **State column:** dispatch (`enabled` / `paused`) and runtime (`off`, `working`, `idle`,
  `failed`, `stopping…`) combined into one label; external agents show `connected` / `offline`
  with last seen. Hover shows the full pair.
- **Work column:** owned active topics, plus counts of waiting answers and messages routed to
  this agent.
- **[+ Agent]:** dialog with name, provider (installed ones), model (from the provider), todo
  pickup checkbox (off by default for additional agents). Creates the record only (§4.1a Add);
  no process starts.
- **⋯ menu:** New session, Rename, Retire. External agents: Reconnect binding, Retire.
- **Retire** opens the handoff dialog (§6). Disabled for `a-chat` (pause or reset only).
- **Failed:** red label with the last error and [Recover] (clears failure, keeps assignments);
  automatic relaunch stays off until then (§4.1a States).
- **Stopping uncertain:** grey label "stop not confirmed"; no replacement writer can start
  until the user confirms or the runtime reports its end.

## 4. Chat per agent

```
 Chat · shop    [Chat ●] [Reviewer ○] [Writer B ⏸]                      provider · model · context
 ───────────────────────────────────────────────────────────────────────────────────────────
 transcript of the selected agent
 ───────────────────────────────────────────────────────────────────────────────────────────
 [ message to Reviewer …                                     ] [Queue ▾]  [Send]
```

- One tab per managed agent; external agents have no chat tab (longe does not run them) but a
  "messages for Codex term." view listing queued items until it pulls them.
- The prompt box sends `to: <selected agent>`. **Queue / Steer** toggle appears only when the
  provider supports steering (§4.3 `mode`); otherwise "will run after the current turn".
- Provider and model selectors, Stop, Continue, New session move into the tab (per agent).
- A paused agent's tab shows a banner "Paused: messages wait" with [Resume].
- The topic page's prompt box sends to the topic's owner by default, with a small "to:" select.

## 5. Board and topic page

- **Owner chip** on each active / needs-decision / review card (agent name and color dot).
  Unowned todo cards show nothing; unowned active cards show "unowned".
- **Filter:** "owner: anyone / <agent> / unowned" above the columns.
- **Drag to active** keeps today's meaning; if several agents could take it, a small popover
  asks "Activate for: Chat / Reviewer / let the queue decide".
- **Topic page owner line:** "Owner: Chat · since 10:20 · [Reassign]". Reassign opens the
  handoff dialog limited to this topic.
- **Linked topics:** a "Linked" section lists e.g. `billing-review` (owner Reviewer, reviewing
  commit abc123). [Request review] appears when project review is "ask per task"; it creates
  the linked review topic and asks which agent owns it.

## 6. Handoff dialog (retire, reassign)

```
 Hand over from Writer B

 Topics             ☑ search (active)   ☑ search-tests (needs-decision)
 Answers waiting    1  (q-20261005-ab12)
 Messages waiting   2
 Workspace          ../shop-writer-b  (branch writer-b/search, 3 commits, dirty files)

 Give to   [Chat ▾]
 ☐ Writer B is stopped (required for external agents)

                                   [Cancel]  [Hand over]   (Retire: [Hand over and retire])
```

- Lists every affected item before anything moves (§4.6 step 2).
- Workspace line is informational: no copy, merge or cleanup happens here.
- External source: the "is stopped" confirmation is required; offline is not proof.
- After confirming, the target gets one handoff message; the transcript shows it as a board
  message at the top of the target's next turn.

## 7. Inbox

- Each question shows "asked by Writer B" and, when the recipient differs after a handoff,
  "goes to Chat".
- Filter chips: all / per agent.
- **Routing problems** section above everything else (§4.3): a message or answer whose
  recipient is retired or missing, with a [Choose recipient] action. Never auto-resolved.
- Blocking questions stay first within each group, as today.

## 8. Notifications and badges

- Side-menu Agents badge: counts by state; red when any agent failed.
- Desktop notifications (today: blocking questions) add "agent failed" and "stop not
  confirmed".
- Overview cards (inbox page top) show per project: agents working / paused / failed.

## 9. Out of scope

Workspace creation, merge and cleanup UI (phase 6 spec); cost dashboards; agent-to-agent
messaging UI; dependency graphs between topics; templates for workflows.

## 10. Open questions

1. **Agents page or Chat page?** Separate `/agents` page (proposed) versus an agents column on
   the Chat page.
2. **Review preference options:** off / ask per task / after every topic (proposed), or only
   off / per task in the first version.
3. **Drag to active with several agents:** popover (proposed) or always "let the queue decide".
4. **External agents' messages:** show a pull-only "messages for …" view (proposed), or only
   counts on the Agents page.
