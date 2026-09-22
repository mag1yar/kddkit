# @kddkit/cli — `kdd`

**The command line for [kddkit](https://github.com/mag1yar/kddkit)** — a kanban +
memory substrate for humans and Claude.

`kdd` is how you drive the board by hand: add and move tasks, record decisions,
search them back, and open the local web board. State lives in SQLite *outside*
your repo, keyed by git repository, so the board is identical from any worktree.

## Install

```bash
npm i -g @kddkit/cli      # puts `kdd` on your PATH
# or, without installing:
npx @kddkit/cli ui
```

Requires **Node ≥ 22** and **git**.

## Use

Run from inside the project you're working on (the store is per-repo):

```bash
kdd ui                             # board at http://localhost:4499
kdd status                         # in-progress / blocked digest
kdd attention [--json]             # tasks currently requiring human action
kdd add "Wire up auth" --priority high
kdd move 12 in_progress
kdd brief 12 --json                  # deterministic <=4KB resume packet
kdd decide "Use FTS5 for recall" --rationale "no extra dep, good enough" --source-task 12
kdd decision 2026-09-20-use-fts5-for-recall
kdd recall "recall ranking"        # search decisions + tasks
```

Commands: `add`, `board`, `show`, `brief`, `attention`, `move`, `edit`, `comment`, `block` / `unblock`,
`link`, `archive` / `unarchive`, `decide`, `decision`, `recall`, `status`, `rebuild`,
`projects`, `export`, `ui`, plus `tick` / `worker` for experimental agent mode.
Add `--json` to most for machine-readable output.

---

Part of **[kddkit](https://github.com/mag1yar/kddkit)** — full docs, the Claude
Code plugin, and agent mode are in the main README. MIT.
