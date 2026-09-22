# longe

> Working name was `aiboard`; the repository folder may still carry that name until you `mv` it.

Local-first, single-user board for tracking work done by AI coding agents in one repository.
The repository's `.ai/` folder is the source of truth; longe is a viewer plus a validated
write layer reachable through MCP, REST, or direct file edits.

Full specification: [SPEC.md](./SPEC.md).

## Status

Phases 0–3 complete (scaffold, store, domain, index, HTML UI). `mcp` and REST land in Phase 4.

## Development

```sh
pnpm install
pnpm test          # vitest
pnpm typecheck
pnpm lint
pnpm dev init --repo /path/to/project
```

## Using in another project

```sh
pnpm build
pnpm link --global          # exposes `longe` on PATH
cd /path/to/project
longe init                # creates .ai/
```
