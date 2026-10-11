<!-- GSD:project-start source:PROJECT.md -->

## Project

**KDD**

KDD — плагин-субстрат памяти и документации для Claude Code: kanban-доска задач и бэклога, решения/конвенции проекта и заметки, которые переживают сессии, ветки и worktree. Пользователь ведёт доску вручную через минимальный web-UI, Claude читает и редактирует её через CLI + тонкий MCP. Это слой состояния под любым исполнителем (Superpowers, GSD, голый Claude Code) — не воркфлоу-движок и не оркестратор.

**Core Value:** Ничего не забывается и не нарушается: задачи, решения и контекст проекта хранятся вне окна контекста, достаются по запросу (pull) и одинаково видны из любого worktree.

### Constraints

- **Tech stack**: Node + TypeScript, node:sqlite (Node ≥22.16), Hono для UI-сервера, без фреймворков — один рантайм на CLI/MCP/UI, ноль барьера установки
- **Хранение**: мутабельное состояние только в SQLite (вне репо); durable-знание только в git-md; не смешивать
- **Контекст-бюджет**: каждый вывод CLI капирован (status ≤2KB, hook ≤3 строк, recall top-k с капом) — цифры в спеку
- **Совместимость**: `.planning/` — структура, совместимая с GSD; KDD не ломает существующие GSD-проекты
- **Дистрибуция**: плагин Claude Code (skills + MCP + CLI через npx)

<!-- GSD:project-end -->

<!-- GSD:stack-start source:STACK.md -->

## Technology Stack

Technology stack not yet documented. Will populate after codebase mapping or first phase.
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
