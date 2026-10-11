# External Integrations

**Analysis Date:** 2026-07-21

## APIs & External Services

**Claude AI (Anthropic):**
- **Service:** Claude Code as host environment
- **Integration:** MCP (Model Context Protocol) server
  - SDK: `@modelcontextprotocol/sdk` 1.12.0
  - Transport: stdio-based (subprocess)
  - Entry: `packages/mcp/src/main.ts`
  - Manifest: `.claude-plugin/plugin.json`
- **Implementation:** `packages/mcp/` - Exposes KDD as MCP server with tools:
  - `get_task` - Fetch task with links and recent comments
  - `list_tasks` - Compact board view
  - `list_tracks` - Active tracks for routing
  - `recall` - FTS5 search over decisions and tasks
  - `update_task` - Edit, move, and comment tasks (AI actor)
- **Auth:** Actor type (user/ai) determined by `KDD_ACTOR` env var; session tracked via `KDD_SESSION`

## Data Storage

**Databases:**
- **Type:** SQLite (embedded)
- **Provider:** node:sqlite (built into Node ≥22.16, wrapped by `Db` in `packages/core/src/db.ts`)
- **Location:** `~/.kdd/<project-hash>/kdd.db`
- **Connection:** Via `packages/core/src/db.ts:openDb()`
- **Schema:** 5 migration steps (tasks, comments, task_links, decisions with FTS5, tracks, criteria)
- **Tables:**
  - `tasks` - Task records with status, priority, area, position
  - `comments` - Task comments with author and timestamp
  - `task_links` - Task relationships (relates_to, blocks, etc.)
  - `events` - Audit log (actor_type, action, timestamp)
  - `errors` - Error tracking (source, message, timestamp)
  - `decisions` - Indexed decision records (path, content_hash, slug)
  - `criteria` - Acceptance criteria per task
  - `tracks` - Task group definitions
  - `search_index` - FTS5 virtual table (decisions + tasks full-text search)
  - `meta` - Key-value config (project_path, fts_last_event_id)
- **Features:**
  - WAL (Write-Ahead Logging) enabled
  - Foreign key constraints enabled
  - 5-second busy timeout
  - Full-text search via FTS5 with Unicode61 tokenization

**File Storage:**
- Local filesystem only
- Decision records stored as `.md` files in `.planning/decisions/`
- Path resolved via `packages/core/src/paths.ts:resolveDecisionsDir()`

**Caching:**
- None - Direct SQLite queries, in-memory during request handling
- Output caps managed via `packages/core/src/caps.ts` for UI performance (configurable limits on comments, events, board rows)

## Authentication & Identity

**Auth Provider:**
- Custom (no external auth provider)

**Implementation:**
- `packages/cli/src/context.ts:getActor()` - Determines actor from env:
  - `KDD_ACTOR=user` → `{ type: 'user' }`
  - `KDD_ACTOR=ai` → `{ type: 'ai', id: process.env.KDD_SESSION }`
- Multi-project isolation via SHA256 hash of git common dir
- No credentials required for local operation

## Monitoring & Observability

**Error Tracking:**
- Local error log in SQLite `errors` table
- `packages/core/src/db.ts:logError(db, source, message)` writes to table
- Errors include source (e.g., 'mcp') and timestamp

**Logs:**
- Console output for CLI commands
- MCP server errors logged to stdout/stderr (inherited by Claude Code)
- No external logging service

**Audit:**
- `events` table tracks all mutations:
  - Actor type + id
  - Action (created, moved, edited, commented, blocked, unblocked, linked, archived, unarchived, criterion_*)
  - Task id and detail payload
  - Timestamp

## CI/CD & Deployment

**Hosting:**
- npm packages (@kddkit/core, @kddkit/cli, @kddkit/ui)
- Claude plugin via Anthropic Claude Code marketplace
- No dedicated hosting; runs locally or as plugin in Claude Code

**CI Pipeline:**
- GitHub Actions (`.github/workflows/test.yml`)
- Trigger: `push` to master, pull requests
- Environment: ubuntu-latest, Node.js 22
- Commands:
  ```bash
  pnpm install --frozen-lockfile
  pnpm turbo build test
  ```
- Caching: pnpm cache via `pnpm/action-setup@v4`

## Environment Configuration

**Required env vars:**
- None (all have sensible defaults)

**Optional env vars:**
- `KDD_HOME` - Override data directory (default: `~/.kdd`)
- `KDD_DB` - Direct database path override
- `KDD_DECISIONS_DIR` - Override decisions directory location
- `KDD_ACTOR` - Set actor type: `user` (CLI) or `ai` (MCP)
- `KDD_SESSION` - Session ID for AI actor
- `NODE_ENV` - Runtime environment

**Secrets location:**
- No secrets required
- No `.env` files used; configuration via env vars at runtime

## Webhooks & Callbacks

**Incoming:**
- None

**Outgoing:**
- None

## Git Integration

**Dependency:**
- `git rev-parse --git-common-dir` - Resolves per-worktree database location
- `git rev-parse --show-toplevel` - Resolves project root for decisions directory
- Failure to locate git throws `KddError` - database resolution requires git repo

---

*Integration audit: 2026-07-21*
