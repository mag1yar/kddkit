# Run Context and Input Snapshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking. Preserved execution method: solo; no auxiliary agent or independent reviewer unless a new risk is evidenced and the route is explicitly escalated.

**Goal:** Сохранять полные проверенные входы каждой authority generation, отдавать их через scoped get_context и блокировать продолжение на устаревших входах без потери истории.

**Architecture:** Одна immutable таблица project SQLite хранит снимок и приватные сведения для проверки его источников. Сборка входит в транзакцию issueRunAuthority; get_context читает публичную часть сохранённого снимка. Общая проверка актуальности защищает run и modeled owner, а отдельный host check сохраняет notice о необходимости обновления.

**Tech Stack:** TypeScript/Node >=22, better-sqlite3 WAL, существующие Vitest и MCP SDK, /usr/bin/git; новых зависимостей нет.

**Spec:** [2026-09-29-run-context-design.md](../specs/2026-09-29-run-context-design.md), утверждённый документ bd97d40. Владелец: «Утверждаю, составь план».

## Global Constraints

- SELECTIVE ROUTE: solo. Root последовательно реализует, проверяет и делает self-review; subagent models: none. Primary current configuration разрешена владельцем; Sol/High metadata не объявляются проверенными.
- Текущая ветка task/143-kanban-orchestrator-contract; task base e8f01bf. Не создавать worktree/новую ветку и не менять untracked references/.
- Миграция v17; migrations 1–16 и старые rows/history не переписываются. Реальный board schema 13 открывается только совместимым установленным MCP, не development core/CLI.
- Core + existing scoped get_context. RunOperation остаётся get_context | submit_report | request_question. Новых transport tools, owner CLI/UI, runtime/process lifecycle, scheduler или role/skill tables нет.
- Полные mandatory requirements/rules/dependencies. UTF-8 byte budget default/max 65536; меньший host budget допустим. Bytes не объявляются tokens; model/Always-skill prompt capacity проверяется #149/#150.
- Native verification: macOS и pinned Codex 0.157.0. Недостаточный/failed/inconclusive proof отказывает; unit mock native attestation не заменяет реальные native gates.
- Истечение/stale/revoke не освобождает writer. Stop/handoff должен оставаться доступным trusted host при stale inputs. Старый grant без snapshot непригоден, без fabricated history.
- input commit не заменяется live HEAD. Новые inputs требуют новой generation/attempt через будущий lifecycle; notice не объявляется доставкой в provider или runtime ACK.
- Паттерны самостоятельно адаптируются под текущий стек. Названия reference repos допустимы только в planning/task docs, не product source/schema/tests/comments/commit trailers.
- Local commits, single-subject messages; never push. Задача остаётся review до приёмки владельца.

## Review Focus

1. Новое обязательное rule после выдачи grant: прежний набор ids не должен скрывать новое обязательство; Task 4 проверяет addition/withdrawal и полный набор.
2. Owned host call без optional authority: launch/result/children/completion не должны обойти stale snapshot; Task 4 проверяет общий owner guard и сохранность stop/handoff.
3. Artifact alias/replacement между path check и чтением: приватный файл или новые bytes не должны попасть в снимок; Task 2 проверяет file descriptor identity, symlink/hardlink/DB/config и изменение hash.
4. Unicode и вложенное JSON escaping на границе cap: считать реально выданный envelope, сохранять mandatory целиком, не переполнять пакет omitted metadata; Task 2 проверяет exact bytes и optional omission.
5. Прежняя generation и неизвестный external id после migration/restart: отсутствие снимка не должно создать permissive fallback или непроверенный handoff; Tasks 1/3/5 проверяют archive/issuance/MCP и внешнего writer.

## Файлы и интерфейсы

Новые production files — только `packages/core/src/run_inputs.ts` (типы, сборка, безопасное artifact read, archive/public projection) и `packages/core/src/run_inputs_current.ts` (freshness и host notice). Existing authority.ts выдаёт grant и читает snapshot; execution.ts вызывает общий owner guard. Рефакторинг соседних подсистем не требуется.

Новые tests — `packages/core/test/run_inputs.test.ts`, `run_inputs_current.test.ts` и shared `run_inputs_fixture.ts`, расширяющий существующий memory_fixture.ts. Native attestation unit shim остаётся внутри тестов и маркируется; production gate не меняется. Existing authority/MCP/schema tests расширяются по месту. Новый compiled observation producer — `.planning/research/orchestration/context-check.mjs` и его настоящий output `context-evidence.json`.

Типы ниже — точный контракт между этапами. `RunContextSnapshot` продолжает определяться в authority.ts; final `inputs` ссылается на `RunInputSections` и добавляется в Task 5. До Task 5 archive использует intersection type, не ломая existing live response type промежуточных commits. Остальные internal helpers не экспортируются из public barrel.

```ts
export interface RunInputGrant {
  projectId: string; taskId: number; workItemId: string; runId: string; generation: number;
  operations: readonly RunOperation[];
  repositories: readonly { repoId: string; checkoutPath: string; commonDir: string; write: boolean }[];
  ownership?: OwnershipRef;
  native: { readableRoots: readonly string[]; writableRoot?: string; scratchDir: string; configHash: string };
}
export interface RunInputOptions { maxBytes?: number; query?: string; k?: number }
export interface RunInputRef { projectId: string; authorityId: string }
export interface RequirementInput {
  task: TaskRef; parentId: number | null; hash: string;
  title: string; body: string | null; criteria: { id: number; text: string }[];
}
export type DependencyContextPayload = Exclude<ResultPayload, { kind: 'contract' }> |
  Omit<Extract<ResultPayload, { kind: 'contract' }>, 'artifact'>;
export interface DependencyContextInput {
  edgeKey: string; resultId: string; payloadHash: string;
  binding: ResultBinding; payload: DependencyContextPayload;
  artifact?: { sha256: string; body: string };
}
export interface RunInputSections {
  schemaVersion: 1; authorityId: string; inputHash: string; createdAt: number;
  budget: { maxBytes: number; omittedRecords: number };
  requirements: RequirementInput[];
  rules: MemoryRecord[]; knowledge: MemoryRecord[];
  workItem: { ref: WorkItemRef; revision: number; inputsHash: string;
    definition: WorkItemDefinition } | null;
  dependencies: DependencyContextInput[];
  repositories: { repoId: string; commit: string; write: boolean }[];
  operations: RunOperation[]; nativeConfigHash: string;
}
export interface RunInputValidation {
  repositories: MemoryRepoVersion[];
  ownership: OwnershipRef | null;
  inputResults: { edgeKey: string; resultId: string }[];
  artifacts: { resultId: string; path: string; sha256: string }[];
}
export interface RunInputSnapshot {
  authorityId: string; inputHash: string; createdAt: number;
  response: RunContextSnapshot & { inputs: RunInputSections }; validation: RunInputValidation;
}
export type RunInputReason = 'requirements_changed' | 'membership_changed' |
  'work_item_changed' | 'ownership_changed' | 'dependency_changed' |
  'readiness_expired' | 'memory_changed' | 'rules_changed' |
  'repository_changed' | 'snapshot_missing';
export interface RunInputChange {
  reason: RunInputReason;
  taskId?: number; entryId?: string; resultId?: string; repoId?: string;
}
export type RunInputStatus =
  { status: 'current'; authorityId: string; inputHash: string } |
  { status: 'update_required'; authorityId: string; inputHash: string | null;
    changeHash: string; changes: RunInputChange[]; eventId: number };
```

