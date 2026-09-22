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
