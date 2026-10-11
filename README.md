# kddkit

**Keep the work contract between you and whichever Claude or Codex session is open
today.** Every session sees the same task board, acceptance criteria, decisions and
project context across branches and worktrees. Models can pull context, update progress
and submit work for review. The submitting AI session cannot accept its own work unless
you explicitly tell it to; a different actor handles acceptance.

Tasks stay fast and local in SQLite; decisions stay durable and reviewable in Git.
Start in Claude Code, continue in Codex, or switch worktrees without retelling the
project history. kddkit is the state layer under those sessions — not a workflow
engine and not an orchestrator.

## How it works

kddkit keeps two kinds of memory, deliberately separated:

- **Tasks** — mutable state, kept in a SQLite store *outside* your repo. They
  churn: `backlog → new → in_progress → review → done`, with comments and an
  event trail. This is "what am I doing / what's next."
- **Knowledge** — decisions, conventions and notes, kept as durable markdown in
  your repo under `.planning/decisions/` and indexed for search. This is "what
  we decided / how this is built / why." It outlives any task.

The store is keyed by your git repository, so the board is identical whether you
open the main checkout or a worktree. Claude and Codex reach it over an MCP server
(5 read/point-write tools, every write attributed to `ai`); you reach it with a
CLI and a local web board.

## Install

### Claude Code

Send these as **two separate prompts** in Claude Code:

```
/plugin marketplace add mag1yar/kddkit@master
```
```
/plugin install kddkit@kddkit
```

Then restart Claude Code. On the first session the plugin prints a one-line
pointer confirming the substrate is active.

### Codex

Run these in your terminal:

```bash
codex plugin marketplace add mag1yar/kddkit --ref master
codex plugin add kddkit@kddkit
codex plugin list
```

The last command should show `kddkit@kddkit` as `installed, enabled`. Then start or
restart Codex **from inside the project you want to use kddkit with**.
MCP writes and Stop reminders use the same full Codex session identity.

## Upgrading from 0.9.x

0.9.x could run agents on its own (`kdd tick` / autotick). That driver is gone and the
upgrade does not stop what it left behind. Once, per project:

```bash
ps -eo pid,pgid,args | grep '[k]dd-worker-'   # stray workers: kill -- -<pgid>
git worktree list | grep kdd/task-            # leftover task worktrees
git worktree remove <path>                    # after saving anything you want to keep
git branch -D kdd/task-N                      # its branch, once merged or unwanted
```

## Requirements

- **Node.js ≥ 22.16** on your `PATH` — the SessionStart hook and the MCP server run
  on it (SQLite is built into Node, no native build). Without it the plugin loads
  but stays quiet.
- **Claude Code or Codex** with plugin support.
- **git** — kddkit resolves its store from the repo you are in, so use it inside a
  git repository.
- macOS, Linux or Windows.

## Using the board (human side)

Claude and Codex use kddkit automatically once the plugin is active. To *see* and
edit the board yourself you need the `kdd` CLI + web UI:

```bash
npm i -g @kddkit/cli   # puts `kdd` on your PATH
# or without installing:
npx @kddkit/cli ui
```

<details>
<summary>Build from source instead</summary>

```bash
git clone https://github.com/mag1yar/kddkit.git
cd kddkit
pnpm install
pnpm build
(cd packages/cli && npm link)   # puts `kdd` on your PATH (subshell: no cd back needed)
```

</details>

Then, **from inside the project you are working on** (the store is per-repo):

```bash
kdd ui          # open the board at http://localhost:4499
kdd status      # in-progress / blocked digest
kdd attention [--json]   # tasks currently requiring human action
kdd add "Wire up auth"        --priority high
kdd move 12 in_progress
kdd brief 12 --json            # deterministic <=4KB resume packet
kdd decide "Use FTS5 for recall" --rationale "no extra dep, good enough" --source-task 12
kdd decision 2026-09-20-use-fts5-for-recall
kdd recall "recall ranking"   # search decisions + tasks
```

Full command set: `add`, `board`, `show`, `brief`, `attention`, `move`, `edit`, `comment`,
`block` / `unblock`, `attach` / `detach`, `link`, `archive` / `unarchive`,
`decide`, `decision`, `recall`, `status`, `rebuild`, `projects`, `export`, `ui`,
`update`. Add
`--json` to most for machine-readable output.

