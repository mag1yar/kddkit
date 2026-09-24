# Self-update for CLI and plugins

**Date:** 2026-09-23
**Task:** #23
**Status:** written spec approved in chat for implementation planning

## Goal

One explicit `kdd update` command updates the installed kddkit CLI and the kddkit
plugins in Claude Code and Codex. Absent installations are skipped. A new
`kdd-update` skill lets an agent request the same operation. Ordinary human CLI
invocations display a short update notice based on a cached stable release and
start a background refresh when the cache expires. No daemon runs.

The update command must work outside a KDD project. It must not open or migrate
a board. Updating files used by a running Claude or Codex session requires a
client restart before the new MCP server and skills take effect.

## Existing constraints

- Versions of the CLI, core, and both plugin manifests move together in the
  two-step release process. npm publication precedes the GitHub Release.
- `packages/core/src/release.ts` already provides the installed version,
  stable latest release, version comparison, and a bounded GitHub request.
  Reuse it. A published stable GitHub Release is the single version signal for
  both UI and CLI. The task's older npm-latest suggestion is superseded for
  this design by the existing UI release decision.
- The pre-release channel is separate task #71. This command and notifier use
  stable releases only; there is no `--next` flag in #23.
- Installed Claude plugins have scopes. Installed Codex plugins have marketplace
  sources; the installed Codex CLI has `marketplace upgrade` and `plugin add`,
  but no `plugin update` subcommand.
- `skills/kdd/SKILL.md` is copied into the Codex plugin by
  `scripts/sync-codex-plugin.mjs`. A new shared skill must use that sync path.

## `kdd update`

1. Fetch the latest stable release directly through `releaseInfo()`; do not use
   the notifier's disk cache for an explicit update. If the fetch fails or no
   stable release exists, report the reason and do not start installations.
2. Inspect installed components without changing them. Treat malformed tool
   output or a failed inspection as an error for that component, never as proof
   that it is absent.
3. Locate the npm CLI belonging to `process.execPath` and ask that npm for its
   global package root. Update the CLI only if the running `dist/index.js` is
   the real file under that root's `@kddkit/cli` package, the package is a
   registry install rather than a symlink or `file:` link, and its version is
   older than the release. If npm omits the installation source, skip it as
   unknown: global registry and local tarball installs can have the same
   `npm ls` output. An explicit source must match the published npm registry
   tarball URL for that package and version; other URLs are skipped. The explicit
   `--replace-cli-from-registry` flag permits replacing an older unknown-source
   CLI with the registry package. It never bypasses prefix, realpath, symlink,
   `npx`, or known non-registry source checks, and the agent skill does not add
   it unless the user specifically requests that replacement. Use that
   same npm CLI, under `process.execPath`, to
   install `@kddkit/cli@<release version>` globally. If npm is unavailable for
   this Node, a different npm prefix owns the installation, or the command is
   running from `npx` or a source checkout, skip the CLI and explain how to
   update it manually. After npm exits successfully, run the `kdd` resolved
   from the caller's PATH with `--version`; report `updated` only if that
   invoked command now reports the target version. A prefix or PATH mismatch
   is a failure with both observed versions in the message.
4. For each installed kddkit Claude plugin in the current scope, refresh the
   `kddkit` marketplace and run `claude plugin update kddkit@kddkit` with its
   installation scope when its version is older. Do not update a project or
   local-scope plugin belonging to another project. A managed installation is
   reported as managed rather than modified. Outside a Git repository, only
   user-scope installations qualify. In a non-TTY call, do not pass `-y`:
   that flag can accept a new marketplace-declared executable command without
   the client's interactive review. The current path-source marketplace needs
   no such acceptance. If Claude refuses an update because approval is needed,
   mark that component `interactive approval required` and show the scoped
   `claude plugin update` command for the user to run in a terminal. Re-read
   `claude plugin list --json`; an exit code of zero without the target version
   is not success.
5. For an installed kddkit Codex plugin whose
   `marketplaceSource.sourceType` is `git`, run
   `codex plugin marketplace upgrade kddkit`. Do not infer marketplace type
   from the plugin's `source`: a Git marketplace can supply a local plugin
   path. Re-read `codex plugin list --json` after the upgrade because the
   refresh may update installed files itself. Only if the installed version
   remains older, run `codex plugin add kddkit@kddkit`, then read the installed
   version again. Report `updated` only when the final version reaches the
   release version; otherwise report the observed version and a failure.
   A genuinely local marketplace is reported as local; its owner updates its
   source directory.