`DependencyContextInput.payload` создаётся явной projection для каждого kind: у contract artifact.path полностью отсутствует, никакой object spread исходного ResultPayload не возвращает его случайно. Для остальных kinds сохраняется их typed payload. `MemoryRecord` projection не отдаёт private filesystem metadata/credentials; source provenance сохраняется в разрешённом виде, без silent изменения body/hash.

`IssueRunInput.context?: RunInputOptions` — host-only настройка сборки. Authority id/generation/project/task/operations/repos берутся исключительно из создаваемого grant. Тип внутреннего `RunInputGrant` содержит соответствующие существующие Grant поля и ownership; authority.ts переиспользует его как type Grant = RunInputGrant без дублирования shape; caller-supplied trusted snapshot не принимается.

## Task 1: v17 и immutable archive

**Files:** Modify `packages/core/src/schema.ts`, `packages/core/src/index.ts`; Create `packages/core/src/run_inputs.ts`, `packages/core/test/run_inputs.test.ts`; Modify version assertions в `packages/core/test/memory.test.ts` и schema-sensitive tests без изменения старых backup expectations.

**Interfaces:** produces `RunInputRef`, `RunInputSnapshot`, `runInputSnapshot(handle: ControllerHandle, ref: RunInputRef): RunInputSnapshot`; internal `readRunInputSnapshotDb(db, authorityId): RunInputSnapshot` и `persistRunInputSnapshotDb(db, snapshot): void`. Последние требуют transaction, проверяют shapes/hashes и остаются вне barrel. Exports/types из общей секции добавлять вместе с использующим их этапом, без unused scaffolding.

- [x] **1. RED миграции.** На реальном временном SQLite выполнить MIGRATIONS.slice(0,16), user_version=16, WAL + wal_autocheckpoint=0. Наполнить historical tables включая memory entry/revisions, external grant, modeled owner/results и legacy FTS; использовать заполнение существующего memory.test.ts с добавленными memory rows. Снять таблицы `SELECT * ORDER BY rowid`, затем вызвать openDb.

```ts
const before = historicalRows(raw);
expect(statSync(path + '-wal').size).toBeGreaterThan(0);
const upgraded = core.openDb(path, core.canonicalCommonDir(f.repo), f.repo);
expect(upgraded.pragma('user_version', { simple: true })).toBe(17);
expect(historicalRows(upgraded)).toEqual(before);
expect(upgraded.prepare('SELECT count(*) n FROM run_input_snapshots').get()).toEqual({ n: 0 });
const backup = new Database(path + '.v16.bak', { readonly: true });
expect(backup.pragma('user_version', { simple: true })).toBe(16);
expect(historicalRows(backup)).toEqual(before);
```

`historicalRows` локален этому test: перечисляет все существовавшие v16 обычные tables плюс search_index; новые snapshot rows не входят. Закрыть backup/upgraded/raw в finally. Проверить reopen, foreign_key_check и newer-schema refusal. Старые v15/v14 backup сценарии продолжают ожидать именно свои исторические версии, current version сверяется с MIGRATIONS.length.

- [x] **2. Run RED.** `pnpm --filter @kddkit/core test -- test/run_inputs.test.ts --maxWorkers=1`. Ожидается отсутствующая таблица/версия 16 вместо 17, не fixture setup failure.
- [x] **3. Добавить только v17 SQL и archive read.** Не переписывать ни одного прежнего SQL блока.

```sql
CREATE TABLE run_input_snapshots (
  authority_id TEXT PRIMARY KEY REFERENCES run_authorities(authority_id),
  input_hash TEXT NOT NULL CHECK(length(input_hash)=64 AND input_hash NOT GLOB '*[^0-9a-f]*'),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at INTEGER NOT NULL
);
CREATE TRIGGER run_input_snapshots_immutable_update BEFORE UPDATE ON run_input_snapshots
BEGIN SELECT RAISE(ABORT,'immutable run input snapshot'); END;
CREATE TRIGGER run_input_snapshots_immutable_delete BEFORE DELETE ON run_input_snapshots
BEGIN SELECT RAISE(ABORT,'immutable run input snapshot'); END;
```

Archive read первым делом получает authentic controllerDb и сверяет projectId с projectOf. Lookup authority/snapshot сверяет ids/project/task/run/generation с настоящим authority row/grant; canonical hash пересчитывается с исключёнными top-level inputHash и response.inputs.inputHash. Missing/malformed/hash mismatch даёт bounded KddError. Token/grant_json не возвращаются. Historical read не вызывает currentAuthority/liveOwner: нужен доступ trusted host после stale/revoke.

