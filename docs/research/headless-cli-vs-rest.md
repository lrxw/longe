# Headless CLI vs REST in longe

Checked **2026-10-01**. Topic: `headless-cli-vs-rest`.

**The chat currently runs local agent processes. The board already has REST. We can add an
HTTP agent provider, but it is a new backend integration, not a configuration toggle.**

## What runs today

| Connection | Current implementation | Code |
| --- | --- | --- |
| Chat → Claude Code | Starts `claude -p --input-format stream-json --output-format stream-json`; sends and reads structured messages through stdin/stdout | [Claude provider](../../src/app/providers/claude.ts) |
| Chat → Codex | Starts `codex app-server`; exchanges JSON-RPC messages over stdin/stdout, including `thread/start`, `thread/resume` and `turn/start` | [Codex provider](../../src/app/providers/codex.ts), [transport](../../src/app/codex.ts) |
| Managed agent → longe board | Runner supplies the project's HTTP MCP endpoint | Both provider adapters above |
| External clients → longe board | REST at `/r/<name>/api/v1/<tool>`; MCP over HTTP or `longe mcp` stdio | [REST adapter](../../src/http/api.ts), [stdio entry](../../src/mcp/stdio.ts) |

Headless means the agent runs without its interactive terminal UI. These integrations read
structured events, not screen-scraped terminal output. The local agents make their own model
requests; longe does not directly call a model API for the chat today.

If the question is about scripting the **board**, no migration is needed. For example:

```sh
curl -s 'http://127.0.0.1:7311/r/longe/api/v1/list_topics?status=active'
```

Use the registered project name in place of `longe` for another project. API documentation
is available at `http://127.0.0.1:7311/api/docs` while the hub is running.

## What “switch to REST” could mean

| Approach | What it changes | Assessment for longe |
| --- | --- | --- |
| Keep the local agents | Current agent runtimes keep executing tools in the local checkout | Smallest change; fits the current local project workflow |
| Use a local SDK or another transport | Change how longe controls a provider runtime | May simplify an adapter, but does not necessarily remove the local agent process |
| Use a managed agent HTTP API | Provider runs the agent loop; longe manages API sessions, streamed events and environment integration | A real candidate if removing the CLI dependency is the goal |
| Call a model HTTP API directly | Longe chooses or builds more of the agent runtime around model responses | More control, but substantially more work to retain today's local coding behavior |

