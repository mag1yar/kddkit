# Releasing

Versions move in lockstep: all `packages/*` + `.claude-plugin/plugin.json` share one version.

Release is two steps. The first lets you preview and abort; the second publishes for real.

**Step 1: preview**

```sh
pnpm release
```

1. **bumpp** prompts for the new version and writes it to the root `package.json`,
   every `packages/*/package.json` and `.claude-plugin/plugin.json`
2. runs `turbo run build test` (rebuilt `dist/` is tracked and lands in the commit)
3. commits everything (`--all`) and tags `vX.Y.Z` — no push
4. generates release notes via `npx changelogithub@14 --dry` and prints them

At this point, **nothing has been published or pushed**. Read the generated notes. A non-conventional commit message silently vanishes from the changelog (see conventions in `CLAUDE.md`). If the notes are wrong or incomplete, rollback:

```sh
git tag -d vX.Y.Z && git reset --hard HEAD~1
```

then fix the commit messages and try again.

**Step 2: publish** (after notes pass review)

```sh
pnpm release:publish
```

1. `pnpm -r publish` publishes the non-private packages to npm
   (`@kddkit/core`, `@kddkit/cli`, `@kddkit/ui`; `@kddkit/mcp` is private, ships inside the plugin)
2. pushes the commit and tag to origin. The tag push triggers `.github/workflows/release.yml`,
   which creates a GitHub Release with the same notes

Requirements: clean working tree, `npm whoami` succeeds (`npm login` otherwise).
If publish fails after the tag exists (OTP, network), just rerun `pnpm release:publish` —
pnpm skips versions already in the registry, and the push/tag step is idempotent.

**After publishing:** check that the workflow run succeeded and the GitHub Release
appeared (Actions tab / Releases page). If the run failed, re-run the job from the
Actions UI — no need to re-tag, `changelogithub` updates the existing Release rather
than creating a duplicate.
