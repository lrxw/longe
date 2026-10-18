import type { InboxTokens, OptionRole } from "../hooks/tokens";

/** One open question from a longe board, as the inbox shows it. */
export type LongeInboxQuestion = {
  id: string;
  /** Registered repo name (`longe repos`), used for REST calls. */
  repo: string;
  /** Display name from `.longe/config.yml` `project`. */
  project: string;
  /** The project's color from `.longe/config.yml`, if set. */
  color: string | null;
  topic: string | null;
  askedBy: string;
  askedAt: string;
  blocking: boolean;
  options: string[];
  /** Options that approve a topic in review (moves it to done). */
  approveOptions: string[];
  /** Options that reject a topic in review (moves it back to active). */
  rejectOptions: string[];
  /** Per option, in order: what picking it does to work in review. */
  optionRoles: OptionRole[];
  assumption: string | null;
  question: string;
  context: string;
  /** Show the context open from the start (it holds code). */
  contextOpen: boolean;
  /** Paths on the longe server. */
  links: { board: string; topic: string | null };
};

/** A question the inbox could not read. */
export type LongeInboxProblem = { file: string; message: string };

export type LongeInboxSnapshot = {
  questions: LongeInboxQuestion[];
  problems: LongeInboxProblem[];
  /** Epoch ms of the last scan. */
  scannedAt: number;
  /** Why nothing could be scanned (no registry, no boards), if so. */
  note: string | null;
  /** Labels and icons by role: the running longe's, else the mod's copy. */
  tokens: InboxTokens;
  /** "server": the view model from a running longe; "files": read from disk. */
  source: "server" | "files";
};

declare module "claude-code" {
  interface PluginState {
    "longe-inbox": {
      inbox: LongeInboxSnapshot;
      /** Question id → message after an answer attempt (error or confirmation). */
      flash: Record<string, string>;
      isBandHidden: boolean;
      /** The mod's version from its plugin.json. */
      version: string;
      /** The question the pane shows in full; the first one when unset or gone. */
      selected: string | null;
      /** Question id → whether its Context section is expanded. */
      openContext: Record<string, boolean>;
    };
  }
}
