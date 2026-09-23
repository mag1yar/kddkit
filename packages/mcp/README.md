# @kddkit/mcp

**The MCP server for [kddkit](https://github.com/mag1yar/kddkit)** — exposes the
task board to Claude Code and Codex over the Model Context Protocol.

A thin, self-contained server over
[`@kddkit/core`](https://github.com/mag1yar/kddkit/tree/master/packages/core). It
surfaces six zod-validated tools — `get_task`, `list_projects`,
`list_tasks`, `list_tracks`, `recall`, `update_task` — with every write attributed to `ai`.
When either client starts above several repositories, call `list_projects` and pass a listed
absolute worktree path as `project` to each task tool. Inside a repository, `project`
is optional.
Creating, archiving, linking and deciding stay CLI-only, so those decisions stay
with the human.

`get_task` has three read modes: ordinary capped detail, `full: true` complete
history, and `brief: true` deterministic resume data capped at 4096 JSON bytes.
`brief` and `full` are mutually exclusive; the brief is derived on read and not stored.

Bundled into the Claude Code and Codex plugins and wired through their manifests —
not published to npm, not run standalone.

---

Part of **[kddkit](https://github.com/mag1yar/kddkit)**. MIT.