- [x] **4. GREEN archive/security.** Проверить настоящие UPDATE/DELETE отказанные triggers; forged/copied handle и foreign project denied; historical rows/backup неизменны. Использовать фиксированный seed payload только для archive/schema test, не объявлять его authority issuance или native proof.
- [x] **5. Commit.** `git add packages/core/src/schema.ts packages/core/src/run_inputs.ts packages/core/src/index.ts packages/core/test/run_inputs.test.ts packages/core/test/memory.test.ts` и только другие фактически изменённые schema assertions; `git commit -m 'feat(core): store immutable run input snapshots'`.

## Task 2: Сборка, artifact bytes и измеренный budget

**Files:** Modify `packages/core/src/run_inputs.ts`; Create `packages/core/test/run_inputs_fixture.ts`; Extend `packages/core/test/run_inputs.test.ts`; reuse execution_fixture.ts, memory_fixture.ts, execution_results.ts и memory_query.ts.

**Interfaces:** internal `buildRunInputSnapshot(db, grant: RunInputGrant, authorityId: string, options: RunInputOptions = {}, observers: ResultObservers = {}, privateRoots: readonly string[] = []): RunInputSnapshot`, `runContextWireBytes(response: RunContextSnapshot): number`. Ни один не становится MCP/public host assembly bypass. Пакет grant для unit tests задан fixture и явно не является production native attestation.

- [x] **1. Создать shared real fixture и RED.** `runInputFixture(registerNative: (packet: VerifiedCodexPackage) => void)` расширяет memoryFixture: git clone --no-hardlinks в root/workspace, mkdir scratch, bindRepository(kind=managed), текущий repoId и IssueRunInput для external workItemId='context-fixture'. Native object регистрируется только в test-local WeakSet через переданный registerNative; production assertVerifiedCodexPackage не меняется. Возврат `{...f, workspace, scratch, input}` позволяет tests использовать f.draft/f.proof/f.ref/f.task.

В beforeEach/afterEach применять existing cleanupFixtures. Создать parent + два children, project/parent/own/sibling rule через точные persisted fixture receipts f.proof, selected fact и candidates. Сначала проверить отсутствие/усечение mandatory секций у настоящего assembler.

```ts
const snapshot = f.db.transaction(() => buildRunInputSnapshot(f.db, grant, authorityId))();
expect(snapshot.response.inputs.requirements.map(r => r.task.taskId)).toEqual([parent.id, children.own.id]);
expect(snapshot.response.inputs.rules.map(r => r.body).sort()).toEqual(['own', 'parent', 'project']);
expect(JSON.stringify(snapshot.response)).not.toContain('sibling private text');
expect(snapshot.response.inputs.knowledge.every(r => r.kind !== 'candidate')).toBe(true);
```

`grant` — известная immutable fixture запись полей RunInputGrant из общей секции, включая реальные bound checkout paths и generation=1; assembler проверяет membership/binding/object independently. authorityId имеет 32 lowercase hex. Сохраняемый snapshot из этого test не выдаёт runnable credential.

- [x] **2. Run RED.** `pnpm --filter @kddkit/core test -- test/run_inputs.test.ts --maxWorkers=1`; ожидается отсутствие assembler или отсутствующие mandatory entries.
- [x] **3. Реализовать сборку через существующие helpers.** В transaction: shape/options, реальные repo bindings + HEAD commit, parent/own/source contracts; scopedWorkItem и raw current owner row для actual pin set; pinnedInputsCurrent плюс объявленные binding checks. selectMemory на pinned view даёт все rules; queryMemoryDb и memoryRecordDb загружают полные optional revisions. Пустой sanitized query не вызывает FTS и даёт пустой optional shortlist. Не добавлять отдельный ranking/embedding/role resolver.

Для owned work не repin, не искать latest result; существующие pins совпадают с owner.inputResults, producer state/revision и transitive validation. Проверить code-in-base/merged/readiness через reused ResultObservers там, где требуются свежие host observations; доступные callbacks — host-only `IssueRunInput.contextObservers?: ResultObservers`, не trusted payload. Если проверка не доказана, refuse до записи. После callback повторно сверить input contracts/pins/rule set перед persistence; cloned caller input не позволяет callback заменить сохранённые данные. Неизвестный repo/source или modeled id без owner даёт отказ.

Для artifact — Node stdlib file descriptor:

```ts
const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
try {
  const file = fstatSync(fd);
  if (!file.isFile() || file.nlink !== 1 || file.size > maxBytes) throw new KddError('unsafe context artifact');
  const bytes = readFileSync(fd);
  if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw new KddError('context artifact changed');
  const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (redact(body) !== body) throw new KddError('private context artifact');
  return body;
} finally { closeSync(fd); }
```

До open проверить absolute canonical path, отсутствие symlink ancestors, точные DB/WAL/SHM и их aliases, known private filename/runtime locations. Переиспользовать memoryPrivatePath/redact; paths внутри privateRoots запрещены, кроме явно зарегистрированных checkout docs и выделенного filesDir, которые всё равно проходят filename/alias/body checks. Root внутри checkout/filesDir или совпадающий с ним остаётся запрещённым; исключение действует только для более широкого родительского root. Не отдавать roots наружу. Выделенный filesDir(db.name) для опубликованных artifacts проверять относительно этого canonical root, чтобы `.kdd/.../files/api.txt` оставался разрешённым, а credentials/runs/bootstrap/config — нет. Сверить lstat/fstat dev/ino и неизменность fd identity/size/timestamps после чтения. Path replacement не позволяет прочитать новые bytes вместо подтверждённых. Public projection никогда не содержит artifact.path/commonDir/checkoutPath.

Считать настоящий MCP wire envelope:

```ts
return Buffer.byteLength(JSON.stringify({
  content: [{ type: 'text', text: JSON.stringify(response) }],
}), 'utf8');
```

Hash self-fields исключаются из canonical inputHash; проверка envelope делается с финальными 64-hex hash и omittedRecords, после добавления каждой целой optional записи. При mandatory overflow throw с безопасными requiredBytes/limit; никаких capText для обязательного текста. Неизвестный/private/non-UTF8 mandatory input также отказывает, не превращается в omission.

