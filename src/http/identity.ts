/**
 * Visual identity of a repo: a stable color and a short monogram, used the same
 * way everywhere (header switcher, overview tiles, inbox cards) so the eye learns
 * it once. Color comes from the repo's place in the registry (repoColors) unless
 * `.longe/config.yml` sets `color:`; the monogram from the title's initials.
 */

/**
 * Colors handed out in this order, so the first repos differ the most: blue,
 * orange, violet, green, then the in-between ones. No red (that means "blocking").
 * All carry white text. Past eight they repeat; the human does not mind for now.
 */
export const PALETTE = [
  "hsl(214 70% 48%)", // blue
  "hsl(28 88% 48%)", // orange
  "hsl(275 55% 52%)", // violet
  "hsl(142 55% 34%)", // green
  "hsl(330 65% 50%)", // pink
  "hsl(45 80% 38%)", // gold
  "hsl(186 70% 32%)", // teal
  "hsl(215 15% 40%)", // slate
] as const;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function validOverride(override: string | undefined): string | undefined {
  const o = override?.trim();
  return o && /^(#[0-9a-f]{3,8}|[a-z]+\(.*\)|[a-z]+)$/i.test(o) ? o : undefined;
}

/** CSS color for one repo on its own: its hash slot in the palette, or `override`. */
export function repoColor(name: string, override?: string): string {
  return validOverride(override) ?? (PALETTE[hash(name) % PALETTE.length] as string);
}

/**
 * Colors for the registered repos, in registry order: the first repo gets blue,
 * the second orange, and so on, so the first few are as different as the palette
 * allows. A repo added later is appended to the registry and does not change the
 * colors of the others. A repo with a valid `override` keeps it and takes no slot.
 */
export function repoColors(
  repos: { name: string; override?: string | undefined }[],
): Map<string, string> {
  const out = new Map<string, string>();
  let next = 0;
  for (const r of repos) {
    const o = validOverride(r.override);
    out.set(r.name, o ?? (PALETTE[next++ % PALETTE.length] as string));
  }
  return out;
}

/** "My Shop" → "MS", "shop" → "SH", "x" → "X". At most two characters, upper-case. */
export function monogram(title: string): string {
  const words = title
    .split(/[\s_\-./]+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
  const initials =
    words.length >= 2
      ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`
      : (words[0] ?? title).slice(0, 2);
  return (initials || title.slice(0, 2) || "?").toUpperCase();
}
