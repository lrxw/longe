/**
 * Visual identity of a repo: a stable color and a short monogram, used the same
 * way everywhere (header switcher, overview tiles, inbox cards) so the eye learns
 * it once. Color comes from a hash of the repo name unless `.ai/config.yml` sets
 * `color:`; the monogram from the title's initials.
 */

/**
 * Eight colors that are easy to tell apart: hues far from each other, and lightness
 * varied too. No red (that means "blocking"). All carry white text.
 */
export const PALETTE = [
  "hsl(214 70% 48%)", // blue
  "hsl(26 85% 46%)", // orange
  "hsl(142 55% 34%)", // green
  "hsl(275 55% 52%)", // violet
  "hsl(182 70% 30%)", // teal
  "hsl(325 62% 48%)", // pink
  "hsl(70 60% 32%)", // olive
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
 * Colors for a set of repos, distinct as long as there are no more repos than
 * palette slots. Each repo starts at its hash slot and takes the next free one if
 * another repo already holds it; repos are placed in name order, so the result does
 * not depend on registry order. A repo with a valid `override` keeps it and takes
 * no slot.
 */
export function repoColors(
  repos: { name: string; override?: string | undefined }[],
): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<number>();
  for (const r of [...repos].sort((a, b) => a.name.localeCompare(b.name))) {
    const o = validOverride(r.override);
    if (o) {
      out.set(r.name, o);
      continue;
    }
    let slot = hash(r.name) % PALETTE.length;
    for (let i = 0; i < PALETTE.length && taken.has(slot); i++) slot = (slot + 1) % PALETTE.length;
    taken.add(slot);
    out.set(r.name, PALETTE[slot] as string);
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