- [x] **4. GREEN + adversarial checks.** RF3/RF4: real files для invalid UTF8, secret, .npmrc/.netrc/.git-credentials, native config, DB/WAL/SHM, symlink/hardlink, file replacement и hash drift. Unicode/quotes/backslashes с budget на exact boundary: wireBytes<=limit, rule/body без truncation, optional omitted целиком; many rules и k=1 не теряют parent policies. Cross-repo contract/readiness получает bytes/refs без включения backend code в frontend. Exact sourceTasks contracts не расширяют memory scope. body из raw report не принимается как published result.
- [x] **5. Commit.** `git add packages/core/src/run_inputs.ts packages/core/test/run_inputs.test.ts packages/core/test/run_inputs_fixture.ts`; `git commit -m 'feat(core): assemble scoped run inputs within a byte budget'`.

## Task 3: Атомарная issuance и поколение снимка

**Files:** Modify `packages/core/src/authority.ts`, `packages/core/src/index.ts`; Extend `packages/core/test/authority.test.ts`, `packages/core/test/authority_store.test.ts`, `packages/core/test/run_inputs.test.ts`.

**Interfaces:** IssueRunInput получает host-only context/contextObservers; IssuedRunAuthority не меняет существующие поля token/authorityId/generation. Создаваемый grant связывает snapshot по authorityId; token не входит в payload. Internal builders/persistence из Task 1/2 вызываются в существующей immediate transaction.

- [x] **1. RED atomic issuance.** Добавить assertions на no-writes до rejected issuance и после rejected rotation. Проверить mandatory budget rejection до нового marker, count grant/snapshot/event, callback mutation и отсутствие полуперехода.

```ts
const before = ['managed_task_policy', 'run_authorities', 'run_input_snapshots', 'events']
  .map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
expect(() => core.issueRunAuthority(f.handle, { ...f.input, context: { maxBytes: 1 } })).toThrow(/limit|budget/);
expect(['managed_task_policy', 'run_authorities', 'run_input_snapshots', 'events']
  .map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(before);
```

Repeat with valid generation1 followed by rejected generation2; original revoked_at остаётся null. Modes/repository/native-privateStore/hardlink conditions existing authority_store tests сохраняются.

- [x] **2. Run RED.** `pnpm --filter @kddkit/core test -- test/authority.test.ts test/authority_store.test.ts test/run_inputs.test.ts --maxWorkers=2`.
- [x] **3. Реализовать issuance.** Clone/shape host input, generation CAS, authentic native + repositoryScope + modeledOwnership + privateStore, генерировать authorityId, build snapshot до mark. Затем mark, revoke previous, insert authority, persist snapshot, append existing authority_issued и snapshot receipt ids/hash/budget bytes без body/token. Callback-side input mutation и filesystem drift ещё раз проверяются перед commit. Любое исключение откатывает всё.

```ts
const authorityId = randomBytes(16).toString('hex');
const snapshot = buildRunInputSnapshot(db, grant, authorityId, input.context, input.contextObservers,
  [input.native.controlDir, ...input.native.protectedPaths]);
// Existing marker/revoke/INSERT remain inside this same immediate transaction.
persistRunInputSnapshotDb(db, snapshot);
```

`buildRunInputSnapshot` уже определён в Task 2 с ResultObservers и privateRoots. Issuer всегда передаёт authentic native controlDir/protectedPaths для file-read guard; function callback/private config/token не сериализуются в snapshot/hash. Test-only вызов assembler с пустыми privateRoots не выдаёт authority. Snapshot receipt фиксирует measured wire bytes, не дублирует body.

- [x] **4. GREEN identities.** external id сохраняет null workItem/ownership; существующий modeled id без owner denied; forged snapshot input key denied. Generation0→1→2 создаёт два immutable rows, старый token denied; replay generation1 не пишет. Legacy grant без snapshot после v17 не оживает. No token/config bytes в rows/public projection/events.
- [x] **5. Commit.** `git add packages/core/src/authority.ts packages/core/src/index.ts packages/core/test/authority.test.ts packages/core/test/authority_store.test.ts packages/core/test/run_inputs.test.ts`; `git commit -m 'feat(core): bind input snapshots to atomic authority issuance'`.

## Task 4: Freshness, host notice и общий owner guard

**Files:** Create `packages/core/src/run_inputs_current.ts`, `packages/core/test/run_inputs_current.test.ts`; Modify `packages/core/src/authority.ts`, `packages/core/src/execution.ts`, `packages/core/src/index.ts`; Extend `packages/core/test/execution_ownership.test.ts`, `packages/core/test/execution_results.test.ts` по boundary сценариям.

**Interfaces:** public `checkRunInputs(handle: ControllerHandle, ref: RunInputRef): RunInputStatus`; internal `runInputChangesDb(db, snapshot): RunInputChange[]`, `assertRunInputsCurrentDb(db, authorityId): void`, `assertOwnedRunInputsCurrentDb(db, owner: OwnershipRef): void`. Helper работает с authentic stored data, не вызывает currentAuthority/liveOwner. Guard caller transaction не пишет notice; host check делает отдельный successful immediate transaction.

- [x] **1. RED RF1/RF2.** Выдать valid modeled grant с selected memory/rules/result, получить get_context snapshot, затем менять каждый вход отдельным fixture: parent/own/source body, parent_id, work revision/fence, selected fact/decision revision, новый rule, withdrawn rule, artifact bytes, transitive result и readiness expiry. Требовать update_required и отказ run/native publication boundaries. Для нового rule убедиться, что прежние ids/hashes остались прежними — проверяется именно set change.

```ts
const frozen = core.runInputSnapshot(f.handle, ref);
core.writeMemory(f.handle, addedRule, f.proof(addedRule, 'create', 'user'));
const notice = core.checkRunInputs(f.handle, ref);
expect(notice.status).toBe('update_required');
expect(core.checkRunInputs(f.handle, ref)).toEqual(notice);
expect(core.runInputSnapshot(f.handle, ref)).toEqual(frozen);
expect(() => core.readRunContext(context)).toThrow();
expect(() => core.recordLaunchIntent(f.handle, { owner: owner.ref,
  intent: { launchId: 'stale-launch', writerScopeId: 'stale-writers' } })).toThrow(/inputs|stale/);
```

CreateSubtasks из ранее сохранённого BA-report также denied, как submitRunReport/publishResult/completeWorkItem с omitted authority. Stale stop/handoff: never_started только без launch; launched owner требует complete actual StopObservation, unknown writer held, no premature release.

