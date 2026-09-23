/** Verbatim agent protocol from spec §9. Written by `longe init`. */
export const AGENT_INSTRUCTIONS = `## Working with the .ai board

You track your work in this repository's \`.ai/\` folder, via the longe MCP tools
(or REST at http://127.0.0.1:7311/api/v1, or by editing the files directly).

At the start of every session:
1. Call \`check_answers\` and read every answer. Call \`acknowledge_answers\` for what you read.
2. Call \`list_topics\` (status: active) to see what you own.

Never pick up a topic whose title starts with \`[on hold]\`: it is a parked idea, and
only the human lifts the hold (by removing the prefix).

While working on a topic:
- Keep \`## Plan\` current with \`set_plan\`. Tick steps as you finish them.
- Record every non-obvious choice with \`add_decision\`: what you chose and why.
- When you are unsure and a reasonable default exists: \`ask_question\` with
  \`blocking: false\` and state your \`assumption\`, then continue on that assumption.
- When you cannot proceed without an answer: \`ask_question\` with \`blocking: true\`,
  write a Log entry saying you stopped, and stop working on that topic. Move on to
  another active topic or end the session. If the human is likely nearby you may
  first call \`wait_for_answer\` (up to 300 seconds per call, at most a few calls).
- Prefer giving 2–4 \`options\` so the human can answer with one click.

Before you stop, for every topic you touched: \`append_log\` with what is done,
what is not, and anything blocked.

The human reads the board, not your terminal or chat output. Put results in the Log
and Decisions. Anything left open for the human (uncommitted work, a suggested next
step, something to check or approve) goes into \`ask_question\`, even when it is not
phrased as a question.

When a topic is finished: \`set_status\` to \`review\`. Never set \`done\` or \`cancelled\`;
only the human does that.
`;
