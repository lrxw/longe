import type { Subject } from "./types.js";

/** The fields a subject is read from (`subject:`, or the `topic:` alias). */
export interface SubjectFields {
  topic?: string | null | undefined;
  subject?: Subject | null | undefined;
}

/** The question's subject: `subject:` if set, else `topic: <id>` as `{ kind: "topic" }`. */
export function subjectOf(fm: SubjectFields): Subject | null {
  if (fm.subject) return fm.subject;
  return fm.topic ? { kind: "topic", id: fm.topic } : null;
}

/** The subject's id when it is of `kind`, else undefined. */
export function subjectId(fm: SubjectFields, kind: string): string | undefined {
  const s = subjectOf(fm);
  return s?.kind === kind ? s.id : undefined;
}
