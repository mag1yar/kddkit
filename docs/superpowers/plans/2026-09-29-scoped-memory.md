# Scoped memory — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Реализовать core-память project/task/subtask с неизменяемыми revisions, проверяемыми источниками и фильтрацией scope до FTS.

**Architecture:** Migration v16 добавляет memory_entries и memory_revisions в существующий store. Core применяет authentic controller/run guards, CAS и общий scope predicate; recall строит временный FTS только из допустимых records. Git import читает выбранный blob без изменения checkout, а legacy decisions/index остаются независимыми.

**Tech Stack:** Node.js ≥22, TypeScript/ESM/NodeNext, установленный better-sqlite3, Vitest и Node stdlib. Реальные temp Git/SQLite/process fixtures; macOS/Codex 0.157.0 для native regression. Новых dependencies нет.

**Spec:** [Подтверждённая спецификация](../specs/2026-09-28-scoped-memory-design.md), утверждённый пользователем commit `f026fd06dd60b5148473d287b704958d964a485f`; ответ 2026-09-29 «Утверждаю, составь план». Исполнитель читает оба документа.

## Global Constraints

- Выбранный route — **solo**. Root исполняет через `superpowers:executing-plans`, проверяет diff и self-review; auxiliary implementer/reviewer не создаются. Generic recommendation в header не меняет сохранённый route. Текущая конфигурация разрешена владельцем, без повторного model approval.
- Текущая ветка `task/143-kanban-orchestrator-contract` сохраняется; base всей #147 — `4cce0833d71faad179f30787b18b1080914abee3`. Не менять preexisting untracked `references/`.
- Пользователь выбрал **«Core сейчас, интерфейсы в #159»**. Ни CLI/global MCP/scoped MCP/HTTP/UI tools, ни RunOperation, tool schemas или native capabilities не расширяются. Get_context response не меняется.
- Context assembly/input snapshot/обязательная инъекция — #148; transports — #159; UI editor — #163; analyser/curator — #165/#167. Полные runtime/workflow/approval/merge модели здесь не создаются.
- Append migration v16; migrations 1–15 и исторические rows неизменны. Ноль auto-imports/auto-starts/approvals/mode changes.
- Kind: fact, decision, rule, candidate. Status текущей revision: active или withdrawn; historical effective status superseded. Active candidate не является подтверждённым знанием/правилом.
- Scope/repo/applicable_commit записи не изменяются. Code fact имеет repo_id и полный Git commit SHA; применимость **строго к declared commit**, без автоматического ancestor/branch/main fallback.
- Все мутации требуют authentic ControllerHandle. Actor/type=user/reason/report pass не являются authority. Active decision/rule требуют user observation; active fact — host evidence; run source разрешает только candidate собственной task/subtask области.
- Recall сначала выбирает допустимый corpus, потом MATCH/snippet/BM25/LIMIT. O(n) corpus на запрос — принятый предел; не добавлять глобальный top-k с последующим отбрасыванием.
- Наследование project → root task → subtask, без siblings/children conversations или автоматического dependency memory grant. Применимые rules не зависят от k/keyword.
- Не изменять legacy decisions/search_index/recall/rebuild и decision Markdown. Import выбранный и идемпотентный, Git reads без checkout/reset/stash/commit/export.
- Fixtures изолированы от `/Users/magiyar/.kdd/94a99e3bba1c50dd/kdd.db` (реальная доска v13). Progress — совместимый установленный MCP; dev core/CLI на настоящей доске не запускать.
- Коммиты локальные conventional, без board ids/body/trailer; push запрещён. #147 остаётся review после проверки; done — только по слову владельца.

## Review Focus

1. Другая DB с тем же numeric task id, JSON-копия handle или известный foreign memory id: отказ через все read/write paths, не только recall. Tests tasks 1/2/4.
2. Очень много sibling hits, k=1 и отличающиеся BM25 statistics: разрешённый результат и порядок не меняются. Test task 2.
3. Candidate/import уже исправлен или withdrawn, затем повтор исходного command/import: нет оживления старой revision и отката current pointer; новый import alias id нельзя переиспользовать с другим payload. Tests tasks 1/3/5.
4. Source report существует, но generation/revoke/ownership/input results изменились: он не подтверждает новый candidate, а RunContext не читает память. Test task 4 и genuine native-issued context task 6.
5. Receipt относится к прежнему body/hash/operation, Git path — symlink/traversal/private config, source bytes не UTF-8 или больше cap: отказ до revision/event. Tests tasks 1/3.

---

## Файлы и ответственность

| Файл | Назначение |
| --- | --- |
| `packages/core/src/schema.ts` | Только append v16, FK/CHECK/UNIQUE/immutability triggers |
| `packages/core/src/memory.ts` (new) | Types, validation/source/evidence, atomic write/revision/replay, internal scoped record selection |
| `packages/core/src/memory_query.ts` (new) | Host read/list/history/rules/recall; ephemeral isolated FTS и bounded hits |
| `packages/core/src/memory_import.ts` (new) | Registered Git binding, selected blob validation, import key и запись через общий writer |
| `packages/core/src/authority.ts` | Core run read и internal report-source validation через existing live/currentAuthority; старые transports/guards сохраняются |
| `packages/core/src/index.ts` | Точные public exports memory API/types, без внутренних DB/grant helpers |
| `packages/core/test/memory_fixture.ts` (new) | Thin wrapper существующего execution_fixture, явные fixture receipts и cleanup |
| `packages/core/test/memory.test.ts`, `memory_query.test.ts`, `memory_import.test.ts`, `memory_races.test.ts` (new) | Revisions/evidence, scope/FTS, Git import/legacy isolation и 20 process races |
| `packages/core/test/authority.test.ts` | Existing real DB/Git grant fixture, новые run memory guards; unit native packet остаётся явно unit-only |
| `packages/core/test/execution.test.ts` | Future-schema test: `MIGRATIONS.length + 1` вместо сегодняшнего hardcoded 16 |
| `packages/core/test/fixtures/execution_race.mjs`, `execution_race.d.mts` | Дополнительный memory-write case в существующем IPC barrier; без нового race framework |
| `.planning/research/orchestration/memory-check.mjs`, `memory-evidence.json` (new) | M01–M14 against fresh public compiled core; source/race/audit metadata |
| `.planning/research/orchestration/codex-broker-check.mjs` | Memory read с genuine production-issued context, live revoke и неизменный business tool registry |
| `.planning/research/orchestration/dependencies-check.mjs`, `dependencies-evidence.json` | Динамический schema assertion и свежая D01–D12 regression |
| Approved spec + этот plan | Approval/исполнение/evidence summary; не выдавать программу проверки за результат |
| Tracked core/CLI/MCP dist и Codex runtime | Только штатный build/plugin sync; generated files вручную не редактировать |

Reuse `controllerDb`, `projectOf`, `repositoriesOf`, `bindingsOf`, `canonicalCommonDir`, `scopedTask`, `checkRepo`, `shape`, `text`, `integer`, `canonical`, `digest`, `newId`, `appendEvent`, `CAPS`, `capText`, `sanitizeQuery`, `parseDecisionMd`, `redact`. Internal imports идут из owning modules; public consumers — только barrel. `controllerDb`, ready-made scope/grant records и новый source validator не становятся public API.

## Общие интерфейсы

Следующие types определяются в `memory.ts` в task 1; повторять их по модулям нельзя. `ControllerHandle`/`RunContext` — existing opaque types, `AuthorityBinding`/`TaskRef` — #146.

