# aiboard

Local-first, single-user board for tracking work done by AI coding agents in one repository.
The repository's `.ai/` folder is the source of truth; aiboard is a viewer plus a validated
write layer reachable through MCP, REST, or direct file edits.

Full specification: [SPEC.md](./SPEC.md).

## Status

Phases 0–1 complete (scaffold, store, domain). `serve` and `mcp` are stubs.

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
pnpm link --global          # exposes `aiboard` on PATH
cd /path/to/project
aiboard init                # creates .ai/
```
