# Releasing

Versions move in lockstep: all `packages/*` + `.claude-plugin/plugin.json` share one version.
The Codex plugin manifest shares that version too.

## Preview channel

Prepare previews on the local `next` branch. Keep `master` on stable contents:
Git marketplace clients can follow either branch without running `kdd update`.

```sh
pnpm release:next
```

This runs bumpp, build, tests, typecheck, and Codex sync checks, then creates a
local `vX.Y.Z-next.N` tag and prints draft notes. Review the commit, tag, and notes
before publishing. The script never publishes or pushes.

```sh
node scripts/test-next-release.mjs
pnpm -r publish --dry-run --tag next --no-git-checks
pnpm release:next:publish
```

The publish command requires a clean tagged `next` commit, publishes public
packages with `--tag next`, and checks each package's `next` and unchanged
`latest` dist-tags. It also checks tags after a retry where npm skips an already
published version. It does not push.

After the npm checks pass, push **only the reviewed tag**, then verify the GitHub
Release exists, is published, and says `prerelease: true`. Only then fast-forward
the remote `next` branch to that same commit. A failed earlier step leaves the
old remote preview ref in place.

Promote to stable separately: merge the accepted preview changes into `master`,
bump all manifests to `X.Y.Z`, use the stable release commands below, and verify
npm `latest`, the published stable GitHub Release, and `master` agree.

## Stable channel

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
