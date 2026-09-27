# Project Store Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Execution method: solo, primary session; no auxiliary agents or fresh reviewer under the declared Sol route.

**Goal:** Сохранить существующую доску при миграции и явно подключать другие checkout к тому же store, защищая общий legacy decisions index.

**Architecture:** Авторитетные identity/repo/binding records добавляются в существующую project SQLite; SQLite registry служит проверяемым locator. Core выполняет поиск, регистрацию и guards; CLI/MCP остаются адаптерами. Legacy decision sync разрешён только источнику основного проекта, backend читает общий индекс.

**Tech Stack:** Node ≥22, TypeScript strict ESM/NodeNext, better-sqlite3, существующий Vitest и pnpm; новых dependencies нет.

**Spec:** [project store foundation](../specs/2026-09-27-project-store-foundation-design.md), включая принятую поправку о legacy decisions.

## Global Constraints

- Ветка `task/143-kanban-orchestrator-contract`; существующие изменения 143 сохраняются.
- Не менять существующие MIGRATIONS и не перемещать DB.
- Новая availability выключена, default manual.
- `KDD_DB` сохраняет приоритет и прежний смысл явного override.
- В исходных checkout не появляются обязательные файлы, Git config или служебные refs.
- Remote URL никогда не используется для автоматического подключения.
- Новая модель памяти, execution tables и managed clone lifecycle остаются следующим задачам.
- Все проверки используют отдельный KDD_HOME/temp Git/SQLite; реальную доску не открывать новым бинарником.
- Commit локально, subject only, conventional, без номера карточки и trailers; никогда не push.
- Reference patterns изучены, код не копируется; названия внешних repos не добавлять в source/tests/comments.

## Review Focus

1. Backend с отсутствующим каталогом или тем же decision slug: shared rows не удаляются/заменяются; проверить в Task 4 и через CLI/MCP в Task 5.
2. Registry потерян после commit project DB: lookup восстанавливает binding, конфликтующая регистрация не захватывает его; Task 3.
3. Symlink, separate-git-dir и старый путь с неканоническим hash: прежняя DB остаётся доступна; Tasks 2–3.
4. Source недоступен, неизвестная schema или повреждённый registry: явная ошибка/сохранение индекса, без создания пустой доски; Tasks 2–4.
5. Открытый клиент во время rebind: existing contexts не переадресуются; операция требует остановленных клиентов/restart, а stale locator не принимается; Tasks 3 и 5.

## Files and interfaces

Production module `packages/core/src/project_store.ts` содержит project records, Git path identity, registry lookup и repo mutations. Он импортирует stdlib, better-sqlite3, errors и Actor через type import; не импортирует `db.ts`/`paths.ts`, чтобы они могли вызывать его без dependency cycle. Shared home передаётся аргументом, а не вычисляется повторно.

`schema.ts` содержит единый список MIGRATIONS; `db.ts` сохраняет его прежний public re-export. Исторические migrations перенесены byte-for-byte, без изменения SQL.

Public API экспортируется только через `packages/core/src/index.ts`:

```ts
type RepositoryAccess = 'context_only' | 'implementation';
type BindingKind = 'source' | 'managed';
interface ProjectRecord {
  project_id: string;
  primary_repo_id: string | null;
  legacy_decisions_dir: string | null;
  autonomy_enabled: boolean;
  default_execution_mode: 'manual' | 'orchestrated';
  created_at: number;
}
interface RepositoryRecord {
  repo_id: string; purpose: string; access: RepositoryAccess;
  remote: string | null; created_at: number;
}
interface RepositoryBinding {
  common_dir: string; repo_id: string; checkout_path: string;
  kind: BindingKind; created_at: number;
}
function projectOf(db: Database.Database): ProjectRecord;
function repositoriesOf(db: Database.Database): RepositoryRecord[];
function bindingsOf(db: Database.Database): RepositoryBinding[];
function canonicalCommonDir(cwd: string): string;
function initializeProjectStore(db: Database.Database, dbPath: string,
  home: string, projectPath?: string, checkout?: string,
  options?: { legacyUpgrade?: boolean; configuredDecisions?: string }): void;
function lookupProjectStore(commonDir: string, home: string):
  { dbPath: string; projectPath: string } | undefined;
function listProjectCheckouts(home: string): string[];
function addRepository(db: Database.Database, dbPath: string, home: string,
  input: { cwd: string; purpose: string; access: RepositoryAccess }, actor: Actor):
  { repository: RepositoryRecord; binding: RepositoryBinding };
function bindRepository(db: Database.Database, dbPath: string, home: string,
  input: { cwd: string; repoId: string; kind: BindingKind }, actor: Actor): RepositoryBinding;
function rebindRepository(db: Database.Database, dbPath: string, home: string,
  input: { fromCommonDir: string; cwd: string }, actor: Actor): RepositoryBinding;
function canSyncLegacyDecisions(db: Database.Database, decisionsDir: string): boolean;
function assertLegacyDecisionSource(db: Database.Database, decisionsDir: string): void;
```

