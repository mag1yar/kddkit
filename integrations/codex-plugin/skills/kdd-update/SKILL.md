---
name: kdd-update
description: Update installed kddkit CLI and Claude Code or Codex plugins when the user asks.
---

# Update kddkit

Run `kdd update` if `kdd` is available. It checks the latest stable GitHub
Release, updates eligible installed components, and verifies each resulting
version. Report every component result, including failures and skips. Do not
claim that a running agent session has reloaded; restart Claude Code or Codex
after a plugin update.

If `kdd update` skips the CLI because npm did not report its source, report the
skip. Use `kdd update --replace-cli-from-registry` only when the user explicitly
asks to replace that CLI from the npm registry; the flag may replace a local
tarball installation.

If the CLI is absent, check the latest stable tag at
`https://api.github.com/repos/mag1yar/kddkit/releases?per_page=10` and update
only this client's already installed kddkit plugin. Stop if the release check
fails; do not infer a target from npm or a prerelease. Say the CLI and other
client were not checked.

- Claude Code: inspect `claude plugin list --json` for `kddkit@kddkit`. Update
  user scope or project/local scope belonging to the current Git repository;
  skip managed and other-project installations. If older than the stable tag,
  run `claude plugin marketplace update kddkit`, then
  `claude plugin update kddkit@kddkit --scope <scope>`. Never pass `-y` or
  accept a changed install command for the user. Re-read the plugin list and
  verify its version. If interactive approval is required, report incomplete
  and show that exact scoped command for the user to run in a terminal.
- Codex: inspect `codex plugin list --json` for `kddkit@kddkit`. Only when
  `marketplaceSource.sourceType` is `git` and the version is older, run
  `codex plugin marketplace upgrade kddkit`. Re-read the installed version.
  Run `codex plugin add kddkit@kddkit` only if it is still older, then verify
  again. A plugin's own `source: local` does not determine marketplace type.
  Skip a genuinely local marketplace; its owner updates that source.

Never install an absent component or report an update based only on a
successful manager exit code.
