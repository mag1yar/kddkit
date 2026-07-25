---
created: 2026-07-18
status: superseded
superseded_by: 2026-07-25-release-process-two-step-preview-then-publish
---
# Release process: bumpp lockstep + pnpm -r publish

## Decision
One command: pnpm release. bumpp bumps root, packages/*, and .claude-plugin/plugin.json to the same version, runs build+test, commits all (tracked dists included), tags vX.Y.Z without pushing; then pnpm -r publish publishes public packages. Push manually with git push --follow-tags. Documented in RELEASING.md.

## Rationale
Solo project with lockstep versions and a plugin.json outside npm packages. Changesets is team/changelog ceremony and would still need a script for plugin.json; bumpp updates arbitrary JSON files natively (same pattern as vitest/unocss).

## Alternatives
-

## Supersedes
-

## Outcome
-
