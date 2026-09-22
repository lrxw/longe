import { randomInt } from "node:crypto";
import { compactDate } from "../domain/time.js";

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const QUESTION_ID_RE = /^q-\d{8}-[0-9a-z]{4}$/;

/** Lowercase, ASCII, hyphen-separated. Falls back to `topic` for empty input. */
export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug || "topic";
}

/** Appends `-2`, `-3`, … until the slug is not in `existing`. */
export function uniqueSlug(base: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

export function randomBase36(length: number, rng: () => number = () => randomInt(36)): string {
  let out = "";
  for (let i = 0; i < length; i++) out += BASE36[rng() % 36];
  return out;
}

/** `q-YYYYMMDD-xxxx` (§2). Never sequential. */
export function newQuestionId(now: Date, rng?: () => number): string {
  return `q-${compactDate(now)}-${randomBase36(4, rng)}`;
}

/** Same as newQuestionId but guaranteed not to collide with `existing`. */
export function uniqueQuestionId(
  now: Date,
  existing: Iterable<string>,
  rng?: () => number,
): string {
  const taken = new Set(existing);
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = newQuestionId(now, rng);
    if (!taken.has(id)) return id;
  }
  throw new Error("could not generate a unique question id");
}