```ts
export type MemoryKind = 'fact' | 'decision' | 'rule' | 'candidate';
export type MemoryStatus = 'active' | 'withdrawn';
export interface MemoryScope { projectId: string; taskId: number | null }
export interface MemoryApplicability { repoId: string | null; commit: string | null }
export interface MemoryRepoVersion { repoId: string; checkoutPath: string; commit: string }
export interface MemoryView { scope: MemoryScope; repositories: readonly MemoryRepoVersion[] }
export interface MemoryRevisionRef { projectId: string; entryId: string; revision: number }
export interface MemoryAuthor { type: 'user' | 'ai'; id: string | null }
export type MemorySource =
  | { kind: 'user'; ref: string }
  | { kind: 'host'; ref: string }
  | { kind: 'run'; task: TaskRef; authority: AuthorityBinding; reportEventId: number }
  | { kind: 'git'; repoId: string; commit: string; path: string; sha256: string;
      documentStatus: 'active' | 'superseded' | 'unknown' | null }
  | { kind: 'revision'; ref: MemoryRevisionRef; hash: string };
export interface MemoryDraft {
  scope: MemoryScope; applicability: MemoryApplicability;
  kind: MemoryKind; status: MemoryStatus; title: string; body: string;
  source: MemorySource; author: MemoryAuthor;
}
export interface MemoryWriteInput extends MemoryDraft {
  commandId: string; entryId: string | null; expectedRevision: number;
}
export type MemoryOperation = 'create' | 'revise' | 'withdraw' | 'accept' | 'import';
export interface MemoryEvidenceRequest {
  operation: MemoryOperation; entryId: string | null; expectedRevision: number;
  origin: 'user' | 'host';
  scope: MemoryScope; applicability: MemoryApplicability;
  payloadHash: string; source: MemorySource;
}
export interface MemoryEvidenceObservation {
  request: MemoryEvidenceRequest; origin: 'user' | 'host';
  verdict: 'pass' | 'fail' | 'inconclusive'; observedAt: number; expiresAt: number | null;
}
export interface MemoryObservers {
  observe?: (request: MemoryEvidenceRequest) => MemoryEvidenceObservation | null;
}
export interface MemoryReceipt {
  entryId: string; revision: number; currentRevision: number;
  hash: string; created: boolean; effectiveStatus: MemoryStatus | 'superseded';
}
export interface MemoryRecord extends MemoryDraft {
  entryId: string; revision: number; currentRevision: number;
  predecessor: number | null; hash: string; createdAt: number;
  evidence: readonly MemoryEvidenceObservation[];
  effectiveStatus: MemoryStatus | 'superseded';
}
export interface MemoryReadOptions { candidates?: boolean; withdrawn?: boolean }
export interface MemoryRecallOptions extends MemoryReadOptions { k?: number }
export interface MemoryHit {
  ref: MemoryRevisionRef; hash: string; kind: MemoryKind;
  status: MemoryStatus; effectiveStatus: MemoryStatus | 'superseded';
  title: string; snippet: string; source: MemorySource;
  scope: MemoryScope; applicability: MemoryApplicability;
}
```

History — явный отдельный API; `withdrawn`/`candidates` flags не открывают другие scopes. By-id/revision lookup — также явный запрос конкретной записи, который может вернуть candidate/withdrawn с явными kind/status, но всегда через общий scope predicate. List/recall по умолчанию их исключают. Нет опции `allProjects`, raw SQL или caller-supplied trusted scope. Все API synchronously return результат либо KddError; validator callbacks бросившие exception дают fail-closed отказ без mutation. Receipt.created означает, что именно этот вызов создал новую revision; replay возвращает false, первоначальные revision/hash и актуальные currentRevision/effectiveStatus.

### Task 1: Migration v16, evidence-bound immutable revisions и replay

**Files:** create `src/memory.ts`, `test/memory_fixture.ts`, `test/memory.test.ts`; modify core `src/schema.ts`, `src/index.ts`, `test/execution.test.ts`. Пути относительны `packages/core/`.

**Interfaces:** consumes existing controller/identity/validators/audit; produces общие types выше и:

```ts
export function writeMemory(handle: ControllerHandle, input: MemoryWriteInput,
  observers?: MemoryObservers): MemoryReceipt;
// Internal only: modules in tasks 2/3 use these, barrel never exports them.
export function memoryDraftHash(draft: MemoryDraft): string;
export function writeMemoryDb(db: Database.Database, input: MemoryWriteInput,
  observers: MemoryObservers, importKey?: string): MemoryReceipt;
export function resolveMemoryView(db: Database.Database, view: MemoryView): MemoryView;
export function selectMemory(db: Database.Database, view: MemoryView,
  options?: MemoryReadOptions, historyEntryId?: string, revision?: number | null): MemoryRecord[];
```

`memoryDraftHash = digest({scope,applicability,kind,status,title,body,source,author})`, command hash = `digest(input)`. Operation выводится из реального predecessor и requested transition, не из verdict/флага клиента; переданный только внутренним importer importKey задаёт operation=import для первоначальной revision. Entry null требует expectedRevision=0; existing entry требует positive safe integer и точный scope/applicability. Kind меняется только candidate → fact/decision/rule с новым proof; обычный edit сохраняет kind. `writeMemoryDb` выполняется только внутри уже открытой immediate transaction, не начинает её повторно. Для replay находить исходную command revision/predecessor до проверки CAS и определять operation по ним; повторно проверять source/authority/proof, затем вернуть receipt без применения старого перехода к нынешнему head. Changed command hash отказывает; historical replay не обязан совпадать с текущей revision.

- [x] **1. RED: migration сохранности и version/evidence failures.** Сохранить actual values всех v15 таблиц/FTS (включая work-item revisions/results/owners/handoff/authorities), открыть заполненный disk fixture с WAL через current openDb и проверить пустую memory и читаемый `.v15.bak`. В существующем future-schema тесте заменить `user_version=16` на `user_version=${core.MIGRATIONS.length + 1}`; смысл отказа сохраняется. New test пример:

Старый store строить независимо из неизменённых migration SQL, не создавать v16 и затем объявлять его v15:

```ts
const legacy = new Database(dbPath);
legacy.pragma('foreign_keys=ON');
for (const sql of core.MIGRATIONS.slice(0, 15)) legacy.exec(sql);
legacy.pragma('user_version=15');
legacy.pragma('journal_mode=WAL');
legacy.pragma('wal_autocheckpoint=0');
```

Seed валидные реальные rows старых таблиц по существующим disk-fixture SQL из dependencies-check.mjs; сохранить канонический snapshot таблиц/legacy FTS перед openDb. Это migration-state fixture, не свидетельство native grant issuance. Legacy connection держать открытым без активной write transaction до окончания migration/backup checks; перед openDb проверить `statSync(dbPath + '-wal').size > 0`. Не вызывать closeDb/checkpoint перед upgrade: они убрали бы проверяемый uncheckpointed WAL. Закрыть оба connections в finally. Old-binary refusal отдельно проверяется baseline compiled core в task 6.

```ts
it('adds a revision only after exact user evidence; preserves old payload', () => {
  const f = memoryFixture(), input = f.draft('rule', 'Keep history');
  const before = f.rows();
  expect(() => core.writeMemory(f.handle, input)).toThrow();
  expect(f.rows()).toEqual(before);
  const first = core.writeMemory(f.handle, input, f.proof(input, 'create', 'user'));
  const next = { ...input, commandId: 'revision-two', entryId: first.entryId,
    expectedRevision: 1, body: 'Use immutable revisions' };
  expect(() => core.writeMemory(f.handle, next, f.proof(input, 'create', 'user'))).toThrow();
  const second = core.writeMemory(f.handle, next, f.proof(next, 'revise', 'user'));
  expect(second.revision).toBe(2);
  expect(f.db.prepare('SELECT body FROM memory_revisions WHERE entry_id=? AND revision=1')
    .get(first.entryId)).toEqual({ body: input.body });
  expect(() => f.db.prepare('DELETE FROM memory_revisions WHERE entry_id=?')
    .run(first.entryId)).toThrow(/immutable/);
});
```