- [x] **2. Run RED.** `pnpm --filter @kddkit/core test -- test/run_inputs_current.test.ts test/execution_ownership.test.ts test/execution_results.test.ts --maxWorkers=2`.
- [x] **3. Реализовать общую проверку.** Сравнить contracts/membership, raw owner row/revision/fence/current work item, pinnedInputsCurrent and transitive results, artifact fd bytes/hashes, readiness expiration, selected memory current revision/status/hash и весь применимый rule set из pinned repo view. Repo identity/binding/object availability проверять через existing helpers. Нельзя сравнивать live HEAD с pinned input commit как требование неизменности code output.

Latest associated snapshot для actual owner/fence определяется по настоящим run_authorities и grant ownership, не по совпавшему runId; новая generation не делает старый stale snapshot действующим. Отсутствующий snapshot у связанного grant блокирует owner operation. У owner без когда-либо выданного run grant сохраняется обычный #146 host-only flow; это не fallback для existing authority без snapshot. Include revoked latest associated grant, чтобы revoke не обходил stale input guard через omitted authority. История иных fences не блокирует новую действительную резервацию.

В currentAuthority добавить snapshot existence/freshness после базового authentic grant validation; liveOwner вызывает общий owner helper после existing contracts/pins guard. Error bounded; notice не писать в transaction, которая немедленно throws.

В checkRunInputs clone/scope/ref shape; sorted reason refs → changeHash, dedup event query по authorityId/inputHash/changeHash under immediate transaction; appendEvent(taskId, controllerActor,'run_inputs_changed', safe ids/hash/reasons), вернуть eventId. Ни новый grant, ни пересборка, ни доставка/ACK не выполняются. Archive по-прежнему доступен после stale/revoke.

- [x] **4. GREEN non-invalidations + notice replay.** Новые candidates/unselected facts, checkbox/evidence/status/comments/ordering не пересобирают response; check status current, неизменный hash. Two-connection notice replay даёт один event; generation rotation invalidates old credential, callback/report не может подтвердить свои правила. Всё до и после сравнить по stored snapshot bytes и owner rows.
- [x] **5. Commit.** `git add packages/core/src/run_inputs_current.ts packages/core/src/authority.ts packages/core/src/execution.ts packages/core/src/index.ts packages/core/test/run_inputs_current.test.ts packages/core/test/execution_ownership.test.ts packages/core/test/execution_results.test.ts`; `git commit -m 'fix(core): fence execution when pinned run inputs change'`.

## Task 5: Saved get_context и pinned run memory

**Files:** Modify `packages/core/src/authority.ts`, `packages/mcp/src/run_server.ts`; Extend `packages/mcp/test/run_server.test.ts`, `packages/core/test/authority.test.ts`.

**Interfaces:** readRunContext(context: RunContext): RunContextSnapshot выдаёт saved response; runMemoryView получает snapshot.validation.repositories, не новый HEAD. Existing response keys + inputs; no client parameters, no tools.

- [x] **1. RED transport.** Через существующий InMemoryTransport и built stdio broker проверить snapshot hashes/bytes, parent/rule/result text, get_context-only catalog, forbidden extra arguments, revoked/stale denied. Закрыть/reopen DB и заново открыть authentic RunContext живым token: response должен совпадать. После title/body/rule change get_context denied; trusted archive frozen и notice explicit, без private path/token leakage.

```ts
const first = await client.callTool({ name: 'get_context', arguments: {} });
const second = await client.callTool({ name: 'get_context', arguments: {} });
expect(second).toEqual(first);
const content = first.content as { type: string; text: string }[];
const payload = JSON.parse(content[0].text);
expect(payload.inputs.inputHash).toBe(core.runInputSnapshot(controller, ref).inputHash);
expect(JSON.stringify(first)).not.toContain(input.native.scratchDir);
```

For stdio use existing StdioClientTransport at packages/mcp/dist/run_main.js and authentic issuer-created DB/token; no migrations in broker. Invalid schema/config/symlink/hardlink startup tests remain.

- [x] **2. Run RED.** `pnpm --filter @kddkit/mcp test -- test/run_server.test.ts --maxWorkers=1`; `pnpm --filter @kddkit/core test -- test/authority.test.ts --maxWorkers=1`. Built stdio tests проверяются после свежего build, иначе old artifact не считается RED/GREEN evidence.
- [x] **3. Подключить чтение.** Добавить required inputs: RunInputSections в final RunContextSnapshot type. После existing live(scope, get_context) вернуть snapshot.response, без task/criteria/legacy decision SELECT на каждом call. MCP registration остаётся прежней, description уточняется на saved run inputs; error handler не раскрывает detail. readRunMemory/recallRunMemory/runMemoryRules используют pinned repository input commits, current scope/grant guards остаются. HEAD B не делает fact B доступным run A; новый valid grant B получает свой snapshot/view.
- [x] **4. GREEN/commit.** Fresh build core/MCP перед built stdio tests; full source test sets из Steps 1–3. Reopen/get_context-only/grant absence/forged schema/HEAD drift checks покрывают C06/C10/C12/RF5. Реальные process races и crash проверяются compiled producer в Task 6 с genuine native packages, не через fake attestation. `git add packages/core/src/authority.ts packages/mcp/src/run_server.ts packages/mcp/test/run_server.test.ts packages/core/test/authority.test.ts`; `git commit -m 'feat(mcp): return saved context through scoped run access'`.

## Task 6: C01–C15, regressions и реальные native gates

**Files:** Create `.planning/research/orchestration/context-check.mjs`, `context-evidence.json`; Modify existing `.planning/research/orchestration/codex-broker-check.mjs`, `memory-check.mjs`, `dependencies-check.mjs` только для новых snapshot contracts/fixtures; refresh real `memory-evidence.json`, `dependencies-evidence.json`; generated build/plugin files; this plan progress and spec status. Local logs/native producer artifacts under ignored `.superpowers/sdd/2026-09-29-run-context/`.

