# Project Research Summary

Research was done before project init via multi-agent analysis of 6 reference systems (agent-kanban, gsd-core, ruflo, superpowers, ECC, hermes-agent) and 6 developer personas. Full reports: `KDD-SYNTHESIS.md` (features/antipatterns/personas/phases), `HERMES.md` (Telegram/memory/cron mechanics), `ORIGINAL-PLAN.md` (исходный план). This file distills what the roadmap must honor.

## Key Findings

**Stack:** Node + TypeScript, better-sqlite3 (sync, WAL), Hono for the UI server, no frameworks. One runtime for CLI + MCP + UI. Decided — do not re-research. — superseded 2026-10-11 by .planning/decisions/2026-10-11-node-sqlite-instead-of-better-sqlite3.md

**Architecture (settled):**
- One central SQLite per project, outside git, key = `git rev-parse --path-format=absolute --git-common-dir` — same DB for all worktrees. ~4 tables: `tasks`, `events` (append-only: actor_type, actor_id, action, session_id), `decisions_index` (FTS5 + content-hash UNIQUE), `errors`.
- Durable knowledge (decisions/conventions) = markdown in `.planning/`, committed, git is canon; SQLite only indexes it. `kdd rebuild` regenerates the index from files.
- State machine for status transitions as a pure function in the write path, gated by actor_type. Short sequence IDs (#42).
- CLI verbs are the primary Claude surface (~8: add, board, status, update/move, comment, decide, recall, rebuild); thin MCP wraps the same core for the UI server. No context-tax tool catalog (ruflo antipattern: 300+ MCP tools).
- Search = FTS5 BM25 only (ruflo benchmark: cosine-only 0% relevance, BM25 70%). No embeddings until FTS5 provably fails.

**Table stakes (v0):** manual web kanban (columns, drag-n-drop, create/edit task with markdown body + priority), Claude read/edit via CLI, decisions as md with Rationale/Alternatives/Supersedes/Outcome, recall with capped top-k, status digest ≤2KB, one ≤3-line SessionStart hook pointer, events audit from day one.

**Anti-features (never):** push-injection of memory per turn; workflow engine/orchestrator agents; markdown as mutable DB; daemons in core; multi-user auth; Jira/ADO sync; test-run/readiness scoring in core.

## Implications for Roadmap

1. **v0 = "documentation mode" end to end:** central SQLite + CLI verbs + decisions md + minimal web kanban + skill contract. No autonomous agents, no claim, no cron, no Telegram. Shippable in days.
2. **Schema future-proofing is v0 scope, mechanics are not:** actor_type/actor_id/session_id columns, events table, state machine — so v1 agents bolt on without migrations.
3. **Later phases (do not pull into v0):** v0.5 = staleness-release, deps DAG, worktree binding, acceptance_criteria/non_goals fields, MMR+recency, handoff rows. v1 = claim/lease, per-column actor gates as data, waiting_on_human + Q&A fields, Telegram outbound (notify_target column + cursor table over events + curl sendMessage, flushed on lifecycle points — no daemon), `kdd wait`/`kdd probe` wake-gate (deterministic script, prints {"wakeAgent":bool}). v2 = optional answer-daemon (long-poll getUpdates, allowlist chat_id, persistent update_id offset), episodic memory, git snapshot of board.
4. **Token budgets are contract:** every CLI output capped (status ≤2KB, recall top-k cap, hook ≤3 lines); dedup via content-hash where duplicate write returns success ("already recorded").
5. **Exit guarantee:** md dir is self-sufficient; DB is rebuildable; no repo litter (no lockfiles/sidecars in worktree).

## Sources

- `.planning/research/KDD-SYNTHESIS.md` — 35 ranked features, 15 antipatterns, 6 persona voices, resolved conflicts, phase plan
- `.planning/research/HERMES.md` — Telegram gateway mechanics, memory discipline, wake-gate cron pattern (file-level evidence)
- `.planning/research/ORIGINAL-PLAN.md` — исходный план и принципы (pull-not-push, substrate-not-orchestrator)
- Reference repos: `C:/My/Projects/Claude plugins/third/{agent-kanban,gsd-core,ruflo,superpowers,ECC,hermes-agent}`
