# @kddkit/core

**The state engine behind [kddkit](https://github.com/mag1yar/kddkit)** — a
kanban + memory substrate for humans and Claude.

All of kddkit's logic lives here: the SQLite store and schema migrations, the
task state machine with its acceptance-criteria and review gates, task claims with
expiring leases, and FTS5 `recall` over tasks and decisions. The CLI, web UI and MCP server are thin clients over this package.

```ts
import { openDb, addTask, listTasks, recall } from '@kddkit/core';

const db = openDb('/path/to/kdd.db');
const task = addTask(db, { title: 'Wire up auth', priority: 'high' }, { type: 'user' });
```

`db: Db` is always the first argument; mutations run in a
transaction and append to an event log. The public API is the `@kddkit/core`
barrel only — don't import nested paths.

## Install

```bash
npm i @kddkit/core
```

Most people don't need this directly — install
[`@kddkit/cli`](https://www.npmjs.com/package/@kddkit/cli) or the
[Claude Code plugin](https://github.com/mag1yar/kddkit#install) instead.

---

Part of **[kddkit](https://github.com/mag1yar/kddkit)**. MIT.
