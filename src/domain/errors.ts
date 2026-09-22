export type ErrorCode =
  | "validation"
  | "not_found"
  | "parse_error"
  | "transition_not_allowed"
  | "human_only"
  | "system_only"
  | "note_required"
  | "same_status"
  | "conflict";

/** Error raised by domain/store code. `code` is machine-readable (§7.3). */
export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export class ParseError extends DomainError {
  constructor(
    message: string,
    public readonly file?: string,
  ) {
    super("parse_error", file ? `${file}: ${message}` : message);
    this.name = "ParseError";
  }
}