The Claude Agent SDK runs the Claude Code binary and supplies its tools, permissions and
sessions. Its client SDK instead calls the model API; its Managed Agents service offers a
hosted agent runtime. These are distinct products, not equivalent ways to spell the same
request. [Claude Agent SDK comparison](https://code.claude.com/docs/en/agent-sdk/overview).

Codex App Server documents JSON-RPC over stdio, WebSocket and Unix socket transports. The
WebSocket transport is marked experimental and unsupported. Moving to it would retain the
agent runtime and JSON-RPC protocol; HTTP health checks do not make its task interface REST.
[Codex App Server protocol](https://learn.chatgpt.com/docs/app-server#protocol).

There are also managed HTTP agent services:

- **OpenAI Agents API:** exposes a managed Codex harness with persistent sessions and tool/MCP
  integration. Model use is billed at API rates; hosted tools and containers have their own
  applicable charges. [Overview](https://developers.openai.com/api/docs/guides/agents-api/overview).
  The documented setup uses an application API key and a beta header.
  [Quickstart](https://developers.openai.com/api/docs/guides/agents-api/quickstart).
- **Claude Managed Agents:** provides sessions, streamed events and built-in tools, with
  cloud or self-hosted sandbox environments. It is a beta API requiring API credentials.
  [Overview](https://platform.claude.com/docs/en/managed-agents/overview).

For a direct model integration, OpenAI distinguishes Responses API and application-run Agents
SDK from the managed Agents API. Anthropic similarly distinguishes Messages API tool loops
from its managed service. A model endpoint alone does not execute commands in this local repo.
[OpenAI runtime comparison](https://developers.openai.com/api/docs/guides/agents),
[Anthropic migration comparison](https://platform.claude.com/docs/en/managed-agents/migration).

## Claude subscription versus API billing

The user's follow-up requested a separate provider ticket. It is queued as
`add-an-optional-managed-api-chat-provider`; existing local providers remain available.

- **Claude Code with a Pro/Max login:** uses the plan's included usage limits. An
  `ANTHROPIC_API_KEY` environment variable instead selects API authentication and charges.
  [Claude Code plan usage](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan).
- **Headless `claude -p` / Agent SDK:** the current Help Center notice says the announced
  June billing change was paused, and this usage still draws from subscription limits when
  using subscription authentication. Do not mistake the superseded credit proposal further
  down that page for the current rule.
  [Agent SDK plan notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).
- **Claude API:** separately billed from the subscription, with model input/output token
  pricing and applicable tool charges.
  [Separate API access](https://support.claude.com/en/articles/9876003-i-have-a-paid-claude-subscription-pro-max-team-or-enterprise-plans-why-do-i-have-to-pay-separately-to-use-the-claude-api-and-console),
  [API pricing](https://platform.claude.com/docs/en/about-claude/pricing).
- **Claude Managed Agents:** adds session runtime charges to tokens; the documented rate
  checked October 1 is $0.08 per session-hour in the `running` state. Idle time is excluded.
  [Managed Agents pricing](https://platform.claude.com/docs/en/about-claude/pricing#claude-managed-agents-pricing).

The distinction is authentication and product usage, not a blanket ban on alternative agent
runtimes. Anthropic's published guidance distinguishes an end user signing in to an unmodified
Claude Code binary from third-party apps collecting or routing users' subscription credentials;
developers building integrations are directed to API authentication. This is a summary of the
documented distinction, not a determination of every possible longe deployment's terms.
[Authentication and credential use](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).

## Concrete migration scope

This is a proposed implementation outline, not work already performed:

1. **Choose the execution location.** Keep tools in a locally connected environment, use a
   self-hosted sandbox, or provision a cloud checkout. Hosted execution does not automatically
   see uncommitted files on this Mac. Define how patches and test results return to the user.
2. **Add a runtime-neutral provider boundary.** Today's `ChatProvider.args/attach` and
   `ProviderProcess.ingest` assume a child process and stdout. Introduce a lifecycle for
   starting/resuming, sending, streaming, stopping and closing that an HTTP adapter can
   implement. Keep current providers working. See [provider types](../../src/app/providers/types.ts).
3. **Connect the board and approvals.** Preserve `ask_question`, answer acknowledgment and
   tool permissions. A remote service cannot reach this Mac's `127.0.0.1` endpoint directly;
   choose a supported connection or a local tool bridge. Do not publish the local board as
   an incidental migration step.
4. **Handle API sessions and failure.** Map streamed output, tool events, interruption,
   reconnects and usage into the chat. Start an API session with an explicit handoff; existing
   CLI session ids are not assumed to be portable. Resolve uncertain tool outcomes before retry.
5. **Make it an optional provider.** Store credentials outside shared config. Verify account
   access, costs and required features before enabling it. A user can retain local agents for
   one project and choose the API backend for another. This does not require reviewer agents.

A proof of concept should complete a small edit and test, ask through the inbox, resume after
an answer, and recover from disconnection without duplicate edits. It must also show where
files execute and where the resulting patch is stored. Merely streaming text is insufficient.

## Recommendation

Keep the current local providers available. If the goal is to eliminate the CLI dependency,
evaluate **one optional managed HTTP provider first**. This uses an existing agent runtime
and avoids making longe responsible for recreating a coding agent from model calls.

Before implementing that adapter, choose the provider and whether work must remain in the
local checkout. Those choices determine the integration, authentication and billing work.
If the goal is only to automate board operations, use the existing REST API instead.

This assessment used repository inspection and official documentation. No live provider API
calls, account eligibility checks, benchmark or migration were performed. Existing local
agents and the running server were left unchanged.
