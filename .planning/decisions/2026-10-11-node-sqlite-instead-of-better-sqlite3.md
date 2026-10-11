---
created: 2026-10-11
status: active
superseded_by:
---
# node:sqlite instead of better-sqlite3

## Decision
Хранилище открывается встроенным `node:sqlite` (`DatabaseSync`), native-зависимостей у kddkit нет. Минимальный Node — 22.16. Форма вызовов better-sqlite3 сохранена тонким классом `Db` в `packages/core/src/db.ts`: `db.transaction(fn)()` / `.immediate()` (вложенные — SAVEPOINT по `isTransaction`), `db.pragma()`, `db.name`, `db.memory`, busy_timeout 5000 по умолчанию. ExperimentalWarning про SQLite на Node 22 глушится до загрузки модуля; остальные warning'и не трогаются.
Простой вызов `db.transaction(fn)()` открывает `BEGIN IMMEDIATE` (`.immediate()` — синоним), транзакции, которые только читают, помечаются `.deferred()` (`BEGIN`).

## Rationale
Один чекаут запускают два Node (24 у kdd и MCP, 22 у части инструментов), а бинарник `better_sqlite3.node` у всех один: выигрывал тот, кто пересобрал последним, остальные падали с `NODE_MODULE_VERSION`. Уже запущенные процессы держали старый модуль, и падения выглядели случайными; `pnpm rebuild` без `allowBuilds` молча ничего не делал. Это прямо противоречило ограничению «ноль барьера установки»: плагинам приходилось докачивать и чинить native-модуль на SessionStart (`smart-install.mjs`). У `node:sqlite` есть FTS5, WAL, `backup`, `isTransaction` — всё, на чём стоит kdd.

## Alternatives
- **Оставить better-sqlite3 и пинить процессы на `process.execPath`.** Лечит симптом у воркеров, не у человека с nvm/fnm и не у плагина.
- **Свободные функции `transaction(db, fn)` вместо класса.** Честнее, но ~120 правок без изменения поведения и переписанная конвенция «каждая мутация в `db.transaction(...)()`».
- **sql.js / WASM.** Нет общего файла с WAL между процессами — ломает модель «одна база на все worktree».

## Outcome
Ловушки перехода, найденные по дороге: `{readonly:true}` молча игнорируется (нужно `readOnly`), busy_timeout по умолчанию 0, лишний именованный ключ бросает «Unknown named parameter» — так и оставлено, это защита от опечатки в ключе (вызов с необязательным фильтром передаёт объект параметров, только когда фильтр задан), отсутствующий — молча NULL, `undefined` в параметре бросает `ERR_INVALID_ARG_TYPE` (better-sqlite3 писал NULL) — передавать `?? null`, недостающий позиционный параметр — молча NULL (better-sqlite3 бросал), повторный `close()` бросает, `db.name`/`db.memory` в node:sqlite нет.