6. Run only fixed executable names with argument arrays, never an assembled
   shell command. Continue after an individual component fails, then exit
   nonzero if any requested update failed. Report updated, current, skipped,
   and failed components separately. Print a restart reminder if a plugin was
   updated.

The command never installs a missing component. It does not change a project
board, clone a repository, publish a release, or update Claude Code or Codex
themselves. A release newer than the version in the source checkout is not
grounds to replace that checkout.

## CLI version notice

- Cache only `{latest, checkedAt}` in the user-level KDD home, independent of
  the active repository. Validate the shape before reading; a corrupt cache is
  a miss. Write through a temporary file and rename so a short command never
  reads partial JSON.
- A cached stable version newer than this CLI produces one unobtrusive stderr
  line: `kdd: vX available; run kdd update`. It appears on a later invocation,
  never waits for the network, and never changes machine-readable stdout.
- When the cache has expired (24 hours after a successful check), a normal CLI
  invocation starts a detached Node process using `process.execPath` and an
  absolute path to the bundled checker.
  The child calls existing `releaseInfo()` and refreshes the disk cache. A
  failed request stays silent and becomes eligible to retry after five minutes.
  Concurrent invocations may start more than one checker; the cache is small
  and the requests are rare. Do not keep the caller alive to finish the request.
- Skip notices and background checks for `kdd update`, help/version, `--json`,
  `npx`, CI, the autonomous `worker` command, and commands run from a Claude or
  Codex agent environment. `NO_UPDATE_NOTIFIER` disables both. Short commands
  remain short even when GitHub is offline.

## Agent skill

Add `skills/kdd-update/SKILL.md`, exposed in Claude Code as
`/kddkit:kdd-update` and copied into the Codex plugin. It asks the agent to run
`kdd update` when the CLI exists. If the CLI is absent, it uses the current
client's plugin manager to update the installed kddkit plugin and reports that
the CLI was absent. It does not claim that the running session has reloaded.
If a non-TTY Claude update requires approval, the agent gives the user the
exact interactive command and reports the update incomplete. The skill does
not bypass client approval or managed-plugin policy.

## Verification

- Automated checks cover disk-cache hit/miss/expiry/corruption, a fast CLI
  invocation with no network wait, the next-run notice, source/npx skips,
  both installed-plugin shapes and scopes, npm/Node prefix mismatch, a linked
  global package, an unchanged PATH `kdd` after npm succeeds, Claude's
  non-TTY approval refusal, Codex refresh with and without a required `add`,
  failure continuation, and argument arrays passed to update subprocesses.
  Stub external commands, GitHub, and background worker launch in unit tests;
  also run built CLI subprocess tests with temporary state. Never mutate the
  developer's global installations in a test.
- Build, type-check, and run CLI/core tests. Check the generated CLI bundle and
  Codex artifact sync. Verify `kdd --help` and update the CLI command table.
- Observe a built CLI process with a temporary KDD home: a cache miss starts a
  background check; an invocation after the check writes its result prints the
  cached notice. JSON output remains parseable, and a failed update returns a
  nonzero exit with a clear component name. Actual registry or plugin
  installation is not needed to verify the command wiring.

## References read before design

- `.planning/decisions/2026-07-25-release-process-two-step-preview-then-publish.md`
  and `docs/superpowers/specs/2026-07-25-ui-releases-panel-design.md`:
  existing release order and one GitHub source. The latter explicitly reserved
  its core release module for #23.
- `/Users/magiyar/Projects/My/References/agent-kanban/packages/cli/src/updateCheck.ts:1-70`
  (disk TTL, bounded request) and
  `/Users/magiyar/Projects/My/References/agent-kanban/packages/cli/src/commands/upgrade.ts:7-47`
  (install-method detection). Adapted, not copied. Its CLI-only upgrade path
  does not fit the confirmed three-component update. Clone was 78 commits
  behind upstream after fetch.
- `/Users/magiyar/Projects/My/References/vibe-kanban/npx-cli/src/cli.ts:198-214`:
  delayed asynchronous notice. Not taken: it has no disk cache, and a later
  invocation cannot use the result. Clone was 10 commits behind upstream.
- `/Users/magiyar/Projects/My/References/OpenAlice/src/core/version.ts:105-182`:
  bounded release request with a memory TTL. Already represented in this
  project's core module; no second version parser or fetcher is needed. Clone
  was 1,775 commits behind upstream, so its line-level behavior was treated as
  historical reference only.
- Official manager behavior was checked against the installed `claude` and
  `codex` CLI help, [Claude marketplace documentation](https://code.claude.com/docs/en/plugin-marketplaces),
  and [Codex plugin documentation](https://developers.openai.com/plugins/build/plugins).