`memoryFixture()` wraps existing `fixture()`; adds `scope={projectId,taskId:null}`, `view={scope,repositories:[]}`, `rows()` for entries/revisions/events, and `draft(kind,body):MemoryWriteInput` with unique command id, title=body, active, no repo/commit, author user/null, source host fixture ref для fact и user fixture ref для остальных kinds. `proof(input,operation,origin):MemoryObservers` constructs an **independent expected request** including requested origin from the known input/hash and registers it in a receipt file under fixture home; callback re-reads that receipt and returns that fixed observation only for canonical equality. It never echoes arbitrary incoming request as pass. Times use core.now(), expiresAt=null. This is a labelled fixture receipt, not a claimed real product human-approval channel. Import `memoryDraftHash` internally for fixture payload binding; negative tests alter body/CAS/scope/hash/operation/origin/time independently. Для двух требуемых origins использовать два независимо зарегистрированных receipts и тот же callback, выбирающий по canonical request.

Run: `pnpm --filter @kddkit/core exec vitest run test/memory.test.ts test/execution.test.ts`. Expected RED: missing API/tables/new behavior; record failing assertions before adding implementation.

- [x] **2. Append schema and SQL invariants.** Use JSON payload for closed source/author, flat searchable title/body and kind/status. Same-entry predecessor/current FK are deferred to support atomic entry+first revision. SQL skeleton:

```sql
CREATE TABLE memory_entries (
  id TEXT PRIMARY KEY,
  task_id INTEGER REFERENCES tasks(id), repo_id TEXT REFERENCES repositories(repo_id),
  applicable_commit TEXT, import_key TEXT UNIQUE,
  current_revision INTEGER NOT NULL CHECK(typeof(current_revision)='integer'
    AND current_revision BETWEEN 1 AND 9007199254740991),
  created_at INTEGER NOT NULL, CHECK(applicable_commit IS NULL OR repo_id IS NOT NULL),
  FOREIGN KEY(id,current_revision) REFERENCES memory_revisions(entry_id,revision)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE memory_revisions (
  entry_id TEXT NOT NULL REFERENCES memory_entries(id),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer'
    AND revision BETWEEN 1 AND 9007199254740991), predecessor INTEGER,
  kind TEXT NOT NULL CHECK(kind IN ('fact','decision','rule','candidate')),
  status TEXT NOT NULL CHECK(status IN ('active','withdrawn')),
  title TEXT NOT NULL, body TEXT NOT NULL,
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  author_json TEXT NOT NULL CHECK(json_valid(author_json)),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json)='array'),
  content_hash TEXT NOT NULL, command_id TEXT NOT NULL UNIQUE,
  command_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(entry_id,revision),
  CHECK((revision=1 AND predecessor IS NULL) OR (revision>1 AND predecessor=revision-1)),
  FOREIGN KEY(entry_id,predecessor) REFERENCES memory_revisions(entry_id,revision)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX idx_memory_scope ON memory_entries(task_id,repo_id,applicable_commit);
CREATE UNIQUE INDEX idx_memory_import_commands ON events(json_extract(detail,'$.commandId'))
  WHERE action='memory_import_replay';
```

Add before UPDATE/DELETE triggers on revisions; before UPDATE of entry id/task/repo/commit/import_key/created_at and DELETE on entries; current pointer cannot regress/skip. Entry id/hash/commit format constraints use existing schema convention (id 32 lowercase hex, hash 64, commit 40/64 hex); source validation also checks existence. Command lookup checks revisions and memory_import_replay events in the same immediate transaction, so a later import alias cannot reuse an id for another write. The index adds no persistent memory table or change to previous events. No persistent memory FTS table and no edits to migrations 1–15.

- [x] **3. Implement one atomic writer and source/evidence checks.** Authentic handle → immediate transaction → shape/caps/identity/source/command lookup → derive transition from original predecessor for replay or current predecessor for a new write → exact proof → replay return or CAS → immutable insert/pointer/event. Persist the exact verified observations as evidence_json; an unconfirmed trusted host proposal has an empty array. For current pointer update use:

```ts
const changed = db.prepare(`UPDATE memory_entries SET current_revision=?
  WHERE id=? AND current_revision=?`).run(nextRevision, id, input.expectedRevision).changes;
if (changed !== 1) throw new KddError('stale memory revision');
```

Source user requires user observation even for candidate attribution; source host with candidate is a trusted host proposal, active fact requires host evidence. Если user source используется для fact, требуются **оба** origins: user подтверждает source attribution, host — факт. Callback получает два полных requests с разным origin; один pass не заменяет другой. Revision source references a real entry/revision in the same project and checks the declared hash against its immutable content_hash. Git и run sources fail-closed на этом этапе: task 3 подключает проверку реального Git blob, task 4 — live report validator. Source run author must be ai/runId. No persisted synthetic `verified`/`trusted` boolean.

Proof checks canonical request, expected origin, pass, finite 0≤observedAt≤now and null expiry or future expiry greater than observedAt. Active rule/decision and their edit/withdraw require user; fact publication/edit/withdraw requires host, Git/code fact additionally exact repo/commit/evidence bytes. Candidate host withdrawal requires authentic controller; user attribution remains independently verified. После task 3 fact с repoId требует commit, а Git-sourced fact — applicability, точно совпадающую с source repo/commit; unversioned host fact допустим для фактов вне кода. Source/report alone never confirms an active fact. `redact(text)!==text` detects/rejects known secret forms before hashing/storing; title ≤CAPS.agentFieldChars, body ≤CAPS.bodyChars, source/author/evidence JSON ≤CAPS.agentDetailBytes. Overflow KddError reports limit and permitted current refs without full bodies; no truncation. Errors never include input body/token.

- [x] **4. GREEN and opposing assertions.** Add replay after newer revision/withdraw (same historical receipt, no pointer rollback), same command different fields denied, fake handle/foreign project with same numeric task id denied, unknown task/repo/malformed SHA, immutable applicability/kind, invalid author/source and callback exception rollback. Candidate cannot replace existing rule; acceptance requires origin matching target kind. Run targeted tests, separate `pnpm --filter @kddkit/core typecheck`, `pnpm build`, `git diff --check`.

- [x] **5. Commit verified unit.** Stage only owned files and generated runtime; `git commit -m 'feat(core): add immutable memory revisions'`. M01/M05/M07/M11/M13 unit coverage now; external observations wait task 6.

### Task 2: Общая scope selection, history/rules и isolated FTS

**Files:** create `src/memory_query.ts`, `test/memory_query.test.ts`; modify `src/memory.ts`, `src/index.ts`. Existing `recall.ts` read only for sanitizeQuery; его contracts не менять.

**Interfaces:** consumes task-1 types/selectMemory/resolveMemoryView; produces:

```ts
export function memoryEntry(handle: ControllerHandle, view: MemoryView,
  entryId: string, revision?: number): MemoryRecord;
export function memoryHistory(handle: ControllerHandle, view: MemoryView,
  entryId: string): MemoryRecord[];
export function listMemory(handle: ControllerHandle, view: MemoryView,
  options?: MemoryReadOptions): MemoryRecord[];
export function memoryRules(handle: ControllerHandle, view: MemoryView): MemoryRecord[];
export function recallMemory(handle: ControllerHandle, view: MemoryView,
  query: string, options?: MemoryRecallOptions): MemoryHit[];
// Internal only, authority.ts consumes in task 4.
export function queryMemoryDb(db: Database.Database, view: MemoryView,
  query: string, options?: MemoryRecallOptions): MemoryHit[];
```

- [x] **1. RED scope corpus and read-by-id.** Create actual parent/children using existing createSubtasks and f.ref/taskContractHash; store independently verified project/root/child/sibling records. Foreign project id with equal numeric task id and known sibling entry id must fail across get/history/list/rules/recall. Add large sibling corpus after baseline and assert full hit equality:

```ts
it('scopes the corpus before rank and top-k', () => {
  const f = memoryFixture(), own = f.task('own'), sibling = f.task('other');
  const ownInput = { ...f.draft('candidate', 'needle authorized'),
    scope: { projectId: f.projectId, taskId: own.id } };
  core.writeMemory(f.handle, ownInput, f.proof(ownInput, 'create', 'user'));
  const view = { scope: ownInput.scope, repositories: [] };
  const baseline = core.recallMemory(f.handle, view, 'needle', { k: 1, candidates: true });
  for (let n = 0; n < 200; n++) {
    const other = { ...f.draft('candidate', 'needle '.repeat(n + 1)),
      scope: { projectId: f.projectId, taskId: sibling.id } };
    core.writeMemory(f.handle, other, f.proof(other, 'create', 'user'));
  }
  expect(core.recallMemory(f.handle, view, 'needle', { k: 1, candidates: true }))
    .toEqual(baseline);
  expect(() => core.memoryEntry(f.handle, view,
    f.db.prepare('SELECT id FROM memory_entries WHERE task_id=?').get(sibling.id).id))
    .toThrow();
});
```