`initializeProjectStore` — bootstrap/migration metadata, не пользовательский grant; повторный вызов не переопределяет primary source. Actor нужен явным repo mutations. Внутренние registry handles всегда закрываются в finally. `canSyncLegacyDecisions` не принимает env как разрешение источника.

### Task 1: Append-only migration и стабильная identity

**Files:** Modify `packages/core/src/db.ts`, `packages/core/src/index.ts`; Create `packages/core/src/project_store.ts`; Test `packages/core/test/db.test.ts`, `packages/core/test/project_store.test.ts`.

**Interfaces:** Реализовать Project/Repository/Binding types, `projectOf`, `repositoriesOf`, `bindingsOf`. Остальные функции добавляются в своих tasks, без пустых stub exports.

- [x] Написать regression для заполненной v12 DB: создать schema из `MIGRATIONS.slice(0, 12)`, установить user_version 12; добавить task, criterion с evidence, comment, event/detail provenance, track/link, attachment row, decision и FTS row. Снять отсортированные строки всех старых таблиц и bytes inventory files/knowledge/workspaces. Держать WAL с `wal_autocheckpoint=0`, не закрывая seed connection до открытия upgrade.

```ts
const before = legacyTables.map(name => raw.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all());
const db = openDb(path);
expect(legacyTables.map(name => db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all())).toEqual(before);
const project = projectOf(db);
expect(project.project_id).toMatch(/^[0-9a-f]{32}$/);
expect(project.autonomy_enabled).toBe(false);
expect(project.default_execution_mode).toBe('manual');
db.close();
const reopened = openDb(path);
expect(projectOf(reopened).project_id).toBe(project.project_id);
```

`legacyTables` — фиксированный список `tasks,criteria,comments,events,tracks,task_links,files,decisions,search_index,agent_events,errors,meta`; имена не берутся из внешнего ввода. Для WITHOUT rowid-подобных таблиц сортировать по объявленным ключам, а не предполагать их наличие. Не включать internal FTS tables или sqlite_sequence в общий SELECT; sequence проверить отдельно добавлением новой task после upgrade.

- [x] Запустить `pnpm --filter @kddkit/core exec vitest run test/db.test.ts test/project_store.test.ts`; получить ожидаемый red на отсутствующей новой identity.
- [x] Добавить migration v13 с project/repositories/repository_bindings, FK/CHECK/PK/index; создать singleton project_id через `lower(hex(randomblob(16)))`. Сохранить существующий backup/version guard. Bootstrap nullable primary fields заполняется Task 2; отсутствие source не создаёт фиктивный binding.
- [x] Проверить v12 backup readonly: version 12 и WAL task присутствуют; проверить новые FK/CHECK и reopen, unknown future schema rejection. Для двух одновременных open перечитывать user_version под migration write lock и не повторять уже применённую migration; неизвестную новую версию также отклонять внутри lock. Старые tests миграций criteria/decisions должны явно seed v10/v11, не использовать «последняя минус один» для проверки исторических migrations. Запустить целевые tests и `pnpm --filter @kddkit/core typecheck`.
- [x] Commit `feat(core): add persistent project store identity` с фактически изменёнными файлами этой task.

### Task 2: Bootstrap source и canonical lookup

**Files:** Modify `packages/core/src/project_store.ts`, `packages/core/src/paths.ts`, `packages/core/src/db.ts`; Test `packages/core/test/project_store.test.ts`, `packages/core/test/paths.test.ts`.

