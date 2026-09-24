# @kddkit/cli — `kdd`

**The command line for [kddkit](https://github.com/mag1yar/kddkit).** Run board
commands inside the target Git repository. `kdd update` works anywhere. Use
`kdd <command> --help` for options.

## Install

```bash
npm i -g @kddkit/cli      # puts `kdd` on your PATH
# or, without installing:
npx @kddkit/cli ui
```

Requires **Node ≥ 22**; board commands also require **git**.

## Update

Run `kdd update` to check the latest stable GitHub Release and update installed
kddkit components: the npm-owned global CLI and eligible Claude Code and Codex
plugins. Absent, linked, managed, or locally sourced components are reported
without changing them. The command verifies each installed version after its
manager runs and reports partial failures. Restart Claude Code or Codex after a
plugin update. An agent can use `/kddkit:kdd-update` or `$kddkit:kdd-update`.
If npm does not report a global CLI installation's source, the CLI is skipped
even when it came from the registry; update it manually with its owning npm.
Other tarball URLs and registry mirrors are also skipped.
Run `kdd update --replace-cli-from-registry` to explicitly replace an older CLI
with the registry package when npm does not report its source. This may replace
a local tarball installation; the flag does not bypass npm prefix or symlink checks.

On ordinary human commands, a short stderr notice appears when a cached newer
release is available. The check refreshes in the background; set
`NO_UPDATE_NOTIFIER=1` to disable it.

## Command reference

| Command | What it does | Example |
| --- | --- | --- |
| `add` | Create a task. | `kdd add "Wire up auth" --priority high` |
| `decide` | Record a project decision. | `kdd decide "Use FTS5" --decision "Use SQLite FTS5" --rationale "No extra service"` |
| `decision` | Show a decision by slug. | `kdd decision 2026-09-20-use-fts5` |
| `board` | List tasks by status, with optional filters. | `kdd board --track 2` |
| `show` | Show a task and its history. | `kdd show 12` |
| `brief` | Show a compact task resume packet. | `kdd brief 12 --json` |
| `attention` | List tasks needing human action. | `kdd attention` |
| `move` | Change a task's status. | `kdd move 12 in_progress` |
| `claim` | Claim or renew a task lease. | `kdd claim --next` |
| `tick` | Run one agent scheduling pass. | `kdd tick` |
| `stop` | Disable agent scheduling and stop live workers. | `kdd stop` |
| `worker` | Supervise an agent working on a task. | `kdd worker 12` |
| `feed` | Show agent events for a task. | `kdd feed 12 --since 5` |
| `edit` | Change task fields. | `kdd edit 12 --priority urgent` |
| `comment` | Add a task comment. | `kdd comment 12 "Ready for review"` |
| `attach` | Attach a local file to a task. | `kdd attach 12 ./screenshot.png` |
| `detach` | Remove an attached file by file ID. | `kdd detach 3` |
| `block` | Mark a task blocked with a reason. | `kdd block 12 "Waiting for API access"` |
| `unblock` | Clear a task's block. | `kdd unblock 12` |
| `link` | Link two tasks. | `kdd link 12 13` |
| `archive` | Hide a task from the active board. | `kdd archive 12` |
| `unarchive` | Restore an archived task. | `kdd unarchive 12` |
| `recall` | Search decisions and tasks. | `kdd recall "auth"` |
| `rebuild` | Rebuild the search index. | `kdd rebuild` |
| `status` | Show an in-progress and blocked digest. | `kdd status` |
| `update` | Update installed kddkit CLI and plugins. | `kdd update` |
| `ui` | Open the local web board. | `kdd ui` |
| `criteria` | Manage task acceptance criteria. | `kdd criteria --help` |
| `criteria add` | Add a criterion. | `kdd criteria add 12 "Tests pass"` |
| `criteria check` | Mark a criterion verified. | `kdd criteria check 12 3 --evidence "pnpm test"` |
| `criteria uncheck` | Mark a criterion unverified. | `kdd criteria uncheck 12 3` |
| `criteria rm` | Remove a criterion. | `kdd criteria rm 12 3` |
| `criteria ls` | List a task's criteria. | `kdd criteria ls 12` |
| `track` | Manage task groups. | `kdd track --help` |
| `track add` | Create a track. | `kdd track add "Backend" --description "Use for API work"` |
| `track ls` | List active tracks. | `kdd track ls --all` |
| `track edit` | Change a track's name or description. | `kdd track edit 2 --name "API"` |
| `track done` | Mark a track complete. | `kdd track done 2` |
| `track reopen` | Reactivate a completed track. | `kdd track reopen 2` |
| `track rm` | Delete a track and detach its tasks. | `kdd track rm 2` |
| `projects` | List locally known projects and their database paths. | `kdd projects` |
| `export` | Export the board as JSON. | `kdd export > board.json` |
| `help` | Show help for a command. | `kdd help criteria` |

Most commands accept `--json` for machine-readable output; `export` already
prints JSON. Check each command's `--help` for its options.

---

Part of **[kddkit](https://github.com/mag1yar/kddkit)**. MIT.
