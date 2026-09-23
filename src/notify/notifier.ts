import type { Notifier } from "../index/effects.js";

/**
 * Desktop notification via node-notifier (§10). Loaded lazily and wrapped so a
 * missing or failing notifier never affects the operation that triggered it.
 * Full wiring (icons, click-through) is Phase 5.
 */
export const desktopNotifier: Notifier = (title, body) => {
  import("node-notifier")
    .then((mod) => {
      const notifier = (mod.default ?? mod) as {
        notify: (o: { title: string; message: string }) => void;
      };
      notifier.notify({ title, message: body || " " });
    })
    .catch(() => {});
};

/**
 * Sends bursts as one: notifications within `ms` of the first are collected, and
 * each title goes out once, with a count when there were several ("longe · Ready
 * for review (3)", the bodies joined).
 */
export function coalescing(send: Notifier, ms = 5000): Notifier {
  let pending: { title: string; body: string }[] = [];
  let timer: NodeJS.Timeout | undefined;
  const flush = () => {
    timer = undefined;
    const byTitle = new Map<string, string[]>();
    for (const n of pending) byTitle.set(n.title, [...(byTitle.get(n.title) ?? []), n.body]);
    pending = [];
    for (const [title, bodies] of byTitle) {
      const uniq = [...new Set(bodies)];
      const body = uniq.join("; ");
      send(
        uniq.length > 1 ? `${title} (${uniq.length})` : title,
        body.length > 200 ? `${body.slice(0, 199)}…` : body,
      );
    }
  };
  return (title, body) => {
    pending.push({ title, body });
    timer ??= setTimeout(flush, ms);
    timer.unref?.();
  };
}
