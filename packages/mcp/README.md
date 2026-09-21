# @kddkit/mcp

**The MCP server for [kddkit](https://github.com/mag1yar/kddkit)** — exposes the
task board to Claude Code over the Model Context Protocol.

A thin, self-contained server over
[`@kddkit/core`](https://github.com/mag1yar/kddkit/tree/master/packages/core). It
surfaces five zod-validated tools to Claude — `get_task`, `list_tasks`,
`list_tracks`, `recall`, `update_task` — with every write attributed to `ai`.
Creating, archiving, linking and deciding stay CLI-only, so those decisions stay
with the human.

`get_task` has three read modes: ordinary capped detail, `full: true` complete
history, and `brief: true` deterministic resume data capped at 4096 JSON bytes.
`brief` and `full` are mutually exclusive; the brief is derived on read and not stored.

Bundled into the [Claude Code plugin](https://github.com/mag1yar/kddkit#install)
and wired through the plugin manifest — not published to npm, not run standalone.

---

Part of **[kddkit](https://github.com/mag1yar/kddkit)**. MIT.
