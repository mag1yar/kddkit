# Codebase Concerns

**Analysis Date:** 2026-07-21

## Tech Debt

### Database Connection Lifecycle

**Issue:** Each CLI command in `packages/cli/src/context.ts` opens a fresh database connection via `withDb()` and closes it after the operation completes. This works for single-command-line usage but has implications for:
- Multi-step operations or scripted workflows that invoke multiple commands sequentially
- The UI server's connection pool which keeps connections open indefinitely

**Files:** 
- `packages/cli/src/context.ts` (withDb function)
- `packages/ui/src/server.ts` (projectPool)

**Impact:** Unnecessary connection churn in CLI; potential resource leak in UI if many projects are accessed over time without cleanup.

**Fix approach:** Consider connection pooling/reuse for CLI in high-frequency scenarios; ensure UI explicitly closes stale connections or implement idle timeout in projectPool.

---

## Concurrency & Race Conditions

### No Explicit Locking for Related Records

**Issue:** Operations like `placeTask()` (`packages/core/src/ops.ts:148-164`) reorder multiple tasks in a single transaction, but the SQLite transaction model with WAL mode provides statement-level isolation, not explicit row locks. Concurrent moves to the same column could theoretically cause ordering conflicts if position calculations race.

**Files:** `packages/core/src/ops.ts` (moveTask, placeTask)

**Impact:** At high concurrency (multiple users/AI agents editing the same board simultaneously), task ordering might become inconsistent, though SQLite transactions should prevent corruption. Position collisions possible.

**Fix approach:** Add a version/generation counter to task ordering, or use explicit SELECT...FOR UPDATE pattern (if supported), or ensure strict serialization via application-level locks for position operations.

---

### Silent Connection Errors in projectPool

**Issue:** In `packages/ui/src/server.ts` (lines 20-31), the projectPool caches database connections but never evicts them. If a cached database becomes unavailable (file deleted, permissions changed), subsequent requests using that cached connection will fail with no automatic recovery.

**Files:** `packages/ui/src/server.ts` (projectPool function)

**Impact:** Once a database connection is cached, transient issues become permanent until server restart.

**Fix approach:** Add health check before returning cached connection; implement TTL or lazy reconnection on error.

---

## Input Validation & Bounds

### No Size Limits on Task/Decision Body

**Issue:** Task bodies (`body` field) and decision bodies accept arbitrary string lengths. While CLI/UI display caps them at `CAPS.bodyChars` (8192), there's no storage limit. A malicious or buggy client could write megabytes of text.

**Files:**
- `packages/core/src/ops.ts` (addTask, editTask)
- `packages/core/src/decisions.ts` (addDecision)

**Impact:** Unbounded database growth; potential performance degradation for queries over large text fields; no protection against bulk storage attacks.

**Fix approach:** Enforce maximum body length in validation (e.g., 1MB), consistent with CAPS.

---

### No Maximum Length for Track Names

**Issue:** Track names are validated for non-empty but have no length constraint (`packages/core/src/tracks.ts:19-24`).

**Files:** `packages/core/src/tracks.ts` (createTrack, editTrack)

**Impact:** UI layout could break with very long track names; database bloat.

**Fix approach:** Add max-length validation, e.g., 200 characters, matching UI constraints.

---

## Security Considerations

### Path Traversal in Static File Serving

**Issue:** The static file handler in `packages/ui/src/server.ts` (lines 177-192) checks `if (!file.startsWith(resolve(publicDir)))` to prevent directory traversal. However, on systems with symlinks, `resolve()` may not canonicalize symlink targets. An attacker could craft paths like `/..%2Fsomething` that bypass the check if URL decoding happens after the guard.

**Files:** `packages/ui/src/server.ts` (mountStatic function)

**Impact:** Potential path traversal / local file disclosure if publicDir contains symlinks or if Hono's path parsing differs from `path.resolve()`.

**Fix approach:** Use `realpath()` to resolve symlinks; validate path after URL decoding; consider using a whitelist of allowed files instead of blacklist.

---

### FTS5 Query Injection Risk

**Issue:** The `sanitizeQuery()` function in `packages/core/src/recall.ts` (lines 84-92) extracts quoted phrases and identifiers to build a conservative FTS5 query. It escapes quotes by doubling them. While this is the correct FTS5 escaping, complex Unicode, zero-width characters, or FTS5-specific operators embedded in inputs could theoretically bypass the sanitizer.

