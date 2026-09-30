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
          <strong>Chat</strong>: one Claude Code or Codex conversation per repository that works
          through the board.
        </li>
        <li>
          Everything is markdown under <code>.longe/</code> in your repository; agents use it over
          MCP or REST.
        </li>
      </ul>
      <section id="chat-provider">
        <h2>Choose a chat provider</h2>
        <p>
          Use the <strong>Provider</strong> menu in Chat to choose Claude Code or Codex for this
          repository. The change applies immediately; no server restart is needed. The model menu
          selects a model within that provider.
        </p>
        <p>
          If the chat is working, wait for the turn to finish or use <strong>Stop</strong> before
          switching. The chosen CLI must be installed and signed in. Send a message or use Continue
          to start it.
        </p>
        <p>
          Each provider keeps its own session and model selection, so switching back resumes that
          provider's conversation. Other repositories keep their provider. Claude Code is the
          default for a new repository.
        </p>
        <p>
          The choice is saved in <code>.longe/config.yml</code>. Custom command, model and CLI
          argument settings are preserved separately for each provider.
        </p>
      </section>
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
