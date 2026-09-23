/** Open questions across every live repo, for the Inbox badge. */
export interface InboxCounts {
  blocking: number;
  open: number;
}

/** Topics per status in one repo, for the Board badge. */
export interface BoardCounts {
  active: number;
  needsDecision: number;
  review: number;
}

/** `attn`: your turn (red). `busy`: something is moving (accent). `quiet`: nothing for you. */
export type Tone = "attn" | "busy" | "quiet";

/** Dot plus a word next to a menu link, re-fetched over SSE. */
export function StateBadge({
  id,
  tone,
  label,
  title,
  src,
  trigger,
  blocking,
}: {
  id: string;
  tone: Tone;
  label: string;
  title?: string | undefined;
  src: string;
  trigger: string;
  /** Inbox only: app.js puts it in the tab title ("(1) Inbox · longe") after a refresh. */
  blocking?: number | undefined;
}) {
  return (
    <span
      id={id}
      class={`state-badge ${tone}`}
      data-blocking={blocking}
      hx-get={src}
      hx-trigger={trigger}
      hx-swap="outerHTML"
      title={title ?? label}
    >
      <i />
      {label}
    </span>
  );
}

/** Blocking questions first, then anything open, else empty. */
export function inboxState(counts: InboxCounts): { tone: Tone; label: string } {
  if (counts.blocking > 0) return { tone: "attn", label: `${counts.blocking} blocking` };
  if (counts.open > 0) return { tone: "busy", label: `${counts.open} open` };
  return { tone: "quiet", label: "empty" };
}

/** Next to "Inbox". */
export function InboxBadge({ counts }: { counts: InboxCounts }) {
  const { tone, label } = inboxState(counts);
  const plural = counts.open === 1 ? "" : "s";
  const title =
    counts.open > 0
      ? `${counts.open} open question${plural}, ${counts.blocking} blocking`
      : "no open questions";
  return (
    <StateBadge
      id="inbox-badge"
      tone={tone}
      label={label}
      title={title}
      src="/fragments/inbox-badge"
      trigger="sse:changed"
      blocking={counts.blocking}
    />
  );
}

/** Where the ball is: your decisions first, then reviews, then the agent's work. */
export function boardState(counts: BoardCounts): { tone: Tone; label: string } {
  const { needsDecision, review, active } = counts;
  if (needsDecision > 0) return { tone: "attn", label: `${needsDecision} to decide` };
  if (review > 0) return { tone: "busy", label: `${review} to review` };
  if (active > 0) return { tone: "quiet", label: `${active} active` };
  return { tone: "quiet", label: "quiet" };
}

/** Next to "Board". */
export function BoardBadge({ counts, base }: { counts: BoardCounts; base: string }) {
  const { tone, label } = boardState(counts);
  const title = [
    `${counts.active} active`,
    `${counts.needsDecision} needs decision`,
    `${counts.review} in review`,
  ].join(" · ");
  return (
    <StateBadge
      id="board-badge"
      tone={tone}
      label={label}
      title={title}
      src={`${base}/fragments/board-badge`}
      trigger="sse:changed"
    />
  );
}
