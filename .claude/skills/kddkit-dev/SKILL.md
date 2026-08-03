---
name: kddkit-dev
description: Use when developing the kddkit codebase itself (this repo — packages/core|cli|mcp|ui, the kdd plugin/skill/MCP), not when merely using a KDD board. Covers the dev store, migration safety, the live dev-plugin loop, tests and release. NOT for driving a board — that is the kdd skill.
---

# Developing kddkit

You are working on the tool, not just using it. The full workflow lives in
[CONTRIBUTING.md](../../../CONTRIBUTING.md); load it for detail. The rules below
are the ones that prevent damage — follow them without being asked.

## Never test on the real board

The store is `~/.kdd/<repo-hash>/kdd.db`. Experiments use a throwaway store via
`KDD_HOME` — the repo ships scripts for it:

```
pnpm dev:cli -- <args>    # KDD_HOME=~/.kdd-dev, real board untouched
pnpm dev:ui               # web board on :4488 against the dev store
```

Any smoke test, migration trial, or scratch task goes to the dev store. Do not
point the local build at `~/.kdd` while iterating.

## Migrations are the one path that can corrupt real data

`MIGRATIONS[]` in `packages/core/src/db.ts` auto-applies on `openDb` (tracked by
`PRAGMA user_version`) — the instant the store opens, in dev and prod alike. So:

- Run a new migration against the dev store first (`pnpm dev:cli`).
- Add a migration test (pattern: `packages/core/test/` migration-5 test — insert
  legacy rows, assert they survive) and get it green **before** the migration
  lands in the array.
- A migration appended to the array runs on the next `kdd status` against a real
  board. Do not commit an untested one.

## Committed dist — rebuild before commit

`dist/` for `core`, `cli`, `mcp` is committed (the git plugin runs without a build
step). If you change their source, `pnpm build` before committing or the shipped
plugin drifts from source. `ui/dist` is not tracked.

## Verify before claiming done

`pnpm test` (or `pnpm turbo build test`) across all packages — this is the safety
net. For UI changes, smoke on `pnpm dev:ui`. Evidence before "it works".

## Writing to a board during dev

If you record dev progress on an actual board, that is the **kdd** skill's job and
its attribution rules apply (MCP `update_task`; the CLI already detects you).
This skill is about changing the codebase.