**Interfaces:** context-check.mjs imports public compiled core and MCP SDK. Genuine grant/native outputs берутся только из issuer/preflight, не raw fabricated proof. Input hash в evidence сопоставляется с DB и actual get_context payload. Producer JSON содержит observedAt, schema, runtime hashes, checks C01–C15, races counts, command exits and limitations.

- [x] **1. Создать compiled observations.** Plain node assert + real temp Git/SQLite; C01–C14 соответствуют таблице spec. Public archive/check APIs используются вместо внутренних trusted scope overrides. Для положительных run/scoped MCP сценариев replay actual fixture state из genuine native broker script, либо вызвать его как measured producer с snapshot values; mocks допустимы только помеченным unit/race checks, не C15. Mutation/known-secret/private-file tests включают 0 rows/events changed. RF1–RF5 каждый сопоставить с конкретными positive/negative outputs.

До GREEN producer делает baseline RED на старом e8f01bf compiled public API в isolated file, без открытия настоящей доски: absent snapshot APIs/fields ожидаемо отказывают. Не применять новую migration к старой real DB и не выдавать старую схему за current baseline.

- [x] **2. Обновить существующие fixtures.** В genuine codex-broker-check memory rule публикуется до первоначального grant либо отдельное изменение после grant проверяет stale refusal/new valid generation. Сохранить все old native/project-config/private-store/operations/hardlink predicates. В #146 persisted-grant fixtures missing snapshot должен отказать; положительные modeled BA-report scenarios получают целый issuer snapshot через unit-native harness или genuine measured fixture, с явной limitation. Никогда не вставлять пустой bypass snapshot и не отключать freshness ради старого порядка. Historical schema backup asserts обновляются только для current version; M08 по-прежнему требует exact current native runtime hashes и passing observations.

- [x] **3. Fresh build/plugin sync, затем полный tests/typecheck.** Последовательно; saved logs и process exit каждый измерить.

```bash
pnpm exec turbo run build --force --only --concurrency=1
node scripts/sync-codex-plugin.mjs
pnpm test --force --only --concurrency=1 -- --maxWorkers=2
pnpm exec turbo run typecheck --force --only --concurrency=1
pnpm test:codex-plugin
node scripts/sync-codex-plugin.mjs --check
```

Capture SHA256 пяти runtime paths перед native: packages/core/dist/index.js, integrations/codex-plugin/runtime/core.js, packages/mcp/dist/main.js, integrations/codex-plugin/runtime/mcp.js, packages/mcp/dist/run_main.js. Нельзя менять build/source между producers без повторения gates.

- [x] **4. Native full/context.** Executable `/Users/magiyar/Projects/My/kddkit/.superpowers/sdd/2026-09-28-subtasks-dependencies/codex-0.157.0/bin/codex`, expected SHA256 ad0be20d04e2ba6146ecdb51d7f8b7b0fe15420a15dc9b0057518d858f1f3714. Использовать genuine production script; portable passive diagnostic observer допустим только для read-only inspection, не для изменения predicates/results.

```bash
KDD_CODEX_EXECUTABLE=/Users/magiyar/Projects/My/kddkit/.superpowers/sdd/2026-09-28-subtasks-dependencies/codex-0.157.0/bin/codex node .planning/research/orchestration/codex-broker-check.mjs
KDD_CODEX_EXECUTABLE=/Users/magiyar/Projects/My/kddkit/.superpowers/sdd/2026-09-28-subtasks-dependencies/codex-0.157.0/bin/codex node .planning/research/orchestration/codex-broker-check.mjs --context-only
```

Saved stdout JSON обоих passes — native-full.json/native-context.json в current ignored evidence dir; stderr отдельный. Initial/bound packages genuine applicable, failures=0, каждая observation executed && unchangedProtectedBytes && !timedOut, protected hashes before/after равны. Same current guardHash/scriptHash, operations совпадают фактическому catalog, new snapshot bytes/hash реально прочитаны Codex get_context. C15 includes existing native creation/old hardlink/root/symlink/project-config/DB/scratch guards. failed/inconclusive/old hash не проходят.

- [x] **5. C13: два настоящих процесса, twenty generation races и SIGKILL.** context-check.mjs поддерживает `--race-child /absolute/fixture.json`; child mode читает только отдельный host fixture file вне repo. Native input каждого child использует одну общую read-only repo scope и собственные scratch/controlDir, private store входит в protectedPaths. Каждый child открывает одну реальную SQLite connection, вызывает настоящий preflightCodex один раз и удерживает process-local VerifiedCodexPackage внутри этого процесса; packet/token не передаются по IPC. Parent ждёт ready только после genuine proof обоих процессов и запускает 20 go barriers с одинаковым expectedGeneration. Native matrix не повторяется двадцать раз, но assertVerifiedCodexPackage повторяется самой issuance на каждом переходе.

```js
// Branch inside context-check.mjs; imports use the same compiled core as the parent.
const packet = await core.preflightCodex(fixture.native);
const controller = core.openController(db);
process.send({ ready: true });
process.on('message', command => {
  if (command.kind === 'issue') {
    try {
      const issued = core.issueRunAuthority(controller, {
        ...fixture.input, expectedGeneration: command.expectedGeneration,
        runId: `race-${command.round}-${fixture.lane}`, native: packet,
      });
      process.send({ ok: true, authorityId: issued.authorityId, generation: issued.generation });
    } catch (error) { process.send({ ok: false, error: String(error.message).slice(0, 256) }); }
  }
});
```

Parent uses Node fork + IPC ready/issue/close barrier по lifecycle pattern existing execution_race.mjs; child keep-alive продлевает только fixture host, не объявляет LLM runtime. На каждом round проверить один winner, один generation conflict, один added snapshot/authority/authority_issued event и один snapshot receipt, old grant revoked, immutable old rows, duplicates=0. После 20 rounds отдельная команда crash начинает outer BEGIN IMMEDIATE, выполняет issuer и сообщает pending; parent SIGKILL и reopen подтверждают rollback grant revocation/snapshot/events. При timeout/child error incomplete вместо passing count; finally kill/wait all children и сохранить command exits. Успешные 20 процессных races получены от compiled issueRunAuthority с genuine preflight, а не подменённой WeakSet.


