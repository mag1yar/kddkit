# @kddkit/ui

**The web board + REST API for [kddkit](https://github.com/mag1yar/kddkit)** — a
kanban + memory substrate for humans and Claude.

A [Hono](https://hono.dev) server that hosts both the REST API and the React
single-page board, multiplexing projects by git-repo hash. The CLI's `kdd ui`
spawns it — you normally don't run this package directly.

## Use

```bash
npx @kddkit/cli ui     # spawns this server, opens the board at http://localhost:4499
```

The board is a drag-and-drop kanban with a markdown editor for task bodies and
decisions, per-task audit history, and per-repo project switching.

## Install

```bash
npm i @kddkit/ui
```

Exposed as `startUi(getDb, port)` for embedding; the CLI is the intended entry
point for humans.

---

Part of **[kddkit](https://github.com/mag1yar/kddkit)**. MIT.
