/**
 * The reply's last paragraph asks something: it ends with "?", or a sentence in it
 * does. Code blocks do not count.
 */
export function endsWithQuestion(text: string): boolean {
  const prose = text.replace(/```[\s\S]*?```/g, "").trim();
  const last =
    prose
      .split(/\n\s*\n/)
      .at(-1)
      ?.trim() ?? "";
  return /\?(\s|$|["'`)*_])/.test(last);
}
