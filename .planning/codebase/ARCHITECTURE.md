<!-- refreshed: 2026-07-21 -->
# Architecture

**Analysis Date:** 2026-07-21

## System Overview

KDD is a multi-layer, multi-interface kanban and decision memory substrate for Claude Code and human users. Data flows from a SQLite backend through a shared core library to three interfaces: CLI, web UI, and Claude-integrated MCP.

```text
┌─────────────────────────────────────────────────────────────┐
│         Three Client Interfaces (read/write)                │
├──────────────┬──────────────────────┬──────────────────────┤
│     CLI      │     Web UI (React)   │    MCP (Claude)      │
│ `packages/   │  `packages/ui/src/   │ `packages/mcp/src/   │
│ cli/src/`    │  web/`               │ server.ts`           │
└────────┬─────┴────────┬─────────────┴──────────┬────────────┘
         │              │                        │
         └──────────────┼────────────────────────┘
                        │
         ┌──────────────▼──────────────┐
         │  Hono HTTP Server           │
         │  `packages/ui/src/server.ts`│
         │  (shared by UI + CLI)       │
         └──────────────┬──────────────┘
                        │
         ┌──────────────▼──────────────┐
         │   Core Logic Layer          │
         │   `packages/core/src/`      │
         │ (ops, queries, state, db)   │
         └──────────────┬──────────────┘
                        │
         ┌──────────────▼──────────────┐
         │  SQLite + FTS5 Index        │
         │  `~/.kdd/<hash>/kdd.db`     │
         │  + Decisions (.md files)    │
         └─────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| **CLI** | Command-line interface for task/track/decision/criteria operations; entry point for UI server | `packages/cli/src/index.ts` |
| **Web UI** | React SPA for kanban board, task editing, project switching | `packages/ui/src/web/App.tsx`, `components/` |
| **UI Server** | Hono HTTP server hosting both web SPA and REST API; project pool + db multiplexing | `packages/ui/src/server.ts` |
| **MCP Server** | Claude-integrated MCP interface exposing tools for AI agents | `packages/mcp/src/server.ts` |
| **Core** | Shared library: data model, operations, queries, state validation, search/recall | `packages/core/src/` |
| **Database** | SQLite with FTS5 for full-text search, schema migrations, event log | `packages/core/src/db.ts` |

## Pattern Overview

**Overall:** Multi-package monorepo with layered separation. Datastore is ground truth (SQLite); all clients are stateless. Single core logic layer shared across CLI/UI/MCP. No client-specific business logic.

**Key Characteristics:**
- **Single source of truth**: SQLite database (per project, keyed by git repo hash)
- **Stateless clients**: CLI, web UI, and MCP all use the same core operations
- **Transactions everywhere**: All mutations wrapped in `db.transaction()` for atomicity
- **Append-only events**: Task changes trigger event log entries for audit trail and observability
- **Multi-project support**: Shared server hosts multiple projects; selected by URL query param `?project=<hash>`
- **Decisions live in git**: `.planning/decisions/` markdown files are source-of-truth; indexed into FTS5 on recall
- **Constraints enforced at core**: State machine (status transitions), acceptance criteria gating, actor-based move validation

## Layers

**CLI Layer:**
- Purpose: Command-line interface for human operators and CI automation
- Location: `packages/cli/src/`
- Contains: Commander-based CLI definition, argument parsing, render functions (text formatting)
- Depends on: Core (ops, types, queries), context helpers (db resolution, actor extraction)
- Used by: Direct invocation via `kdd` command; also invokes UI server (`kdd ui`)

**Web UI Layer:**
- Purpose: Browser-based kanban board, task management, project navigation
- Location: `packages/ui/src/web/`
- Contains: React components (Board, TaskDialog, NewTaskDialog, etc.), fetch-based API client
- Depends on: REST API provided by UI server; no direct db access
- Used by: Browsers; opened from CLI via `kdd ui`

**UI Server (HTTP):**
- Purpose: Host both the web SPA and the REST API; manage multi-project database pool
- Location: `packages/ui/src/server.ts`
- Contains: Hono app with `/api/*` endpoints, static SPA serving, project pool manager
- Depends on: Core (ops, queries, state), node:sqlite
- Used by: Web UI clients, CLI (for board export), MCP (for search)

**MCP Layer:**
- Purpose: Claude-integrated Model Context Protocol server for AI agents
- Location: `packages/mcp/src/`
- Contains: Tool definitions (get_task, list_tasks, list_tracks, recall, update_task)
- Depends on: Core (ops, queries, handlers), MCP SDK
- Used by: Claude Code plugins and agents via stdio

**Core Logic Layer:**
- Purpose: Shared business logic, data model, validation, query interface
- Location: `packages/core/src/`
- Contains: Operations (addTask, moveTask, editTask), queries (boardData, taskDetail), state validation
- Depends on: node:sqlite, zod (validation)
- Used by: All three clients (CLI, UI server, MCP)

**Database Layer:**
- Purpose: Data persistence, schema migrations, event logging, full-text search
- Location: `packages/core/src/db.ts`, SQL schema in migrations array
- Contains: SQLite schema, migration history, WAL pragmas
- Depends on: node:sqlite, Node.js fs/path
- Used by: Core operations (all mutate through db.prepare/db.transaction)

## Data Flow

### Primary Request Path: Create Task via CLI

1. **CLI parsing** (`packages/cli/src/index.ts:40-55`)
   - User runs `kdd add "Title" --priority high --criterion "acceptance 1"`
   - Command handler calls `addTask(db, {...}, actor)`

2. **Core operation** (`packages/core/src/ops.ts:37-67`)
   - Validates inputs (title not empty, criteria not empty, track exists if specified)
   - Runs inside `db.transaction()`:
     - Inserts task row with auto-increment id
     - Inserts criterion rows (with positions)
     - Appends event row (action='created', actor_type/actor_id)
   - Returns Task object

3. **Render & output** (`packages/cli/src/index.ts:54`)
   - Text output: `#${t.id} created`
   - JSON output: full Task object

### Secondary Path: Move Task via Web UI

1. **Web UI drag** (`packages/ui/src/web/components/Board.tsx`)
   - User drags task card to new column
   - Sends PATCH `/api/tasks/:id` with `{ status, position }`

2. **UI Server endpoint** (`packages/ui/src/server.ts:120-140`)
   - Parses request body, resolves db from project pool
   - Calls `placeTask(db, id, to, orderedIds, actor)`
   - Validation happens in core: `checkMove(fromStatus, toStatus, actor, reason, openCriteria)`

3. **Core mutation** (`packages/core/src/ops.ts:148-180`)
   - If status changes: verify transition + criteria gating, then update + event
   - If reorder only (same status): update positions only, no event

4. **Response** (`packages/ui/src/server.ts`)
   - Returns updated Task object
   - Web UI rerenders board with new state

### Recall/Search Path: Query Decisions + Tasks

1. **CLI search** (`packages/cli/src/index.ts:168-177`)
   - User runs `kdd recall "component design"`
   - CLI calls `recall(db, decisionsDir, query, { k: 10, kind: undefined })`

2. **Recall core** (`packages/core/src/recall.ts:94-120`)
   - Calls `syncIndex(db, decisionsDir)` to refresh FTS5 index:
     - Scans `.planning/decisions/` directory for `.md` files
     - For each decision, parses header + content, computes hash, syncs to `search_index`
     - For tasks, scans events since last sync, indexes task title + body + comments
   - Runs FTS5 MATCH query (sanitized with `sanitizeQuery`)
   - Returns top-k `RecallHit[]` with kind, ref, title, snippet, status

3. **Render results** (`packages/cli/src/render.ts:73-91`)
   - Text output: decision ref [superseded?] title — snippet
   - Text output: task #id [status] title — snippet

**State Management:**
- **Tasks**: Stored in SQLite, mutations trigger events, UI polls or uses SSE
- **Decisions**: Markdown files in git; FTS5 index built on demand during recall
- **Events**: Append-only log; used for audit trail, history view, task indexing
- **Project context**: Resolved via git (project path → repo hash → db path); passed in env vars or CLI args

## Key Abstractions

**Task State Machine:**
- Purpose: Enforce valid status transitions and acceptance criteria gating
- Examples: `packages/core/src/state.ts`, checkMove function
- Pattern: Transition matrix + actor-based guards (AI cannot move to review with open criteria)

**Actor (User vs AI):**
- Purpose: Track who made changes; gate certain operations (AI moves are constrained)
- Examples: `{ type: 'user' } | { type: 'ai', id: '...' }`
- Pattern: Serialized in events + comments author field

**Acceptance Criteria:**
- Purpose: Gating mechanism: tasks cannot move to review if criteria unchecked
- Examples: `packages/core/src/criteria.ts`, `listCriteria`, `setCriterionChecked`
- Pattern: Stored separately from task; ordered by position; checked_at timestamp tracks completion

**Tracks (Task Groups):**
- Purpose: Organize tasks by epic/feature; routing hint for agents
- Examples: `packages/core/src/tracks.ts`
- Pattern: Tasks linked via `track_id`; tracks have status (active/done) and description

**Recall Hit (Search Result):**
- Purpose: Unified search result type for decisions and tasks
- Examples: `packages/core/src/recall.ts:74-81`
- Pattern: kind ('decision'|'task'), ref (slug or id string), snippet (text excerpt)

## Entry Points

**CLI Entry Point:**
- Location: `packages/cli/src/index.ts:1-20` (shebang + Commander setup)
- Triggers: Direct invocation `kdd <command> [args]`
- Responsibilities: Parse arguments, resolve db/project context, call core ops, format output

**Web UI Entry Point:**
- Location: `packages/ui/src/web/main.tsx`
- Triggers: CLI `kdd ui --port 4499` (spawns server) or joins running server
- Responsibilities: Mount React SPA, fetch API from server, manage board state

**UI Server Entry Point:**
- Location: `packages/ui/src/server.ts:54-320+` (createApp) + `packages/ui/src/server.ts:200-220` (uiStart)
- Triggers: CLI `kdd ui` or auto-spawn from CLI when opening UI
- Responsibilities: Create/reuse Hono server, project pool, serve SPA + API

**MCP Entry Point:**
- Location: `packages/mcp/src/main.ts` (startServer)
- Triggers: Claude invokes MCP plugin (stdio)
- Responsibilities: Resolve db/decisions dir, instantiate MCP server with tools, connect stdio transport

## Architectural Constraints

- **Threading:** Single-threaded event loop (Node.js); database uses WAL for concurrent readers
- **Global state:** Project pool in UI server (Map<hash, Database>); closed on process exit
- **Circular imports:** None detected; clear layering (CLI → Core → DB; UI → Core → DB; MCP → Core → DB)
- **Multi-project isolation:** Databases isolated by git repo hash; UI server multiplexes via `?project=<hash>` query param
- **Decisions mutable:** `.planning/decisions/*.md` files are edited/created outside KDD; FTS5 index rebuilt on each recall (not incremental beyond event watermark)
- **No distributed consensus:** All reads/writes to single SQLite instance; suitable for single user per project

## Anti-Patterns

### Global mutable Actor across calls

**What happens:** Temptation to store Actor in module-level state and reuse across requests/commands
**Why it's wrong:** Actor identity changes per command (user vs AI, different session IDs); reusing stale actor leads to attribution errors
**Do this instead:** Pass Actor as parameter through call stack; resolve from CLI context (`getActor()` in `packages/cli/src/context.ts`) or HTTP request metadata for UI/MCP

### Skipping db.transaction()

**What happens:** Direct db.prepare().run() calls without wrapping in db.transaction()
**Why it's wrong:** Partial failures leave db in inconsistent state; events may not be recorded
**Do this instead:** All mutations in `packages/core/src/ops.ts` and `packages/core/src/criteria.ts` wrap in `db.transaction(() => {...})()`; even single-statement changes are wrapped for consistency

### Editing decisions without re-indexing

**What happens:** Modifying `.planning/decisions/*.md` files and assuming recall will find them
**Why it's wrong:** FTS5 index is only rebuilt on explicit recall or rebuild command; stale index misses updates
**Do this instead:** Call `syncIndex(db, decisionsDir)` at start of recall (already done); or run `kdd rebuild` after manual edits

## Error Handling

**Strategy:** Validation at boundaries (CLI args, HTTP body); KddError for domain errors; generic Error for system failures.

**Patterns:**
- Input validation at core function entry (empty title, invalid status, nonexistent task ID)
- KddError thrown with user-friendly message; caught by CLI fail() or HTTP onError
- DB errors (constraint violations) propagate as KddError or system error, logged to events table

## Cross-Cutting Concerns

**Logging:** No centralized logger; errors logged to SQLite `errors` table via `logError(db, source, message)` in `packages/core/src/errors.ts`. CLI prints to stdout/stderr.

**Validation:** Centralized in core functions (checkMove, checkPriority, checkStatus); also Zod schemas in MCP server for tool input validation.

**Authentication:** User vs AI actor model; no credentials/secrets; identity derived from CLI context (user) or MCP session ID (ai).

---

*Architecture analysis: 2026-07-21*
