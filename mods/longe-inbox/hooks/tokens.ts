// A copy of longe's inbox view contract (src/inbox/view.ts in longe): a mod
// cannot import files outside its folder. longe's test suite checks that this copy
// matches. The running longe also sends its tokens with GET /api/v1/inbox; the mod
// uses those, and this copy only while longe is not running.

export const INBOX_VIEW_VERSION = 1;

export type InboxRole = "blocking" | "nonBlocking" | "approve" | "reject" | "muted" | "accent";
export type OptionRole = "approve" | "reject" | "neutral";

export const INBOX_TOKENS = {
  roles: {
    blocking: { label: "blocking", icon: "●" },
    nonBlocking: { label: "non-blocking", icon: "○" },
    approve: { label: "approves the work", icon: "✓" },
    reject: { label: "sends the work back", icon: "✗" },
    muted: { label: "", icon: "" },
    accent: { label: "", icon: "" },
  },
  text: {
    workingOn: "Working on:",
    projectWide: "project-wide",
    context: "Context",
    reply: "Reply",
    empty: "Nothing is waiting on you.",
    emptyProject: "Nothing is waiting on you in this project.",
  },
};

export type InboxTokens = typeof INBOX_TOKENS;

/** GET /api/v1/inbox, the fields the mod reads. */
export interface InboxViewWire {
  version: number;
  tokens: InboxTokens;
  questions: {
    id: string;
    repo: string;
    project: string;
    color: string;
    topic: string | null;
    kind: "blocking" | "nonBlocking";
    askedBy: string;
    askedAt: string;
    question: string;
    context: string;
    contextOpen: boolean;
    assumption: string | null;
    options: { index: number; label: string; role: OptionRole }[];
    links: { board: string; topic: string | null };
  }[];
  problems: { file: string; message: string }[];
}

/** Each role as a Claude Code theme key: the meaning is longe's, the colour the theme's. */
export const THEME: Record<InboxRole, string> = {
  blocking: "warning",
  nonBlocking: "suggestion",
  approve: "success",
  reject: "error",
  muted: "inactive",
  accent: "claude",
};

export function optionRole(
  label: string,
  q: { approveOptions: string[]; rejectOptions: string[] },
): OptionRole {
  return q.rejectOptions.includes(label)
    ? "reject"
    : q.approveOptions.includes(label)
      ? "approve"
      : "neutral";
}
