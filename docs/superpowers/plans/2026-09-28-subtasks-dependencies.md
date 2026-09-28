# Подзадачи, зависимости и владение — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Реализовать core-модель одного уровня подзадач, типизированных зависимостей от проверяемых результатов и атомарных reservations/handoff без запуска агентов.

**Architecture:** Append migration v15 сохраняет обычные карточки и добавляет шесть таблиц исполнения. Existing opaque controller handle, SQLite immediate transactions, task creation, repo bindings и audit переиспользуются. Core заново проверяет реальные requirements/artifacts и trusted observations при чтении и reservation; незавершённая остановка сохраняет ownership.

**Tech Stack:** Existing Node.js ≥22, TypeScript/ESM, better-sqlite3, Vitest и Node stdlib; новых dependencies нет. Реальные Git/SQLite/process fixtures на macOS; Codex/macOS regression остаётся проверкой #145.

**Spec:** [Утверждённая спецификация #146](../specs/2026-09-28-subtasks-dependencies-design.md), первоначальный утверждённый коммит `66e2597`. Исполнитель читает оба документа.

## Global Constraints

- Route **solo**: исполнение тем же primary через `superpowers:executing-plans`, без auxiliary implementer/reviewer. Текущая конфигурация разрешена владельцем; ветка `task/143-kanban-orchestrator-contract` сохраняется.
- Пользователь подтвердил один уровень: основная задача → несколько подзадач. Вложенные подзадачи не нужны.
- `parent_id` означает принадлежность, зависимость означает требование к результату, происхождение от run хранится отдельно.
- Допустима зависимость от другой основной задачи того же project store.
- Append migration v15; существующие 14 migrations неизменны.
- Старые записи получают `parent_id = NULL`, `execution_mode = manual`; миграция ничего не запускает и не создаёт managed markers.
- `task_links` сохраняются как legacy-навигация и не импортируются автоматически, независимо от их kind.
- Для разных `repo_id` code edge отклоняется при записи, до побочных эффектов.
- После terminal-state повторная работа создаёт новый work item, а не превращает историю в цикл.
- Отсутствующий verifier или обязательное наблюдение означает неудовлетворённую зависимость. Worker JSON, `verified=true` или caller-provided `ready=true` не принимаются за доказательство.
- Revoke/expiry authority, heartbeat timeout, mode change, cancel intent, `completed` или business-status не доказывают остановку и не освобождают слот. В #146 нет автоматического TTL reclaim.
- Authority generation #145 и ownership fence не смешиваются. Existing low-level grants с внешними ids не превращаются в synthetic work items.
- Ready и reservation не являются Start. Назначение агентов #149, snapshots #148, runtime #150, workspace #151, scheduler #152, workflow #153, questions #155, Git integration #156, checks #157, acceptance #158, owner transports #159, UI #161 и память #147 сохраняют свой scope.
- Настоящая доска разработки остаётся v13: bookkeeping — совместимый установленный MCP/изолированный legacy CLI, migration — только temp copies/stores. Не открывать `/Users/magiyar/.kdd/94a99e3bba1c50dd/kdd.db` development core.
- Локальные коммиты после проверок, без push. Критерии 396/397 отмечать только после реализации и D01–D12; done — по слову владельца.

## Review Focus

1. Чужой project с совпадающим numeric task id или JSON-копия handle: отказ без частичных children/events. Проверка в task 1.
2. Изменение title/body/criteria родителя после подготовки ребёнка: output становится stale; checkbox/comment/order не меняют fingerprint. Проверка в tasks 2/3.
3. Два отдельных процесса одновременно записывают противоположные edges: проходит только один; новая current revision не активирует цикл. Проверка в tasks 2/6.
4. Artifact исчез, bytes изменены, evidence ref неизвестен или probe относится к другому consumer scope: зависимость закрыта при следующем чтении и reservation. Проверка в tasks 3/4.
5. Launch intent без runtime id, живой дочерний writer или устаревший stop observation: прежний owner/intent остаются, credential rotation не освобождает слот. Проверка в tasks 4/6.

---

## Файлы и ответственность

| Файл | Ответственность |
| --- | --- |
| `packages/core/src/schema.ts` | Только migration v15: task fields, constraints и шесть таблиц модели |
| `packages/core/src/controller.ts` (новый, internal) | Перенос существующего WeakMap/controller handle; authentic DB access для core-модулей, без public DB accessor |
| `packages/core/src/authority.ts` | Сохранённые API #145; known schema, handoff/ownership guard для modeled grants |
| `packages/core/src/execution.ts` (новый) | Подзадачи, fingerprints, immutable definitions/revisions, typed edges и cycle check |
| `packages/core/src/execution_results.ts` (новый) | Result envelopes, invalidation, common verifier и dependency projection/pinning |
| `packages/core/src/execution_ownership.ts` (новый) | Reservation CAS, launch-intent metadata и двухфазный handoff; без spawn/kill runtime |
| `packages/core/src/ops.ts`, `types.ts`, `claim.ts`, `queries.ts`, `brief.ts`, `index.ts` | Project default на создание, parent/mode reads, legacy exclusion, brief budget и точные публичные exports |
| `packages/core/test/execution_fixture.ts` (новый, test-only) | Один temp Git/store fixture и cleanup; никакой работы с настоящей доской |
| `packages/core/test/execution.test.ts` (новый), `db.test.ts`, `authority.test.ts` | Schema, one-level parent, provenance, revisions, graph и authentic handle |
| `packages/core/test/execution_results.test.ts` (новый) | Реальные artifact bytes, input changes, receipts/probes и pinning |
| `packages/core/test/execution_ownership.test.ts` (новый) | Fences, marker, stop failure и process-tree fixture |
| `packages/core/test/execution_races.test.ts`, `fixtures/execution_race.mjs`, `fixtures/execution_race.d.mts`, `fixtures/execution_tree.mjs` (новые) | Отдельные процессы, IPC barrier и реальный fixture writer tree; .d.mts описывает shared JS fixture для test typecheck |
| `packages/core/test/claim.test.ts`, `brief.test.ts`, `queries.test.ts`, `managed_mutations.test.ts` | Legacy compatibility и отсутствие обходов |
| `packages/cli/test/contracts.test.ts`, `packages/mcp/test/server.test.ts`, `run_server.test.ts`, `packages/ui/test/server.test.ts` | Реальные существующие transport calls; новых owner tools нет |
| `packages/ui/src/web/api.ts`, `packages/ui/test/app.test.tsx`, `board.test.tsx`, `filter-bar.test.tsx`, `filters.test.ts` | Только parent/mode в дублированном browser type и literal fixtures; renderer не меняется |
| `.planning/research/orchestration/dependencies-check.mjs`, `dependencies-evidence.json` (новые) | D01–D12 против свежего compiled core, counts и сохранённые ids/receipts |
| Tracked core/CLI/MCP `dist`, UI `dist`, Codex plugin `runtime/core.js`, `runtime/mcp.js` | Штатная генерация `pnpm build`; никаких ручных edits |

Три новых публичных execution-модуля разделены по модели, verification и ownership. Внутренний `controllerDb` не экспортировать из barrel; клиентам/worker не давать raw DB через handle. Existing `addTask`, `appendEvent`, `projectOf`, `repositoriesOf`, `bindingsOf`, `protectTask`, `revokeRunAuthority` использовать по месту, без нового policy engine или универсального command framework.

## Общие условия исполнения

Команды запускать из корня репозитория. Текущий совместимый Node — `process.execPath` (baseline Node 24.15.0, SQLite ABI 137); child fixtures используют его же. Не переключать Node через login shell в package directory и не rebuild addon ради ошибочно выбранного ABI.

Каждый task выполняется небольшими RED → implementation → GREEN вертикальными шагами ниже. После source edits — package typecheck и `pnpm build` перед commit; это сохраняет generated consumers синхронными. Локальная подпись коммита без body/trailer и без номера карточки. Не менять preexisting untracked `references/`.

Новый test-only `fixture()` определён в task 1; другие helpers определены в owning task. Обозначения `core` в тестах — `import * as core from '../src/index.js'`; `expect`, `it`, `afterEach` — Vitest, fs/crypto/child_process — явные Node imports. Ни один тест не получает права owner через `Actor`.

### Task 1: Сохранная migration v15 и подзадачи одного уровня

**Files:** create `packages/core/src/controller.ts`, `packages/core/src/execution.ts`, `packages/core/test/execution_fixture.ts`, `packages/core/test/execution.test.ts`; modify `schema.ts`, `authority.ts`, `ops.ts`, `types.ts`, `index.ts`, `test/db.test.ts`, `test/authority.test.ts`.

**Interfaces:** consumes existing `addTask(db, input, actor): Task`, `appendEvent(...)`, `mustGetTask(db,id): Task`, `projectOf(db): ProjectRecord`, `protectTask(handle,taskId): void`. Produces:

```ts
// execution.ts; Task gains parent_id and execution_mode in types.ts.
export type ExecutionMode = 'manual' | 'orchestrated';
export interface TaskRef { projectId: string; taskId: number }
export interface AuthorityBinding {
  authorityId: string; runId: string; workItemId: string; generation: number;
}
export type CreationSource =
  | { kind: 'manual'; sourceTask: TaskRef; instructionRef: string }
  | { kind: 'run'; sourceTask: TaskRef; authority: AuthorityBinding; proposalEventId: number };
export interface SubtaskDraft {
  key: string; title: string; body?: string; criteria: readonly string[];
  kind?: Kind; priority?: Priority; area?: string; trackId?: number;
  executionMode?: ExecutionMode;
}
export interface CreateSubtasksInput {
  parent: TaskRef; expectedParentHash: string; source: CreationSource;
  children: readonly SubtaskDraft[];
}
export function taskContractHash(handle: ControllerHandle, ref: TaskRef): string;
export function createSubtasks(handle: ControllerHandle, input: CreateSubtasksInput): Record<string, Task>;
export function listSubtasks(handle: ControllerHandle, parent: TaskRef): Task[];

// controller.ts: internal exports only; authority.ts re-exports the existing public pair.
export interface ControllerHandle { readonly kind: 'controller' }
export function openController(db: Database.Database): ControllerHandle;
export function controllerDb(handle: ControllerHandle): Database.Database;
```

`Kind`/`Priority` come from existing `state.ts`, `Task` from `types.ts`, `ControllerHandle` from `controller.ts`. No task-creation flags added to CLI/MCP/UI schemas. `CreationSource` records provenance and does not authorize worker requests.

- [x] **1. Создать test fixture и failing one-level test.** `execution_fixture.ts` contains this helper (imports Node fs/path/os/child_process, better-sqlite3 type and source core); tests call `afterEach(cleanupFixtures)`:

```ts
const cleanups: (() => void)[] = [];
export function cleanupFixtures(): void {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
}
export function fixture() {
  const saved = { ...process.env };
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kdd-execution-')));
  const home = join(root, 'home'), repo = join(root, 'source');
  mkdirSync(repo); process.env.KDD_HOME = home;
  delete process.env.KDD_DB; delete process.env.KDD_DECISIONS_DIR;
  const git = (...args: string[]) => execFileSync('git', args,
    { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '--allow-empty', '-m', 'seed');
  const dbPath = join(home, 'external-store.db');
  const db = core.openDb(dbPath, core.canonicalCommonDir(repo), repo);
  const handle = core.openController(db), projectId = core.projectOf(db).project_id;
  const ref = (taskId: number): core.TaskRef => ({ projectId, taskId });
  const task = (title: string) => core.addTask(db,
    { title, body: 'contract', criteria: ['required outcome'] }, { type: 'ai', id: 'fixture' });
  cleanups.push(() => {
    if (db.open) db.close(); process.env = saved;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, home, repo, dbPath, db, handle, projectId, ref, task, git };
}
```

```ts
it('creates siblings, inherits mode once and rejects a child parent atomically', () => {
  const f = fixture(), parent = f.task('main');
  f.db.prepare("UPDATE tasks SET execution_mode='orchestrated' WHERE id=?").run(parent.id);
  const input: core.CreateSubtasksInput = {
    parent: f.ref(parent.id), expectedParentHash: core.taskContractHash(f.handle, f.ref(parent.id)),
    source: { kind: 'manual', sourceTask: f.ref(parent.id), instructionRef: 'owner:split' },
    children: [{ key: 'a', title: 'API', criteria: ['API artifact'] },
      { key: 'b', title: 'UI', criteria: ['UI code'], executionMode: 'manual' }],
  };
  const children = core.createSubtasks(f.handle, input);
  expect([children.a.parent_id, children.b.parent_id]).toEqual([parent.id, parent.id]);
  expect([children.a.execution_mode, children.b.execution_mode]).toEqual(['orchestrated', 'manual']);
  const counts = f.db.prepare('SELECT (SELECT count(*) FROM tasks) t,(SELECT count(*) FROM events) e').get();
  expect(() => core.createSubtasks(f.handle, { ...input, parent: f.ref(children.a.id),
    expectedParentHash: core.taskContractHash(f.handle, f.ref(children.a.id)) })).toThrow(/parent/);
  expect(f.db.prepare('SELECT (SELECT count(*) FROM tasks) t,(SELECT count(*) FROM events) e').get()).toEqual(counts);
});
```

- [x] **2. RED.** Run `pnpm --dir packages/core exec vitest run test/execution.test.ts`. Expected FAIL: missing new API/fields, not SQLite ABI/config failure.
- [x] **3. Append DDL v15.** Use six tables below, no role/attempt/workspace/check schemas. Implement the integer and depth constraints first. `FOREIGN KEY (id,current_revision)` is deferred so item/revision can be inserted together.

```sql
ALTER TABLE tasks ADD COLUMN parent_id INTEGER REFERENCES tasks(id);
ALTER TABLE tasks ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'manual'
  CHECK(execution_mode IN ('manual','orchestrated'));
CREATE INDEX idx_tasks_parent ON tasks(parent_id);
CREATE TRIGGER task_parent_insert BEFORE INSERT ON tasks WHEN NEW.parent_id IS NOT NULL BEGIN
  SELECT CASE WHEN NEW.parent_id=NEW.id OR NOT EXISTS
    (SELECT 1 FROM tasks WHERE id=NEW.parent_id AND parent_id IS NULL)
    THEN RAISE(ABORT,'invalid root parent') END;
END;
CREATE TRIGGER task_parent_update BEFORE UPDATE OF parent_id ON tasks
WHEN NEW.parent_id IS NOT OLD.parent_id BEGIN
  SELECT CASE WHEN NEW.parent_id IS NOT NULL AND
    (NEW.parent_id=NEW.id OR NOT EXISTS
      (SELECT 1 FROM tasks WHERE id=NEW.parent_id AND parent_id IS NULL)
      OR EXISTS (SELECT 1 FROM tasks WHERE parent_id=OLD.id))
    THEN RAISE(ABORT,'invalid root parent') END;
END;
CREATE TABLE work_items (
  id TEXT PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id),
  current_revision INTEGER NOT NULL CHECK(typeof(current_revision)='integer' AND current_revision BETWEEN 1 AND 9007199254740991),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN
    ('pending','ready','running','waiting_input','retry_wait','completed','failed','cancelled')),
  fence INTEGER NOT NULL DEFAULT 0 CHECK(typeof(fence)='integer' AND fence BETWEEN 0 AND 9007199254740991),
  created_at INTEGER NOT NULL,
  FOREIGN KEY(id,current_revision) REFERENCES work_item_revisions(work_item_id,revision) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX idx_work_items_task ON work_items(task_id);
CREATE TABLE work_item_revisions (
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
  definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
  inputs_json TEXT NOT NULL CHECK(json_valid(inputs_json)),
  inputs_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(work_item_id,revision)
);
CREATE TABLE work_item_dependencies (
  consumer_id TEXT NOT NULL, consumer_revision INTEGER NOT NULL,
  edge_key TEXT NOT NULL, producer_id TEXT NOT NULL, producer_revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('contract','code','merged','readiness')),
  output_key TEXT NOT NULL, binding_json TEXT NOT NULL CHECK(json_valid(binding_json)),
  pinned_result_id TEXT REFERENCES work_item_results(id),
  PRIMARY KEY(consumer_id,consumer_revision,edge_key), CHECK(consumer_id<>producer_id),
  FOREIGN KEY(consumer_id,consumer_revision) REFERENCES work_item_revisions(work_item_id,revision),
  FOREIGN KEY(producer_id,producer_revision) REFERENCES work_item_revisions(work_item_id,revision)
);
CREATE INDEX idx_work_item_dependencies_producer ON work_item_dependencies(producer_id);
CREATE TABLE work_item_results (
  id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, command_hash TEXT NOT NULL,
  producer_id TEXT NOT NULL, producer_revision INTEGER NOT NULL, output_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('contract','code','merged','readiness')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  source_json TEXT NOT NULL CHECK(json_valid(source_json)), created_at INTEGER NOT NULL,
  invalidated_at INTEGER, invalidation_reason TEXT,
  successor_id TEXT REFERENCES work_item_results(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(producer_id,producer_revision) REFERENCES work_item_revisions(work_item_id,revision)
);
CREATE UNIQUE INDEX idx_work_item_results_current
  ON work_item_results(producer_id,producer_revision,output_key) WHERE invalidated_at IS NULL;
CREATE TABLE work_item_owners (
  work_item_id TEXT NOT NULL, fence INTEGER NOT NULL
    CHECK(typeof(fence)='integer' AND fence BETWEEN 1 AND 9007199254740991),
  revision INTEGER NOT NULL, owner_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('manual','orchestrated')),
  write_access INTEGER NOT NULL CHECK(write_access IN (0,1)),
  inputs_json TEXT NOT NULL CHECK(json_valid(inputs_json)),
  launch_id TEXT, launch_json TEXT CHECK(launch_json IS NULL OR json_valid(launch_json)),
  created_at INTEGER NOT NULL, released_at INTEGER, release_handoff_id TEXT REFERENCES execution_handoffs(id),
  PRIMARY KEY(work_item_id,fence),
  FOREIGN KEY(work_item_id,revision) REFERENCES work_item_revisions(work_item_id,revision),
  CHECK((launch_id IS NULL)=(launch_json IS NULL)),
  CHECK((released_at IS NULL)=(release_handoff_id IS NULL))
);
CREATE UNIQUE INDEX idx_work_item_owners_live ON work_item_owners(work_item_id) WHERE released_at IS NULL;
CREATE TABLE execution_handoffs (
  id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, task_id INTEGER NOT NULL REFERENCES tasks(id),
  expected_mode TEXT NOT NULL CHECK(expected_mode IN ('manual','orchestrated')),
  target_mode TEXT NOT NULL CHECK(target_mode IN ('manual','orchestrated')),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), created_at INTEGER NOT NULL,
  completed_at INTEGER, receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
  CHECK((completed_at IS NULL)=(receipt_json IS NULL))
);
CREATE UNIQUE INDEX idx_execution_handoffs_live ON execution_handoffs(task_id) WHERE completed_at IS NULL;
CREATE TRIGGER work_item_revisions_immutable_update BEFORE UPDATE ON work_item_revisions
BEGIN SELECT RAISE(ABORT,'immutable work item revision'); END;
CREATE TRIGGER work_item_revisions_immutable_delete BEFORE DELETE ON work_item_revisions
BEGIN SELECT RAISE(ABORT,'immutable work item revision'); END;
CREATE TRIGGER work_item_dependencies_immutable BEFORE UPDATE OF
  consumer_id,consumer_revision,edge_key,producer_id,producer_revision,kind,output_key,binding_json
  ON work_item_dependencies BEGIN SELECT RAISE(ABORT,'immutable dependency'); END;
CREATE TRIGGER work_item_dependencies_no_delete BEFORE DELETE ON work_item_dependencies
BEGIN SELECT RAISE(ABORT,'immutable dependency'); END;
CREATE TRIGGER work_item_dependencies_pin BEFORE UPDATE OF pinned_result_id ON work_item_dependencies
WHEN OLD.pinned_result_id IS NOT NULL AND NEW.pinned_result_id IS NOT OLD.pinned_result_id
BEGIN SELECT RAISE(ABORT,'dependency result already pinned'); END;
CREATE TRIGGER work_item_results_immutable BEFORE UPDATE OF
  id,command_id,command_hash,producer_id,producer_revision,output_key,kind,payload_json,source_json,created_at
  ON work_item_results BEGIN SELECT RAISE(ABORT,'immutable result payload'); END;
CREATE TRIGGER work_item_results_no_delete BEFORE DELETE ON work_item_results
BEGIN SELECT RAISE(ABORT,'immutable result payload'); END;
CREATE TRIGGER work_item_results_no_revalidate BEFORE UPDATE OF invalidated_at,invalidation_reason,successor_id
  ON work_item_results WHEN OLD.invalidated_at IS NOT NULL AND
    (NEW.invalidated_at IS NOT OLD.invalidated_at OR NEW.invalidation_reason IS NOT OLD.invalidation_reason
      OR NEW.successor_id IS NOT OLD.successor_id)
BEGIN SELECT RAISE(ABORT,'result invalidation is final'); END;
```

Definitions/edges/result payload immutable; result invalidation fields and first result pin are projections with append-only audit events. New rows use randomBytes(16).toString('hex') ids. Host validators additionally enforce closed shape, safe ids, output/definition compatibility and source tuple; SQL FK is the final local integrity guard.

- [x] **4. Перенести handle и реализовать parent path.** Move the existing controller WeakMap and `openController` into `controller.ts`; gate schema with `MIGRATIONS.length` and existing `projectOf(db)`. Re-export `openController`/type from `authority.ts`, import `controllerDb` there; keep run contexts/token/native guards unchanged. `index.ts` exports execution public API, not `controller.ts` wholesale.

`Task` adds `parent_id: number | null; execution_mode: ExecutionMode`. `addTask` reads `project.default_execution_mode` inside its creation transaction and inserts it explicitly. Old migration defaults remain manual. `createSubtasks` obtains authentic DB first, then performs every validation/write/event in one `.immediate()` transaction. Reuse `addTask` for row/criteria/legacy created event, set parent/mode before outer commit, and append a `subtask_created` event containing source fields and parent membership. Do not overwrite old audit events or overload `events.parent_id`.

Canonical task contract bytes:

```ts
const task = mustGetTask(db, ref.taskId);
const criteria = db.prepare('SELECT id,text FROM criteria WHERE task_id=? ORDER BY id').all(task.id);
const bytes = JSON.stringify({ projectId: projectOf(db).project_id,
  taskId: task.id, title: task.title, body: task.body, criteria });
const hash = createHash('sha256').update(bytes).digest('hex');
```

Compare `ref.projectId` with store before local lookup; require positive safe task id, nonempty unique child keys/titles/criteria and allowed enums. Parent root and hash must match. For run source, query `run_authorities` by exact authority id + task/work item/run/generation, require live current authority through the shared scoped runtime grant validator (including current modeled inputs/ownership, repository/native scope and private store), then match `events.id=proposalEventId`, `action='run_report'`, task and run/generation/work_item fields. The event remains `untrusted`; it is provenance, not permission or check outcome. Manual source validates local source task/instructionRef. `listSubtasks` returns children ordered by id, including archived rows without conflating membership/status.

- [x] **5. Review Focus 1 / D02: добавить реальные отказы и mode inheritance.**

```ts
it('rejects foreign numeric refs and fabricated handles without partial rows', () => {
  const a = fixture(), b = fixture(), parent = a.task('a'), foreign = b.task('b');
  expect(parent.id).toBe(foreign.id);
  const input: core.CreateSubtasksInput = {
    parent: b.ref(foreign.id), expectedParentHash: core.taskContractHash(b.handle, b.ref(foreign.id)),
    source: { kind: 'manual', sourceTask: a.ref(parent.id), instructionRef: 'owner:split' },
    children: [{ key: 'x', title: 'child', criteria: ['outcome'] }],
  };
  const before = a.db.prepare('SELECT * FROM events').all();
  expect(() => core.createSubtasks(a.handle, input)).toThrow(/project/);
  expect(() => core.createSubtasks(JSON.parse(JSON.stringify(a.handle)), input)).toThrow(/authority/);
  expect(a.db.prepare('SELECT * FROM events').all()).toEqual(before);
  expect(core.listSubtasks(a.handle, a.ref(parent.id))).toEqual([]);
});
```

Also pin missing parent, self-parent via SQL, attempt to make root-with-children a child via SQL, invalid mode/unknown input key, duplicate batch key, second invalid child rollback and wrong source generation. Confirm parent mode later changes do not alter existing child modes. Reuse actual scoped run fixture in `authority.test.ts` for valid `run_report` provenance and reject request_question/worker JSON as source; no synthetic grant is native evidence.

- [x] **6. D01: v14 fixture preservation before GREEN.** Build a raw temp file by executing `MIGRATIONS.slice(0,14)`, set `user_version=14`, seed old task/claim/criteria checked/evidence/event/provenance/file/decision/FTS/project/repository/marker/grant rows, capture deterministic `SELECT * ... ORDER BY primary key` snapshots, close raw connection, reopen via `openDb`. Compare every old column byte/value (new task columns excluded), `foreign_key_check=[]`, no owners/handoffs/results, marker/grant counts unchanged. Read `.v14.bak` and verify original rows/version; reopen v15 and verify no duplicates. Future schema v16 refuses `openDb` and `openController`, JSON/spread/RunContext handles refuse new APIs. Existing 14 migration strings compare byte-for-byte with `git show cb7e7a8:packages/core/src/schema.ts` before commit.
- [x] **7. GREEN и commit.** Run `pnpm --dir packages/core exec vitest run test/execution.test.ts test/db.test.ts test/authority.test.ts`, then `pnpm --dir packages/core typecheck`, `pnpm build`, `git diff --check`. Stage exact task files and generated dist/runtime; commit `feat(core): add subtasks and execution schema`.

### Task 2: Versioned work items и атомарный граф всего project

**Files:** modify `packages/core/src/execution.ts`, `index.ts`, `packages/core/test/execution.test.ts`.

**Interfaces:** consumes task 1 `TaskRef`, `ExecutionMode`, `CreationSource`, `CreateSubtasksInput`, `taskContractHash`, `createSubtasks`, internal `controllerDb`. Produces the definitions below; these same types are consumed by tasks 3/4/6:

```ts
export type WorkItemKind = 'analysis' | 'architecture' | 'implementation' | 'check' |
  'integration' | 'human_action' | 'curation';
export type WorkItemState = 'pending' | 'ready' | 'running' | 'waiting_input' |
  'retry_wait' | 'completed' | 'failed' | 'cancelled';
export type DependencyKind = 'contract' | 'code' | 'merged' | 'readiness';
export interface WorkItemRef { projectId: string; workItemId: string }
export interface OwnershipRef extends WorkItemRef { revision: number; ownerId: string; fence: number }
export interface OutputRequirement {
  key: string; kind: DependencyKind; required: boolean; version: string;
  checkRefs: readonly string[];
}
export interface WorkItemDefinition {
  kind: WorkItemKind; repoId: string | null;
  sourceTasks: readonly TaskRef[]; outputs: readonly OutputRequirement[];
}
export type DependencyBinding =
  | { kind: 'contract'; repoId: string | null; version: string }
  | { kind: 'code'; repoId: string; version: string; baseHead: string }
  | { kind: 'merged'; repoId: string; version: string; target: string; baseHead: string }
  | { kind: 'readiness'; repoId: string | null; version: string; resourceId: string;
      configHash: string; consumerScope: string; capabilities: readonly string[] };
export interface DependencyInput {
  key: string; producer: WorkItemRef; producerRevision: number;
  outputKey: string; binding: DependencyBinding; resultId?: string;
}
export interface WorkItemRecord {
  ref: WorkItemRef; task: TaskRef; revision: number; state: WorkItemState; fence: number;
  definition: WorkItemDefinition; inputs: readonly { task: TaskRef; hash: string }[];
  inputsHash: string; dependencies: readonly DependencyInput[];
}
export interface WorkItemInput { task: TaskRef; definition: WorkItemDefinition; dependencies: readonly DependencyInput[] }
export function createWorkItem(handle: ControllerHandle, input: WorkItemInput): WorkItemRecord;
export function reviseWorkItem(handle: ControllerHandle, input: {
  ref: WorkItemRef; expectedRevision: number; definition: WorkItemDefinition;
  dependencies: readonly DependencyInput[];
}): WorkItemRecord;
export function workItem(handle: ControllerHandle, ref: WorkItemRef): WorkItemRecord;
export function taskWorkItems(handle: ControllerHandle, task: TaskRef): WorkItemRecord[];

export interface SubtaskPlanInput extends CreateSubtasksInput {
  workItems: readonly { key: string; childKey: string; definition: WorkItemDefinition }[];
  dependencies: readonly {
    consumerKey: string; key: string;
    producer: { localKey: string } | { ref: WorkItemRef; revision: number };
    outputKey: string; binding: DependencyBinding; resultId?: string;
  }[];
}
export function createSubtaskPlan(handle: ControllerHandle, input: SubtaskPlanInput): {
  tasks: Record<string, Task>; workItems: Record<string, WorkItemRecord>;
};
```

No generic workflow DSL: local keys are only batch references resolved to durable ids in one transaction. `reviseWorkItem` replaces the entire definition/edges with a new immutable revision; no independent mutable `addEdge` API. Current readers return empty arrays when card has no work items. Public schemas reject undeclared keys at every nested level.

- [x] **1. RED для требования родителя и revisions.** Add:

```ts
it('includes the parent contract and does not retarget an older revision', () => {
  const f = fixture(), parent = f.task('main');
  const child = core.createSubtasks(f.handle, {
    parent: f.ref(parent.id), expectedParentHash: core.taskContractHash(f.handle, f.ref(parent.id)),
    source: { kind: 'manual', sourceTask: f.ref(parent.id), instructionRef: 'split' },
    children: [{ key: 'api', title: 'API', criteria: ['manifest'] }],
  }).api;
  const definition: core.WorkItemDefinition = { kind: 'architecture', repoId: null,
    sourceTasks: [], outputs: [{ key: 'api', kind: 'contract', required: true, version: 'v1', checkRefs: [] }] };
  const first = core.createWorkItem(f.handle, { task: f.ref(child.id), definition, dependencies: [] });
  expect(first.inputs.map(i => i.task.taskId).sort((a,b) => a-b)).toEqual([parent.id, child.id]);
  const second = core.reviseWorkItem(f.handle, { ref: first.ref, expectedRevision: 1,
    definition: { ...definition, outputs: [{ ...definition.outputs[0], version: 'v2' }] }, dependencies: [] });
  expect(second.revision).toBe(2);
  expect(f.db.prepare('SELECT count(*) n FROM work_item_revisions WHERE work_item_id=?').get(first.ref.workItemId)).toEqual({ n: 2 });
  expect(() => core.reviseWorkItem(f.handle, { ref: first.ref, expectedRevision: 1,
    definition, dependencies: [] })).toThrow(/revision/);
});
```

Run `pnpm --dir packages/core exec vitest run test/execution.test.ts`; expected missing `createWorkItem` failure.
- [x] **2. Реализовать definitions/fingerprints в transaction.** Gather own task + automatic parent + explicit source tasks, compare project refs before lookup, deduplicate and sort by task id. Compute individual hashes with task 1 function, then SHA-256 of canonical ordered `{task,hash}` array; store it and canonical definition. Output/check/source/edge keys are distinct, enums closed, repo ids must be registered; `code` requires non-null matching producer/consumer repo ids. Validate finite safe revisions/fences/ids before SQL, reject increment at MAX_SAFE_INTEGER. Active reservation, active handoff and terminal state prevent revision activation; no silent update to owner inputs. Insert revision/edges, update current pointer, event in one immediate transaction.
- [x] **3. RED для cycle через разные задачи и rejected revision rollback.**

```ts
it('rejects a cross-task cycle and keeps the prior current revision', () => {
  const f = fixture(), a = f.task('A'), b = f.task('B');
  const definition: core.WorkItemDefinition = { kind: 'analysis', repoId: null, sourceTasks: [],
    outputs: [{ key: 'contract', kind: 'contract', required: true, version: 'v1', checkRefs: [] }] };
  const wa = core.createWorkItem(f.handle, { task: f.ref(a.id), definition, dependencies: [] });
  const wb = core.createWorkItem(f.handle, { task: f.ref(b.id), definition, dependencies: [] });
  const edge = (producer: core.WorkItemRecord): core.DependencyInput => ({ key: 'needs-contract',
    producer: producer.ref, producerRevision: producer.revision, outputKey: 'contract',
    binding: { kind: 'contract', repoId: null, version: 'v1' } });
  const a2 = core.reviseWorkItem(f.handle, { ref: wa.ref, expectedRevision: 1,
    definition, dependencies: [edge(wb)] });
  const before = f.db.prepare('SELECT * FROM events').all();
  expect(() => core.reviseWorkItem(f.handle, { ref: wb.ref, expectedRevision: 1,
    definition, dependencies: [edge(a2)] })).toThrow(/cycle/);
  expect(core.workItem(f.handle, wb.ref).revision).toBe(1);
  expect(f.db.prepare('SELECT * FROM events').all()).toEqual(before);
});
```

- [x] **4. Реализовать whole-project reachability в том же write transaction.** Check proposed replacement graph, not prior graph alone. Active edges are rows whose consumer_revision equals its work item's current_revision; producer_revision remains a pinned input, not a topology escape hatch. For candidate consumer C → producer P (consumer requires producer), reject if P reaches C, including paths via candidate siblings. Write candidate revision/current pointer inside the transaction, run CTE, throw on cycle to roll back every row/event. The CTE operates on all project items, never task_links/parent relations:

```sql
WITH RECURSIVE active(consumer,producer) AS (
  SELECT d.consumer_id,d.producer_id FROM work_item_dependencies d
  JOIN work_items w ON w.id=d.consumer_id AND w.current_revision=d.consumer_revision
), reachable(id) AS (
  SELECT producer FROM active WHERE consumer=?
  UNION SELECT a.producer FROM active a JOIN reachable r ON a.consumer=r.id
)
SELECT 1 FROM reachable WHERE id=? LIMIT 1;
```

Evaluate it with `[candidateProducerId,candidateConsumerId]` for each changed edge; `UNION` terminates even on a malformed graph. Validate endpoints/revisions/output kinds/repo bindings/result ids before insertion; pinned existing result must match exact producer/revision/key/kind. No partial replacement on failure.
- [x] **5. Batch creation проверять как один commit.** `createSubtaskPlan` starts one outer immediate transaction, uses `createSubtasks` with only its base fields, allocates all work-item ids first, resolves all local keys, constructs complete revision 1 definitions/edges, checks global DAG, and appends `subtask_plan_created` with durable maps. Share internal insertion logic with `createWorkItem`; don't create then mutate revision 1. A bad last edge rolls back children/criteria/model/audit. BA caller adapter/child limit remain #153 and no worker tool invokes this API.
- [x] **6. D02–D04/D06 negative matrix.** Test local batch three siblings (two independent, third depends on one), parent alone creates zero edges, cross-main-task dependency, self-edge, missing endpoint/revision/output, foreign producer project, stale expected revision, duplicate edge key, extra JSON keys and same-repo/cross-repo code. Snapshot DB/events and frontend Git `HEAD`, `for-each-ref` before rejected backend→frontend code; assert unchanged. Explicit task_links of kind `depends_on` still produce zero executable edges. Update a new revision to a cycle and ensure old definition/edges/current pointer survive.
- [x] **7. GREEN и commit.** Run `pnpm --dir packages/core exec vitest run test/execution.test.ts`, `pnpm --dir packages/core typecheck`, `pnpm build`, `git diff --check`. Commit exact source/test/generated files with `feat(core): add versioned work item dependencies`.

### Task 3: Проверяемые results, immutable pinning и dependency projection

**Files:** create `packages/core/src/execution_results.ts`, `packages/core/test/execution_results.test.ts`; modify `execution.ts`, `index.ts`.

**Interfaces:** consumes task 2 model/types and task 1 authentic handle/task hashes. Produces:

```ts
export type ResultSource =
  | { kind: 'manual'; sourceTask: TaskRef; instructionRef: string }
  | { kind: 'owned'; owner: OwnershipRef; authority?: AuthorityBinding; instructionRef: string };
interface PayloadBase { repoId: string | null; version: string; checkRefs: readonly string[] }
export type ResultPayload =
  | (PayloadBase & { kind: 'contract'; head: string | null; artifact: { path: string; sha256: string } })
  | (PayloadBase & { kind: 'code'; repoId: string; head: string; proofRef: string })
  | (PayloadBase & { kind: 'merged'; repoId: string; head: string; target: string; baseHead: string;
      acceptedResultId: string; userRef: string; receiptRef: string })
  | (PayloadBase & { kind: 'readiness'; resourceId: string; configHash: string;
      consumerScope: string; capabilities: readonly string[]; userRef: string; probeRef: string;
      observedAt: number; expiresAt: number | null });
export interface ResultBinding {
  producer: WorkItemRef; producerRevision: number; inputsHash: string;
  outputKey: string; kind: DependencyKind; version: string; repoId: string | null;
}
export type EvidenceRequest =
  | { kind: 'check'; ref: string; binding: ResultBinding; payloadHash: string }
  | { kind: 'code_result'; ref: string; binding: ResultBinding; head: string }
  | { kind: 'code_in_base'; ref: string; binding: ResultBinding; head: string; baseHead: string }
  | { kind: 'merge_acceptance'; ref: string; binding: ResultBinding; acceptedResultId: string }
  | { kind: 'merge_receipt'; ref: string; binding: ResultBinding; acceptedResultId: string;
      target: string; baseHead: string; head: string }
  | { kind: 'readiness_confirmation'; ref: string; binding: ResultBinding; resourceId: string }
  | { kind: 'readiness_probe'; ref: string; binding: ResultBinding; resourceId: string;
      configHash: string; consumerScope: string; capabilities: readonly string[] };
export interface EvidenceObservation {
  request: EvidenceRequest; verdict: 'pass' | 'fail' | 'inconclusive';
  origin: 'host' | 'user'; observedAt: number; expiresAt: number | null;
}
export interface ResultObservers {
  observe?: (request: EvidenceRequest) => EvidenceObservation | null;
}
export interface ResultRecord {
  id: string; commandId: string; binding: ResultBinding; payload: ResultPayload;
  source: ResultSource; inputResults: readonly { edgeKey: string; resultId: string }[];
  invalidatedAt: number | null; invalidationReason: string | null; successorId: string | null;
}
export interface PublishResultInput {
  commandId: string; producer: WorkItemRef; expectedRevision: number;
  outputKey: string; expectedResultId: string | null; payload: ResultPayload; source: ResultSource;
}
export type DependencyReason = 'missing_output' | 'producer_not_completed' | 'failed' | 'cancelled' |
  'stale_revision' | 'checks_not_passed' | 'base_missing_code' | 'merge_not_succeeded' |
  'readiness_unconfirmed' | 'readiness_unverified' | 'readiness_expired' | 'scope_mismatch';
export interface DependencyProjection {
  ref: WorkItemRef; revision: number; inputsCurrent: boolean; ready: boolean;
  edges: readonly ({ key: string; producer: WorkItemRef; binding: DependencyBinding } &
    ({ satisfied: true; resultId: string; pinned: boolean } |
     { satisfied: false; reason: DependencyReason; resultId: string | null }))[];
}
export function publishResult(handle: ControllerHandle, input: PublishResultInput,
  observers?: ResultObservers): ResultRecord;
export function invalidateResult(handle: ControllerHandle, input: {
  commandId: string; resultId: string; reason: string; successorId?: string;
}): ResultRecord;
export function result(handle: ControllerHandle, resultId: string): ResultRecord;
export function inspectDependencies(handle: ControllerHandle, ref: WorkItemRef,
  observers?: ResultObservers): DependencyProjection;
export function resolveDependencies(handle: ControllerHandle, input: {
  ref: WorkItemRef; expectedRevision: number;
}, observers?: ResultObservers): DependencyProjection;
export function completeWorkItem(handle: ControllerHandle, input: {
  ref: WorkItemRef; expectedRevision: number; source: ResultSource;
}, observers?: ResultObservers): WorkItemRecord;
export function setWorkItemWaiting(handle: ControllerHandle, input: {
  ref: WorkItemRef; expectedRevision: number; source: ResultSource;
}): WorkItemRecord;
export function endWorkItem(handle: ControllerHandle, input: {
  ref: WorkItemRef; expectedRevision: number; source: ResultSource; state: 'failed' | 'cancelled';
}): WorkItemRecord;
```

Default observers are `{}`. This is a trusted synchronous library callback, not an MCP/worker JSON parameter: the host resolves concrete durable evidence refs. Closed returned request/binding must equal the core-generated request; fail/inconclusive/missing/throwing/mismatched observation blocks. Mandatory `check` requests include the canonical full payload SHA-256 (`payloadHash`), so a durable pass cannot apply to a different artifact/head/resource/receipt even within one producer revision. Only `merge_acceptance` and `readiness_confirmation` accept `origin='user'`; other evidence requires host origin. No adapter executing CI, network probes or merges is built here.

`setWorkItemWaiting` changes pending/ready to waiting_input; it creates neither question nor attempt. `endWorkItem` allows failed/cancelled from nonterminal states only when there is no potentially launched live owner; an unlaunched reservation may remain held. Completed/failed/cancelled cannot be reopened or revised. Neither operation releases ownership. `running`/`retry_wait` runtime transitions remain #150/#152; negative fixtures can seed those persisted projections without claiming runtime implementation.

- [x] **1. Добавить real-artifact helper и RED positive contract.** Define test-local `contractFlow()` fully as below; it reuses `fixture()` and creates separate main tasks, so it also covers cross-task outputs:

```ts
function contractFlow() {
  const f = fixture(), a = f.task('API'), b = f.task('frontend');
  const definition: core.WorkItemDefinition = { kind: 'architecture', repoId: null,
    sourceTasks: [], outputs: [{ key: 'api', kind: 'contract', required: true, version: 'v1', checkRefs: [] }] };
  const producer = core.createWorkItem(f.handle, { task: f.ref(a.id), definition, dependencies: [] });
  const consumer = core.createWorkItem(f.handle, { task: f.ref(b.id),
    definition: { kind: 'implementation', repoId: null, sourceTasks: [], outputs: [] },
    dependencies: [{ key: 'api', producer: producer.ref, producerRevision: 1, outputKey: 'api',
      binding: { kind: 'contract', repoId: null, version: 'v1' } }] });
  const artifact = join(f.root, 'api.json'); writeFileSync(artifact, '{"schema":"v1"}\n');
  const payload: core.ResultPayload = { kind: 'contract', repoId: null, head: null, version: 'v1',
    checkRefs: [], artifact: { path: artifact, sha256: createHash('sha256').update(readFileSync(artifact)).digest('hex') } };
  const source: core.ResultSource = { kind: 'manual', sourceTask: f.ref(a.id), instructionRef: 'owner:publish' };
  const publication: core.PublishResultInput = { commandId: 'publish:api', producer: producer.ref,
    expectedRevision: 1, outputKey: 'api', expectedResultId: null, payload, source };
  return { ...f, producer, consumer, artifact, payload, source, publication };
}
it('requires verified output and completion, then pins only the requested result', () => {
  const f = contractFlow();
  expect(core.inspectDependencies(f.handle, f.consumer.ref).ready).toBe(false);
  const published = core.publishResult(f.handle, f.publication);
  expect(core.inspectDependencies(f.handle, f.consumer.ref).ready).toBe(false);
  core.completeWorkItem(f.handle, { ref: f.producer.ref, expectedRevision: 1, source: f.source });
  const ready = core.resolveDependencies(f.handle, { ref: f.consumer.ref, expectedRevision: 1 });
  expect(ready.ready).toBe(true);
  expect(ready.edges).toEqual([expect.objectContaining({ key: 'api', resultId: published.id, pinned: true, satisfied: true })]);
});
```

Run `pnpm --dir packages/core exec vitest run test/execution_results.test.ts`; expected missing result API failure.
- [x] **2. Реализовать закрытый result/source guard и publication.** In one immediate transaction: authenticate → validate input → compare any command replay for conflicts → source permission/fence guard → authorized exact replay return, otherwise current producer/revision/fingerprints → declared output/bindings → current input dependencies → real payload verifier → current output-slot CAS → insert/event. A manual source must refer to producer task and requires no active new owner; an owned source matches the unreleased owner id/fence/revision/current inputs, and optional authority tuple matches stored #145 grant. Unknown instruction/source ids, stale ownership, foreign scope and protected handoff fail before result/event writes. Idempotence does not give a released owner a fence bypass; controller can read historical records through `result`.

Publication is a verified host operation: nonpassing external evidence rejects it; no `verified` field is stored from caller. Allocate id once per command, persist core-computed `inputResults` from producer's resolved/pinned dependencies in source metadata. Store `command_hash` = SHA-256 of canonical original `PublishResultInput` bytes (known object key order, stable sorted sets, including expectedResultId/source); this is a dedup digest, not verification evidence. Authorized exact replay compares that digest, returns old record even after invalidation, and does not create events; changed payload/source/expected input with the same commandId is a conflict. A different command must match `expectedResultId` for the current output slot. For correction before producer completes, preallocate successor id, update prior record once with invalidated_at/reason/successor_id, then insert successor/event in the same transaction: deferred successor FK permits this ordering while the partial unique output index is freed. Rollback keeps prior output valid if insertion fails. Once producer is terminal, only authorized exact replay is allowed; rework creates a new work item.
- [x] **3. Реализовать один повторяемый validator.** Keep private `validateResult(db, record, requiredBinding, observers, visited): DependencyReason | null` in `execution_results.ts`; `requiredBinding` is `DependencyBinding | null` (null for producer publication/completion without a consumer base), `visited` is `Set<string>` for the current recursion path of producer/revision/result tuples. `inspectDependencies`, publication, completion and reservation use it. Compare actual current task hashes, producer current revision, immutable definition/output requirements, stored source inputs and upstream result pins. Add tuple on descent and delete in finally: a cycle on the current path returns stale/inconclusive, but a diamond DAG sharing one valid producer is allowed. Memoization can be per single evaluation only; don't cache artifact/probe validity across calls.

Contract hash is computed from current bytes, not a claimed revision:

```ts
const actual = createHash('sha256').update(readFileSync(payload.artifact.path)).digest('hex');
if (actual !== payload.artifact.sha256) return 'stale_revision';
```

Missing/non-file artifact, I/O error, malformed hash, mismatched repo/output/version gives a closed dependency. Exact mandatory check refs are taken from `OutputRequirement.checkRefs`; missing/unknown/failed evidence maps to `checks_not_passed`. Optional checks cannot erase mandatory ones.

Code publication/completion first requires `code_result` for its exact registered repo/verified head and mandatory checks; absent producer evidence gives `checks_not_passed`. Consumer validation additionally requests `code_in_base` for exact repo/result head/pinned consumer base; absent inclusion pass gives `base_missing_code`. Never invent a base for a producer-only publication. Merged verifies accepted result exists/current and requires both user acceptance and successful receipt for exact target/base/head/result tuple; absent pass gives `merge_not_succeeded`. Readiness requires user-origin confirmation and fresh host probe for exact resource, repo/version/config/current inputs and consumer scope/capabilities. Reject future/nonfinite timestamps; expiry at or before `now()` gives `readiness_expired`. Without expiry, a new observer call is still mandatory each read/reservation; cached manifest alone cannot pass. Credentials are excluded from closed payloads and audit.
- [x] **4. Projection/pinning/completion в transaction.** `inspectDependencies` only reads (SQLite read snapshot), returns ready=false for stale own inputs or any failed edge. `resolveDependencies` repeats verification inside immediate transaction, pins result ids only if all requirements pass, records `dependencies_resolved` only on changed pins and never repoints an existing pin. First resolution may select the single current uninvalidated result of exact producer/revision/output; after invalidation it cannot float to a successor. A new consumer revision explicitly requests the new input. Failed/cancelled producers map to their reasons, waiting/pending/running/retry_wait to `producer_not_completed`; card `done` is ignored. `completeWorkItem` verifies actual current inputs/dependencies and every mandatory output, records completed with event and retains reservation. Empty optional outputs do not imply approval/Start.
- [x] **5. Review Focus 2/4 / D05/D07: real edits и исчезновение artifacts.**

```ts
it('closes a pinned edge when bytes change or the artifact disappears', () => {
  const f = contractFlow();
  core.publishResult(f.handle, f.publication);
  core.completeWorkItem(f.handle, { ref: f.producer.ref, expectedRevision: 1, source: f.source });
  core.resolveDependencies(f.handle, { ref: f.consumer.ref, expectedRevision: 1 });
  writeFileSync(f.artifact, '{"schema":"changed"}\n');
  expect(core.inspectDependencies(f.handle, f.consumer.ref).ready).toBe(false);
  rmSync(f.artifact);
  expect(core.inspectDependencies(f.handle, f.consumer.ref).ready).toBe(false);
});
it('rejects a replay with conflicting content and preserves the immutable record', () => {
  const f = contractFlow(), first = core.publishResult(f.handle, f.publication);
  expect(core.publishResult(f.handle, f.publication).id).toBe(first.id);
  expect(() => core.publishResult(f.handle, { ...f.publication,
    source: { ...f.source, instructionRef: 'different instruction' } })).toThrow(/conflict/);
  expect(core.result(f.handle, first.id).source).toEqual(f.source);
});
```

For parent propagation use task 1 sibling fixture and real `editTask` on its unprotected parent: change title/body separately, expect `inputsCurrent=false`, publication/completion rejected, and no new publication events/results. Current legacy API has no criterion-text editor: represent an owner requirements edit on actual fixture rows with `db.prepare('UPDATE criteria SET text=? WHERE id=?').run('changed requirement',criterionId)`, then require the same stale outcome. Restore text, then toggle checked/evidence, criterion position, comment and card position/status separately; stored hashes stay equal. Explicit additional source task change propagates; caller cannot omit automatic parent. With an active child reservation in task 4, parent edit still does not update owner's revision/inputs. Add a diamond graph with two incoming branches sharing one valid source result and assert both branches satisfy, pinning the recursion-path rule.
- [x] **6. D05/D06 matrix и invalidation.** Actual old `moveTask(...,'done',user,reason)`, comment, checked criteria and report `exit 0` leave consumer closed. Test pending/waiting/failed/cancelled producers, missing mandatory output, fail/inconclusive/missing/throwing/wrong-binding check observer and stale producer revision. For each external proof variant use an authentic host test observer matching exact request; replacing it with `{}`, returning wrong request/origin/scope/time or removing it closes the edge. These are contract fixtures, not production checks/acceptance. Backend contract reads a real artifact and pins repo/version without changing frontend HEAD/refs; cross-repo code rejected by task 2. Same-repo code without inclusion proof, merged without acceptance/receipt, readiness without confirmation/current probe remain closed.

`invalidateResult` authenticates and reads exact result, rejects conflicting command replay, validates optional successor record exists and has compatible output kind/repo, marks old result final-invalidated and appends `result_invalidated` with command/result/reason/successor. Replay dedup uses that exact event action/commandId under immediate transaction with `json_valid(detail)` guard. Old payload/source remain identical. Create a new producer/work item for rework, publish its artifact, invalidate prior result with that successor id, and assert pinned consumer remains closed until an explicit new consumer definition. Test immutability triggers by raw fixture UPDATE/DELETE and verify no history loss.
- [x] **7. GREEN и commit.** Run `pnpm --dir packages/core exec vitest run test/execution_results.test.ts test/execution.test.ts`, `pnpm --dir packages/core typecheck`, `pnpm build`, `git diff --check`. Commit `feat(core): verify and pin dependency results` with exact source/test/generated files.

### Task 4: Reservation fences, launch intent и подтверждённый handoff

**Files:** create `packages/core/src/execution_ownership.ts`, `packages/core/test/execution_ownership.test.ts`, `packages/core/test/fixtures/execution_tree.mjs`; modify `authority.ts`, `execution_results.ts`, `execution.ts`, `index.ts`, `packages/core/test/authority.test.ts`, `managed_mutations.test.ts`.

**Interfaces:** consumes `OwnershipRef`, model revision/inputs, `resolveDependencies(handle,{ref,expectedRevision},observers)`, `protectTask` and `revokeRunAuthority`. Produces:

```ts
export interface LaunchIntent {
  launchId: string; writerScopeId: string; authority?: AuthorityBinding;
}
export interface OwnershipRecord {
  ref: OwnershipRef; mode: ExecutionMode; write: boolean;
  inputsHash: string; inputResults: readonly { edgeKey: string; resultId: string }[];
  launchIntent: LaunchIntent | null; releasedAt: number | null;
}
export interface ReserveWorkItemInput {
  ref: WorkItemRef; expectedRevision: number; expectedFence: number;
  expectedMode: ExecutionMode; ownerId: string; write: boolean;
}
export function reserveWorkItem(handle: ControllerHandle, input: ReserveWorkItemInput,
  observers?: ResultObservers): OwnershipRecord;
export function ownership(handle: ControllerHandle, ref: OwnershipRef): OwnershipRecord;
export function recordLaunchIntent(handle: ControllerHandle, input: {
  owner: OwnershipRef; intent: LaunchIntent;
}): OwnershipRecord;
export interface HandoffRecord {
  id: string; commandId: string; task: TaskRef; expectedMode: ExecutionMode; targetMode: ExecutionMode;
  owners: readonly OwnershipRecord[]; authorities: readonly AuthorityBinding[];
  receipt: HandoffReceipt | null;
}
export interface HandoffReceipt {
  handoffId: string; task: TaskRef; mode: ExecutionMode;
  released: readonly OwnershipRef[]; revokedAuthorityIds: readonly string[];
  stops: readonly ({ owner: OwnershipRef; outcome: 'never_started' } |
    { owner: OwnershipRef; outcome: 'stopped'; observationId: string; launchId: string; writerScopeId: string })[];
}
export interface StopObservation {
  observationId: string; owner: OwnershipRef; launchId: string; writerScopeId: string;
  observedAt: number; verdict: 'stopped' | 'live' | 'unknown'; complete: boolean;
  writers: readonly { id: string; state: 'gone' | 'alive' | 'unknown' }[];
}
export type StopObserver = (owner: OwnershipRecord) => Promise<StopObservation | null>;
export type HandoffOutcome = { status: 'complete'; receipt: HandoffReceipt } |
  { status: 'held'; handoffId: string; reason: 'missing_observer' | 'observer_error' |
      'unknown' | 'live' | 'stale_observation' | 'snapshot_changed' };
export function beginHandoff(handle: ControllerHandle, input: {
  commandId: string; task: TaskRef; expectedMode: ExecutionMode; targetMode: ExecutionMode;
  expectedOwners: readonly OwnershipRef[];
}): HandoffRecord;
export function handoff(handle: ControllerHandle, handoffId: string): HandoffRecord;
export function finishHandoff(handle: ControllerHandle, input: { handoffId: string },
  observer?: StopObserver): Promise<HandoffOutcome>;
```

`writerScopeId` is the durable launch/writer-set identity chosen by trusted host before possible spawn. It is not a pid/path or a worker's arbitrary report. #150 supplies a real adapter with complete process/provider observations. #146 records metadata only; its only actual spawned processes are isolated test/research fixtures.

Existing `IssueRunInput` gains optional `ownership?: OwnershipRef`. If `input.workItemId` exists in new `work_items`, this tuple is required, must match task/current revision/live reservation, and native writable scope requires `owner.write=true` and the non-null definition.repoId equal to its writable repository identity. Null repoId permits context/scratch work, not an arbitrary writable product repo. Existing #145 implementation-access/managed-binding checks still apply. Store tuple in grant JSON and recheck it and repo binding in lookup. Existing grants with unmodeled ids retain #145 behavior and are not synthetic execution records. `issueRunAuthority(handle,input): IssuedRunAuthority` return type stays unchanged. Authority rotation and ownership fence remain separate counters.

- [x] **1. RED single-owner и marker-before-claim guard.**

```ts
it('keeps one owner, advances fences and refuses expired legacy claims before marking', () => {
  const f = fixture(), task = f.task('implementation');
  const item = core.createWorkItem(f.handle, { task: f.ref(task.id),
    definition: { kind: 'implementation', repoId: null, sourceTasks: [], outputs: [] }, dependencies: [] });
  const input: core.ReserveWorkItemInput = { ref: item.ref, expectedRevision: 1, expectedFence: 0,
    expectedMode: 'manual', ownerId: 'controller:a', write: true };
  f.db.prepare("UPDATE tasks SET status='in_progress',claimed_by='ai:old',claim_expires=1 WHERE id=?").run(task.id);
  expect(() => core.reserveWorkItem(f.handle, input)).toThrow(/legacy.*writer|claim/);
  expect(f.db.prepare('SELECT * FROM managed_task_policy').all()).toEqual([]);
  f.db.prepare("UPDATE tasks SET status='new',claimed_by=NULL,claim_expires=NULL WHERE id=?").run(task.id);
  const owner = core.reserveWorkItem(f.handle, input);
  expect(owner.ref.fence).toBe(1);
  expect(() => core.reserveWorkItem(f.handle, { ...input, ownerId: 'controller:b' })).toThrow(/owner|fence/);
  expect(f.db.prepare('SELECT count(*) n FROM work_item_owners WHERE released_at IS NULL').get()).toEqual({ n: 1 });
});
```

Run `pnpm --dir packages/core exec vitest run test/execution_ownership.test.ts`; expected missing reservation API failure.
- [x] **2. Реализовать fenced reservation.** Authenticate first; one immediate transaction validates closed request, safe finite expected integers, current mode/state/revision/fingerprint/manual blocked/archive state, no active handoff and no live reservation. Pending/ready are reservable only when `resolveDependencies` now passes. Reject backlog/terminal/waiting states; no automatic queue selection. Increment fence with overflow guard and CAS (`UPDATE work_items SET fence=? WHERE id=? AND fence=? AND current_revision=?`), persist pinned inputResults/inputsHash/owner/mode/write in owner row and append `work_item_reserved`. On any failure—including marker/protect failure—outer rollback covers result pins/current fence/events.

`write=true` calls existing `protectTask` inside the same transaction; any legacy claim, even expired, rejects before marker. `implementation`/`integration` cannot request `write=false`; read-only review does not accept output or change mode. A legacy writer cannot coexist with a new write owner. Task business status must be new/in_progress, not backlog/review/done; this is a reservation guard, not automatic selection. Other item ids can have independent reservations; no assertion of physical workspace uniqueness from a string path. Reservation does not set running or spawn an attempt.
- [x] **3. Проверить stale source и requirements change.** Source-guard from task 3 checks live exact owner tuple at publication/completion; wrong owner/project/revision/fence and MAX_SAFE_INTEGER/NaN/Infinity/negative values leave result/audit untouched. Read validation of a previously valid output checks historical source provenance rather than requiring a still-live credential; ordinary confirmed stop/revoke does not invalidate completed verified outputs. A new fence or changed input/revision makes stale output unusable. After reserving a child, edit its unprotected parent's body and assert readiness/reservation/publication fail while owner's persisted inputs/revision stay identical. Revised definition is denied while any live owner exists. Manual stop flag closes reservation independently of dependencies.
- [x] **4. RED handoff with unresolved launch.**

```ts
it('holds a launched owner on missing/throwing observer and rejects never_started JSON', async () => {
  const f = fixture(), task = f.task('owned');
  const item = core.createWorkItem(f.handle, { task: f.ref(task.id),
    definition: { kind: 'implementation', repoId: null, sourceTasks: [], outputs: [] }, dependencies: [] });
  const owner = core.reserveWorkItem(f.handle, { ref: item.ref, expectedRevision: 1, expectedFence: 0,
    expectedMode: 'manual', ownerId: 'controller:a', write: true });
  core.recordLaunchIntent(f.handle, { owner: owner.ref, intent: { launchId: 'launch:1', writerScopeId: 'writers:1' } });
  const transfer = core.beginHandoff(f.handle, { commandId: 'handoff:1', task: f.ref(task.id),
    expectedMode: 'manual', targetMode: 'orchestrated', expectedOwners: [owner.ref] });
  expect(await core.finishHandoff(f.handle, { handoffId: transfer.id })).toEqual({
    status: 'held', handoffId: transfer.id, reason: 'missing_observer' });
  expect((await core.finishHandoff(f.handle, { handoffId: transfer.id },
    async () => { throw new Error('observer unavailable'); })).status).toBe('held');
  expect((await core.finishHandoff(f.handle, { handoffId: transfer.id },
    async () => ({ verdict: 'never_started' } as unknown as core.StopObservation))).status).toBe('held');
  expect(core.ownership(f.handle, owner.ref).releasedAt).toBeNull();
  expect(core.mustGetTask(f.db, task.id).execution_mode).toBe('manual');
});
```

- [x] **5. Реализовать durable intent и stop-before-commit.** `recordLaunchIntent` requires exact live owner/current inputs/no active handoff; repeat same tuple/intent is idempotent, different launch identity is denied. If authority is supplied, match exact live #145 task/work/run/generation and grant ownership tuple. Write launch metadata/event before any future spawn. No method clears it to NULL; launch intent without runtime id still means potentially launched.

`beginHandoff` validates task ref/expectedMode/targetMode, no legacy claim and exact sorted set of live owner tuples for work items of that card only. Freeze snapshot of owner rows (including launch metadata) and matching modeled authority ids/generations. Repeated command returns same intent/receipt; conflicting command replay is refused. Another active intent refuses. Intent blocks new reservations, revision activation, launch-intent changes and new grants for target task. Do not touch children or release anything here.

`finishHandoff` reads intent/snapshot, then invokes observer for every launched owner **outside** a SQLite transaction. For unlaunched owners core itself derives `never_started` from persisted absence of launch intent, and does not accept it from callback JSON. Launched owner needs nonempty observation id, exact project/work/revision/owner/fence/launch/writerScope, finite current observedAt, `complete=true`, nonempty unique writer ids, every writer gone and verdict stopped. Missing/throwing/unknown/incomplete/live/stale observation appends bounded diagnostics and retains all owners/mode/credentials/intent; no partial release if one of several owners is still alive.

Final immediate transaction re-reads intent, mode, current item revisions/fences, owner set/rows, launch identity and modeled authority identity tuples. Captured authorities may already be revoked/expired while stop is pending: their immutable id/task/work/run/generation tuple must still match, and no new grant may have appeared since intent. Monotonic revoke/clock expiry does not invalidate a real stop proof or permanently strand the intent; it also never supplies stop proof itself. Changed owner/launch/revision/new-grant snapshot returns held; no stale observation releases a later owner. On match, release all reservations with release_handoff_id, invoke `revokeRunAuthority` for matching credentials still live, update chosen card mode, store receipt/completed_at and append `execution_handoff_completed` atomically. Replay returns same receipt without events. Keeping `targetMode===expectedMode` is allowed for confirmed release without changing control mode. For a card with no owners, expectedOwners=[] and no legacy claim, the same protocol provides explicit mode change without requiring an unnecessary stop observer. Protected policy is retained in every path.
- [x] **6. D08/D09/D11 guards и credential rotation.** Assert fresh grant for modeled item requires exact ownership, matching writable definition repo and no handoff; wrong repo/null repo/read-only owner cannot acquire a product-write grant, while existing unmodeled #145 grants still work. Rotate native-verified credential using existing authority test fixture; generation increases independently while ownership fence stays fixed. Revoked/expired credential, business move/reason/user Actor and synthetic run report cannot release or reserve; marker rejects old mutation paths. Revoke a captured credential while intent is held, then supply valid stop observation and assert handoff completes without a permanently stale credential snapshot. Read-only report/question is never result publication. After confirmed never-started handoff, all matching credentials revoked, one receipt/event, old owned publication denied, next owner has fence+1 and new mode. Child modes/reservations remain unchanged. Conflicting handoff retry, omitted owner, forged handle, other store and mixed valid/invalid tuples create no partial intent/release.
- [x] **7. Review Focus 5 / D10 real process-tree fixture.** Put this Node-only fixture in `test/fixtures/execution_tree.mjs` (no product imports):

```js
import { fork } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const [role, scope, artifact] = process.argv.slice(2);
if (role === 'writer') {
  process.send?.({ ready: true, scope, pid: process.pid });
  setInterval(() => appendFileSync(artifact, `${scope}\n`), 25);
} else {
  const child = fork(fileURLToPath(import.meta.url), ['writer', scope, artifact],
    { execPath: process.execPath, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.once('message', message => process.send?.({ ...message, parentPid: process.pid, childPid: child.pid }));
  process.on('message', message => { if (message === 'exit-parent') process.exit(0); });
}
```

 Test records intent with unique writerScope before forking. Await IPC ready, record both pids in test observer's private fixture state, then request parent-only exit. A bound observer uses actual `process.kill(pid,0)` probes and process exit events for this tree; live child returns verdict live despite dead parent. Handoff remains held and a second reservation is refused. Kill child, await its actual disappearance with bounded 5s check/timeout, then stopped observation for both scoped writer ids completes handoff. Mismatched fence/launch/scope, an unknown writer or `complete=false` stays held. `finally` kills/reaps both fixture processes and closes temp stores even on assertion failure. Never use a bare stale pid to claim production stop; the fixture scope and observed child lifecycle are the evidence here, runtime identity/probe adapter belongs to #150.
- [x] **8. GREEN и commit.** Run `pnpm --dir packages/core exec vitest run test/execution_ownership.test.ts test/execution_results.test.ts test/authority.test.ts test/managed_mutations.test.ts`, `pnpm --dir packages/core typecheck`, `pnpm build`, `git diff --check`. Commit `feat(core): fence reservations and controller handoff` with exact source/test/fixture/generated files.

### Task 5: Legacy exclusion и сохранённые read/transport contracts

**Files:** modify `packages/core/src/authority.ts`, `claim.ts`, `queries.ts`, `brief.ts`, `types.ts`; modify `packages/core/test/claim.test.ts`, `queries.test.ts`, `brief.test.ts`, `managed_mutations.test.ts`; modify `packages/ui/src/web/api.ts` and the four Task fixture files listed above; modify `packages/cli/test/contracts.test.ts`, `packages/mcp/test/server.test.ts`, `run_server.test.ts`, `packages/ui/test/server.test.ts`.

**Interfaces:** consumes persisted `tasks.parent_id/execution_mode`, `execution_handoffs.completed_at`, managed marker and existing transport handlers. Preserves every existing mutation signature and six global MCP tools; scoped tools remain the granted subset of `get_context|submit_report|request_question`. Produces `TaskBrief.task.parent_id: number|null`, `.execution_mode: ExecutionMode`, and `NextAction.kind` additionally allowing `'await_controller'`. Existing `taskDetail`/capped/board functions retain signatures; explicit graph/children reads are task 1/2/3 APIs and don't add a full graph to legacy packets.

- [x] **1. RED core legacy explicit/auto selection.**

```ts
it('excludes an orchestrated task from explicit and queued legacy claims', async () => {
  const f = fixture(), orchestrated = f.task('orch'), manual = f.task('manual');
  const intent = core.beginHandoff(f.handle, { commandId: 'mode:orch', task: f.ref(orchestrated.id),
    expectedMode: 'manual', targetMode: 'orchestrated', expectedOwners: [] });
  expect((await core.finishHandoff(f.handle, { handoffId: intent.id })).status).toBe('complete');
  const actor = { type: 'user' } as const;
  expect(core.claimTask(f.db, orchestrated.id, actor).ok).toBe(false);
  expect(core.claimNext(f.db, actor)?.id).toBe(manual.id);
  expect(core.mustGetTask(f.db, orchestrated.id).claimed_by).toBeNull();
});
```

Run `pnpm --dir packages/core exec vitest run test/claim.test.ts`; expected orchestrated explicit claim incorrectly succeeds before new predicate.
- [x] **2. Общий handoff guard и все legacy claim paths.** Extend `assertLegacyTaskMutation` to reject selected task ids with active execution_handoffs as well as existing managed policy. Keep its checks before Actor/reason bypasses. In `claim.ts` add `execution_mode='manual'` and no active handoff to `CLAIMABLE_SQL` and claim UPDATE CAS; explicit `claimTask` checks mode before reap and again in transaction, returning `{ok:false,error:'orchestrated task requires controller execution'}`. `renewClaim` returns the same refusal, `releaseClaim`/`recordFailedAttempt` reject nonmanual mode. `expiredLeases`, stopWorkers selection and reclaim clear predicates exclude orchestrated/managed/handoff rows **before** any kill callback. No writer release via TTL on new owner table.

Selection predicate to combine with existing claim conditions:

```sql
execution_mode='manual'
AND NOT EXISTS (SELECT 1 FROM managed_task_policy p WHERE p.task_id=tasks.id)
AND NOT EXISTS (SELECT 1 FROM execution_handoffs h WHERE h.task_id=tasks.id AND h.completed_at IS NULL)
```

Test mixed sets: manual old tick lease is passed to killer/reclaimed as before; orchestrated/managed/handoff ids never reach callback or count as released. If mode/intent changes during outside-transaction stop observation, re-read/CAS refuses stale clear. Plain legacy task status/self-accept/claim/reclaim semantics remain unchanged. `autonomy_enabled` and project default do not activate a new scheduler.
- [x] **3. RED metadata и brief budget.**

```ts
it('keeps parent/mode without expanding the resume packet into a graph', async () => {
  const f = fixture(), parent = f.task('parent');
  const child = core.createSubtasks(f.handle, { parent: f.ref(parent.id),
    expectedParentHash: core.taskContractHash(f.handle, f.ref(parent.id)),
    source: { kind: 'manual', sourceTask: f.ref(parent.id), instructionRef: 'split' },
    children: [{ key: 'child', title: 'child', criteria: ['outcome'], executionMode: 'orchestrated' }] }).child;
  const brief = core.taskBrief(f.db, join(f.repo, '.planning', 'decisions'), child.id);
  expect(brief.task.parent_id).toBe(parent.id);
  expect(brief.task.execution_mode).toBe('orchestrated');
  expect(brief.next_action.kind).toBe('await_controller');
  expect(Buffer.byteLength(JSON.stringify(brief), 'utf8')).toBeLessThanOrEqual(4096);
  expect(core.taskDetailCapped(f.db, child.id).task.parent_id).toBe(parent.id);
});
```

- [x] **4. Реализовать bounded reads.** Add parent/mode to explicit TaskBrief projection; browser `Task` type repeats these two required fields (SQLite stays server-only), update Task literals to null/manual. `READY_SQL` reflects legacy claimability for mode/managed/handoff with existing new/unblocked/unarchived/kind predicates. Keep task graph outside taskBrief/taskDetailCapped and existing omitted counts/budget intact. After existing archived/done/blocker next-action precedence, orchestrated or protected/handoff task returns `await_controller`; no legacy “start work” or autonomous claim instruction for it. Managed manual after takeover still requires controller action; ordinary manual retains previous next action. No renderer, UI control, route or owner tool is introduced.
- [x] **5. D12 real transport regressions.** Existing helpers are `makeEnv()/kdd(env,...args)` in CLI `test/run.ts`, `connect(db)/textOf(result)` in MCP server tests, and `mk():{db,app}` in UI server tests. Add concrete tests using those helpers:

```ts
// packages/cli/test/contracts.test.ts (imports new core APIs and kddFail).
it('refuses legacy CLI claim after host switched a task to orchestrated', async () => {
  const db = openDb(env.KDD_DB!, 'mode-cli'), task = addTask(db,
    { title: 'orchestrated', criteria: ['proof'] }, { type: 'user' });
  const handle = openController(db), ref = { projectId: projectOf(db).project_id, taskId: task.id };
  const intent = beginHandoff(handle, { commandId: 'mode', task: ref,
    expectedMode: 'manual', targetMode: 'orchestrated', expectedOwners: [] });
  await finishHandoff(handle, { handoffId: intent.id });
  const before = db.prepare('SELECT * FROM tasks').all();
  expect(kddFail({ ...env, KDD_ACTOR: 'user' }, 'claim', String(task.id)).stderr).toMatch(/orchestrated/);
  expect(db.prepare('SELECT * FROM tasks').all()).toEqual(before); db.close();
});
// packages/mcp/test/server.test.ts: add inside existing describe.
it('returns parent/mode over MCP without adding owner tools', async () => {
  const db = openDb(':memory:', 'mode-mcp'), task = addTask(db, { title: 'manual' }, ai);
  const client = await connect(db);
  try {
    const detail = textOf(await client.callTool({ name: 'get_task', arguments: { id: task.id } }));
    expect(detail.task).toMatchObject({ parent_id: null, execution_mode: 'manual' });
    expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(
      ['get_task', 'list_projects', 'list_tasks', 'list_tracks', 'recall', 'update_task']);
  } finally { await client.close(); db.close(); }
});
// packages/ui/test/server.test.ts: read-only metadata through the actual HTTP handler.
it('returns mode metadata through the existing board route', async () => {
  const { db, app } = mk(); addTask(db, { title: 'manual' }, user);
  const response = await app.request('/api/board');
  const board = await response.json() as Record<string, { parent_id: number|null; execution_mode: string }[]>;
  expect(board.new[0]).toMatchObject({ parent_id: null, execution_mode: 'manual' }); db.close();
});
```

Retain and run #144 backend recall empty/conflicting decisions tests in core/MCP: primary decisions and decision FTS rows unchanged, original project/store still discovered after registry deletion/rebind. Retain #145 native-store-in-scratch rejection before marker, GET-only scoped server test, revoked/stale context tests, user/reason/ordered-id/file/track bypass matrix. Existing read-only scoped tools never expose new model mutations.
- [x] **6. GREEN и commit.** Run `pnpm build` first for built CLI/package imports, then `pnpm --dir packages/core exec vitest run test/claim.test.ts test/brief.test.ts test/queries.test.ts test/managed_mutations.test.ts test/project_store.test.ts`, `pnpm --dir packages/cli exec vitest run test/contracts.test.ts`, `pnpm --dir packages/mcp exec vitest run test/server.test.ts test/run_server.test.ts`, `pnpm --dir packages/ui exec vitest run test/server.test.ts`. Run `pnpm exec turbo run typecheck --force`, `git diff --check`. Commit `fix(core): keep managed work out of legacy execution` with exact source/test/generated files.

### Task 6: Межпроцессные гонки, D01–D12 и свежие общие gates

**Files:** create `packages/core/test/execution_races.test.ts`, `packages/core/test/fixtures/execution_race.mjs`, `execution_race.d.mts`, `.planning/research/orchestration/dependencies-check.mjs`, `dependencies-evidence.json`; update ignored `.superpowers/sdd/2026-09-28-subtasks-dependencies/progress.md` and measurement JSONs. Change production source only if these checks reproduce a violation, then repeat the affected owning-task checks.

**Interfaces:** consumes the compiled exports from tasks 1–5; no new product API. Shared test/research fixture exports `runRace(dbPath,requests): Promise<RaceOutcome[]>`. Its adjacent `.d.mts` declares exact types:

```ts
import type { ReserveWorkItemInput, reviseWorkItem } from '../../src/index.js';
export type RaceRequest = { op: 'reserve'; input: ReserveWorkItemInput } |
  { op: 'revise'; input: Parameters<typeof reviseWorkItem>[1] };
export interface RaceOutcome { ok: boolean; error?: string; value?: unknown }
export function runRace(dbPath: string, requests: readonly [RaceRequest, RaceRequest]): Promise<RaceOutcome[]>;
```

The JS fixture is shared by the Vitest race test and standalone observer; it imports `../../dist/index.js`. `dependencies-check.mjs` imports `../../../packages/core/dist/index.js` and `../../../packages/core/test/fixtures/execution_race.mjs`; no source/Vitest imports or test mock callbacks masquerade as native proof.

- [x] **1. Написать RED race tests до worker fixture.** Each family uses one file-backed `fixture()` and **20 rounds** with fresh work-item ids, not two in-process handles. Test both family invariants:

```ts
it('serializes twenty opposing-edge races across separate processes', async () => {
  const f = fixture();
  const definition: core.WorkItemDefinition = { kind: 'analysis', repoId: null, sourceTasks: [],
    outputs: [{ key: 'contract', kind: 'contract', required: true, version: 'v1', checkRefs: [] }] };
  for (let round=0; round<20; round++) {
    const a = core.createWorkItem(f.handle, { task: f.ref(f.task(`a${round}`).id), definition, dependencies: [] });
    const b = core.createWorkItem(f.handle, { task: f.ref(f.task(`b${round}`).id), definition, dependencies: [] });
    const proposal = (consumer: core.WorkItemRecord, producer: core.WorkItemRecord) => ({
      ref: consumer.ref, expectedRevision: 1, definition,
      dependencies: [{ key: 'needs', producer: producer.ref, producerRevision: 1, outputKey: 'contract',
        binding: { kind: 'contract' as const, repoId: null, version: 'v1' } }],
    });
    const outcomes = await runRace(f.dbPath, [
      { op: 'revise', input: proposal(a,b) }, { op: 'revise', input: proposal(b,a) },
    ]);
    expect(outcomes.filter(o => o.ok)).toHaveLength(1);
    expect(outcomes.find(o => !o.ok)?.error).toMatch(/cycle|revision/);
    const current = [core.workItem(f.handle,a.ref), core.workItem(f.handle,b.ref)];
    expect(current.flatMap(w => w.dependencies)).toHaveLength(1);
    expect(current.map(w => w.revision).sort()).toEqual([1,2]);
  }
}, 120000);
it('keeps exactly one live reservation in twenty separate-process races', async () => {
  const f = fixture();
  for (let round=0; round<20; round++) {
    const item = core.createWorkItem(f.handle, { task: f.ref(f.task(`owner${round}`).id),
      definition: { kind: 'implementation', repoId: null, sourceTasks: [], outputs: [] }, dependencies: [] });
    const input: core.ReserveWorkItemInput = { ref: item.ref, expectedRevision: 1, expectedFence: 0,
      expectedMode: 'manual', ownerId: 'a', write: true };
    const outcomes = await runRace(f.dbPath, [{ op: 'reserve', input },
      { op: 'reserve', input: { ...input, ownerId: 'b' } }]);
    expect(outcomes.filter(o => o.ok)).toHaveLength(1);
    expect(outcomes.find(o => !o.ok)?.error).toMatch(/owner|fence/);
    expect(f.db.prepare('SELECT count(*) n FROM work_item_owners WHERE work_item_id=? AND released_at IS NULL')
      .get(item.ref.workItemId)).toEqual({ n: 1 });
    expect(core.workItem(f.handle,item.ref).fence).toBe(1);
  }
}, 120000);
```

Import `runRace` from `./fixtures/execution_race.mjs`. Run `pnpm --dir packages/core exec vitest run test/execution_races.test.ts`; expected missing fixture/worker failure. If core invariants fail after fixture exists, fix the shared core transaction/CAS, not a test retry.
- [x] **2. Реализовать actual IPC barrier worker.** The shared JS fixture has these entry and parent function. Every child sends ready **after opening its own SQLite connection**; parent releases both only after both ready. Add bounded error/exit handling and a 10s per-race timeout with cleanup, never count timeout/database-busy/unexpected worker exit as a legitimate rejected contender:

```js
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as core from '../../dist/index.js';
const entry = fileURLToPath(import.meta.url);
export async function runRace(dbPath, requests) {
  const children = requests.map(() => fork(entry, [dbPath], {
    execPath: process.execPath, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  }));
  const message = child => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('race worker timeout')), 10000);
    const finish = (error, value) => {
      clearTimeout(timer); child.off('error', failed); child.off('exit', exited); child.off('message', received);
      error ? reject(error) : resolve(value);
    };
    const failed = error => finish(error);
    const exited = code => finish(new Error(`race worker exited ${code}`));
    const received = value => finish(null, value);
    child.once('error', failed); child.once('exit', exited); child.once('message', received);
  });
  try {
    const ready = children.map(message);
    children.forEach((child,i) => child.send({ request: requests[i] }));
    const acknowledgements = await Promise.all(ready);
    if (!acknowledgements.every(value => value.ready === true)) throw new Error('race barrier incomplete');
    const results = children.map(message); children.forEach(child => child.send('go'));
    return await Promise.all(results);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}
if (process.argv[1] === entry) {
  const db = core.openDb(process.argv[2]), handle = core.openController(db);
  let request;
  process.on('message', message => {
    if (message !== 'go') { request = message.request; process.send({ ready: true }); return; }
    let response;
    try {
      if (request.op === 'reserve') response = { ok: true, value: core.reserveWorkItem(handle,request.input) };
      else if (request.op === 'revise') response = { ok: true, value: core.reviseWorkItem(handle,request.input) };
      else throw new Error('unknown race operation');
    } catch (error) { response = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    db.close(); process.send(response, () => process.disconnect());
  });
}
```

Before returning from `runRace`, await child close/reap promises so no SQLite connection survives the round; on timeout remove listeners and reap killed children. Child stderr is captured only for failure diagnostics and contains no token. Parent verifies persisted rows/event counts/DAG, not just reported `ok`. Independent work items must both reserve in a separate two-request round, with two live rows and no shared-task false exclusion.
- [x] **3. Написать standalone observation D01–D12.** `dependencies-check.mjs` uses Node `assert/strict`, direct file/Git/process reads and only fresh compiled core. Create private temp home/source/backend/frontend repos, genuine local contract artifacts, raw historical v14 DB fixture and compatible external store. Use the exact arrange/action/assert cases in tasks 1–5 to produce twelve records; observation names and measurable postconditions are fixed below. The script calls `runRace` for another 20+20 rounds and the real process-tree fixture for D10; it does not infer success from Vitest status.

Output envelope/termination:

```js
const evidence = {
  observedAt: new Date().toISOString(), node: process.version,
  runtimeHash: createHash('sha256').update(readFileSync(new URL('../../../packages/core/dist/index.js', import.meta.url))).digest('hex'),
  schema: 15, checks: [], raceRounds: { edges: 20, reservations: 20 },
};
const record = (id, details) => evidence.checks.push({ id, outcome: 'pass', ...details });
// Each record follows its successful assertions; failures throw before printing a pass envelope.
// Actual ids, pins, fence values and handoff receipt ids are stored, never authority tokens.
assert.deepEqual(evidence.checks.map(c => c.id),
  ['D01','D02','D03','D04','D05','D06','D07','D08','D09','D10','D11','D12']);
process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
```

The middle consists of the twelve concrete cases in the following matrix, not unconditional `record` calls. In finally, close/reap fixture processes and DB handles, restore env and remove temp root. D12 additionally invokes built CLI and existing MCP/HTTP handlers with their real protocols against isolated stores; user Actor env is fixture-only. Preserve `.planning/research/orchestration/authority-check.mjs` and `project-store-check.mjs` assertions and execute both against v15. Old calibration/native JSON is never input to verification.

- [x] **4. GREEN races/model и сохранить observations.** Run `pnpm build`, `pnpm --dir packages/core exec vitest run test/execution_races.test.ts test/execution_ownership.test.ts`, then:

```bash
node .planning/research/orchestration/dependencies-check.mjs > .planning/research/orchestration/dependencies-evidence.json
node .planning/research/orchestration/project-store-check.mjs > .superpowers/sdd/2026-09-28-subtasks-dependencies/store-regression.json
node .planning/research/orchestration/authority-check.mjs > .superpowers/sdd/2026-09-28-subtasks-dependencies/authority-regression.json
```

Expected D01–D12 all pass, 20/20 edge races with one commit each and 20/20 reservation races with one owner each, store 8/8 and authority 7/7 without lost protected bytes/rows. Record actual counts, don't rename an assertion failure into an unsupported scenario.
- [x] **5. Свежие package и plugin gates отдельно.** Run `pnpm exec turbo run test --force --only --concurrency=1 -- --maxWorkers=2`, `pnpm exec turbo run typecheck --force --only`, `pnpm test:codex-plugin`, `git diff --check`. Expected all four packages pass both test and typecheck, plugin installer/hooks/scoped broker smoke passes. Dependencies were freshly built before these gates; `--only` runs all four actual test/typecheck tasks without rebuilding or removing runtime files during native probes. Verify the compiled hashes stay unchanged. Capture actual suite counts/exit codes. A test pass is not a typecheck pass; previous 937 tests are baseline, not future #146 proof.
- [x] **6. Native/scoped regression на свежем runtime.** Controller/authority/shared guards changed, so execute actual full-operations and context-only native broker entries, without `--calibrate`:

```bash
node .planning/research/orchestration/codex-broker-check.mjs > .superpowers/sdd/2026-09-28-subtasks-dependencies/native-full.json
node .planning/research/orchestration/codex-broker-check.mjs --context-only > .superpowers/sdd/2026-09-28-subtasks-dependencies/native-context-only.json
```

These use real Codex shell/apply_patch and the shared production preflight; full native matrix, existing hardlink/symlink checks, DB-in-scratch denial before marker, broker operation subset and fresh permission package binding must pass. If the installed CLI has advanced beyond the #145 allowlist, `KDD_CODEX_EXECUTABLE` may select an isolated official 0.157.0 binary verified against its release digest; the shared preflight still validates the version and executable hash. Run the two isolated scripts concurrently only if independent fixtures/config paths are confirmed; wait/poll no longer than 60s per tool call and report progress. Failed/inconclusive/incomplete native evidence blocks completion; do not weaken #145 conditions or use saved old runtime hash as new proof. No product execution/role/scheduler is thereby implemented.
- [x] **7. Commit проверяемую реализацию и обновить карточку.** If any fixes occurred after gates, rebuild and repeat only affected checks plus guards whose behavior changed. Stage exact tests/fixtures/research evidence/generated consumers and commit `test(core): verify dependency and ownership invariants`. Record D01–D12 actual evidence, core runtime hash, 396/397 mapping, scope limits and all gate exits in ignored ledger and #146 compatible installed MCP comment. Check criteria through compatible v13 bookkeeping with evidence only now, then move task to review. Do not mark done, squash or push without owner's subsequent request.

## Приёмка и трассировка спецификации

| ID | Где проверяется | Конкретный postcondition standalone observer |
| --- | --- | --- |
| D01 | Task 1 migration; task 6 | v14 backup читается; old rows/project/repo/decisions/FTS/markers/grants равны; старые tasks manual/root; new owners/launches 0; второй open без дублей |
| D02 | Tasks 1/2/4 | Несколько durable child ids, one-level FK/trigger отказы атомарны; foreign numeric collision не принят; источник отделён; parent mode change не меняет детей |
| D03 | Tasks 2/3 | Ноль parent/legacy-link execution edges; независимые siblings ready; dependent закрыт до точного producer/output/result, затем pin совпадает |
| D04 | Tasks 2/6 | Межзадачный graph доступен, self/cycle/revision отказ сохраняет snapshot; 20 opposing-process rounds дают один commit и DAG |
| D05 | Task 3 | Status/comment/checkbox/exit/report не открывают edge; mandatory real hashed contract + completed producer открывает только требуемые edges; failed/cancelled/waiting закрыты |
| D06 | Tasks 2/3 | Backend code edge отказан без frontend HEAD/ref changes; backend API artifact/hash/repo/version pin сохранён; code/merged/readiness без точного proof закрыты |
| D07 | Tasks 2/3/4 | Requirements edits → stale; nonrequirement edits не stale; invalidated/superseded payload остаётся в истории; active owner не переехал; command replay 1 result, conflicting replay отказ |
| D08 | Tasks 4/6 | 20 separate-process rounds → 1 live owner/fence=1; separate items → 2 owners; stale fence publication даёт 0 result/event writes |
| D09 | Task 4 | Missing/throw/unknown/live observer удерживает owner+intent+mode; grant revoke/expiry не освобождает; never-started confirmed transfer → receipt, atomic mode, следующий fence+1 |
| D10 | Tasks 4/6 | Launch intent без runtime id не освобождён как never_started; реальный живой child удерживает ownership; оба scoped fixture writers остановлены → handoff completed |
| D11 | Tasks 1/4/5 | Forged handle/RunContext/Actor/reason/report не разрешают mutations/check outcome; managed policy существует после manual takeover |
| D12 | Tasks 5/6 | Plain legacy CLI/MCP/UI и #144 store/decision protections проходят; explicit/queued legacy claim orch отказан; global/scoped tool sets прежние; product agent launches 0 |

Spec §1–2/8 → tasks 1/5/6; §3 → tasks 1/2/4; §4 → task 2; §5 → task 3; §6 → task 4; §7 → tasks 1–5; §9 → task 6/matrix; §10 grounding already recorded and not replaced by invented reference evidence. Критерий 396 — D03–D07, критерий 397 — D08–D11.

## Самопроверка плана и передача

Перед commit документа сверить 12/12 D-cases и пять Review Focus с owning tests, все relative links, closed interfaces/signatures и отсутствие незаполненных шагов. Проверить DDL на изолированной in-memory v14 fixture как syntax/constraint check документа; не называть это реализационной приёмкой #146. Убедиться, что saved spec approval не означает approval плана и все execution checkboxes ещё пустые.

Владелец утвердил план `349100a` и поручил начать реализацию solo на текущей ветке. Результаты execution отмечаются выше; свежие native и общие gates обязательны перед review #146.

Самопроверка документа выполнена 2026-09-28: 6 tasks, 42 незавершённых execution steps, D01–D12 и 5 Review Focus связаны с owning checks; relative spec link существует; 23 TS/JS блока разобраны без syntax errors. Proposed DDL выполнен поверх изолированной in-memory v14: legacy manual/root, one-level parent, immutable revisions/results, unique live owner и deferred atomic supersede проверены; foreign_key_check пуст. Это validation документа, не выполненная приёмка реализации. Запись — `.superpowers/sdd/2026-09-28-subtasks-dependencies/plan-check.json`; критерии 396/397 не отмечены.


## Свежие результаты реализации #146

Реализация выполнена solo в шесть этапов. Миграции 1–14 сохранены без изменений; v15 добавляет один уровень подзадач и core-модель исполнения. Обнаруженный при проверке v15 отказ scoped broker исправлен общей проверкой `MIGRATIONS.length`; реальный stdio-тест подтверждает текущую версию и отказ для старой/будущей без миграции. Для неполной native-матрицы добавлена ограниченная диагностика отказа; условия выдачи permission package сохранены.

На окончательной сборке: core 483/483, CLI 215/215, MCP 78/78, UI 212/212 — 988/988; четыре forced typecheck, fresh-install plugin gate и `git diff --check` прошли. Standalone [D01–D12](../../../.planning/research/orchestration/dependencies-evidence.json) выполнен отдельным процессом через compiled API; 20 opposing-edge races и 20 reservation races, реальный orphaned fixture writer и полная остановка его дерева. Отдельные store #144 8/8 и authority #145 7/7 прошли. Критерий 396 связан с D03–D07; 397 — с D08–D11.

Оба реальных native entry завершились с exit 0: full operations и `get_context` only; каждый выполнил 129 initial, 158 broker-bound и 29 final scenarios, с пятью fail-closed preflight refusals в заключительном наблюдении и без failures. Пакеты выданы production preflight; calibration и сохранённые старые proof не использовались. В обоих entry также прошли DB-in-scratch отказ до marker, private credential rotation, late hardlink, start/resume Git binding и public config binding guards.

Проверен изолированный официальный Codex 0.157.0: archive SHA256 `97809f91cb355e55480cd7a126f9ad24bb7b162222515e30286bcac6fba94acd`, executable SHA256 `ad0be20d04e2ba6146ecdb51d7f8b7b0fe15420a15dc9b0057518d858f1f3714`. Установленный 0.157.1 повторно отвергнут shared preflight; его поддержка не заявлена. Полные native/package/typecheck/plugin logs находятся в `.superpowers/sdd/2026-09-28-subtasks-dependencies/`. Предыдущие неуспешные прогоны сохранены отдельно и не считаются положительной проверкой.

SHA256 `packages/core/dist/index.js`: `354471f247836a203649c82ffe06732109e6e12cb3240a9a18f9e6e86d4db80e`; compiled core/MCP/CLI/UI hashes проверены неизменными после native gate. Production agent launches: 0; run/workflow/roles/scheduler/owner transports остаются задачами #149–#161 по границам спецификации. Actual board schema 13 не открывалась development runtime; bookkeeping выполняется совместимыми установленными средствами.

## Исправления после ревью #146

Оба замечания ревью `cb7e7a8…e233d21` исправлены: mandatory check request привязан к SHA-256 полного канонического payload, source authority переиспользует актуальный scoped grant validator. Две регрессии сначала дали RED, затем GREEN: unchecked replacement и stale BA proposal отклоняются без новых rows/events; проверенный payload и актуальный source остаются допустимыми. Отказ source проверен также для атомарного создания subtask plan.

На исправленной сборке: core 485/485, CLI 215/215, MCP 78/78, UI 212/212 — 990/990; четыре forced typecheck, fresh-install plugin и D01–D12 прошли. Оба реальных native entry вновь завершились с exit 0 на официальном Codex 0.157.0: по 129 initial, 158 broker-bound и 29 final scenarios, 5 fail-closed preflight refusals и 12 outer checks, failures пусты. Проверены grants с тремя operations и только `get_context`; прежний proof не подменяет этот прогон. SHA256 core `7b3ad501dd3df52960bb821c1fbcb72cb5d9755a766d5b525cca3ad298612f41`; core/MCP/CLI/UI и plugin runtime bytes неизменны после native gate. Логи и отдельные compiled-API проверки: `.superpowers/review/146/fixes/`; новая [D01–D12 evidence](../../../.planning/research/orchestration/dependencies-evidence.json) относится к этой сборке. Development runtime не открывал actual v13 board.

### Дополнительные замечания после squash 882e1f9

Внешний compiled-core repro подтвердил пропуск external work-item credentials в handoff и доступность launch/subtasks после invalidation pinned API. Bounded fixes выполняются solo в существующем контракте: snapshot всех grants карточки/связанных work items; unknown writer удерживает переход даже после revoke/expiry; ранее закрытый owner распознаётся только по завершённому handoff. Связи credentials повторно проверяются после stop observer. Общий live-owner guard использует существующий result validator для точных сохранённых pins, включая transitive invalidation, artifact/producer changes и readiness expiry; новые host approvals или Start не создаются.

Перед изменениями наблюдались RED: 3 handoff-регрессии и 4 stale-input-регрессии. После исправления проходят 55/55 профильных тестов, включая использование прежнего BA-report для обоих children APIs, выдачу/операции modeled grant, сохранение owner snapshot и разрешённый stop stale owner. Положительные code/merged inputs и повторный transfer после завершённого handoff также проверены. Исходный compiled repro завершён с exit 0: unknown handoff held/manual, context/launch/children после invalidation запрещены, failures пусты.

Все четыре свежих package test задачи прошли: core 493, CLI 215, MCP 78, UI 212 — 998/998; четыре forced typecheck, fresh-install plugin и D01–D12 прошли. SHA256 исправленного core `98c1bf167fa524a2a459addbf9796ab774dbed8c1db53414ee5e6060abd65bfe`. Оба полных native entry из Task 6 завершились с exit 0 на официальном Codex 0.157.0: production initial preflight и broker-bound package прошли, каждый package содержит 153 исполненных результатов; каждый финальный прогон выполнил 29/29 native-сценариев, пять fail-closed preflight refusals и 12 outer checks, failures пусты. Проверены full operations и `get_context` only; scriptHash/guardHash совпадают с указанным core SHA256, executable SHA256 `ad0be20d04e2ba6146ecdb51d7f8b7b0fe15420a15dc9b0057518d858f1f3714`. Все семь runtime hashes неизменны после native gate. Логи этой проверки сохраняются отдельно в `.superpowers/review/146/fixes-2/`; [D01–D12 evidence](../../../.planning/research/orchestration/dependencies-evidence.json) обновлена для этой сборки. Actual v13 board не открывалась development runtime.
