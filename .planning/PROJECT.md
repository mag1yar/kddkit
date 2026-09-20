# KDD

## What This Is

KDD — continuity substrate для человека, работающего через последовательные сессии Claude Code и Codex. Общий task contract (задачи, criteria, comments, event trail) и долговечные решения переживают смену клиента, сессии, ветки и worktree. Модель достаёт контекст и обновляет прогресс через тонкий MCP. Сдавшая работу AI-сессия не может принять её сама без явного указания пользователя; приёмку выполняет другой актор. Agent mode существует как optional experimental/advanced capability, а не как центр продукта.

## Core Value

Контракт работы не теряется при смене сессии или модели: задачи остаются быстрыми и локальными в SQLite, решения — долговечными и reviewable в Git, а приёмка отделена от сдавшего работу актора.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Центральный SQLite-стор задач вне git (ключ = git-common-dir), общий для всех worktree проекта
- [ ] CLI-глаголы для человека: add / board / status / edit / move / comment / decide / recall / rebuild
- [ ] Решения/конвенции как md-файлы в `.planning/` (коммитятся, ревьюятся, edут с веткой); SQLite их индексирует (FTS5), git — канон
- [ ] Минимальный web-канбан: колонки, drag-n-drop, создание/правка задач (markdown-описание, приоритет)
- [ ] Тонкий MCP для Claude/Codex поверх того же ядра: get_task / list_tasks / list_tracks / recall / update_task
- [ ] Append-only таблица events (actor_type, actor_id, session_id) — аудит с первого дня
- [ ] Стейт-машина переходов статусов в коде (не в промптах), гейт по типу актора
- [ ] Skill-контракт, обучающий Claude/Codex протоколу доски (pull, не push)
- [ ] `kdd rebuild` — индекс пересобирается из md-файлов; база никогда не единственный носитель durable-знания

### Out of Scope

- Собственный multi-agent dispatcher/fleet как основной продукт — существующий experimental agent mode остаётся optional advanced capability и не диктует core model
- Telegram-уведомления — v1 (outbound), ответы из Telegram — v2; дизайн готов в research
- Эмбеддинги/вектор-поиск — FTS5 BM25 достаточен (бенчмарк ruflo: cosine-only = 0% релевантности); вектор только после доказанного провала FTS5
- Push-инъекция памяти в каждый ход — главный антипаттерн (боль RuFlo); только pull
- Multi-user auth, Jira/ADO-sync — локальный однопользовательский субстрат; в v2 максимум JSON-экспорт
- Test-run/readiness-скоринг — отдельный QA-плагин поверх субстрата, не ядро

## Context

- Автор — solo full-stack разработчик, работает в 2–3 git worktree параллельно (worktree = свой «спринт»), исполнители — последовательные сессии Claude Code и Codex.
- Боль: GSD-агенты пишут отсебятину; `.planning` в gitignore ломается на worktree (tracked-файлы не переносятся); коммитимая доска даёт merge-конфликты. Отсюда центральный стор вне git.
- Проведено исследование (июль 2026): 6 референсов (agent-kanban, gsd-core, ruflo, superpowers, ECC, hermes-agent) + 6 персон. Отчёты: `.planning/research/` (KDD-SYNTHESIS.md, HERMES.md). Ключевые заимствования: атомарный claim одним UPDATE, append-only events, decision-md с Outcome-колонкой, FTS5 вместо векторов, дедуп по content-hash, wake-gate для cron.
- hermes-agent независимо сошёлся с той же архитектурой (CAS-claim, events, центральный SQLite) — сильная валидация дизайна.

## Constraints

- **Tech stack**: Node + TypeScript, better-sqlite3, Hono для UI-сервера, без фреймворков — один рантайм на CLI/MCP/UI, ноль барьера установки
- **Хранение**: мутабельное состояние только в SQLite (вне репо); durable-знание только в git-md; не смешивать
- **Контекст-бюджет**: каждый вывод CLI капирован (status ≤2KB, hook ≤3 строк, recall top-k с капом) — цифры в спеку
- **Совместимость**: `.planning/` — структура, совместимая с GSD; KDD не ломает существующие GSD-проекты
- **Дистрибуция**: плагины Claude Code и Codex поверх общего MCP/core runtime

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Центральный SQLite вне git, ключ = git-common-dir | Один стор для всех worktree; нет merge-конфликтов и gitignore-дыр | — Pending |
| CLI-глаголы как основной интерфейс человека, MCP для Claude/Codex тонкий | Каждая MCP-схема — налог на контекст каждого хода (антипаттерн ruflo: 300+ тулов) | — Pending |
| Решения в `.planning/` md, коммитятся | Совместимость с GSD-привычками; ревью в PR; edут с веткой | — Pending |
| FTS5 BM25, без эмбеддингов | Бенчмарк ruflo: cosine-only 0% → BM25 70%; вектор = v2+ по доказанной нужде | — Pending |
| Web-UI в v0, но минимальный | Пользователь ведёт доску вручную с первого дня — это и есть режим «документирование» | — Pending |
| Node+TS, better-sqlite3, Hono | Один рантайм, нативная среда Claude Code плагинов | — Pending |
| Схема с actor_type/session_id/events с v0 | Continuity и аудит не требуют владеть исполнением; optional agent mode использует тот же субстрат | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-09-20 for cross-client continuity positioning*