- [x] **6. Final compiled proofs.** Передать fresh native artifact paths в context-check и memory-check через documented explicit CLI args, сохраняя strict hash/shape gates; не hardcode passing numbers. Затем выполнить:

```bash
node .planning/research/orchestration/dependencies-check.mjs
node .planning/research/orchestration/memory-check.mjs
node .planning/research/orchestration/context-check.mjs
```

Defaults у memory-check обновить на current task evidence dir либо задать новые exact paths; prior #147 native artifacts остаются historical, не смешиваются с current run. Producer JSON копировать byte-for-byte в tracked evidence files после exit0. Counts C=15/15, D=12/12, M=14/14 должны исходить из реально executed scenarios; race winners=20/20 и duplicates=0. Confirm runtime hashes unchanged после всех producers. Новое code fix → повтор affected tests/build, full typecheck и native, если изменились hashes/authority boundary.

- [x] **7. Self-review и review владельца.** Review accumulated diff от e8f01bf, все C01–C15/RF1–RF5, public exports, private source paths, snapshot absence/replay/notice, owner guard и actual stop safety. Открытый blocking defect исправляется до review; не добавлять fresh auxiliary при solo. Check tests и typecheck отдельно, git diff --check, plugin sync check. Record actual commands/counts/hashes/limitations в этом плане и KDD comment; check criteria400/401 совместимым installed CLI только после измерений. Move #148→review через MCP, не done. Commit только фактически changed scoped files; squash/close только по запросу владельца.

## Self-review плана и трассировка

| Spec / observations | Этап |
| --- | --- |
| §1–2 scope/trust/no implicit delivery | Global Constraints, Tasks 2/4/5/6 |
| §3 requirements/parent/sourceTasks/memory/pins/private artifacts/repos | Task 2, freshness Task 4, pinned view Task 5 |
| §4 bytes/mandatory overflow/optional omissions | Task 2 и atomic refusal Task 3 |
| §5 v17/archive/atomic generation/external/missing snapshots | Tasks 1/3/5 |
| §6 freshness/durable dedup/omitted authority/handoff | Task 4 |
| §7 saved get_context/restart/host-only history/no tools | Task 5 |
| C01 | Task 1, compiled Task 6 |
| C02 | Task 2 inherited scope, compiled Task 6 |
| C03 | Tasks 2/3 mandatory budget, compiled Task 6 |
| C04 | Task 2 exact typed dependency payload, compiled Task 6 |
| C05 | Tasks 2/4 missing/stale dependency, compiled Task 6 |
| C11 | Task 2 byte/secret/private file boundary, compiled Task 6 |
| C06 | Task 5 real transport/restart, compiled Task 6 |
| C10 | Tasks 1/3/4/5 immutable/authority rejection, compiled Task 6 |
| C12 | Tasks 2/5 pinned repo view, compiled Task 6 |
| C07 | Task 4 mutable input notices/dedup, compiled Task 6 |
| C08 | Task 4 non-invalidations, compiled Task 6 |
| C09 | Task 4 boundary guards/handoff, transport Task 5, compiled Task 6 |
| C13 | Task 6 step 5 compiled genuine process races/rollback |
| C14 | Task 6 legacy/regression checks, old tests сохраняются |
| C15 | Task 6 genuine full/get_context-only native matrices |
| RF1/RF2/RF3/RF4/RF5 | Task 4 / Task 4 / Task 2 / Task 2 / Tasks 1/3/5 |

План fe97f44 утверждён владельцем: «План подтверждаю, начинай». Этапы 1–5 выполнены solo; коммиты a066d28, 572bdcc, b43307b, 0272b22, ce9bf25. Fresh build/typecheck четырёх пакетов и plugin smoke/sync-check прошли; full tests: 1112 (core606, CLI215, MCP79, UI212). Этап6 завершён; ниже приведены результаты реальных gates. Итоговый self-review от e8f01bf выполнен solo, blocking defects не найдены.

## Измеренная проверка исходной реализации f593654 — 2026-09-29

Все команды выполнены на одной текущей сборке, exit 0:

| Команда | Результат |
| --- | --- |
| `pnpm exec turbo run build --force --only --concurrency=1` | 4/4 packages |
| `node scripts/sync-codex-plugin.mjs` | Синхронизировано |
| `pnpm test --force --only --concurrency=1 -- --maxWorkers=2` | 1112: core606, CLI215, MCP79, UI212 |
| `pnpm exec turbo run typecheck --force --only --concurrency=1` | 4/4 packages |
| `pnpm test:codex-plugin` | Реальный plugin stdio smoke |
| `node scripts/sync-codex-plugin.mjs --check` | Exact runtime sync |
| `node .planning/research/orchestration/codex-broker-check.mjs` | Initial124 / bound153 / final29; failures0 |
| Та же команда с `--context-only` | Initial124 / bound153 / final29; failures0 |
| `node .planning/research/orchestration/dependencies-check.mjs` | D01–D12; 20 edges +20 reservations races |
| `node .planning/research/orchestration/memory-check.mjs` | M01–M14; 20 revision races, duplicates0 |
| `node .planning/research/orchestration/context-check.mjs` | C01–C15; 20 generation races, winners20, duplicates0; SIGKILL rollback |

Codex executable и его SHA256 совпадают с step4. Обе финальные native-матрицы применимы, каждая protected observation executed/unchanged/not timed out, hashes before/after равны. Каждая матрица дважды прочитала actual saved inputHash через native `get_context`; выданные operations соответственно full и get_context-only. Genuine preflight каждого race child выполнен в его собственном процессе; VerifiedCodexPackage/token по IPC не передавались. Оба child закрыты намеренным SIGKILL; измеренные OS outcomes записаны в context-evidence.commandExits, crash также в races.crash. Root command exits0 и baseline exit1 зафиксированы отдельно в local command-exits.json и в таблице выше.

C11: wireBytes7199 <= limit7399; обязательный Unicode сохранён целиком, optional record опущен целиком. Семь unsafe artifact scenarios закрыты: шесть отказов grant и один более ранний atomic отказ publishResult для изменившихся DB bytes; canonical filesDir прошёл. Known-secret refusal не записал marker/grant/snapshot/events. RF1→C09, RF2→C07, RF3→C04, RF4→C11, RF5→C01/C10/C13; прежние missing/cancelled/transitive pin и store checks сохранены в D/M producers.