Use [`kdd update`](packages/cli/README.md#update) to refresh installed CLI and
Claude Code or Codex plugins. It works outside a Git repository; restart the
client after a plugin update.
Use `kdd update --next` to opt into previews for all eligible installed parts;
plain `kdd update` returns Git plugins to stable `master`. Preview Git refs may
receive later previews automatically through the client. The background notice
only announces stable releases.
If npm cannot identify the CLI's source, it is skipped unless you explicitly run
`kdd update --replace-cli-from-registry` to replace it from the registry.
Verified replacements write `<KDD_HOME>/update-cli-receipt.json` (default
`~/.kdd/update-cli-receipt.json`) as continuing consent; delete it to revoke.
The receipt also permits replacing a later local tarball at the same path and
version. Disabled Codex plugins are skipped to preserve their disabled state.

`kdd export` writes a versioned JSON board snapshot; see the [export v1 contract](docs/export-v1.md).

On the board itself, a task's dialog has a **Files** tab: drop a file, or
paste/drop an image straight into the body's markdown editor to attach it and
insert `![…](…)` inline. `kdd attach <taskId> <path> [--desc "<text>"]` does
the same from the CLI (20 MB cap per file, `kdd detach <fileId>` to remove).

### Task kinds

Every task carries a kind: `feature` (the default), `bug`, `chore` or `research`. It is not a
label — a `research` task is never claimed by an agent (`kdd claim <id>` refuses an `ai` actor on
it): its deliverable is a recorded decision, not a commit.

Only non-default kinds are shown on a card: a board full of tasks that predate kinds says
nothing about them rather than calling them all features.

```bash
kdd add "crashes on start" --kind bug   # seeds an empty body with Steps / Expected / Actual
kdd board --kind bug
```

Prefer not to link globally? Run it directly: `node /path/to/kddkit/packages/cli/dist/index.js ui`.

The board listens on `127.0.0.1` only — it has no login, and `/api/projects` knows the absolute
path of every board on the machine. To reach it from another device, opt in explicitly and bring a
secret: `kdd ui --host 0.0.0.0 --token <secret>` (or `KDD_UI_TOKEN`). Exposed that way, every
`/api` call needs the token, and the project list narrows to the one board you served.

## What Claude and Codex do with it

The bundled skill teaches a **pull** protocol: at the start of a task the agent
pulls what it needs (`list_tasks`, `recall "<topic>"`) instead of holding the
whole board in context, records progress as it goes (`update_task`), and never
makes mass or destructive board edits without you asking. Recording a decision
is human-gated — the agent proposes it; it lands via `kdd decide`.

MCP tools: `get_task`, `list_tasks`, `list_tracks`, `recall`, `update_task`. Creating,
archiving, linking and deciding are intentionally CLI-only, so those stay with
you. `get_task { id, brief: true }` returns only the deterministic resume packet;
it is derived on read, never generated or stored, and cannot be combined with `full: true`.

## Where things live

- **Store:** `~/.kdd/<repo-hash>/kdd.db` (override the root with `KDD_HOME`).
- **Decisions:** `.planning/decisions/` in your repo, versioned with your code.

Each store has a persistent local project id. Linked worktrees share it automatically;
an independent clone or an additional repository joins only through an explicit binding.
From the primary checkout, use `kdd project show --json` to inspect ids, then
`kdd project bind /path/to/clone --repo <repo_id> --kind managed --json` or
`kdd project add-repo /path/to/backend --purpose backend --access context_only --json`.
After a move, stop existing clients and use
`kdd project rebind /old/git-common-dir /new/checkout --json`, targeting the existing
store with `KDD_DB` if needed; restart clients afterwards. A conflicting existing
board is never silently replaced. These commands do not start agents or create clones.
Additional repositories read the shared legacy decisions index; they cannot replace
it through their own `.planning/decisions`, `rebuild`, or `decide`.

To copy a board, copy it with SQLite, not with `cp`: the store runs in WAL mode, and recent
writes — sometimes all of them — live in the `-wal` file next to it. `sqlite3 kdd.db "VACUUM INTO
'copy.db'"` writes one consistent file; `cp kdd.db` alone can silently lose everything since the
last checkpoint. kdd itself already does this wherever it copies the board.

## Layout

```
.claude-plugin/    Claude plugin manifest
integrations/codex-plugin/  self-contained Codex plugin + native runtime
hooks/             Claude SessionStart pointer, Stop reminder
skills/kdd/        the pull-protocol contract
scripts/           session-start.mjs, stop.mjs
packages/
  core/            store, state machine, recall (node:sqlite, FTS5)
  cli/             the `kdd` command
  mcp/             thin MCP server over core (committed self-contained bundle)
  ui/              Hono API + React board
```

## Development

```bash
pnpm install
pnpm build         # turbo, builds every package
pnpm test          # vitest across core / cli / mcp / ui
pnpm dev:cli -- status   # local build on a throwaway store (~/.kdd-dev), real board untouched
```

The plugin ships committed `dist/` for `core`, `cli` and `mcp` so it runs with no
build step on install. Rebuild before committing if you change their source.

Full workflow — dev store isolation, migration safety, live dev-plugin install,
release — is in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
