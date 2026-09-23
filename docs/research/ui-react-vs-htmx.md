# UI approach: React or htmx + idiomorph?

Status: recommendation adopted, 2026-09-23. Option A is implemented and checked in the
browser (topic `morph-swaps-for-live-refreshes-htmx-idiomorph`). Board topic:
`research-react-vs-htmx-idiomorph-for-the-longe-ui`.

**Sources.** Facts about longe come from the codebase and the board's topic history, with
file references. Web search was not available when this was written. Claims about idiomorph
are now checked against its source (`node_modules/idiomorph`, version 0.8.0) and against the
implementation, and are marked *(verified)*. Claims about React and the other options are from
general knowledge and stay *(unverified)*.

## Recommendation

Keep htmx and add idiomorph morph swaps. A React rewrite would fix one class of bugs that
morphing also fixes. It would not fix the other bugs we had, and it would add a build step, a
JSON layer for everything the UI does, and a rewrite of about 1,250 lines of views.

Revisit React only if longe's UI moves towards heavy client-side interaction. Examples are
editing topics inline on the board, optimistic drag and drop, or offline use. None of these is
planned.

## What longe's UI is

- **Views.** Server-rendered Hono JSX, about 1,250 lines in `src/http/views/`. The largest are
  `agent.tsx` (399 lines) and `layout.tsx` (203).
- **Client code.** `public/app.js` has 271 lines, with no framework and no build step. htmx 2
  and its SSE extension are vendored in `public/vendor/`.
- **Pages.**
  - Inbox: question cards with answer forms.
  - Board: columns of topic cards, drag and drop between columns, and the cleanup bar.
  - Topic page: status actions.
  - Chat: a prompt form, a live transcript that refreshes every 250 ms while the agent
    streams, a model select and the action buttons.
- **Live updates.** One SSE stream (`/events`). A merged `changed` event makes the board, the
  inbox, the topic page and the badges re-fetch their HTML fragment; `agent-changed` refreshes
  the chat panel. Every refresh is an `outerHTML` swap.
- **Shipping.** An npm package with `dist` and `public`. `prepare` only runs `tsc` on `src`.
- **JSON API.** `/api/v1` exists, but only for the agent tools and the human status actions.
  Board cleanup, arbitrary status moves, the counts and the whole chat exist only as HTML
  routes.

## The bugs so far, by root cause

These are the twelve rendering and refresh topics on the board, now mostly archived.

| Root cause | Topics | Would React have avoided it? | Would idiomorph? |
|---|---|---|---|
| (a) A whole-fragment swap wipes client state | transcript jumps while streaming; status line flickers; board flashes as a whole; the inbox wipes the answer you are typing | yes | yes *(details: see below)* |
| (b) Server state or events | lost file-watcher events; the "my_game" chat shows "off" while output flows; header repo counts not refreshing | no | no |
| (c) Out-of-order refresh responses | the board is stale after cleanup | no, a fetch-based client has the same race and needs the same guard | no, it is fixed by `hx-sync` plus SSE coalescing (done) |
| (d) CSS and layout | the status bar changes shape | no | no |
| (e) Browser caching and navigation | the board is stale after Escape from an approved topic | partly, since a single-page app avoids the back-forward cache but must refetch on focus | no |
| (f) Wording and behaviour | the chat opens at the top; autofocus; the "New session" dead end | no | no |

Four of twelve are class (a). That is the only class where the choice of library matters, and
morphing addresses it.

## Option A: htmx + idiomorph

**What changes.**
- Vendor `idiomorph-ext.min.js`, then add `hx-ext="morph"` and `hx-swap="morph"` to `#board`,
  `#inbox`, `#topic` and `#agent`.
- The markup barely changes. The routes and the server stay as they are.

**What it fixes.** Idiomorph matches existing elements by `id` and updates them in place instead
of replacing them *(unverified)*. The elements that survive keep:
- focus, caret and selection,
- the scroll position of the transcript,
- the element identity, so the "detached target" workaround goes away.

Swaps that do not rebuild the page also do not flash.

**What it does not do by itself.** State the user created and the server does not render is
reset to the server's HTML *(verified: the `open` state of `<details>` closed on every refresh
until handled)*. Idiomorph offers `ignoreActiveValue`, `restoreFocus` (on by default) and the
callback `beforeAttributeUpdated` in `Idiomorph.defaults` *(verified in the source)*. What
longe does now:
- `beforeAttributeUpdated` keeps `open` on existing `<details>`, and `ignoreActiveValue` keeps the
  value of the focused field.
- Open and closed boxes are remembered per tab (`data-key` plus `sessionStorage`), which also
  survives reloads.
- The text of unfocused textareas is still reset by a morph *(verified)*, so the carry-over of
  typed text in `app.js` stays.
- `hx-preserve` was not needed.

**Risks, as they turned out.**
- Elements without an `id` are matched by position *(verified: `findBestMatch` falls back to a
  "soft match" on tag name)*. This caused a real bug: dragging the first card away showed its
  title on the card that moved up. `data-id` is not an id. Cards and columns now carry `id`s.
- `ignoreActiveValue` skips the children of the focused element *(verified)*. It protects typed
  text, but a card that kept focus after a drag missed its own update. The dragged card is now
  blurred when the drag ends.
- Large DOMs cost more CPU than a plain swap *(unverified)*. Our fragments are small.

**Effort, as it turned out.** About half a day, including three follow-up fixes found in the
browser (details state, drag title, tab title).

**Keeps.** No build step, the vendored-file model, server-side rendering, the tests that assert
on HTML, and one language and code path for the UI.

## Option B: React

**What changes.**
- **A build step.** Vite or esbuild for client code, and a bundle in the npm package.
- **A data layer.** JSON endpoints for everything the UI does, which today are HTML-only: chat,
  cleanup, counts and status moves. Alternatively, SSR plus hydration.
- **Client state.** Client state fed by SSE, either hand-written or with a query library.
- **The views.** A rewrite of about 1,250 lines of views plus `app.js` as components.

**What it fixes.** Class (a), through reconciliation *(well established)*.

**What it does not fix.** Out-of-order responses still need guards such as AbortController or
response versioning. The server-side bugs remain.

**Cost.**
- Weeks rather than a day.
- About 45 KB gzipped of React *(unverified figure; Preact is a much smaller alternative)*.
- Two rendering stacks during the migration, and tests that change from HTML assertions to
  component tests.

**Worth it when.** The UI needs rich client-side state: inline editing, optimistic updates,
complex drag and drop, or offline mode.

## Options named for completeness

- **Alpine.js next to htmx:** local UI state such as disclosures and drafts, declaratively.
  It has a morph plugin *(unverified)*.
- **Datastar:** SSE plus morphing as its core model, close to what longe does *(unverified)*.
  It would replace htmx rather than add to it.
- **Preact:** React's model at a fraction of the size. It still needs a build step and the
  same data layer as option B.

## Next steps

1. Done: morph swaps are in, and htmx, its SSE extension and idiomorph come from npm
   (`/vendor/<name>`). The `app.js` review kept the live-element lookup (the badges still use
   outerHTML), the transcript follow-to-end, and the carry-over of typed text; the old details
   restore is gone.
2. Open: verify the remaining *(unverified)* claims about React, Alpine.js and Datastar once
   web tools are allowed. They would not change the decision unless the UI moves to heavy
   client-side interaction.