**Files:** `packages/core/src/recall.ts` (sanitizeQuery)

**Impact:** Potential for FTS5 injection or unexpected query behavior. Current implementation is conservative (no operator support) but remains a trust boundary.

**Fix approach:** Add explicit allowlist of character types in extracted tokens; add fuzzing tests for edge-case Unicode and FTS5 operator strings.

---

### No Authentication/Authorization

**Issue:** The UI server in `packages/ui/src/server.ts` has no authentication. Any process with access to the port can read/write all tasks and decisions.

**Files:** `packages/ui/src/server.ts` (createApp)

**Impact:** Assumes single-user or trusted-network deployment. Not suitable for multi-user or internet-facing scenarios.

**Fix approach:** This is by design (local-only tool), but document the assumption clearly. If multi-user is needed, add session/token-based auth.

---

### No Rate Limiting

**Issue:** The UI server has no rate limiting on API endpoints. A malicious client could spam requests to create/edit tasks, perform large searches, or exhaust database connections.

**Files:** `packages/ui/src/server.ts` (createApp, all endpoints)

**Impact:** Denial of service via request flooding.

**Fix approach:** Add per-IP or per-session rate limiting; implement request budgets per operation type.

---

## Error Handling

### Silent Error Swallowing in logError

**Issue:** The `logError()` function in `packages/core/src/errors.ts` is called with a `try-catch` that silently ignores logging failures (e.g., `catch { /* logging is best-effort */ }` in `packages/mcp/src/server.ts:22`). If the database is corrupted or unreachable, critical errors are lost.

**Files:**
- `packages/core/src/errors.ts` (logError)
- `packages/mcp/src/server.ts` (line 22)

**Impact:** Errors that occur during error logging are discarded. Difficult to diagnose failures.

**Fix approach:** Log failures to stderr as fallback; ensure error logging never throws; consider separate error log file for critical failures.

---

### Silent Failure in listProjects

**Issue:** The `listProjects()` function in `packages/core/src/paths.ts` (line 51) silently skips corrupted databases: `catch { /* повреждённая база — пропускаем, не падаем */ }`. Corrupted databases disappear from the project list without warning.

**Files:** `packages/core/src/paths.ts` (listProjects)

**Impact:** Users lose visibility into broken projects; no feedback that something went wrong.

**Fix approach:** Log warnings to stderr when skipping corrupted databases; optionally expose corruption status in project list.

---

## Fragile Areas

### Unicode Surrogate Handling in capText

**Issue:** The `capText()` function in `packages/core/src/caps.ts` (lines 21-26) checks if the character at position `n-1` is a high surrogate (`0xd800`) to avoid cutting a surrogate pair. However, it doesn't account for:
- Combining diacritics (which appear after the base character)
- Zero-width joiners (ZWJ) sequences
- Complex grapheme clusters (e.g., emoji with skin tone modifiers)

Cutting mid-grapheme could still produce visually broken output.

**Files:** `packages/core/src/caps.ts` (capText)

**Impact:** Display of truncated non-Latin text could be broken or misleading (e.g., emoji without modifiers, diacritics separated from base).

**Fix approach:** Use proper grapheme cluster API (ICU or third-party library) instead of character-by-character handling. For now, truncate conservatively and include `… [+N chars]` suffix.

---

### Decision Supersede Without Validation

**Issue:** In `packages/core/src/decisions.ts` (line 131), `addDecision()` calls `supersede()` without validating that the superseding slug exists in the file system or database. If `input.supersedes` points to a non-existent decision, the function silently succeeds but marks it as superseded in the database.

**Files:** `packages/core/src/decisions.ts` (supersede, addDecision)

**Impact:** Decisions can be marked as superseded by non-existent slugs, creating broken references in the index.

**Fix approach:** Validate that the superseding slug exists before proceeding; throw an error if it doesn't (or warn and allow if intentional loose linking).

---

### Git Command Failures Assumed to Be "Not in Repo"

**Issue:** In `packages/core/src/paths.ts`, both `resolveDbPath()` and `resolveDecisionsDir()` call git commands and assume any error means "not in a git repository". Actual errors (e.g., git config corruption, permission denied, git binary missing) are misdiagnosed.

