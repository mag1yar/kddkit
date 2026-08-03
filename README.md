# kddkit

**A kanban + memory substrate for humans and Claude.** Task board, decisions
and project context that survive sessions, branches and worktrees. You drive the
board by hand through a small web UI; Claude reads and writes it through MCP. It
is the state layer *under* whatever runs on top — bare Claude Code, Superpowers,
GSD — not a workflow engine and not an orchestrator.

Nothing gets forgotten or overwritten: tasks, decisions and context live outside
the context window, are pulled on demand, and look the same from every worktree.

## How it works

kddkit keeps two kinds of memory, deliberately separated:

- **Tasks** — mutable state, kept in a SQLite store *outside* your repo. They
  churn: `backlog → new → in_progress → review → done`, with comments and an
  event trail. This is "what am I doing / what's next."
- **Knowledge** — decisions, conventions and notes, kept as durable markdown in
  your repo under `.planning/decisions/` and indexed for search. This is "what
  we decided / how this is built / why." It outlives any task.

The store is keyed by your git repository, so the board is identical whether you
open the main checkout or a worktree. Claude reaches it over an MCP server
(4 read/point-write tools, every write attributed to `ai`); you reach it with a
CLI and a local web board.

## Install

Two steps, sent as **two separate prompts** in Claude Code:

```
/plugin marketplace add mag1yar/kddkit
```
```
/plugin install kddkit@kddkit
```

Then restart Claude Code. On the first session the plugin fetches its one native
dependency (`better-sqlite3`) into the plugin directory and prints a one-line
pointer confirming the substrate is active.

## Requirements

- **Node.js ≥ 22** on your `PATH` — the SessionStart hook and the MCP server run
  on it. Without it the plugin loads but stays quiet.
- **Claude Code** with plugin support.
- **git** — kddkit resolves its store from the repo you are in, so use it inside a
  git repository.
- **better-sqlite3** — native, *auto-installed* into the plugin on first session.
- macOS, Linux or Windows.

## Using the board (human side)

