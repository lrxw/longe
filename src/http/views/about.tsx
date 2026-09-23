/** The about page: the big logo, what longe is, where to read more. */
export function AboutPage({
  version,
  description,
  homepage,
}: {
  version: string;
  description: string;
  homepage?: string | undefined;
}) {
  return (
    <section class="about">
      <img class="about-logo" src="/public/logo/wordmark.svg" alt="longe" />
      <p class="about-version">
        version <code>{version}</code>
      </p>
      <p class="about-lead">{description}</p>
      <ul class="about-points">
        <li>
          <strong>Board</strong>: topics with a goal, a plan, decisions and a log, moved from
          backlog through todo and active to review and done.
        </li>
        <li>
          <strong>Inbox</strong>: the questions agents ask you, answered with one click.
        </li>
        <li>
          <strong>Chat</strong>: one Claude Code conversation per repository that works through the
          board.
        </li>
        <li>
          Everything is markdown under <code>.longe/</code> in your repository; agents use it over
          MCP or REST.
        </li>
      </ul>
      <p class="about-links">
        <a href="/api/docs">REST API</a> · <a href="/openapi.json">openapi.json</a>
        {homepage ? (
          <>
            {" · "}
            <a href={homepage}>README</a>
          </>
        ) : null}
      </p>
    </section>
  );
}
