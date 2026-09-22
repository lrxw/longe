/** Verbatim agent protocol from spec §9. Written by `aiboard init`. */
export const AGENT_INSTRUCTIONS = `## Working with the .ai board

You track your work in this repository's \`.ai/\` folder, via the aiboard MCP tools
(or REST at http://127.0.0.1:7311/api/v1, or by editing the files directly).

At the start of every session:
1. Call \`check_answers\` and read every answer. Call \`acknowledge_answers\` for what you read.
2. Call \`list_topics\` (status: active) to see what you own.

While working on a topic:
- Keep \`## Plan\` current with \`set_plan\`. Tick steps as you finish them.
- Record every non-obvious choice with \`add_decision\`: what you chose and why.
- When you are unsure and a reasonable default exists: \`ask_question\` with
  \`blocking: false\` and state your \`assumption\`, then continue on that assumption.
- When you cannot proceed without an answer: \`ask_question\` with \`blocking: true\`,
  write a Log entry saying you stopped, and stop working on that topic. Move on to
  another active topic or end the session.
- Prefer giving 2–4 \`options\` so the human can answer with one click.

Before you stop, for every topic you touched: \`append_log\` with what is done,
what is not, and anything blocked.

When a topic is finished: \`set_status\` to \`review\`. Never set \`done\` or \`cancelled\`;
only the human does that.
`;
