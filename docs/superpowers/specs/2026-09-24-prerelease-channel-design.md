# Stable and next release channels

**Date:** 2026-09-24
**Task:** #71
**Status:** design approved; written specification awaiting owner review

## Goal

Ship previews without changing the version offered to ordinary users. `kdd update`
selects the stable release and updates every eligible installed component, even
when that means replacing a newer-numbered preview. `kdd update --next` explicitly
selects the preview channel for the CLI and installed Claude Code and Codex plugins.
Absent, managed, local-source, and other-project installations retain the safety
rules agreed for #23. The background CLI notice remains stable-only.

Running `--next` subscribes eligible Git marketplaces to a moving `next` ref.
Clients may automatically receive later previews from that ref. A later plain
`kdd update` is the explicit return to stable. The CLI itself does not auto-install
anything; subsequent preview CLI updates still require `--next`.

## Existing constraints and decisions

- The [two-step release decision](../../../.planning/decisions/2026-07-25-release-process-two-step-preview-then-publish.md)
  remains: preview version and notes locally, then publish only after review.
  Versions of npm packages and both plugin manifests move in lockstep.
- [#23's self-update specification](2026-09-23-self-update-design.md) uses a
  published GitHub Release as its version signal and verifies actual installed
  versions. Keep those safeguards, the CLI's npm ownership checks, scope rules,
  client approval behavior, and component-level failure reporting.
- npm `latest` and `next` are separate mutable dist-tags. Git marketplaces do
  not follow npm tags; their refs must be selected separately.
- Current `compareVersions` compares prerelease suffixes lexically and sorts
  `next.10` below `next.9`. Fix that before using it for channel selection.
- Codex refuses to add a marketplace with an existing name from a different
  source/ref. Its CLI JSON lists the source URL but omits the configured ref
  and sparse paths, so that JSON alone is insufficient for a reversible switch.

## Channel contract

| Channel | Git plugin ref | npm dist-tag | Version | GitHub Release | Selected by |
| --- | --- | --- | --- | --- | --- |
| stable | `master` | `latest` | `X.Y.Z` | published, `prerelease: false` | `kdd update`, default notice |
| preview | `next` | `next` | `X.Y.Z-next.N` | published, `prerelease: true` | `kdd update --next` only |

`master` remains on stable plugin contents until stable promotion. Preview
development and version bumps happen on `next`; a preview ref points at a
published preview commit, never an unreviewed working tip. Stable promotion
merges or otherwise incorporates the accepted preview work into `master`, bumps
the lockstep manifests to `X.Y.Z`, and uses the existing stable publish path.
This is a release-process rule: pushing a preview manifest to `master` would
expose it to existing unpinned Git marketplace installations outside `kdd update`.

`next` need not exist until the first preview is prepared. Documentation for
existing installations keeps `master` as stable; new installation instructions
may pin `master` explicitly. No new plugin ID or second marketplace name is
introduced.

## Publishing

1. Keep the stable `pnpm release` and `pnpm release:publish` behavior. Add a
   preview pair using the same bumpp file list and build/test/typecheck gates.
   The preview command runs on `next`, requires a `-next.N` version, creates a
   local tag and changelog preview, and stops before publication or push.
   Refuse a mismatched branch/version rather than silently publishing to the
   wrong channel.
2. The preview publish command publishes every public workspace package with
   `--tag next`. It must not run a default-tag publish for any package. Check
   `npm dist-tag ls` for each published package: `next` equals the preview
   version and each prior `latest` value is unchanged. If a package was already
   published during a retry, verify its tags instead of assuming a skipped
   publish assigned `next`.
3. Push the reviewed preview tag so the existing release workflow creates a
   GitHub Release. The pinned `changelogithub@14` derives its prerelease flag
   from the version suffix; verify the resulting Release is published with
   `prerelease: true`. Advance the remote `next` ref to that release commit only
   after the npm tags and GitHub Release have been verified. A failed earlier
   step leaves the previous preview ref in place.
4. Stable publication remains a separate decision and uses `latest`. Verify
   npm `latest`, the stable GitHub Release, and `master` agree before calling
   promotion complete. A stable release does not silently retag an earlier
   prerelease version as `latest`.

Release commands may describe the owner's publish and push steps. This task's
implementation and verification do not execute a real publish or push.

## Selecting a target

- Extend the existing core release read to expose the newest published
  `-next.N` prerelease separately from stable `latest`. Ignore drafts, malformed
  versions, and prereleases with a different identifier. Stable selection
  excludes prereleases even if GitHub metadata is inconsistent with the tag.
  A long sequence of previews must not make stable selection disappear merely
  because the current `releases?per_page=10` page no longer contains a stable
  row; use a stable-release lookup or equivalent bounded fallback.
- Compare prerelease identifiers as SemVer segments: numeric segments compare
  numerically (`next.10` > `next.9`); a stable version is newer than its own
  prereleases. Keep the accepted version syntax narrow; no general versioning
  framework is required.
- Explicit update fetches a fresh GitHub Release, not the notifier cache. Before
  changing any installation, check the chosen npm dist-tag for `@kddkit/cli`
  against the GitHub target. If absent or different, fail without switching
  components; publication may still be in progress. Stable and preview both
  install an exact version, never an unverified moving tag.
- If the requested channel has no published Release, fail clearly and change
  nothing. `--next` does not fall back to stable. After a stable promotion, an
  old `next` tag may still point to the preceding preview; do not downgrade a
  stable installation to that older preview. Report that no newer preview is
  available until the next preview release is published.

## Updating installed components

### CLI

Reuse the #23 same-Node npm-root, realpath, symlink, `npx`, known-source, and
PATH verification checks. A version inequality, not merely `current < target`,
triggers a channel change. Plain `kdd update` therefore installs stable
`X.Y.Z` over `X.Y.Z-next.N` even though the preview may compare higher than the
previous stable release. Verify the invoked `kdd --version` equals the exact
target after installation.

npm can omit the source for both registry and local-tarball global installs.
Keep the #23 default skip for an unknown source on installations this updater
has not yet changed, unless the user passes `--replace-cli-from-registry`.
The flag permits a channel change even when the target version is numerically
lower; it never permits a no-op reinstall of the same version. After a registry
install by this updater passes PATH/version verification,
record the invoked CLI path, npm global root, installed version, and channel.
This receipt is **continuing consent to replace an unknown-source CLI** at
that same path and root, not proof that the current files came from the
registry. It does not expire while those identity fields match; users can
revoke it by deleting the documented receipt file. Even a local tarball
installed later at the same path and version will match and may be replaced
on the next update. State that consequence and the receipt location in the
CLI help and update documentation. A missing or mismatched receipt still
requires `--replace-cli-from-registry`; a known non-registry source is always
skipped. The receipt never bypasses the #23 npm ownership, symlink, `npx`, or
PATH checks. Refresh it only after another verified updater install. This
allows a plain `kdd update` to return an updater-installed `next` CLI to stable
without repeating the flag.

### Claude Code plugin

Inspect installed plugin scopes and the configured `kddkit` Git marketplace.
Keep #23's user/project/local ownership and managed-scope rules. Switch only
when its source is the expected repository and its declaration has one editable
scope; skip ambiguous multi-scope declarations. Save the exact source transport,
ref (including an unset ref), declaration scope, and plugin version, installation
scope, and enabled state before any mutation. Local or policy-owned sources are
skipped; never replace an unrelated source merely because its name is `kddkit`.

When the ref is already correct, use `claude plugin marketplace update kddkit`
and the scoped `claude plugin update kddkit@kddkit` as in #23. For a ref change,
preflight the target ref and manifest, then run `claude plugin marketplace
remove kddkit --scope <declaration-scope>` followed by `claude plugin
marketplace add <saved-source-with-target-ref> --scope <declaration-scope>`.
Removing the last declaration **uninstalls the plugin**. Reinstall it with
`claude plugin install kddkit@kddkit --scope <plugin-scope>` and restore its
enabled state if necessary. Re-read the marketplace ref and installed plugin
version; only the exact target and preserved scope/enabled state count as
success. A same-name `marketplace add` with a different Git ref fails in Claude
2.1.263, so it cannot replace the remove/add sequence. Do not edit Claude's
settings or plugin cache to change the ref.

If any step after removal fails, remove a partial target declaration if
present, re-add the saved source with its original ref and scope, reinstall
the plugin in its original scope, restore its enabled state, and verify the
original ref, version, scope, and enabled state. Report the update as failed
with the rollback result. If rollback cannot restore that state, report the
saved source/ref and the remaining damage for manual recovery. If Claude asks
for interactive approval, keep #23's refusal behavior: do not pass `-y`,
show the scoped terminal command, and attempt rollback rather than leaving
the plugin absent or subscribed to the wrong ref.

### Codex plugin

Before mutation, inspect the installed `kddkit@kddkit` plugin and the
user-owned Git marketplace. Save the exact prior source URL, ref (including an
unset/default ref), sparse paths, and installed plugin version/enabled state.
`codex plugin
marketplace list --json` does not contain ref or sparse paths, so read the
user-owned Codex marketplace declaration with a proper TOML parser or an
equivalent lossless source. If these values or ownership cannot be established,
skip the switch. Managed, local, unrelated, and missing installations keep
the #23 behavior.

When the ref differs, preflight the target ref and manifest, then use Codex's
native `marketplace remove` and `marketplace add ... --ref ...` commands. Follow
with `plugin add` if the refresh did not install the target. Re-read the
marketplace ref and installed plugin version; only the exact target counts as
success. Switching from preview back to stable is required even when the
installed preview version compares higher than stable.

If target `add`, plugin installation, or verification fails after removal,
remove any partial target marketplace, re-add the saved original URL/ref/sparse
configuration, reinstall the plugin if necessary, and verify that its original
source and installed state are restored. Report the original error plus the
rollback result. If an external failure also prevents rollback, report that
critical state and the saved source/ref for manual recovery; never report
success or discard the saved source. Do not edit Codex's config or plugin
cache as a shortcut around its manager.

### Shared behavior

Each eligible installed component is handled separately after target
preflight; a component failure does not prevent attempts on the others. The
command exits nonzero if any requested component fails. It never installs a
previously absent component. A plugin change requires a client restart. The
agent skill may pass `--next` only on the user's explicit request and must
report that preview plugin subscription persists until a plain `kdd update`.

## Verification

- Release-script checks prove the preview publish path passes `--tag next` for
  every public package, refuses the wrong branch/version, and leaves `latest`
  unchanged in an isolated registry or equivalent reproducible publish probe.
  Check GitHub prerelease classification from the pinned release tool without
  publishing a real release.
- Core tests cover stable and preview selection, absent/inconsistent releases,
  more than ten previews, and `next.9` versus `next.10`.
- CLI tests cover explicit `--next`, unflagged stable selection, exact-version
  install and PATH verification, return from a higher-numbered preview, a
  valid receipt, a stale receipt, same-version local-tarball replacement under
  the stated continuing-consent rule, and the #23 unknown/local source guards.
- Plugin tests cover eligible and managed/local sources, ref changes in both
  directions, already-current versions, Claude removal uninstalls the plugin,
  target add/install failure, original plugin restoration and approval refusal,
  plus Codex remove/add success, target add failure, plugin add failure, and
  rollback to the exact saved source/ref/sparse paths. Exercise real Claude
  and Codex CLIs with disposable configurations so the ref conflicts and
  rollback paths are observed without touching user installs.
- Run build, typecheck, targeted and full tests, Codex artifact sync, and a
  built CLI `--help`/failure-path smoke check. Observe actual manager and npm
  output in disposable environments; never use the developer's global
  installations as test targets.

## References read before design

- `.planning/decisions/2026-07-25-release-process-two-step-preview-then-publish.md`
  and `docs/superpowers/specs/2026-09-23-self-update-design.md`: retain the
  project's two-step release order, GitHub version signal, and update guards.
- [npm dist-tag documentation](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag/):
  publish without `--tag` changes `latest`; `--tag next` isolates preview
  publication. Applied to the existing workspace publish path.
- [Claude Code marketplace documentation](https://code.claude.com/docs/en/plugin-marketplaces):
  Git refs define release channels; a marketplace update follows its pinned
  ref; removing the last declaration uninstalls its plugins. In an isolated
  `CLAUDE_CONFIG_DIR`, Claude 2.1.263 rejected a same-name add from
  `mag1yar/kddkit@v0.8.0` to `@master` despite the documentation's general
  same-name replacement statement. Remove/add/install succeeded; after a
  target add failed on a nonexistent ref, re-adding the saved source restored
  the plugin at `v0.8.0`.
- [Codex plugin marketplace documentation](https://developers.openai.com/plugins/build/plugins)
  and source [add](https://github.com/openai/codex/blob/main/codex-rs/core-plugins/src/marketplace_add.rs),
  [remove](https://github.com/openai/codex/blob/main/codex-rs/core-plugins/src/marketplace_remove.rs),
  [CLI JSON](https://github.com/openai/codex/blob/main/codex-rs/cli/src/plugin_cmd.rs):
  refs are supported, but a same-name different-source add is refused; remove
  deletes the snapshot; list JSON omits ref/sparse. Applied to reversible switching.
- `changelogithub@14` source
  [config](https://github.com/antfu-collective/changelogithub/blob/v14.0.0/src/config.ts)
  and [git](https://github.com/antfu-collective/changelogithub/blob/v14.0.0/src/git.ts):
  release prerelease status is inferred from the version tag. Reuse the
  already-pinned tool; no extra release generator.
