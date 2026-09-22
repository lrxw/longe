import { TOPIC_STATUSES } from "../../domain/types.js";
import type { RepoNav } from "./layout.js";

export interface RepoOverview {
  nav: RepoNav;
  counts: Record<string, number>;
  blocking: number;
  open: number;
}

/** One tile per repo at the top of the inbox: where the work is, where the ball is. */
export function OverviewStrip({ repos }: { repos: RepoOverview[] }) {
  if (repos.length === 0) {
    return (
      <p class="empty">
        No repos registered. Run <code>longe init</code> in a project, or{" "}
        <code>longe repos add &lt;dir&gt;</code>.
      </p>
    );
  }
  return (
    <section class="overview">
      {repos.map((r) => (
        <a
          class={`tile ${r.nav.missing ? "missing" : ""}`}
          href={r.nav.missing ? "/" : `${r.nav.base}/board`}
          title={r.nav.missing ?? r.nav.name}
        >
          <strong>{r.nav.title}</strong>
          {r.nav.missing ? (
            <span class="meta">unavailable</span>
          ) : (
            <>
              <span class="counts">
                {TOPIC_STATUSES.filter((s) => (r.counts[s] ?? 0) > 0).map((s) => (
                  <span class={`status ${s}`}>
                    {r.counts[s]} {s}
                  </span>
                ))}
                {Object.values(r.counts).every((n) => n === 0) ? (
                  <span class="meta">no topics</span>
                ) : null}
              </span>
              {r.blocking > 0 ? (
                <span class="tag block">{r.blocking} blocking</span>
              ) : r.open > 0 ? (
                <span class="tag">{r.open} open</span>
              ) : null}
            </>
          )}
        </a>
      ))}
    </section>
  );
}
