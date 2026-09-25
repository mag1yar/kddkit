---
name: kdd-update
description: Update installed kddkit CLI and Claude Code or Codex plugins when the user asks.
---

# Update kddkit

Run `kdd update` for the stable channel. Pass `--next` only when the user
explicitly requests the preview channel. The command checks the chosen
published GitHub Release against npm's matching dist-tag, updates eligible
installed components, and verifies their versions. Report every result,
including failures and skips.

`--next` subscribes eligible Git plugin marketplaces to the moving `next` ref;
later previews may arrive through the client. A plain `kdd update` returns
them to stable `master`, even when the preview's version number is higher.
Restart Claude Code or Codex after a plugin change. Do not claim that this
running session has reloaded.

If npm did not report the global CLI's source, report the skip. Use
`--replace-cli-from-registry` only when the user explicitly asks to replace
that CLI from npm. A verified replacement stores continuing consent in
`<KDD_HOME>/update-cli-receipt.json` (default `~/.kdd/update-cli-receipt.json`);
deleting the file revokes it. A local tarball later installed at the same path
and version can still be replaced while the receipt remains valid.

If `kdd` is absent, stop and explain that channel switching cannot be verified
through this skill without the CLI. Do not silently refresh a marketplace at
its existing ref or install an absent component.