Keep repeated body within write cap; annotate SQLite query row type in real test. Run `pnpm --filter @kddkit/core exec vitest run test/memory_query.test.ts`; expected missing API/incorrect global corpus before implementation.

- [x] **2. Implement one common predicate.** Within DB transaction resolve project/task/root parent; allowed task ids are [null], [null,task], [null,parent,subtask]. Validate every repo version: closed shape/unique repo, existing repo/binding, canonical realpath/common-dir, full commit SHA and actual commit object in that bound Git. Host pin may differ from HEAD; it cannot refer to another repo. Match entries by task set, repo set and exact applicable_commit; entry id/revision lookup first uses that same predicate. Read flags only control active candidates/withdrawn in an already allowed view. Historical reads retain that scope and compute superseded without modifying rows. Defaults exclude kind candidate/status withdrawn; rules return **all** active applicable rules without keyword/k limits. Stable id/revision order; no narrower-scope winner.

- [x] **3. Build per-query memory-only FTS after selection.** Reuse sanitizeQuery and caps, disposable DB closed in finally, parameterized inserts. Sketch of the search phase:

```ts
const corpus = new Database(':memory:');
try {
  corpus.exec(`CREATE VIRTUAL TABLE hits USING fts5(ref UNINDEXED,title,body,
    tokenize='unicode61 remove_diacritics 2')`);
  const insert = corpus.prepare('INSERT INTO hits(ref,title,body) VALUES(?,?,?)');
  corpus.transaction(() => {
    for (const row of eligible) insert.run(row.entryId, row.title, row.body);
  })();
  const hits = corpus.prepare(`SELECT ref,title,
    snippet(hits,2,'','','...',${CAPS.recallSnippetTokens}) snippet
    FROM hits WHERE hits MATCH ? ORDER BY bm25(hits,0,3.0,1.0),ref LIMIT ?`)
    .all(sanitizeQuery(query), k) as { ref: string; title: string; snippet: string }[];
  const records = new Map(eligible.map(row => [row.entryId, row]));
  return hits.map(hit => {
    const row = records.get(hit.ref)!;
    return { ref: { projectId: row.scope.projectId, entryId: row.entryId, revision: row.revision },
      hash: row.hash, kind: row.kind, status: row.status, effectiveStatus: row.effectiveStatus,
      title: capText(hit.title, CAPS.recallTitleChars), snippet: hit.snippet,
      source: row.source, scope: row.scope, applicability: row.applicability };
  });
} finally { corpus.close(); }
```

Add the specified ponytail ceiling/upgrade comment; no global FTS index or new search abstraction. Unknown flags/k outside 1..CAPS.recallKMax/non-string/empty queries reject before corpus creation. Output snippet/title reuse existing recall caps; authoritative record text is never trimmed on storage. No audit mutation for a read.

- [x] **4. GREEN opposing reads.** Test exact commit A vs B and ancestor mismatch, detached HEAD labels, different repo with same SHA, typo/foreign binding, candidates/history explicitly labelled, withdrawn replay, active rules >k and contradictory parent/local rules both visible. Use actual Git commits/blob evidence and real SQLite. Run targeted tests, separate core typecheck, build and diff check.

- [x] **5. Commit.** `git commit -m 'feat(core): add scoped memory reads and recall'`. Coverage M02/M03/M04/M11/M12; do not claim context assembly or prompt injection implemented.

### Task 3: Выбранный Git import и сохранность после legacy recall

**Files:** create `src/memory_import.ts`, `test/memory_import.test.ts`; modify `src/memory.ts`, `src/index.ts` only for shared writer integration.

**Interfaces:** consumes task-1 writer and task-2 read API; produces:

```ts
export interface MemoryImportInput {
  commandId: string; scope: MemoryScope; applicability: MemoryApplicability;
  repoId: string; checkoutPath: string; commit: string; path: string; sha256: string;
  kind?: MemoryKind; status?: MemoryStatus; author: MemoryAuthor;
}
export function importMemory(handle: ControllerHandle, input: MemoryImportInput,
  observers?: MemoryObservers): MemoryReceipt;
// Internal shared validator also serves source.kind=git in writeMemory.
export function readMemoryDocument(db: Database.Database,
  input: Pick<MemoryImportInput,'repoId'|'checkoutPath'|'commit'|'path'|'sha256'>):
  { title: string; body: string; source: Extract<MemorySource,{kind:'git'}> };
```

- [x] **1. RED real import + legacy independence.** Commit `.planning/decisions/local.md` in temp source A, obtain SHA and raw-byte sha256, call import twice with the same source key but different command id and assert one entry/import receipt. Switch source to B without this file (Git commands affect only fixture), invoke old recall/rebuild, then bind backend with empty/conflicting decisions and call old recall there. Assert all memory entries/revisions/hashes/events unchanged. Add withdraw imported entry then import replay: remains withdrawn; changed import kind/authority cannot silently reactivate. Run `pnpm --filter @kddkit/core exec vitest run test/memory_import.test.ts`; expected missing import API/behavior.

```ts
const f = memoryFixture(), path = 'notes.md', bytes = Buffer.from('# API\n\nPinned schema\n');
writeFileSync(join(f.repo, path), bytes);
f.git('add', '--', path);
f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'document');
const repoId = core.projectOf(f.db).primary_repo_id!;
const input: core.MemoryImportInput = { commandId: 'import-first', scope: f.scope,
  applicability: { repoId: null, commit: null }, repoId, checkoutPath: f.repo,
  commit: f.git('rev-parse', 'HEAD'), path,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  kind: 'candidate', status: 'active', author: { type: 'user', id: null } };
const first = core.importMemory(f.handle, input);
const replay = core.importMemory(f.handle, { ...input, commandId: 'import-second' });
expect(replay).toMatchObject({ entryId: first.entryId, revision: 1, created: false });
expect(f.db.prepare('SELECT count(*) n FROM memory_revisions').get()).toEqual({ n: 1 });
expect(() => core.importMemory(f.handle, { ...input, commandId: 'import-second', kind: 'rule' }))
  .toThrow();
```

- [x] **2. Validate immutable source bytes before writer.** Require bound repo/canonical checkout/common-dir, normalized relative path (no absolute/backslash/traversal/NUL), 40/64 hex commit, 64 hex sha256. Use Git argument arrays with no shell:

```ts
const record = execFileSync('/usr/bin/git', ['ls-tree', '-z', commit, '--', path],
  { cwd: checkoutPath, encoding: 'utf8', stdio: 'pipe' });
// Require exactly the requested regular blob, mode 100644/100755; no 120000/160000.
const bytes = execFileSync('/usr/bin/git', ['show', `${commit}:${path}`],
  { cwd: checkoutPath, stdio: 'pipe', maxBuffer: 4 * CAPS.bodyChars + 4096 });
const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
if (createHash('sha256').update(bytes).digest('hex') !== sha256)
  throw new KddError('memory document hash mismatch');
```

Validate exact ls-tree record/path/object count, commit object type and decoded body cap; reject known env/credential/controller paths and detected secret forms before storing. Derive title/body with existing Markdown parser (title fallback to filename), and actual legacy documentStatus only for decision metadata; caller cannot assert active status. Known superseded/unknown legacy decision cannot be imported as active decision/rule directly; create candidate/withdrawn then separate explicit acceptance. Avoid source path symlink resolution entirely by Git object reads; selected symlink/submodule modes reject.