**Interfaces:** Реализовать `canonicalCommonDir`, `initializeProjectStore`, `lookupProjectStore`, `listProjectCheckouts`; сохранить return shape `resolveDbPath` и `listProjects`.

- [x] В новом core test использовать real temp Git repo и отдельный KDD_HOME. Создавать commit локальными `git -c user.name=Test -c user.email=test@example.invalid commit --allow-empty -m seed`, без изменения global Git config. Снимать/restoring env в afterEach; удалять temp fixtures и закрывать DB handles в finally.

```ts
const before = resolveDbPath(source);
const db = openDb(before.dbPath, before.projectPath);
expect(bindingsOf(db)).toHaveLength(1);
expect(projectOf(db).primary_repo_id).toBe(bindingsOf(db)[0].repo_id);
expect(resolveDbPath(symlinkToSource).dbPath).toBe(before.dbPath);
expect(listProjectCheckouts(home)).toContain(realpathSync(source));
```

- [x] Запустить целевые paths/store tests red. Добавить separate-git-dir, missing source, неизвестный independent clone и KDD_DB override cases. Для legacy noncanonical hash вручную разместить v12 DB под хэшем исходного Git пути; ожидать именно этот DB path после upgrade.
- [x] Реализовать Git common-dir realpath, locator read-only validation и miss recovery из store records/legacy meta. Registry schema version guard и transaction-based initialization; отсутствие registry восстанавливаемо, corrupt/unreadable/unknown schema не равно отсутствию. Только отсутствие совпадений разрешает legacy fallback/new DB; duplicate matches возвращают конфликт. Не мигрировать stores во время discovery.
- [x] В `openDb` после migrations и initial meta insert вызвать bootstrap: сначала использовать сохранённый source, не текущий alias. Из common-dir проверить источник через Git worktree list и сохранённый project_toplevel, включая separate-git-dir; не выводить checkout простым dirname('.git'). Для внешнего KDD_DB с негитовым projectPath identity сохраняется без binding; сохранить прежний unbound override сценарий и его decision tests. Source/decision authority появляется только из проверенного original Git source либо явно заданного unbound override источника, не из последующего backend вызова. Повторный open не меняет primary path/id. Проверить tests и typecheck.
- [x] Commit `feat(core): resolve project stores through canonical bindings`.

### Task 3: Явные repo/bind/rebind и recovery

**Files:** Modify `packages/core/src/project_store.ts`; Test `packages/core/test/project_store.test.ts`.

**Interfaces:** `addRepository`, `bindRepository`, `rebindRepository`; Actor из существующего `types.ts`, home/dbPath явно переданы.

- [x] Red tests: source → `git clone --no-hardlinks` → clone linked worktree; до bind store другой, после bind DB/repo/project ids совпадают. Добавить independent backend через addRepository с explicit purpose/access.

```ts
const primary = projectOf(db).primary_repo_id!;
bindRepository(db, dbPath, home, { cwd: clone, repoId: primary, kind: 'managed' }, actor);
expect(resolveDbPath(cloneWorktree).dbPath).toBe(dbPath);
expect(bindRepository(db, dbPath, home,
  { cwd: clone, repoId: primary, kind: 'managed' }, actor).repo_id).toBe(primary);
expect(() => bindRepository(otherDb, otherPath, home,
  { cwd: clone, repoId: otherRepoId, kind: 'managed' }, actor)).toThrow(/conflict/);
```

