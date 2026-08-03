---
name: kdd
description: Use when working in a project that has a KDD board — to check current tasks, record progress, move tasks through the board, or recall past decisions. KDD is the substrate that stores tasks, decisions and project context outside the context window, pulled on demand and shared across every worktree.
---

# KDD — task & memory substrate

KDD keeps the project's task board, decisions and context in a store outside the
context window. You reach it through MCP tools and, for the human, a CLI and web
board.

## Surfaces — which one to use

There are two ways in, and picking wrong misattributes your work to the human.

- **MCP tools — your default for everything task-shaped.** Reads: `list_tasks`,
  `get_task`, `recall`, `list_tracks`. The one write: `update_task` (edit / move /
  comment ONE task). Every MCP write is logged as `ai` automatically — no flags,
  no prefix.
- **`kdd` CLI — the human's surface** (it also runs the web board, `kdd ui`). It
  logs as the **human** by default. So do NOT reach for `kdd comment` / `kdd move`
  / `kdd edit` — those exist for the person, and running them yourself stamps your
  work as theirs. Use `update_task` instead; same effect, correct author.
- **When you genuinely need a CLI op MCP doesn't expose** (below), prefix
  `KDD_ACTOR=ai` or the event shows up as the user's:

  ```
  KDD_ACTOR=ai kdd block 12 "waiting on the API key"
  ```

### CLI reference — the whole surface, no `--help` needed

**Every command takes `--json`** for a machine-readable object. Add it when you
will parse the result; omit it to show the human plain text. Never scrape the
pretty text — `--json` is the contract.

Read-only (safe, no author written — use freely, though the MCP reads above are
usually enough):

```
kdd status                         # digest: counts + in_progress + blocked
kdd board [--track <id>] [--area <a>] [--status <s>] [--kind <k>]
kdd show <id>                      # one task with comments + event trail
kdd recall "<query>" [-k <n>] [--kind decision|task]   # kind = result type here, not task kind
kdd track ls [--all]               # --all includes done tracks
```

Writes — prefix `KDD_ACTOR=ai`, and only on an explicit user request (see Iron Law):

```
kdd block <id> "<reason>"   /   kdd unblock <id>
kdd criteria ls <taskId>
kdd criteria add <taskId> "<text>"
kdd criteria check <taskId> <id>   /   kdd criteria uncheck <taskId> <id>
kdd criteria rm <taskId> <id>
kdd decide "<title>" --decision "…" --rationale "…"   # human-gated, see Decisions
kdd archive <id>            # Iron Law: normally the human
kdd link <from> <to> [--kind relates_to]   # kind = link type here, not task kind
kdd track add "<name>" --description "use when: …"
kdd track edit <id> [--name …] [--description …]
kdd track done <id>   /   kdd track reopen <id>   /   kdd track rm <id>
```

Worked example — block a task as yourself, then read the board as JSON to act on it:

```
KDD_ACTOR=ai kdd block 12 "waiting on the API key"   # → #12 blocked: waiting on the API key
kdd board --track 3 --json                           # → {"backlog":[…],"new":[…],"in_progress":[…],…}
kdd track add "Secondary backend" --description "use when: partner-fed tasks, module X"  # → track #4 Secondary backend
```

That is the complete command set. If a form is unclear, run the command with no
arguments — the error names what is required. Do NOT reach for `kdd --help` or
guess flags; the forms above are the whole surface.

## Orientation (session start)

If the SessionStart pointer reports active tracks, orient before doing anything:

1. Call `list_tracks` — each track carries a `name`, a `description` written as a
   "use when…" routing hint, and a `status`. Route work to an `active` track;
   `status: "done"` marks a finished body of work (like a completed milestone) —
   kept for context, not a routing target.
2. Check where you are: current branch (`git branch --show-current`) and worktree
   (`git rev-parse --show-toplevel`).
3. Match branch/worktree against each track's `description`, pick the track the
   current work most likely belongs to.
4. Tell the user in 2–3 sentences what you understood: which track, which
   branch/worktree, and what is `in_progress` there (`list_tasks { track_id }`).

Tracks are non-time-boxed task groups (unlike sprints or gsd milestones); several
run `active` at once, so a project may have parallel tracks by source of work.
When you create or touch a task, put it on the track its `description` matches;
attach with `update_task { id, edit: { track_id } }`.

## Pull protocol

- At the start of a task, **pull** what you need: `list_tasks` for the board,
  `recall "<topic>"` for past decisions and related tasks. Do not try to hold the
  whole board in context — fetch on demand.
- Before proposing an approach that touches an earlier decision, `recall` it
  first so you do not contradict what was already decided.

## Writing to the board

All task writes go through the MCP `update_task` tool (logged as `ai`), never the
CLI equivalents.

- Record progress as you go: `update_task { id, comment: "<what happened>" }`.
  Write the comment in your own voice, as the one who did the work — "Fixed the
  token-expiry off-by-one", not "you asked me to fix…". Describe what happened, not
  who requested it; the author (`ai`) is already recorded.
- Move a task when its state changes: `update_task { id, move: { to: "<status>" } }`.
  Valid statuses: backlog, new, in_progress, review, done. A move that skips the
  normal flow needs `move.reason` explaining that the user asked for it.
- Edit a task's fields with `update_task { id, edit: { ... } }`.

### Acceptance criteria

A task's `criteria` list (visible in `get_task`) is the acceptance contract: the
task is done when every criterion holds. Working a task, you own the checkboxes:

- **Check each criterion as you complete it** — after verifying it actually
  holds (test ran, behavior observed), not when you merely wrote the code:

  ```
  KDD_ACTOR=ai kdd criteria check <taskId> <id>
  ```

  (`kdd criteria ls <taskId>` shows ids; criteria writes are CLI-only, so the
  `KDD_ACTOR=ai` prefix is mandatory here.)
- **Move to review only when every criterion is checked.** An unchecked
  criterion means the task is not ready — finish it or say why you cannot.
- Never check a criterion you did not verify. If one is impossible or obsolete,
  leave it unchecked and comment why — removing criteria is the human's call.
- A criterion the human **unchecks** during review is rework: the task comes
  back to `in_progress` and that criterion is your work list.
- `get_task { id }` returns the task with its most recent comments and events;
  `comments_total` / `events_total` show the real counts. When the trail is
  longer than what you received and the history matters, call
  `get_task { id, full: true }` for the complete, uncapped record.

### Task kind

Every task carries a `kind` from a closed vocabulary — `feature` (default), `bug`,
`chore`, `research` — set or changed with `update_task { id, edit: { kind } }`.
`research` is excluded from the claim protocol: the queue walk (`kdd claim` with no
id, and `kdd tick`) never surfaces a `research` task to anyone — not because it is
`ai`-only work, but because its deliverable is a recorded decision, not a commit,
and the queue has no one to hand it to. A human takes one on purpose with an
explicit `kdd claim <id>`. This is a different `kind` from `kdd recall --kind`
(result type) and `kdd link --kind` (link type) above — same word, three
vocabularies.

## Decisions

Recording a project decision is deliberate and human-gated: propose the
decision to the user; it is written with `kdd decide` (by the user, or by you via
the CLI only when the user asked). Decisions are **not** an MCP tool.

Decisions are **append-only**: never edit or delete a decision file. To change
course, record a new decision with `--supersedes <old-slug>` — the old one stays
in history as `superseded`, and `recall` ranks the active one above it.

## Iron Law

**Never make mass or destructive board edits without an explicit user request.**
Creating, archiving, linking and bulk changes are intentionally not available as
MCP tools — they stay with the human via the CLI. Touch one task at a time, in
response to a real request, and record what you did.
