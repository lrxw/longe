/**
 * Visual identity of a repo: a stable color and a short monogram, used the same
 * way everywhere (header switcher, overview tiles, inbox cards) so the eye learns
 * it once. Color comes from a hash of the repo name unless `.ai/config.yml` sets
 * `color:`; the monogram from the title's initials.
 */

/** Hues spread around the wheel, skipping the reds used for "blocking". */
const HUES = [212, 262, 292, 322, 22, 42, 82, 152, 172, 192];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** CSS color for a repo. `override` is used verbatim when it looks like a color. */
export function repoColor(name: string, override?: string): string {
  if (override && /^(#[0-9a-f]{3,8}|[a-z]+\(.*\)|[a-z]+)$/i.test(override.trim()))
    return override.trim();
  const hue = HUES[hash(name) % HUES.length] ?? 212;
  return `hsl(${hue} 55% 46%)`;
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