**Files:** `packages/core/src/paths.ts` (resolveDbPath, resolveDecisionsDir)

**Impact:** Users get misleading error messages for root-cause issues unrelated to git repo presence.

**Fix approach:** Parse git stderr to distinguish "not a repository" from other errors; surface the actual error message.

---

## Performance Bottlenecks

### FTS5 Index Not Maintained On-Demand

**Issue:** The recall/search feature in `packages/core/src/recall.ts` calls `syncIndex()` during every search (line 105). `syncIndex()` re-reads the decisions directory and checks all events since last index. For large event logs, this becomes slow.

**Files:** `packages/core/src/recall.ts` (recall, syncIndex)

**Impact:** Search is O(n) in event history, not O(1). Large projects (1000+ events) may see multi-second search latency.

**Fix approach:** Implement triggers or background indexing; cache the last sync timestamp and only process new events; add index rebuild command with progress indication.

---

### Position Gaps in Task Ordering

**Issue:** When tasks are moved, the `nextPosition()` function in `packages/core/src/ops.ts` (lines 118-123) finds the max position + 1. Over time, deleting/archiving tasks without recompacting positions leaves gaps, wasting integer space (though SQLite integers are 64-bit, so practical limit is high).

**Files:** `packages/core/src/ops.ts` (nextPosition, placeTask)

**Impact:** Eventually positions could exceed integer limits (extremely unlikely in practice), or gaps make reordering logic harder to reason about.

**Fix approach:** Not urgent, but add a recompact-positions maintenance command; document the design choice.

---

## Missing Test Coverage

### No Concurrent Database Access Tests

**Issue:** Test suite in `packages/core/test/` uses in-memory databases and single-threaded test execution. No tests verify behavior under concurrent reads/writes or connection pool stress.

**Files:** All test files (*.test.ts)

**Impact:** Race conditions or connection pool leaks could go undetected until production.

**Fix approach:** Add integration tests with concurrent operations using multiple connections; stress-test projectPool with many projects.

---

### No Search Robustness Tests

**Issue:** The recall/FTS5 functionality has basic tests in `packages/core/test/recall.test.ts` but no tests for:
- Special FTS5 operators (`AND`, `OR`, `NOT`, `NEAR`)
- Unicode normalization edge cases
- Very long queries
- Queries with only stopwords

**Files:** `packages/core/test/recall.test.ts`

**Impact:** Search could fail or behave unexpectedly on edge-case inputs.

**Fix approach:** Add fuzz tests for sanitizeQuery; add unit tests for FTS5 edge cases; test Unicode normalization.

---

### No Static File Security Tests

**Issue:** The static file handler in UI has no tests for:
- Path traversal attempts (`/../`, `..%2F`, symlinks)
- Very long paths
- Special characters in filenames

**Files:** No test file for `packages/ui/src/server.ts` static serving

**Impact:** Path traversal vulnerabilities could exist undetected.

**Fix approach:** Add tests for path validation; fuzz with malicious path patterns.

---

## Scaling Limits

### Database File I/O is Single-Process Bottleneck

**Issue:** KDD uses a single SQLite file (WAL mode) per project. node:sqlite (`DatabaseSync`) is synchronous and single-threaded. While SQLite handles WAL concurrency, JavaScript is single-threaded, so all database calls block the event loop.

**Files:** `packages/core/src/db.ts`, all CLI/UI endpoints

**Impact:** High-frequency operations (e.g., many API requests from UI) will block; can't scale to multi-core or distributed scenarios.

**Fix approach:** This is by design (simplicity over scale). Document single-process assumption. If scale is needed, migrate to multi-process architecture with connection pooling or switch to a true server-based database.

---

### Board View Loads All Tasks Into Memory

**Issue:** The `boardData()` function in `packages/core/src/queries.ts` (lines 11-27) fetches all tasks matching filters into memory as an array, then distributes them by status. For projects with 10K+ tasks, this could exhaust memory.

**Files:** `packages/core/src/queries.ts` (boardData)

**Impact:** Large boards are slow to render and consume memory.

**Fix approach:** Implement pagination; add filtering by status or track to reduce dataset; profile memory usage at scale.

---

## Dependencies at Risk

### better-sqlite3 Native Module — RESOLVED (2026-10-11)

