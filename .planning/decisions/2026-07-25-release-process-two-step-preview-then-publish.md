---
created: 2026-07-25
status: active
superseded_by:
---
# Release process: two-step preview then publish

## Decision
Release is two commands. `pnpm release` bumps root + packages/* + .claude-plugin/plugin.json in lockstep (bumpp), runs build+test, commits everything, tags `vX.Y.Z` locally, then runs `npx changelogithub@14 --dry` to print the release notes it *would* publish — and stops. Nothing is pushed or published yet. `pnpm release:publish` runs `pnpm -r publish` (skips versions already in the registry) and `git push --follow-tags`; the tag push triggers `.github/workflows/release.yml`, which runs changelogithub for real and creates the GitHub Release. Documented in RELEASING.md.

## Rationale
Split from the original one-command flow because the changelog preview is the only point where a silently-dropped non-conventional commit is still fixable — `v0.4.0` reached npm but never got a GitHub Release because the manual `git push --follow-tags` step was forgotten once, after publish had already happened. Everything else about the original decision holds: solo project with lockstep versions, plugin.json outside npm packages, bumpp chosen over changesets because it updates arbitrary JSON natively.

## Alternatives
-

## Supersedes
2026-07-18-release-process-bumpp-lockstep-pnpm-r-publish

## Outcome
-