- [x] **3. Implement import key/replay.** `import_key=digest({repoId,path,commit,sha256,scope,applicability})`, UNIQUE in entries. In one immediate transaction authorize/validate blob and derive MemoryDraft, then call writeMemoryDb with entryId=null/expectedRevision=0/importKey; this internally derives operation=import. Active fact/rule/decision still requires full payload-bound evidence. Duplicate key compares original import kind/status/author/source authority binding, returns original receipt + current state without altering head; changed selection/publication request directs caller to explicit revision. If an identical import uses a new commandId, append one existing audit event action=memory_import_replay containing only commandId, commandHash, entryId and original revision. It reserves that command id without another revision/table; repeating that alias appends nothing, changed alias payload refuses across both import/write paths. Source key must survive edits/withdraw and simultaneous import attempts; no code writes to legacy decisions/index. Legacy-isolation snapshots are taken after both import commands, including this explicit audit alias.

Omitted kind/status normalize to candidate/active before hashing; это статус предложения, а не подтверждение legacy policy. Author относится к явному import action; неизвестное авторство legacy документа не выводить из importer. После task 3 Git source в общем writer вызывает тот же validator, разрешая bound checkout из сохранённых bindings; importer передаёт и проверяет конкретный checkoutPath. Нет второго упрощённого source validator.

- [x] **4. GREEN opposing fixtures.** Include spaces/Unicode path, malformed UTF-8, symlink blob pointing at private files, gitlink, absolute/../NUL, credential file, missing object, hash mismatch, oversized Git bytes, commit from unregistered repo, SourceGit/application repo mismatch, replay after source file disappears. Explicit import defaults return candidate; active publication passes required proof. Reuse import alias commandId with another source or via writeMemory: denied, no new revision/event. Compare actual source refs/files and legacy decision rows/FTS before/after new operations. Run target memory/import/project_store/recall tests, typecheck and build separately.

- [x] **5. Commit.** `git commit -m 'feat(core): import selected versioned memory documents'`. M09/M10/M13, no directory scan/watcher/export.

### Task 4: Run-bound core reads и source guard без новых MCP tools

**Files:** modify `src/authority.ts`, `src/memory.ts`, `src/index.ts`, `test/authority.test.ts`; create no new authority registry or native protocol.

**Interfaces:** consumes existing `live(context,'get_context')`, currentAuthority and task-2 internal reads; produces:

```ts
export interface RunMemoryReadInput {
  entryId?: string; revision?: number; candidates?: boolean; withdrawn?: boolean;
}
export function readRunMemory(context: RunContext, input?: RunMemoryReadInput): MemoryRecord[];
export function recallRunMemory(context: RunContext, query: string,
  options?: MemoryRecallOptions): MemoryHit[];
export function runMemoryRules(context: RunContext): MemoryRecord[];
// Internal only, same module as currentAuthority; never export from public barrel.
export function assertRunMemorySource(db: Database.Database, scope: MemoryScope,
  applicability: MemoryApplicability,
  source: Extract<MemorySource,{kind:'run'}>, author: MemoryAuthor): void;
```

RunMemoryReadInput has no project/task/repo/head/path override. entryId omitted lists current records; specified entryId + revision reads that permitted revision explicitly; revision without entryId rejects. Rules/recall/read all use the same grant-derived MemoryView and repeat live checks each call.

- [x] **1. RED existing grant fixture.** Extend authority.test.ts after production-shaped issuance/openRunContext to read own/project/parent memory and reject sibling entryId, unknown input properties and all fake/copied contexts. Source candidate proof test:

```ts
const eventId = core.submitRunReport(context, 'Memory candidate: inspect API');
const proposed: core.MemoryWriteInput = { ...candidateInput, scope: { projectId, taskId },
  source: { kind: 'run', task: { projectId, taskId }, authority: {
    authorityId: issued.authorityId, workItemId: input.workItemId,
    runId: input.runId, generation: issued.generation }, reportEventId: eventId },
  author: { type: 'ai', id: input.runId } };
core.writeMemory(controller, proposed);
const before = memoryRows();
core.revokeRunAuthority(controller, issued.authorityId);
expect(() => core.readRunMemory(context)).toThrow(/authority/);
expect(() => core.writeMemory(controller, { ...proposed, commandId: 'after-revoke' })).toThrow();
expect(memoryRows()).toEqual(before);
```

Use the actual existing local variables/functions in that fixture; define `candidateInput` as task-1 active candidate with repo/app null and `memoryRows()` as three-table read, not a hidden native proof. This fixture's WeakSet native packet is **unit-only**, explicitly separate from task-6 genuine preflight. Run `pnpm --filter @kddkit/core exec vitest run test/authority.test.ts test/memory.test.ts`; expected missing run reads or failing scope assertions.

- [x] **2. Integrate at the existing shared boundary.** Use live/currentAuthority directly, no serialized RunContext/Grant acceptance or parallel guard. Derive scope from grant and each repo tuple from canonical checkout + actual full HEAD; validate it with resolveMemoryView. Keep selection and response in registered DB transaction. New internal source guard looks up exact authority/task/work/run/generation, requires submit_report in operations, validates report event detail tuple/untrusted and author runId, scope equals grant task, and applicability repo is null or granted. Existing modeledOwnership/liveOwner covers current input invalidation. External ids remain permitted genuine #145 ids, not fake scheduler rows. Only kind candidate may use source run; existing rule/decision entry cannot be mutated from it.

In index.ts replace the existing authority wildcard with explicit exports preserving **all** currently public authority names, then add only the new core read functions/type. assertRunMemorySource remains directly importable inside core but absent from the barrel:

```ts
export { openController, assertLegacyTaskMutation, protectTask, issueRunAuthority,
  revokeRunAuthority, assertRunAuthorityBinding, openRunContext, runOperations,
  readRunContext, submitRunReport, requestRunQuestion,
  readRunMemory, recallRunMemory, runMemoryRules } from './authority.js';
export type { ControllerHandle, RunOperation, RunContext, IssueRunInput,
  IssuedRunAuthority, RunContextSnapshot, RunMemoryReadInput } from './authority.js';
```

Test the actual barrel: `expect('assertRunMemorySource' in core).toBe(false)`. Preserve the old exports for existing callers; don't remove unrelated legacy DB helpers in this task.

- [x] **3. Pin opposing guards.** Rotate grant then replay old command; expire/revoke in initialized context; remove get_context/submit_report operation; report from another task/run/generation; authority valid but API result invalidated or parent requirements changed; wrong repo/commit/native scratch/privateStore guard. After each denial entries/revisions/events are unchanged. Default candidate excluded; explicit candidates are labelled; mandatory rules remain full. No source guard treats direct DB fixture insert as production-issued grant evidence.

- [x] **4. GREEN compatibility.** Assert `readRunContext(context)` equals its previous response, `runOperations` remains exact original granted subset, MCP registry/schema tests untouched and get_context-only works. Run authority/memory/execution-results targeted tests and existing MCP run_server tests; separate typecheck/build/diff check. If new internal import cycle appears, keep function declarations/type-only imports; don't restructure unrelated authority/runtime modules.

- [x] **5. Commit.** `git commit -m 'feat(core): bind memory reads to live run authority'`. M07/M08 unit behavior; full native evidence still required task 6.

### Task 5: Процессные CAS races, import replay и schema compatibility

**Files:** create `test/memory_races.test.ts`; modify existing `test/fixtures/execution_race.mjs`, `.d.mts`, `.planning/research/orchestration/dependencies-check.mjs`; tests `memory.test.ts`/`memory_import.test.ts` receive rollback/replay cases.

**Interfaces:** existing `runRace(dbPath,requests)` retains its barrier/timeout/cleanup. Extend RaceRequest with `{op:'memory'; input:MemoryWriteInput}` and child dispatcher calls writeMemory with a trusted **candidate host source** fixture; no serialized positive active-fact/user verdict. Existing reserve/revise cases and all process cleanup remain unchanged. The same child executable accepts one test-only `{op:'memory-crash';input:MemoryWriteInput}` request for a single-worker crash observation; this is not sent through the two-worker runRace helper.

- [x] **1. RED two actual processes, 20 rounds.** Create one active candidate per round with host fixture source; two children propose different bodies/command ids with the same entry/current revision. Example assertions:

```ts
for (let round = 0; round < 20; round++) {
  const initial = core.writeMemory(f.handle, candidateDraft(round));
  const requests = ['left','right'].map(side => ({ op: 'memory' as const,
    input: { ...candidateDraft(round), commandId: `race-${round}-${side}`,
      entryId: initial.entryId, expectedRevision: 1, body: side } }));
  const replies = await runRace(f.dbPath, requests as [RaceRequest,RaceRequest]);
  expect(replies.filter(r => r.ok)).toHaveLength(1);
  expect(replies.filter(r => !r.ok)).toHaveLength(1);
  expect(f.db.prepare('SELECT count(*) n FROM memory_revisions WHERE entry_id=?')
    .get(initial.entryId)).toEqual({ n: 2 });
}
```

Define `candidateDraft(round):MemoryWriteInput` with same task/project/applicability, active candidate, source host `fixture:race`, author ai/fixture, null entry/expectedRevision=0 and deterministic round command id. Parent creates initial once; worker only revises. Run after fresh build: `pnpm --filter @kddkit/core exec vitest run test/memory_races.test.ts test/execution_races.test.ts`. Expected RED unknown race op or bad CAS, not stale dist imported by children.

- [x] **2. Reuse dispatcher and enforce rollback.** Add memory cases in existing child branch and exact TS union import. No process pool/lock service. Race import duplicates using two bound temp DB connections and same import key; SQL UNIQUE and writer replay return one created import. Add audit-trigger failure rollback. For crash, fork the same executable with one memory-crash request; child after the existing ready/go barrier executes:

```js
db.exec('BEGIN IMMEDIATE');
core.writeMemory(handle, request.input); // Nested savepoint, outer transaction remains open.
process.send({ pending: true });
return; // Wait for parent SIGKILL, without closing DB or committing the outer transaction.
```

Parent waits for **pending after the real write**, then sends SIGKILL and awaits close; deadline=10s, kill/close in finally on failure. Compare entry/revision/event rows after reopening with their original snapshot. Killing before the write or after commit does not prove rollback and is not this check. No callback can return private body/token in an error.

- [x] **3. Preserve evolving schema fixtures.** Source `execution.test.ts` future test is dynamic from task 1. In dependencies-check.mjs change `assert.equal(authorityRegression.schema,15)` to `assert.equal(authorityRegression.schema,core.MIGRATIONS.length)`; retain exact historical v14/v15 assertions/backup comparisons. Other schema-specific fixtures remain pinned to the migration they test. Never change expectation to merely accept any version or remove a security assertion.

- [x] **4. GREEN process/legacy tests.** Verify 20/20 single CAS winners, preserved old execution edge/reservation races, current rules untouched by candidate races, original command after acceptance/withdraw never revives or regresses. Run targeted core memory/execution/store/recall and separate typecheck/build. Existing legacy source/backend protection remains exercised, not replaced by new memory assertions.

- [x] **5. Commit.** `git commit -m 'test(core): verify memory concurrency and legacy isolation'`. M06/M10/M11 regression; no production concurrency API added.

### Task 6: M01–M14 observations, fresh native gates и review submission

**Files:** create `.planning/research/orchestration/memory-check.mjs`, `memory-evidence.json`; modify existing codex-broker-check.mjs for genuine run memory assertions, generate fresh dependencies-evidence.json; update plan execution summary and approved spec only for measured clarification. Runtime outputs under ignored `.superpowers/sdd/2026-09-29-scoped-memory/` (canonical execution workspace recorded in the ledger).

**Interfaces:** compiled consumer imports only `packages/core/dist/index.js`, fixture Git/SQLite and existing process race helper. Output:

```ts
interface MemoryEvidenceFile {
  observedAt: string; node: string; schema: number; runtimeHash: string;
  checks: { id: string; passed: boolean; observations: object }[];
  races: { rounds: number; singleWinners: number; duplicateRevisions: number };
  limitations: string[];
}
```

M01–M14 ids and observations correspond to the approved spec; failures exit nonzero. Store actual counts/ids/hashes/exit codes, not simply 14 hardcoded true values. Fixture user receipts are labelled fixture observations; genuine native proof comes only from real preflight/broker matrix.

- [x] **1. Write failing external observations and build.** memory-check.mjs creates isolated Git/store/project/task/children and chosen documents, exercises public create/revise/read/list/history/rules/recall/import, reads durable rows/audit and compares previous bytes. Include all M ids, actual 20 race child processes, v15 WAL backup/newer binary refusal and source refs/files unchanged. Default import is current public dist; an explicit `--core <absolute dist/index.js>` option permits the negative baseline check, without changing source or switching this branch. Extract tracked packages/core/dist from base 4cce083 into ignored artifact baseline dir using git archive; symlink only its packages/core/node_modules to the existing real package dependencies. Against that baseline the script must exit nonzero with missing-memory-API diagnostics before creating a development store; against current dist it must pass all observations. Record both diagnostics before marking criteria. The baseline check establishes missing functionality, not a claim that today's M scenarios ran on old code.

- [x] **2. Add genuine authority observations to existing native script.** After initial production preflight/issueRunAuthority, publish explicit fixture knowledge using trusted verified receipts, then call new core run reads with `openRunContext` and assert own memory visible/sibling denied. After actual native final live-revoke, the same initialized context rejects new memory reads. Record checks `memory-own-scope`, `memory-sibling-refused`, `memory-live-revoke-refused` alongside existing outer checks. Business MCP tools remain the original granted three/subset; do not add memory to get_context or tools/list, do not weaken matrix. These new library calls are reported as core observations with genuine issued credential, not as a new native memory tool.

- [x] **3. Fresh deterministic gates, each exit 0.** From repo root:

```bash
pnpm build
pnpm test --force --only --concurrency=1 -- --maxWorkers=2
pnpm exec turbo run typecheck --force --only --concurrency=1
pnpm test:codex-plugin
node scripts/sync-codex-plugin.mjs --check
node .planning/research/orchestration/memory-check.mjs
node .planning/research/orchestration/dependencies-check.mjs
git diff --check
```

Capture stdout/stderr/exit separately in ignored artifact dir, copy validated memory/dependencies JSON to their tracked evidence paths with force-add if local excludes apply. Tests/typecheck/build are separate gates; task-1–5 test totals are not whole-repo evidence. One full pass suffices unless a failure/new change justifies repetition. Gate logs contain actual test counts and fresh task execution, not turbo-cache receipts.

- [x] **4. Full native regression against current generated hashes, not calibration.** Read-only executable/version/SHA preflight was observed during planning: Codex 0.157.0, SHA256 `ad0be20d04e2ba6146ecdb51d7f8b7b0fe15420a15dc9b0057518d858f1f3714`. Repeat before actual gate; unsupported global binary is not a fallback. Use existing isolated official executable:

```bash
KDD_CODEX_EXECUTABLE=/Users/magiyar/Projects/My/kddkit/.superpowers/sdd/2026-09-28-subtasks-dependencies/codex-0.157.0/bin/codex node .planning/research/orchestration/codex-broker-check.mjs
KDD_CODEX_EXECUTABLE=/Users/magiyar/Projects/My/kddkit/.superpowers/sdd/2026-09-28-subtasks-dependencies/codex-0.157.0/bin/codex node .planning/research/orchestration/codex-broker-check.mjs --context-only
```

Keep both processes/artifacts isolated, no --calibrate, SQL-generated grants, substituted proof or prior task evidence. Completion requires applicable=true, failures empty, every observation executed, protected bytes unchanged, issued ops respected and final live revoke verified. Counts may evolve with actual matrix; report observed totals, not copied 129/153/29 constants. scriptHash/guardHash equal current core runtime SHA; compare all generated runtime hashes before/after. Poll long-running gates in ≤60-second windows and report meaningful progress. Gate failure/inconclusive prevents review submission; no permissive native fallback or claimed platform support beyond the observed macOS/Codex fixture.