**Resolved:** replaced by built-in node:sqlite; no native dependency remains. See `.planning/decisions/2026-10-11-node-sqlite-instead-of-better-sqlite3.md`.

**Issue:** `better-sqlite3` is a native module. Updates may require recompilation. Deployment to environments with different architectures or libc versions could fail.

**Files:** `packages/core/package.json` (better-sqlite3 dependency)

**Impact:** Deployment complexity; potential breakage on platform changes (e.g., M1 Mac vs Intel).

**Fix approach:** Use pre-built binaries where possible; test on all target platforms; consider fallback to pure-JS SQLite if native module becomes unmaintainable.

---

### No Pinned Versions for key Dependencies

**Issue:** `package.json` uses semver ranges (e.g., `^11.1.0` for bumpp) without lock. While `pnpm-lock.yaml` is likely committed, mismatches between lock and declared ranges could occur.

**Files:** `/package.json`, `packages/*/package.json`

**Impact:** Subtle build failures; reproducibility issues.

**Fix approach:** Consider using exact versions (`11.1.0` not `^11.1.0`) for critical dependencies, especially in the monorepo root; ensure lock file is always committed and up-to-date.

---

## Missing Critical Features

### No Backup/Export Strategy

**Issue:** KDD state is stored in SQLite (not committed to git). There's an `exportBoard()` function in queries but no automatic backup or export on every change.

**Files:** `packages/core/src/queries.ts` (exportBoard), but no automated backup

**Impact:** Database corruption or accidental deletion could lose work. No easy disaster recovery.

**Fix approach:** Implement periodic snapshots to git; add a pre-commit hook that exports current board state; document backup procedure.

---

### No Offline-First Sync

**Issue:** The UI server requires a live database connection. If the database file is moved, network accessed, or in another worktree, the UI fails. No conflict resolution for multi-repository edits.

**Files:** `packages/ui/src/server.ts` (projectPool)

**Impact:** Can't use KDD in disconnected mode or across multiple machines easily.

**Fix approach:** This is by design (simplicity). Document single-machine assumption; if sync is needed, consider eventual-consistency model with log-based replication.

---

## Known Limitations & Design Choices

### Git Dependency

**Issue:** KDD resolves database paths using git commands. Works well for git-based workflows but breaks if:
- Working in a subdirectory with its own git repo (nested repos)
- Using git worktrees (might work, depends on git version)
- Git is not installed or broken

**Files:** `packages/core/src/paths.ts`

**Impact:** Assumed environment (git always available and sane).

**Fix approach:** Document; consider fallback to environment variables for non-git projects.

---

### Single Writer (CLI/MCP/UI)

**Issue:** While the database supports concurrent readers via WAL, the application assumes a single writer at a time (CLI command, MCP call, or UI request). Simultaneous writes from multiple sources aren't tested.

**Files:** All core operations

**Impact:** Race conditions possible if user runs CLI and UI simultaneously, or if multiple browser tabs make concurrent changes.

**Fix approach:** Implement optimistic locking or explicit transaction ordering; test concurrent write scenarios.

---

### No Schema Versioning After Migration 5

**Issue:** The MIGRATIONS array in `packages/core/src/db.ts` ends at migration 5 (events.type and events.level columns). Future schema changes require appending to MIGRATIONS, which is prone to errors if not carefully coordinated in a team.

**Files:** `packages/core/src/db.ts` (MIGRATIONS)

**Impact:** Adding schema requires modifying MIGRATIONS array; no version control on schema changes other than code review.

**Fix approach:** Consider versioned migration files (e.g., `001-initial.sql`, `002-add-search.sql`) for better auditability; or add migration registration function.

---

## Recommendations

1. **High Priority:** Add concurrent write tests and either enforce single-writer discipline or implement optimistic locking.
2. **High Priority:** Set maximum sizes for body/content fields (1MB/task, 1MB/decision).
3. **Medium Priority:** Implement connection health checks and TTL in UI projectPool.
4. **Medium Priority:** Add path traversal security tests for static file serving.
5. **Medium Priority:** Improve error messages from git command failures.
6. **Low Priority:** Optimize FTS5 index maintenance for large event logs.
7. **Low Priority:** Add rate limiting to UI server.

---

*Concerns audit: 2026-07-21*
