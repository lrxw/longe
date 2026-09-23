import { TOPIC_STATUSES } from "../../domain/types.js";
import { Avatar, type RepoNav } from "./layout.js";

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
        No repos registered. <a href="/repos/new">Create a project</a>, run <code>longe init</code>{" "}
        in a project, or <code>longe repos add &lt;dir&gt;</code>.
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
          style={`--repo:${r.nav.color}`}
        >
          <strong>
            <Avatar repo={r.nav} />
            {r.nav.title}
          </strong>
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
      <a
        class="tile new"
        href="/repos/new"
        title="Create a folder (or use an existing one) with .longe/"
      >
        <strong>+ New project</strong>
        <span class="meta">folder, .longe/, board</span>
      </a>
    </section>
  );
}

/** The "New project" form: a folder under home, an optional name. */
export function NewProjectForm({
  home,
  path,
  name,
  error,
}: {
  home: string;
  path?: string | undefined;
  name?: string | undefined;
  error?: string | undefined;
}) {
  return (
    <section class="card new-project">
      <h1>New project</h1>
      <p class="meta">
        Creates the folder if it is missing and adds <code>.longe/</code> (like{" "}
        <code>longe init</code>
        ), then opens its board. An existing folder works too. Only folders inside {home}.
      </p>
      <form method="post" action="/repos/new">
        <label>
          Folder
          <input name="path" value={path ?? "~/projects/"} required autocomplete="off" />
        </label>
        <label>
          Name <span class="meta">(optional, default: the folder name)</span>
          <input name="name" value={name ?? ""} autocomplete="off" />
        </label>
        {error ? <p class="error">{error}</p> : null}
        <div class="row">
          <a href="/">Cancel</a>
          <button type="submit" class="primary">
            Create
          </button>
        </div>
      </form>
    </section>
  );
}