- [x] **5. Self-review, measured summary, local commit и board review.** Inspect actual full diff against 4cce083, exact changed-file scope, public API/source bounds and all Review Focus inputs. Preserve core-only scope and untouched MCP schemas/get_context; no automatic context snapshot, no agent lifecycle or git export. Stage generated artifacts/evidence, commit `test(core): verify scoped memory end to end`. Update this plan with commands/counts/runtime SHA/paths/limits; criterion 398 after M02/M03/M04/M07/M08/M12/M14, criterion 399 after M01/M05/M06/M09/M10/M11/M13. Criteria writes use installed compatible CLI only; get_task/update_task use MCP. Comment with measurements, then move #147 to review with all criteria checked. Never self-accept or push.

## Coverage and handoff

| Spec/scenarios | Owner |
| --- | --- |
| Schema/immutable history/status/authority/evidence/replay, M01/M05/M07/M11/M13 | Task 1; Task 6 external verification |
| Inheritance/read-by-id/repo commit/pre-FTS/rules, M02/M03/M04/M11/M12 | Task 2; Tasks 4/6 run/external paths |
| Explicit selected import/source bytes/dedup/legacy protection, M09/M10/M13 | Task 3; Tasks 5/6 races/external paths |
| Genuine RunContext/live sources/ownership inputs, M07/M08/M14 | Task 4; Task 6 real production issuance/native regression |
| 20 process races/rollback/current pointer, M06/M10/M11 | Task 5; Task 6 measured rounds |
| Whole-repo build/test/typecheck/plugin/dist/native/board evidence, M01–M14 | Task 6 |

Пользователь подтвердил план `034c850` 2026-09-29: «План подтверждаю, начинай». Execution method сохранён: **solo на текущей ветке**, без новых auxiliaries; применяется `superpowers:executing-plans`.

## Исполнение

- Task 1: RED — 17 новых memory cases отказали на отсутствующих API/v16 tables, 9 existing execution cases прошли. GREEN — 26/26 targeted tests, 510/510 core tests; отдельный core typecheck и build 4/4 packages exit 0, diff check чистый. Upgrade/WAL/backup, evidence origins, immutable revisions, acceptance/withdrawal/replay и audit rollback проверены на temp Git/SQLite. Это unit evidence; M01–M14 compiled observations и native gates ещё впереди.
- Scope selectors реализуются вместе с первым consumer в Task 2 вместо неиспользуемых stubs. Fixture hash считается независимо через stdlib SHA256 и existing canonical. Новые Git/run sources пока отказывают до подключения validators в Tasks 3/4.
- Task 2: RED — 11/11 new scoped-read cases; opposing explicit-null k/revision tests затем дали два дополнительных RED failures. GREEN — 30/30 writer/query tests, 523/523 core; separate typecheck/build exit 0. Проверены parent inheritance и запрет siblings/children, foreign project collision, 200 чужих corpus hits при k=1 без изменения результата, exact commit/ancestry/repo identity, явные history/candidates/withdrawn, все 12 applicable rules без keyword/top-k. Internal selector revision=null означает current; публичный null revision отклоняется, history не материализуется для обычного by-id чтения.
- Task 3: RED — 25/25 import cases на отсутствующем API; отдельный BOM test затем подтвердил потерю prefix у default TextDecoder. GREEN — 99/99 memory/store/recall targeted, 549/549 core; separate typecheck/build exit 0. Выбранные blob bytes читаются через literal full-tree ls-tree и cat-file проверенного object id. Raw body сохраняет BOM/CRLF, title/metadata парсятся отдельно; unknown legacy status не синтезируется в active. Same-source aliases резервируют command id в existing audit без второй revision; withdrawal/replay не откатывают head. Git-only managed commit проверяется в зарегистрированных bindings того же repo; явно указанный checkout не получает fallback. Malformed/private/symlink/gitlink/UTF-8/NUL/hash/oversize источники отказали; primary branch-B и backend empty/conflicting legacy recall не изменили memory rows/history.

- Task 4: live run memory reads / candidate provenance, targeted 98/98, MCP run_server 6/6, full core 557/557; separate typecheck/build exit 0. Unit native packet remains an isolated issuance fixture; genuine native evidence pending Task 6.

- Task 5: 20/20 process CAS winners; uncommitted SIGKILL rollback; two-connection import/replay/audit rollback. Targeted 113/113, core typecheck/build exit 0.


## Решения при исполнении

Полный список ledger rulings, в порядке принятия; исходные строки и RED/GREEN logs сохранены в `.superpowers/sdd/2026-09-29-scoped-memory/progress.md`.

| Решение | Основание | Ограничение / цена ошибки |
| --- | --- | --- |
| Solo и self-review | Подтверждённый пользователем route | До отдельного review владельца нет независимой второй пары глаз |
| Pinned Codex 0.157.0 из workspace предыдущего плана используется read-only | Именно этот executable утверждён в плане | Если файл недоступен, native gate отказывает; глобальный executable не подставляется |
| Fixture payload hash: existing canonical + stdlib SHA256 | RED должен работать до появления writer API и независимо проверять payload | При расхождении canonical отрицательные hash/field cases должны отказать |
| Scope selectors реализованы вместе с первым consumer, Task 2 | Не создавать временные неиспользуемые security stubs в Task 1 | Общий selector требует совместной проверки всех read paths |
| Внутренний revision selector: null=current, omitted=history | By-id read не должен загружать всю историю | Внутренняя семантика требует явных tests; публичный null остаётся ошибкой |
| Git bytes: literal full-tree ls-tree + cat-file verified blob id | Пути с glob/Unicode/пробелами не должны менять выбор или разрешать symlinks | Неподходящий mode/object/hash отказывает вместо fallback |
| Неуказанный checkout ищет commit только в registered bindings того же repo | Managed-only commit может отсутствовать в source checkout | Explicit checkout не получает fallback; stale/foreign binding отказывает |
| Raw UTF-8 body, BOM/CRLF и byte hash сохраняются; parser используется для metadata/title | Не терять исходные bytes и provenance | Frontmatter входит в bounded body; нормализация только для parsing |
| M08 читает обе свежие actual native artifacts | Serialized fixture grant не доказывает production issuance | Повтор M08 требует сохранённых native artifacts с актуальным runtime hash |
| Ignored workspace сохраняется до owner review | Проверяемость native/ledger observations | Временные logs занимают диск; последующее удаление отдельное |
| Git replace refs не меняют значение pinned SHA | Источник должен соответствовать исходному immutable Git object | Для replacement требуется явно указать новый SHA |

Deferred minors: нет. Финальные deterministic и genuine native gates завершены; измерения приведены ниже.


- Task 6 deterministic gates после self-review fixes: `pnpm exec turbo run build --force --only --concurrency=1` + штатный plugin sync — 4/4, 0 cache, exit 0; `pnpm test --force --only --concurrency=1 -- --maxWorkers=2` — **1074/1074** (core 569, MCP 78, CLI 215, UI 212), 4/4 tasks, 0 cache, exit 0. Отдельный `pnpm exec turbo run typecheck --force --only --concurrency=1` — 4/4, 0 cache, exit 0; plugin smoke/sync check и diff check — exit 0. Compiled D01–D12 прошли, прежние edge/reservation races — 20/20 каждая; producer JSON скопирован без изменения.
- Self-review воспроизвёл mutable caller payload после exact receipt, Git commit/blob replace refs, empty/EOF legacy status, приватный DataCloneError и lossy UTF-16 → SQLite UTF-8. Shared writer snapshot, neutral error, original-object Git reads, exact declared status и bounded UTF-8 round-trip закрывают эти причины. Для каждого исправления сохранён RED/GREEN; последние whole-repo gates относятся к финальному runtime. Raw body/BOM/CRLF и корректные emoji сохраняются; malformed surrogate отвергается до записи/hash.
- `node .planning/research/orchestration/memory-check.mjs` — **M01–M14 14/14, exit 0**, 20/20 single CAS winners, duplicate revisions 0; producer JSON скопирован без изменения в [memory-evidence.json](../../../.planning/research/orchestration/memory-evidence.json). M01 сохраняет 23 historical tables и читаемый v15 backup при upgrade v16; старый compiled binary отказывает v16. Baseline 4cce083 exits 1 на missing-memory-API до создания fixtures, а не считается проходом сегодняшних сценариев.


