# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

kddkit — a kanban + memory substrate for humans and Claude. Two deliberately separated kinds of state:

- **Tasks** — mutable, in SQLite *outside* the repo (`~/.kdd/<git-hash>/kdd.db`), keyed by git repository so the board is identical from any worktree.
- **Knowledge** — decisions/conventions as durable markdown *in* the repo under `.planning/decisions/`, indexed into FTS5 on demand for `recall`.

It is a state layer, not a workflow engine. Distributed as a Claude Code plugin (MCP over stdio) plus a `kdd` CLI and a local web board.

## Commands

pnpm workspace + turbo. Node ≥22.

```bash
pnpm build                     # turbo run build (all packages)
pnpm test                      # turbo run test (build first, then vitest)
cd packages/core && pnpm test  # test one package
cd packages/core && pnpm vitest run test/ops.test.ts   # single test file
```

Dev (isolated store so you never touch your real board):

```bash
pnpm dev:cli   # KDD_HOME=~/.kdd-dev  kdd via built dist
pnpm dev:ui    # same store, UI on :4488
```

Release: `pnpm release` (bumpp + build + test + publish).

## Architecture

Single core library, three stateless clients, one SQLite ground truth.

```
CLI  ·  Web UI (React)  ·  MCP (Claude)     ← clients, no business logic
              │
      packages/core/src/                    ← ALL logic lives here
   (ops · queries · state · db · recall)
              │
   SQLite + FTS5  +  .planning/decisions/*.md
```

- **`packages/core`** — the only place business logic belongs. `ops.ts` (mutations), `queries.ts` (reads), `state.ts` (status transition matrix + `checkMove` gating), `db.ts` (schema + `MIGRATIONS` array), `recall.ts` (FTS5). Clients are thin adapters — never duplicate core logic in a client.
- **`packages/cli`** — commander CLI (`index.ts`) + text `render.ts` + `context.ts` (db/actor resolution).
- **`packages/ui`** — `server.ts` is a Hono HTTP server that hosts both the REST API and the React SPA (`src/web/`), multiplexing projects via `?project=<hash>`. The CLI's `kdd ui` spawns this server.
- **`packages/mcp`** — `server.ts` tool defs (zod-validated) + `handlers.ts` adapting core to the 5 tools (get_task, list_tasks, list_tracks, recall, update_task).

Adding a task-related feature usually touches core (`ops.ts`/`queries.ts`) **plus** each client that should expose it (CLI command+render, UI endpoint+component+api.ts, MCP tool+handler).

## Non-obvious rules

- **Every mutation wraps in `db.transaction(() => {...})()`** — even single statements. Mutations append to the `events` log; a partial write breaks the audit trail. Validate first (guard clauses / `KddError`), transaction after.
- **Actor is threaded, never global.** State-changing ops take `actor: Actor` (`{type:'user'}` | `{type:'ai', id}`) as a required param. Resolved per-call from CLI context or request metadata. Reusing a module-level actor causes attribution bugs.
- **AI is gated by acceptance criteria.** `checkMove` blocks an `ai` actor from moving a task to `review` while criteria are unchecked; a `user` actor is not gated. This gate is a core rule, not UI logic.
- **Decisions index on demand.** Editing `.planning/decisions/*.md` does not update search until the next `recall` (which calls `syncIndex`) or `kdd rebuild`. FTS5 is watermark-incremental for tasks, full-rescan for decisions.
- **Schema changes = append a migration** to `MIGRATIONS` in `packages/core/src/db.ts`. Don't edit existing migrations.

## Conventions

- ESM only, strict TS, NodeNext — `.js` extensions required in relative imports (`'./db.js'`), `import type` for type-only imports. No formatter/eslint configured; TS strict mode is the lint.
- Core public API is exposed through `packages/core/src/index.ts` barrel only — consumers import `@kddkit/core`, never nested paths.
- `db: Database.Database` is always the first parameter; ops return the full modified entity, not just an id.
- Multi-case returns use discriminated unions (`{ok:true} | {ok:false; error}`), e.g. `checkMove`.
- No mocks in tests — vitest with real `openDb(':memory:')`, real CLI via `execFileSync`, real temp dirs via `mkdtempSync`. Tests co-located in `packages/*/test/*.test.ts`. CLI test helpers in `packages/cli/test/run.ts`.
- Comments are mixed Russian (domain/business rules) and English (mechanics); comment *why*, not *what*.
- Сообщения коммитов конвенциональные (`feat(scope): …`, `fix(core): …`) — из них генерируется тело GitHub Release. Неконвенциональный коммит не ломает сборку, он **молча выпадает** из changelog.
- Не ссылаться на id задач доски kdd из сообщений коммитов: GitHub превратит `#N` в ссылку на свой issue с тем же номером. Правило касается и агентских коммитов — воркер коммитит в свою ветку сам.
- Релиз в два шага: `pnpm release` бампает и печатает будущие заметки, `pnpm release:publish` публикует и пушит тег. Если заметки после первого шага не устроили, откат — `git tag -d vX.Y.Z && git reset --hard HEAD~1`.

## Env vars

`KDD_HOME` (data root, default `~/.kdd`), `KDD_DB`, `KDD_DECISIONS_DIR` (path overrides), `KDD_ACTOR`/`KDD_SESSION` (actor identity). Store path resolves via `git rev-parse` — commands must run inside a git repo.