- [x] Реализовать validation пустых/недопустимых purpose/access/kind/ids и Git paths. Registry write lock → повторный ownership scan → project mutation+event transaction → registry commit. События `repository_added`, `repository_bound`, `repository_rebound` используют task_id NULL, переданный actor, прежние/новые ids/paths в detail. Идемпотентный повтор не добавляет событие. Existing alias-owned DB не скрывать; remote credentials не хранить (remote metadata в 144 оставить NULL).
- [x] Запустить два отдельных Node процесса с разными owners против одного alias; ровно один успешный bind. Crash-gap test воспроизводит реальное состояние: authoritative binding уже в DB, locator отсутствует; второй owner отвергается, lookup восстанавливает первый. Не добавлять production failure-injection API. Corrupt/mismatched locator и stale rebind возвращают явную ошибку.
- [x] Проверить перенос source/clone: rename temp path, rebind с old common-dir; ids/path DB не меняются. Если legacy source отсутствовал до первого upgrade и binding ещё нет, rebind допускает только fromCommonDir, совпадающий с сохранённым meta.project_path, и создаёт первый primary repo/binding явно. Add-repo не выбирает backend в качестве отсутствующего primary source; до восстановления primary возвращает source error. Audit старого и нового пути сохранён. Обновлять authority directory primary source только при его явной rebind, не при backend/managed binding. Снять source refs/status/config до/после — одинаковые. Запустить целевые tests/typecheck.
- [x] Commit `feat(core): add explicit repository binding operations`.

### Task 4: Защита legacy decisions в общем write-path

**Files:** Modify `packages/core/src/project_store.ts`, `packages/core/src/recall.ts`, `packages/core/src/decisions.ts`, при необходимости `packages/core/src/brief.ts`; Test `packages/core/test/project_store.test.ts`, `packages/core/test/recall.test.ts`, `packages/core/test/decisions.test.ts`, `packages/core/test/brief.test.ts`.

**Interfaces:** `canSyncLegacyDecisions`, `assertLegacyDecisionSource`; сигнатуры recall/syncIndex/rebuild/addDecision сохраняются.

- [x] Написать основной red regression с primary Git source и добавленным backend. Изначально sync primary и снять обе decision projections. Backend сначала без `.planning/decisions`, затем с конфликтующим slug/body/provenance. В обоих случаях сравнить полные строки, а не только count.

```ts
const decisionsBefore = db.prepare('SELECT * FROM decisions ORDER BY slug').all();
const ftsBefore = db.prepare("SELECT * FROM search_index WHERE kind='decision' ORDER BY ref").all();
for (const dir of [missingBackendDir, conflictingBackendDir]) {
  expect(recall(db, dir, 'primarytoken', { kind: 'decision' })).toHaveLength(1);
  expect(db.prepare('SELECT * FROM decisions ORDER BY slug').all()).toEqual(decisionsBefore);
  expect(db.prepare("SELECT * FROM search_index WHERE kind='decision' ORDER BY ref").all()).toEqual(ftsBefore);
}
commentTask(db, task.id, 'backendtasktoken', actor);
expect(recall(db, missingBackendDir, 'backendtasktoken', { kind: 'task' })[0].ref).toBe(String(task.id));
expect(() => rebuild(db, conflictingBackendDir)).toThrow(/source/);
expect(() => addDecision(db, conflictingBackendDir, { title: 'foreign', decision: 'foreign' })).toThrow(/source/);
```

- [x] Запустить целевые tests red; после rejected rebuild/addDecision ещё раз сравнить DB и backend filesystem. Прямой syncIndex из backend тоже должен сохранять обе decision projections.
- [x] Реализовать guard в core. Для valid primary source допустимы его own linked worktrees; realpath foreign symlink и managed common-dir не допустимы. Missing/недоступный source сохраняет decision projection. Из unbound KDD_DB legacy override сохраняется текущий сценарий с фиксированным explicit directory, без автоматического назначения нового источника после bind. Task events sync выполняется независимо от разрешения decision sync.

```ts
// В syncIndex decision filesystem block выполняется только при true;
// task event block остаётся в той же transaction и выполняется всегда.
const maySyncDecisions = canSyncLegacyDecisions(db, decisionsDir);
// В rebuild и addDecision guard выполняется ДО DELETE/файловых side effects.
assertLegacyDecisionSource(db, decisionsDir);
```

- [x] Проверить primary edits/deletes сохраняют прежний legacy sync; override на backend и symlink наружу не обходят guard. `syncedTaskDetail`, decisionDetail и export проходят через guarded syncIndex. `taskBrief` сейчас читает Markdown напрямую: для foreign input вернуть task-linked decisions из общей DB, не читать конфликтующие foreign файлы; сохранить caps/omitted. Запустить tests/typecheck.
- [x] Commit `fix(core): protect shared decisions from foreign repository sync`.

### Task 5: CLI и существующий MCP/UI доступ