### Финальные native observations

Оба fresh прохода завершены exit 0 на final runtime. Initial production preflight: по 124 verified package results; bound preflight: по 153 (отфильтрованные результаты, не raw execution counts). Genuine generation-2 issuance и token rotation прошли. Final broker matrices: **29 attempted / 29 executed / 0 failures каждая**, applicable=true; все protected bytes сохранены. Operations совпали с grant: `get_context, submit_report, request_question` и только `get_context`. Старый token, expiry, изменённые parent inputs, чужой scope и live revoke отказывают последующим memory reads/proposals; 7 memory checks full и 6 context-only записаны producer script.

Первый bound проход на этом SHA отказал fail-closed: project-config-patch/workspace timed out, attempted 73/executed 72. Он сохранён как `native-*-inconclusive-1` и не принят. Повтор выполнен через **пассивный локальный Node inspector**: breakpoint после возврата реального case только считывает observation, пишет redacted trace и resume; нет debug port, изменения production source/predicates, calibration или SQL-generated positive proof. Wrapper импортирует тот же `.planning/research/orchestration/codex-broker-check.mjs`. Actual project-config-patch в обоих mode/preflight затем executed=true, timedOut=false, exitCode=0 с отказом patch по approval settings; причина прежнего timeout не установлена. Четыре более ранних obsolete прохода остановлены exit 143/130 после source fixes, не приняты.

Фактически прошедшие commands (workspace сохранён до review):

```bash
KDD_CODEX_EXECUTABLE=/Users/magiyar/Projects/My/kddkit/.superpowers/sdd/2026-09-28-subtasks-dependencies/codex-0.157.0/bin/codex node .superpowers/sdd/2026-09-29-scoped-memory/native-diagnostic.mjs full
KDD_CODEX_EXECUTABLE=/Users/magiyar/Projects/My/kddkit/.superpowers/sdd/2026-09-28-subtasks-dependencies/codex-0.157.0/bin/codex node .superpowers/sdd/2026-09-29-scoped-memory/native-diagnostic.mjs context
```

Executable Codex 0.157.0 SHA256: `ad0be20d04e2ba6146ecdb51d7f8b7b0fe15420a15dc9b0057518d858f1f3714`. Перед/после gates совпали все пять runtime hashes:

| Runtime | SHA256 |
| --- | --- |
| core/dist и plugin core | `b01e0625309ae59eebfcb7a70637e6c0f0f83d7ae8818671be1025c9ea79b9c0` |
| MCP main/dist и plugin MCP | `e3bda07a061f5a710bde68c5197c499408f7c9a9cb58f25c559097c55dae122a` |
| MCP run_main/dist | `1347168d84bd0dcb22aa548eaca83ad3204475cca5cf8d68d19afd1d8f5d0dc2` |

Native stdout JSON SHA256:

| Artifact в `.superpowers/sdd/2026-09-29-scoped-memory/` | SHA256 |
| --- | --- |
| `native-full.json` | `4667d1b753e8a246950d34bd0a473b3ed92b225ecd3ea1727d0c7caf4afe5957` |
| `native-context.json` | `790b74a9923368eb81971b13cf7adf09b20d748d952cdd0f153e35af398715d9` |


Рядом сохранены `native-*.stderr`, `native-*-project-config.jsonl`, `runtime-hashes.json`, `memory.stderr`, `final-build-fresh.log`, `final-tests.log`, `final-typecheck.log`, `final-plugin.log` и RED/GREEN diagnostics. Fresh D01–D12 producer JSON сохранён в [dependencies-evidence.json](../../../.planning/research/orchestration/dependencies-evidence.json); старые edge/reservation races по 20/20.

### Итоговый self-review

Whole-branch review от 4cce083 включает все source/test/dist/scripts/docs/evidence изменения. Review Focus 1–5 проверены: foreign IDs/handle/sibling paths; corpus/order при 200 foreign hits; replay после acceptance/withdraw; live generation/expiry/revoke/current inputs; exact source/receipt/hash/operation и malformed/private/oversize bytes. Найденные причины исправлены с RED→GREEN до финальных gates; открытых Critical/Important и deferred minors нет. Это owner-approved **solo self-review**, независимый reviewer не создавался.

Core-only граница сохранена: 10 public memory functions, migrations 1–15 без изменений, текущая v16, новые transport tools/RunOperation/get_context fields — 0. Import не меняет source refs/checkout и не экспортируется обратно; legacy decisions/index не управляют новой памятью. User/host receipts в fixtures не являются реальным пользовательским одобрением. Native доказательство относится к наблюдённым macOS/Codex 0.157.0 permissions; memory вызовы там являются core library calls с genuine credential, а не новыми native MCP tools. Recall имеет принятую стоимость O(n) допустимого corpus. Context assembly остаётся #148, пользовательские интерфейсы #159.


### Исправление review P1: private credential paths

Независимый Spec review squash aeabd1f воспроизвёл импорт `.npmrc`, `.git-credentials`, `.netrc` и прямую Git-source запись их bytes с выдачей через явный candidate recall. Причина — неполный общий `memoryPrivatePath`. В него добавлены эти три credential filename; оба Git paths и user/host source refs используют этот же guard. Отказ происходит до memory revision/audit, без отдельного import-only фильтра.

RED: четыре path regression cases (import, git-write, host-ref, user-ref) отказали до исправления; user-ref проверен с точным fixture user receipt, чтобы authority denial не маскировал отсутствие path guard. GREEN: 100/100 targeted, включая root/nested paths, сохранность rows/audit и разрешённую документацию `docs/npmrc-guide.md`. Полная suite — 1079/1079 (core 574, MCP 78, CLI 215, UI 212); fresh build/typecheck 4/4, plugin smoke/sync и D01–D12 exit 0.

Compiled M01–M14 — 14/14, command exit 0; M09 проверил 16 отрицательных входов вместо 13, M13 — три credential filenames через direct Git-source writer, CAS — 20/20 winners и 0 duplicate revisions. Обе свежие genuine native gates завершились exit 0 на актуальном runtime: initial/bound verified package results 124/153, final broker matrices 29/29 каждая, applicable=true, failures 0, все protected bytes сохранены. Full grant предоставляет get_context/submit_report/request_question, ограниченный — только get_context; token rotation, live revoke и 7/6 memory checks прошли. Использован тот же production script через ранее описанный passive inspector; source/predicates/native permissions не изменены. Промежуточный M08 отказ на старом hash сохранён как отрицательное наблюдение, а не passing evidence.

Актуальный core/dist и plugin core SHA256: `be239ec65a2a5a3c90f6f3cc8f4468ec98bae7a24c50515f329ef1028398bffa`. Остальные runtime hashes в таблице Task 6 не изменились; все пять проверены после native. Свежие logs, producer JSON и runtime-hashes.json находятся в `.superpowers/sdd/2026-09-29-scoped-memory/fix-private-path/`; предыдущие producer artifacts сохранены в `*-before.json`. M08 потребил новые native-full/context.json, скопированные без изменения в canonical evidence directory. Fresh M/D producer JSON также без изменения сохранены в tracked `.planning/research/orchestration/memory-evidence.json` и `dependencies-evidence.json`.

| Свежий native artifact | SHA256 |
| --- | --- |
| `native-full.json` | `22b354d0c60a0a25fde5e30ed8ac15b5c698807dc66abb2e3c4bf17774edf855` |
| `native-context.json` | `a32a3b602818ea32ba44576e5ddedf694651ae2c2a40b7b79e2ef75fe6b02c86` |

Self-review исправления проверил общий guard, всех callers, RED/GREEN paths и соответствие generated runtime. Review P1 устранён; задача остаётся в review владельца. Ограничения core-only, fixture receipt, наблюдённой macOS/Codex 0.157.0 и O(n) recall остаются прежними.
