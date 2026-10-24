# longe-inbox

This mod is a client of **longe ask**, the question-and-answer part of longe.
It shows the same Inbox for standalone questions and questions from **longe board** topics.
The plugin name remains `longe-inbox`; the Ask / Board names do not change its installation.

A Claude Code mod that brings longe's question inbox into Claude Code, so you can answer your agents
without switching to the browser.

- **Band above the prompt**: `● longe inbox: 2 blocking, 1 non-blocking questions [Open] [Hide]`,
  shown whenever something waits on you. It comes back by itself when a new question arrives.
- **Inbox pane** (`/longe`, or **Open** on the band): every open question across your registered
  repositories, in longe's order (blocking first, then oldest). Each card shows the project, topic,
  who asked it and when, the question and context as rendered markdown, and the assumption the agent
  is working on. Pick an option, or type a reply and press Enter. **↗ open in longe** opens the
  topic on the board.
- **Toast** when a new blocking question arrives.

It runs alongside the web board: both read the same files, so you can answer in either place.

## How it works

- **Reading**: while longe runs, the mod draws longe's inbox view model
  (`GET http://127.0.0.1:7311/api/v1/inbox`): the same order, labels, icons and option roles
  (✓ approves, ✗ sends back) as the web inbox. Roles map to Claude Code theme keys (blocking →
  `warning`, approve → `success`, reject → `error`); project colours are the same hex values.
  The view carries a version; one this mod does not know makes it fall back to the files and
  say so. The shared contract is `src/inbox/view.ts` in longe; `hooks/tokens.ts` is the
  mod's copy, kept equal by longe's tests.
- **Offline**: while `longe serve` is stopped, the mod reads the board files directly, the way
  longe does. It takes repositories from `~/.config/longe/repos.yml`, each repository's `id`
  from `.longe/config.yml`, and open questions from `~/.longe/projects/<id>/questions/*.md`.
  `LONGE_HOME` and `XDG_CONFIG_HOME` are respected. The pane says "(from files)". It refreshes
  every 5 seconds and after each Claude turn, and re-reads only the files that changed.
- **Answering**: answers go to `POST http://127.0.0.1:7311/api/v1/answer_question` with `repo`,
  `id` and either `option_index` or `answer`. longe then applies its own rules: it unblocks the
  topic, approves or rejects a review, and wakes the chat. If longe isn't running, the card tells
  you to start it with `longe serve -d`.

## Try it

```sh
claude --plugin-dir /path/to/longe/mods/longe-inbox
```

Then run `/longe`. To check that it loaded, run `/plugin`; the dim line lists `longe-inbox`.

If longe listens on another port, set `port` in `/config` (or in `pluginConfigs["longe-inbox"]`
in `~/.claude/settings.json`).

## Install permanently

Add this folder's parent as a marketplace once, then install from it:

```sh
claude plugin marketplace add /path/to/longe/mods
claude plugin install longe-inbox@longe-mods
```

## Develop

```sh
claude plugin validate .   # what it hooks and calls
claude plugin test .       # hooks/inbox.test.tsx, on the terminal and desktop surfaces
```

Requires Claude Code 2.1.287 or later (2.1.286 or later in the Desktop app).
