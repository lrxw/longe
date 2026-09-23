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
 * Sends bursts as one: notifications within `ms` of the first are collected per
 * repo (the title's part before " · "). A single one goes out as it is; several
 * become "longe · 3 blocking questions" with their titles as the text.
 */
export function coalescing(send: Notifier, ms = 5000): Notifier {
  let pending: { title: string; body: string }[] = [];
  let timer: NodeJS.Timeout | undefined;
  const flush = () => {
    timer = undefined;
    const byRepo = new Map<string, { title: string; body: string }[]>();
    for (const n of pending) {
      const repo = n.title.includes(" · ") ? (n.title.split(" · ")[0] as string) : "";
      byRepo.set(repo, [...(byRepo.get(repo) ?? []), n]);
    }
    pending = [];
    for (const [repo, list] of byRepo) {
      const first = list[0];
      if (!first) continue;
      if (list.length === 1) {
        send(first.title, first.body);
        continue;
      }
      const titles = list.map((n) => (repo ? n.title.slice(repo.length + 3) : n.title));
      const body = titles.join("; ");
      send(
        `${repo ? `${repo} · ` : ""}${list.length} blocking questions`,
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
