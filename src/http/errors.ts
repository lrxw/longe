import { DomainError } from "../domain/errors.js";

/** HTTP status for a DomainError (§7.3). */
export function statusFor(err: unknown): number {
  if (!(err instanceof DomainError)) return 500;
  switch (err.code) {
    case "validation":
    case "note_required":
    case "parse_error":
      return 400;
    case "not_found":
      return 404;
    default:
      return 409;
  }
}
