const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** ISO 8601 with the local UTC offset, e.g. `2026-09-22T14:10:00+02:00` (§2). */
export function toLocalIso(d: Date): string {
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export function nowIso(): string {
  return toLocalIso(new Date());
}

/** `YYYY-MM-DD` in local time. Used for Decisions lines. */
export function dateStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `YYYY-MM-DD HH:mm` in local time. Used for Log lines. */
export function minuteStamp(d: Date): string {
  return `${dateStamp(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `YYYYMMDD` in local time. Used for question ids. */
export function compactDate(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

export const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$/;

export function isIsoTimestamp(s: unknown): s is string {
  return typeof s === "string" && ISO_WITH_OFFSET.test(s) && !Number.isNaN(Date.parse(s));
}
