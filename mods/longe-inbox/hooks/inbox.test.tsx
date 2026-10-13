import type { On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";

const HOME = "/home/me";
const BOARD = `${HOME}/.longe/projects/demo-abcd/questions`;

const files: Record<string, string> = {
  [`${HOME}/.config/longe/repos.yml`]: [
    "# Repositories known to longe.",
    "repos:",
    "  - path: /work/demo",
    "    name: demo",
    "    last_seen: 2026-10-12T10:00:00+02:00",
  ].join("\n"),
  "/work/demo/.longe/config.yml": 'version: 1\nid: demo-abcd\nproject: "Demo app"\n',
  [`${BOARD}/q-20261012-aaaa.md`]: [
    "---",
    "id: q-20261012-aaaa",
    "topic: settings-screen",
    "asked_by: claude",
    "asked_at: 2026-10-12T10:00:00+02:00",
    "status: open",
    "blocking: true",
    "options:",
    "  - This project",
    '  - "All projects: global"',
    "---",
    "## Question",
    "Should settings apply to **this project** or all projects?",
    "",
    "## Context",
    "Decides where the file lives.",
    "",
    "## Answer",
    "",
  ].join("\n"),
  [`${BOARD}/q-20261012-bbbb.md`]: [
    "---",
    "id: q-20261012-bbbb",
    "asked_by: codex",
    "asked_at: 2026-10-12T09:00:00+02:00",
    "status: answered",
    "blocking: false",
    "assumption: keep it",
    "---",
    "## Question",
    "Old one",
    "## Answer",
    "done",
  ].join("\n"),
  [`${BOARD}/q-20261012-cccc.md`]: [
    "---",
    "id: q-20261012-cccc",
    "asked_by: codex",
    "asked_at: 2026-10-12T11:00:00+02:00",
    "status: open",
    "blocking: false",
    "assumption: Keep the old CLI name",
    "---",
    "## Question",
    "Rename the `longe` CLI?",
    "## Context",
    "## Answer",
  ].join("\n"),
};

function fakeDisk(on: On, posts: string[], isDown = false) {
  mock.env(on, { HOME });
  on("fs.read", ($, e) => {
    const text = files[e.path];
    if (text === undefined) throw new Error(`ENOENT ${e.path}`);
    return { value: text };
  });
  on("fs.list", ($, e) => {
    if (e.path !== BOARD) throw new Error(`ENOENT ${e.path}`);
    return {
      value: Object.keys(files)
        .filter((f) => f.startsWith(`${BOARD}/`))
        .map((f) => ({
          name: f.slice(BOARD.length + 1),
          kind: "file" as const,
          size: 1,
          mtimeMs: 1,
          isLink: false,
        })),
    };
  });
  on("http.fetch", ($, e) => {
    if (isDown) throw new Error("ECONNREFUSED");
    posts.push(e.init?.body ?? "");
    return {
      value: {
        status: 200,
        ok: true,
        headers: {},
        text: '{"id":"q-20261012-aaaa","status":"answered"}',
      },
    };
  });
  mock.clock(on);
  on("ui.toast", () => ({ value: undefined }) as never);
  on("ui.render", () => null as never);
  on("command.register", () => ({ value: undefined }) as never);
  on("session.start", ($, e) => ({ cwd: e.cwd }));
}

test("band and pane show the open question; an option answers it over REST", async ($, on) => {
  const posts: string[] = [];
  fakeDisk(on, posts);
  await $.session.start({ cwd: "/work/demo", surface: "terminal", isInteractive: true });

  for (const surface of ["terminal", "desktop"] as const) {
    const band = await $.ui.mount({
      plugin: "longe-inbox",
      surface,
      component: "AbovePrompt",
      props: { hasSurvey: false } as never,
    });
    expect(await band.find({ type: "Text", text: /1 blocking/ })).toBeDefined();
    await band.unmount();

    const pane = await $.ui.mount({
      plugin: "longe-inbox",
      surface,
      component: "Pane",
      requestId: "longe-inbox",
      props: { title: "longe inbox", isFocused: true, bodyColumns: 80, placement: "dock" } as never,
    });
    expect(await pane.find({ type: "Text", text: /Demo app/ })).toBeDefined();
    expect(await pane.find({ type: "Text", text: /Old one/ })).toBeUndefined();
    await pane.press({ key: "opt-q-20261012-aaaa-1" });
    await pane.press({ key: "sel-q-20261012-cccc" });
    expect(await pane.find({ type: "Text", text: /Keep the old CLI name/ })).toBeDefined();
    await pane.press({ key: "sel-q-20261012-aaaa" });
    await pane.unmount();
  }

  expect(posts.length).toBe(2);
  expect(JSON.parse(posts[0]!)).toEqual({ repo: "demo", id: "q-20261012-aaaa", option_index: 1 });
});

test("a written reply is sent as a custom answer", async ($, on) => {
  const posts: string[] = [];
  fakeDisk(on, posts);
  await $.session.start({ cwd: "/work/demo", surface: "terminal", isInteractive: true });
  const pane = await $.ui.mount({
    plugin: "longe-inbox",
    surface: "terminal",
    component: "Pane",
    requestId: "longe-inbox",
    props: { title: "longe inbox", isFocused: true, bodyColumns: 80, placement: "dock" } as never,
  });
  await pane.input({ key: "reply-q-20261012-aaaa", text: "Only this repo, please" });
  expect(JSON.parse(posts[0]!)).toEqual({
    repo: "demo",
    id: "q-20261012-aaaa",
    answer: "Only this repo, please",
  });
  await pane.unmount();
});

test("says how to start longe when the server is down", async ($, on) => {
  fakeDisk(on, [], true);
  await $.session.start({ cwd: "/work/demo", surface: "terminal", isInteractive: true });
  const pane = await $.ui.mount({
    plugin: "longe-inbox",
    surface: "terminal",
    component: "Pane",
    requestId: "longe-inbox",
    props: { title: "longe inbox", isFocused: true, bodyColumns: 80, placement: "dock" } as never,
  });
  await pane.press({ key: "opt-q-20261012-aaaa-0" });
  expect(await pane.find({ type: "Text", text: /longe serve -d/ })).toBeDefined();
  await pane.unmount();
});
