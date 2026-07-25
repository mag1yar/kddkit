# Contributing to kddkit

kddkit is both a tool you use daily (the published plugin + your real board) and
the codebase you hack on. This doc keeps those two apart so dev experiments never
corrupt real data.

There is no `dev`/`staging`/`prod` environment switch — like hermes and claw-code,
isolation is a **throwaway store via an env override**, not an environment flag.

## Dev loop

```bash
pnpm install
pnpm build          # turbo, builds every package (committed dist for core/cli/mcp)
pnpm test           # vitest across core / cli / mcp / ui
```

The plugin ships committed `dist/` for `core`, `cli` and `mcp` so it runs with no
build step on install. **Rebuild before committing** if you touch their source.

## Data isolation — never test on your real board

The store lives at `~/.kdd/<repo-hash>/kdd.db`, resolved per project directory.
Two env overrides redirect it (see `packages/core/src/paths.ts`):

- `KDD_HOME` — the store root (default `~/.kdd`).
- `KDD_DB` — a single explicit db file (bypasses the git-hash resolution).

Convenience scripts run the local build against a separate dev store `~/.kdd-dev`:

```bash
pnpm dev:cli -- status          # KDD_HOME=~/.kdd-dev, real board untouched
pnpm dev:cli -- add "try this"
pnpm dev:ui                     # web board on :4488 against the dev store
```

Want real-shaped data for a smoke test? Copy your board once:

```bash
mkdir -p ~/.kdd-dev && cp -r ~/.kdd/<hash> ~/.kdd-dev/
```

## Migrations — the one thing that can corrupt the real board

`MIGRATIONS[]` in `packages/core/src/db.ts` auto-applies on `openDb` (tracked by
`PRAGMA user_version`) — **in dev and in prod, same path**, the moment the store
opens. A half-finished migration in the array runs against your real board on the
next `kdd status`.

Rules:

1. Develop and run a new migration against the dev store first (`pnpm dev:cli`).
2. Add a migration test (see the migration-5 test in `packages/core/test/` —
   insert legacy rows, assert they survive). Only land a migration once its test
   is green.
3. Before the first run against a real board, back it up:
   `cp ~/.kdd/<hash>/kdd.db ~/.kdd/<hash>/kdd.db.bak`.

We have numbered `user_version` migrations + tests — stronger than the
additive-only, unversioned approach in the reference tools. Keep it that way.

## Testing this machine as a live dev plugin

On your dev box, install the plugin from the **local repo** instead of the
published marketplace, so skill/MCP edits are live without a release (this is the
canonical Claude Code plugin dev loop — `marketplace.json` already has
`source: "./"`):

```
/plugin marketplace add /absolute/path/to/kddkit    # local marketplace
# install kddkit from it; remove the github install so the MCP server 'kdd' isn't duplicated
```

Then: edit → `pnpm build` (skip for skill `.md` changes) → `/reload-plugins` → live.

Other machines keep the **published** plugin (release below) for real work.

## Release (promote to prod)

Release in two steps: preview first, then publish.

```bash
npm login                       # publish needs auth + OTP
pnpm release                    # bumpp: pick version, build+test, bump all
                                # package.json + plugin.json, commit + tag, preview notes
```

Read the printed release notes. If they look wrong, rollback with
`git tag -d vX.Y.Z && git reset --hard HEAD~1`, fix the commit messages
(see conventions in `CLAUDE.md`), and try again.

Once the notes are approved:

```bash
pnpm release:publish            # publish to npm, push commit + tag
```

This publishes `@kddkit/core|cli|ui` to npm (`@kddkit/mcp` is `private` — it ships
via the git plugin, not npm). The tag push triggers `.github/workflows/release.yml`,
which creates the GitHub Release. After the release completes, update consumers:
`/plugin` update + `/reload-plugins` on each machine (the skill + MCP are
git-distributed, npm does not update them).