**Files:** Modify `packages/cli/src/index.ts`, `packages/mcp/src/server.ts`; Test Create `packages/cli/test/project.test.ts`; Modify `packages/mcp/test/server.test.ts`, `packages/ui/test/server.test.ts` только если требуется существующему test layout; docs команды в `README.md`.

**Interfaces:** Core API Tasks 1–4; UI hash address и существующие MCP read/write tools неизменны. `knownProjects()` использует `listProjectCheckouts(kddHome())` и фильтрует доступные actual worktrees; не создаёт stores при перечислении.

- [x] Зафиксировать CLI grammar и red integration с built CLI, subprocess cwd и isolated home; передавать `KDD_DB` только как явное target существующего store у bind/add/rebind, очистить override у последующего clone/backend recall.

```text
kdd project show --json
kdd project add-repo <checkout> --purpose <text> --access context_only|implementation --json
kdd project bind <checkout> --repo <repo_id> --kind source|managed --json
kdd project rebind <old-common-dir> <checkout> --json
```

`show` возвращает `{project,repositories,bindings}`, add-repo `{repository,binding}`, bind/rebind binding. Store выбран из cwd либо явным KDD_DB; неизвестный target файл запрещён для mutations, не создаётся implicit DB. Нет force/remote matching/auto-start.

- [x] Тонкие CLI команды вызывают core с getActor, kddHome и тем же открытым db/dbPath; поля validate core. JSON ошибки через существующий run/fail. Добавить краткое описание explicit binding/rebind/source index guard в README.
- [x] На real MCP transport `lazyCtx` проверить get_task/recall с `project: backend` и `project: cloneWorktree`: DB shared, пустой и конфликтующий backend decisions не меняют primary rows. MCP list_projects включает clone/worktree; существующий primary path остаётся. Добавить CLI recall аналогичные cases. Для query/get_task без auto-sync side effect не вводить другую машину состояния.
- [x] UI projectPool уже адресует старый dirname hash: проверить `/api/projects`, чтение и mutation задачи с прежним id после bind, один project listing. Менять server source только при наблюдаемой несовместимости; не добавлять UI формы. Rebind выполняется после закрытия lazyCtx/серверов; новый процесс видит новый путь, старый stale alias отвергается. Запустить `pnpm --filter @kddkit/core build`, затем build/typecheck CLI/MCP/UI и соответствующие tests.
- [x] Commit `feat(cli): expose project repository bindings` с actual adapter/doc/test diff.

### Task 6: Сквозное наблюдение и сдача

**Files:** Create `.planning/research/orchestration/project-store-check.mjs`; update task 144 comment/criteria через KDD, без production расширений.

**Interfaces:** Только built core/CLI публичные exports Tasks 1–5. Script использует assert, tempdirs и subprocesses, не новый framework.

- [x] Script создаёт свой KDD_HOME/source/independent clone/linked worktree/backend; snapshots source status/refs/config и inventory вне DB. Seed old v12 через первые 12 migrations, затем открыть новой сборкой. Проверить row preservation/WAL backup/identity, bind и task mutation из cloneWorktree, два backend recall с пустым/конфликтующим slug. Все tempdirs удаляются и DB закрываются в finally, вывод только чисел/check names без реальных пользовательских путей.
- [x] Выполнить полный необходимый verification после последнего изменения:

```sh
pnpm build
pnpm typecheck
pnpm test
node .planning/research/orchestration/project-store-check.mjs
git diff --check
```

- [x] Self-review actual diff: scope, references names отсутствуют в коде/tests, no deps/managed lifecycle/new memory/runtime tables, registry failure не silent fallback, decision guard защищает прямой core caller. Проверить все spec scenarios, включая concurrent binding и missing registry; не объявлять непроверенное готовым.
- [x] Записать measured outputs/counts/commands и commits в 144; check 392 только после preservation evidence, 393 после shared clone/worktree evidence; `review` только оба checked. Продуктовые критерии до исполнения остаются unchecked. Не принимать собственный результат без слова пользователя.
- [x] Commit runnable check `test: verify project store migration and shared repository access`; дальнейший squash — по запросу пользователя, без push.

## Execution handoff