Claude uses kddkit automatically once the plugin is active. To *see* and edit the
board yourself you need the `kdd` CLI + web UI:

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
kdd add "Wire up auth"        --priority high
kdd move 12 in_progress
kdd decide "Use FTS5 for recall" --rationale "no extra dep, good enough"
kdd recall "recall ranking"   # search decisions + tasks
```

Full command set: `add`, `board`, `show`, `move`, `edit`, `comment`,
`block` / `unblock`, `link`, `archive` / `unarchive`, `decide`, `recall`,
`status`, `rebuild`, `projects`, `export`, `ui`. Add `--json` to most for
machine-readable output.

### Task kinds

Every task carries a kind: `feature` (the default), `bug`, `chore` or `research`. It is not a
label — three rules hang off it. A `research` task is never picked up by an agent: its
deliverable is a recorded decision, not a commit. The worker prompt branches on it, so a bug
worker is told to reproduce the failure and fix the cause rather than the symptom. And it
fixes the commit type the worker writes (`feat` / `fix` / `chore` / `docs`), which matters
because the release notes are generated from commit subjects and a non-conventional subject is
dropped silently.

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

## What Claude does with it

The bundled skill teaches a **pull** protocol: at the start of a task Claude
pulls what it needs (`list_tasks`, `recall "<topic>"`) instead of holding the
whole board in context, records progress as it goes (`update_task`), and never
makes mass or destructive board edits without you asking. Recording a decision
is human-gated — Claude proposes it; it lands via `kdd decide`.

MCP tools: `get_task`, `list_tasks`, `recall`, `update_task`. Creating,
archiving, linking and deciding are intentionally CLI-only, so those stay with
you.

## Agent mode (experimental)

kdd can drive ephemeral agent workers off the board. `kdd tick` is a thin dispatcher —
it reclaims expired leases, claims ready tasks, and fire-and-forget spawns one worker per
task up to a cap. It runs no LLM itself; schedule it from cron.

```cron
# every 2 minutes, dispatch workers for this repo
*/2 * * * * cd /path/to/repo && kdd tick >> /tmp/kdd-tick.log 2>&1
```

Stopping agent mode stops the agents, not just the dispatcher: `kdd stop` turns auto-tick off,
kills every live worker of this board, and returns to the queue only the tasks whose worker is
confirmed dead (one that survives `SIGKILL` keeps its slot until the normal TTL path retries it;
one that finished while being stopped keeps its `review`). Switching **Auto-tick** off in the web
UI does the same — clearing the timer alone would leave the already-spawned agents editing files
and committing.

**Config (env):**

- `KDD_MAX_WORKERS` — max parallel workers (default 3)
- `KDD_WORKER_TTL` — lease TTL for spawned workers, seconds (default: core's `DEFAULT_TTL`, 900s —
  the supervisor heartbeat renews it every `ttl/3`, so this bounds only how long a dead worker holds
  its slot)
- `KDD_WORKER_IDLE` — how long the agent may produce no output before the supervisor calls the run
  wedged, seconds (default 1800). On timeout it stops renewing the lease, kills the agent's process
  group and ends the run, so `kdd tick` reclaims the task and retries it through the normal
  failed-attempt path. Generous on purpose: a long tool call or a long thinking turn must not trip it
- `KDD_WORKER_PROMPT` — replaces the instructions the built-in supervisor gives the agent. The run
  marker `kdd tick` looks for in `ps` is appended to it either way: a custom prompt customizes the
  work, not the lifecycle
- `KDD_SPAWN_CMD` — shell command to spawn a worker (default: a `claude -p` bootstrap). This one
  really does opt out: kdd no longer builds the command line, so a custom spawn carries no run
  marker and its workers are never killed on reclaim — your spawn, your lifecycle.

**Feed hygiene.** A worker's activity feed carries raw tool input and output, so kdd caps each
value before it reaches the store (4 KB per string, 64 KB per event) and redacts well-known secret
shapes — API keys, GitHub/Slack tokens, JWTs, private key blocks, `*_TOKEN=`-style env lines — on
the way in. Best-effort, not a guarantee: the point is not to keep the obvious ones forever in a
file that gets backed up and shared. Seven days after a task is done or archived, `kdd tick` drops
the verbose part of its feed; the run skeleton (`run_start`, `run_end`, errors) stays.

**Worker contract.** A spawned worker gets only `KDD_TASK_ID` + actor env — never the task body
(pull-context). It must:

1. `kdd show $KDD_TASK_ID` — read the task, criteria, links itself. Its `PATH` is led by the
   directory of the node running `kdd worker`, so a bare `kdd` resolves to the install whose
   native modules match — under nvm/fnm the shell's own first node usually does not.
2. Do the work in the repo (cwd is the repo root).
3. When done: leave one summary comment (`kdd comment`), check acceptance criteria
   (`kdd criteria check`), then `kdd move $KDD_TASK_ID review`.

The lease is renewed by the supervisor, not by the agent: the built-in `kdd worker` renews every
`ttl/3` for as long as its process lives, and stops the agent the moment a renewal is refused
(lease reclaimed or taken away). A custom `KDD_SPAWN_CMD` has no such supervisor — it owns its own
renewal: call `kdd claim $KDD_TASK_ID --renew` periodically, and **stop immediately** if renew
errors, because another worker now owns the task.

A task that fails to make progress (worker crashes, exits without moving to review, or spawn fails)
is retried on the next tick; after 3 failed attempts it is auto-blocked for a human to inspect.

> Ceiling: two overlapping workers doing raw `git commit` are not yet fenced at the git level
> (only board mutations are). Rare under the default TTL + heartbeat; closed by worktree-per-lease.

## Where things live

- **Store:** `~/.kdd/<repo-hash>/kdd.db` (override the root with `KDD_HOME`).
- **Decisions:** `.planning/decisions/` in your repo, versioned with your code.

To copy a board, copy it with SQLite, not with `cp`: the store runs in WAL mode, and recent
writes — sometimes all of them — live in the `-wal` file next to it. `sqlite3 kdd.db "VACUUM INTO
'copy.db'"` writes one consistent file; `cp kdd.db` alone can silently lose everything since the
last checkpoint. kdd itself already does this wherever it copies the board.

## Layout

```
.claude-plugin/    plugin + marketplace manifests (MCP server wired here)
hooks/             SessionStart: smart-install + pointer
skills/kdd/        the pull-protocol contract
scripts/           smart-install.mjs, session-start.mjs
packages/
  core/            store, state machine, recall (better-sqlite3, FTS5)
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