Baseline e8f01bf compiled API дал ожидаемый RED (нет runInputSnapshot/checkRunInputs) до создания DB. Неудачные fixture attempts сохранены в ignored logs: legal Unicode body cap исправлен до запуска proof; dependency randomUUID заменён уже импортированным randomBytes; mutable DB artifact отдельно измерен на publication boundary. Эти attempts не включены в passing evidence и не потребовали weakening production guards.

Tracked JSON скопированы byte-for-byte из завершённых stdout после exit0:

| Artifact | SHA256 |
| --- | --- |
| `.planning/research/orchestration/context-evidence.json` | `6bf518d3040c9e883c25eec45208421215f1bf979852c0e0927cf4ccbfd22e41` |
| `.planning/research/orchestration/dependencies-evidence.json` | `d4d3b24ebc2221981094624941fc26fddadedb93be6b90dd1cc7b2656e7dda58` |
| `.planning/research/orchestration/memory-evidence.json` | `1542aa55328c6ca5b854c03bea51f9845d631a54d32ee7a9e84eac639d82e47c` |

Native producer JSON и полные logs сохранены в ignored `.superpowers/sdd/2026-09-29-run-context/`:

- `native-full.json`: `f55a94f6d9b23cdc9ca205ed5c7b59ad9ae9d8f1606f17cbc55054c8ab1f8ad4`.
- `native-context.json`: `481394537ca7000b24318ddf0077a55b1f0ac8f1ce193f8cf869eb3492ace1f9`.

Пять runtime SHA256 до/после gates совпадают:

| Runtime | SHA256 |
| --- | --- |
| `packages/core/dist/index.js` | `4490b0bfd8107a0549b6c1ade676919a208335641568d02d8ffb8bba86ea7faf` |
| `integrations/codex-plugin/runtime/core.js` | `4490b0bfd8107a0549b6c1ade676919a208335641568d02d8ffb8bba86ea7faf` |
| `packages/mcp/dist/main.js` | `c9164efd17f75489bad2ad68469867b4b36ce85ef62f20e261f25d35be09a13b` |
| `integrations/codex-plugin/runtime/mcp.js` | `c9164efd17f75489bad2ad68469867b4b36ce85ef62f20e261f25d35be09a13b` |
| `packages/mcp/dist/run_main.js` | `c11e052584c2240d6a03a3d21d03e457c8cefd8ff3e177ae16577e41e4caf8f9` |

Ограничения остаются утверждёнными: user/host receipts — fixture evidence; bytes не model tokens; host notice не provider delivery ACK; roles/skills и runtime start/resume/steering принадлежат #149/#150/#155. Real board schema13 открывается только совместимым installed MCP/legacy CLI, development v17 к ней не применяется.

Criteria400/401 checked AI с measured evidence через isolated compatible legacy CLI (MIGRATIONS13); #148 переведена в review установленным MCP. Принятие владельцем и done не заявлены. references/ сохранён, squash/push не выполнялись.

## Исправления после независимого review

Владелец разрешил исправления: «Исправь». SPEC-01: исключение checkout/filesDir теперь применяется только к более широкому родительскому protected root; вложенный или совпадающий protected root сохраняет запрет. SPEC-02: notices содержат entryId и previous/current revision/hash; разные additions и successive revisions дают разные changeHash/eventId, одинаковое наблюдение дедуплицируется. Добавлены пять регрессионных проверок, включая атомарный отказ выдачи grant для опубликованного bootstrap.

Свежие команды: `pnpm build` — 4/4; `pnpm exec turbo run test --force --only --concurrency=1 -- --maxWorkers=2` — 1117 (core611, CLI215, MCP79, UI212); `pnpm exec turbo run typecheck --concurrency=1` — четыре typecheck; plugin smoke и sync-check — exit0. Начальные параллельные Turbo invocations дали гонки очистки dist и таймауты; их failed logs сохранены, итоговые тесты выполнены без конкурирующих сборок. Промежуточный native запуск остановлен перед окончательной сборкой; собственные процессы и девять fixture roots удалены, passing evidence из него не использовалось.

C01–C15, D01–D12 и M01–M14 повторно прошли на одной окончательной сборке. C07 подтвердил точные refs и два разных notice ids; C11 — восемь unsafe artifacts (семь отказов grant и один atomic отказ publication), включая настоящий controller внутри readonly backend checkout; canonical filesDir разрешён. Двадцать generation races дали двадцать single winners и ноль duplicates; SIGKILL подтвердил полный rollback. Обе genuine native-матрицы: initial124 / bound153 / final29, applicable, failures0, protected bytes неизменны; get_context прочитал сохранённые hashes. Все пять producer commands завершились exit0.

Ожидающий fixture-координатор C14/C15 временно приостановлен после завершённого C13 и продолжен после готовности companion JSON (971 seconds, ignored scheduling receipt). Все assertions и native per-call timeouts сохранены; оценка производительности не заявляется. Исполнители и inspector закрыты. Итоговые JSON скопированы byte-for-byte после exit0; `verify-final.mjs` подтвердил hashes, результаты и сохранность evidence.

| Evidence | SHA256 |
| --- | --- |
| `.planning/research/orchestration/context-evidence.json` | `45b9d0e4d309b393b62d1568e7d6794a3bfc77baa015e5cba3abb5a251caaabd` |
| `.planning/research/orchestration/dependencies-evidence.json` | `7cb6725b51eb9faf6a0e74ab751db169fe3a881f76a92ae8966aafd9e8b9264e` |
| `.planning/research/orchestration/memory-evidence.json` | `373252d21d30bac188b0f1a22c0afb8c28400ca4482d4bc41e801363e79c94cd` |

Core/plugin core SHA256: `420473eee4574a464998c771a18756e5f216575268e5e9d02a1b7331c7a12a96`; scoped MCP: `5bb47310c02a353aaca94ab330dd951563d3bd59697e47277dc987b88839ed56`. Остальные runtime hashes и полные native JSON сохранены в ignored verification workspace и в context-evidence.runtimeHashes. #148 остаётся в review, приёмка владельцем ожидается.