План требует review пользователя перед исполнением. Выбранный Sol route остаётся solo: primary реализует, проверяет и self-review; подзадачи выполняются последовательно. Требование planning skill о свежем reviewer не добавляет reviewer вопреки явно выбранному Sol solo. При новом риске route меняется только отдельной объявленной эскалацией.


## Execution result — 2026-09-27

Все 6 tasks выполнены solo на заданной ветке; продуктовая приёмка остаётся за пользователем.

- `pnpm build`: 4/4 tasks; `pnpm typecheck`: 6/6; `pnpm test`: 892/892 tests (core 399, CLI 213, MCP 70, UI 210).
- `pnpm test:codex-plugin`: fresh install SQLite, MCP initialize, 6 tools и hooks прошли.
- `node .planning/research/orchestration/project-store-check.mjs`: 5/5 последовательных запусков, по 8/8 observations. Сравнены все 12 legacy таблиц и WAL backup, сохранены attachments/knowledge/workspace; clone/worktree writes видны source; два backend recall сохраняют полные decision/FTS projections; registry восстановлен; source Git state не изменён; concurrent WAL upgrades дают один project_id.
- Критерии 392/393 проверены с evidence; задача сдаётся в review. Реальная доска не мигрировалась новым бинарником.

Уточнения по наблюдаемым случаям: verified checkout добавлен для separate-git-dir; внешние KDD_DB stores имеют атомарный location manifest в KDD_HOME для восстановления registry; alias не перенаправляет legacy project_toplevel. Guard проверяет также individual decision-file symlinks и symlink до bootstrap; второй source одного repo требует rebind. MCP test зависит от CLI build, subprocess integration имеет локальный 30s timeout. Concurrent upgrade проверяется на фактическом legacy WAL формате; одновременный перевод сторонних DELETE-mode databases в WAL не заявляется. Новая модель памяти, runtime tables и clone lifecycle не добавлены.


## Review corrections — 2026-09-27

По запросу пользователя «Исправь» закрыты четыре findings review `c1bb0c3...4e2d7b1`:

- Прежний configured decisions directory сохраняется по путям legacy index; пустой legacy index принимает конфигурацию только от проверенного source caller. Внешний каталог остаётся единственным source, без удаления старых decision/FTS rows пустым default-каталогом. Backend первым может запустить upgrade, но не назначить собственный decisions directory.
- Default directory всегда проверяет Git ownership. Nested backend и симлинк до/после upgrade не получают authority через совпадение пути; `/var`/`/private/var` aliases проверяются по checkout anchor, без следования default symlink.
- Saved legacy KDD_DB checkout metadata нормализуется при upgrade; свежий arbitrary override cwd не регистрируется source. Locator recovery также распознаёт saved legacy checkout.
- Supported schema maximum берётся из MIGRATIONS.length в schema.ts. Append-only SQL всех 13 migrations сохранён без edits; циклических imports нет.

Новых cases: 8; исходные пять regression failures и дополнительный legacy-symlink failure прошли RED→GREEN. Полный результат после последнего code change: core 407, CLI 213, MCP 70, UI 210 — **900/900 tests**; build/typecheck и Codex plugin check успешны. Built-runtime воспроизведение четырёх review scenarios — 4/4 pass; project-store-check.mjs — 5/5 запусков по 8/8 observations. Diff checks успешны. Исправления локальны, задача возвращается в review без собственной приёмки; реальная task DB не мигрировалась новым бинарником. Memory/runtime tables по-прежнему отложены.

## Orchestrator review correction — 2026-09-27

Воспроизведён P2 на fa97a22: upgrade внешней v12 базы при недоступном source пропускал recovery catalog; после rebind и потери registry lookup выбирал новую пустую доску. `rebindRepository` теперь вызывает существующий `catalogStore` после проверки конфликтов, до изменения binding. Регрессионный тест для hashed/external stores проверяет upgrade → rebind → удаление registry → прежние DB/project_id/task; внешний вариант прошёл RED→GREEN.

Проверено: **901/901 tests** (core 408, CLI 213, MCP 70, UI 210), build 4/4, typecheck 6/6, fresh Codex plugin check, 8/8 сквозных observations, diff checks. Source и generated runtime синхронизированы. Задача остаётся в review; реальная доска не мигрировалась новым бинарником.
