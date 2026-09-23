import { execFile } from "node:child_process";
import { BOARD_DIR } from "../store/paths.js";

/**
 * Read-only git lookups for the board: the commits made for a topic (their message
 * carries a `Topic: <id>` trailer, see the agent protocol) and whether the repo has
 * work that is not committed. A folder that is not a git repo, or a missing git,
 * simply yields nothing.
 */

export interface TopicCommit {
  hash: string;
  subject: string;
  /** ISO 8601 author date. */
  date: string;
}

function git(root: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: root, timeout: 5000, maxBuffer: 4 << 20 }, (err, stdout) => {
      resolve(err ? undefined : stdout);
    });
  });
}

/** Commits whose message has the line `Topic: <id>`, newest first (at most 50). */
export async function topicCommits(root: string, id: string): Promise<TopicCommit[]> {
  const out = await git(root, [
    "log",
    "-n",
    "50",
    "--fixed-strings",
    `--grep=Topic: ${id}`,
    "--format=%h%x1f%s%x1f%aI%x1f%B%x1e",
  ]);
  if (!out) return [];
  return (
    out
      .split("\x1e")
      .map((rec) => rec.replace(/^\n/, "").split("\x1f"))
      .filter((f): f is [string, string, string, string] => f.length === 4)
      // --grep matches anywhere: keep only commits whose trailer names exactly this topic
      .filter(([, , , body]) => body.split("\n").some((l) => l.trim() === `Topic: ${id}`))
      .map(([hash, subject, date]) => ({ hash, subject, date }))
  );
}

const dirtyCache = new Map<string, { at: number; files: number | undefined }>();

/**
 * How many files have uncommitted changes, outside the board folder (its topic and
 * question files change all the time and are not the work). Undefined outside git.
 * Cached for a few seconds: the board asks on every live refresh.
 */
export async function uncommittedFiles(
  root: string,
  now = Date.now(),
): Promise<number | undefined> {
  const hit = dirtyCache.get(root);
  if (hit && now - hit.at < 3000) return hit.files;
  const out = await git(root, ["status", "--porcelain", "--", ".", `:(exclude)${BOARD_DIR}`]);
  const files = out === undefined ? undefined : out.split("\n").filter(Boolean).length;
  dirtyCache.set(root, { at: now, files });
  return files;
}
