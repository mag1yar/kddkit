# Controller authority и scope запуска — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Закрыть обход managed authority через Actor/reason и предоставить Codex/macOS проверенные native permissions и отдельный run MCP.

**Architecture:** Сначала реальный установленный Codex выполняет shell и apply_patch в временном fixture; отрицательный или неполный результат останавливает дальнейшую реализацию. Затем SQLite хранит controller-issued capabilities, общий core guard закрывает legacy writers, а scoped MCP предоставляет только собственный context/report/question. Native package использует штатные Codex profiles и Seatbelt; готовый пакет проверяется вместе с доверенным stdio broker.

**Tech Stack:** Node.js ≥22, TypeScript, better-sqlite3, существующие Vitest/MCP SDK/Zod, codex-cli 0.157.0, macOS Seatbelt. Новых dependencies нет.

**Spec:** [Утверждённая спецификация #145](../specs/2026-09-27-controller-authority-design.md). Исполнитель читает оба документа.

## Global Constraints

- Пользователь выбрал **сначала только Codex на macOS**. Route solo; текущая конфигурация primary разрешена пользователем после неуспешной проверки metadata. Выполнение в текущей ветке.
- Append migration v14; прежние migrations не менять.
- Неподдерживаемый runtime/host, расширенный effective profile или failed/inconclusive probe дают отказ, не permissive fallback.
- Custom profile не смешивается с --sandbox/sandbox_mode/sandbox_workspace_write.
- Native command network отключён в первом варианте 145. Git metadata/refs/object store закрыты для записи.
- Во всех effective writable roots, включая scratch/TMPDIR, отсутствуют existing files с nlink > 1. Повторный обход непосредственно перед каждым start/resume; check→spawn под общим protected controller lock. Busy/stale lock, исчезнувший entry или неполный обход — отказ, не retry с расширением rights.
- MCP credentials не включаются в prompt, tool arguments, события, errors, logs или recall. Секрет grant не передаётся в argv.
- Настоящая доска разработки не мигрируется новым бинарником; все новые runtime проверки выполняются с изолированными temp Git/SQLite/stores.
- Actor/reason/manualSession остаются legacy attribution. Managed human acceptance в #145 отсутствует, включая controller move в done.
- Context assembly/input snapshot — #148; role profiles — #149; runtime lifecycle — #150; clones — #151; scheduler/lease/recovery — #152. Память #147, вопросы #155, checks #157, acceptance #158 и owner transports #159 не реализуются здесь.
- Локальные коммиты после проверяемых этапов; без push. Готовность к review не означает закрытие карточки.

## Review Focus

1. Legacy config или пользовательский plugin расширяет effective permissions: отказ до выдачи launch package. Проверка в tasks 1/5.
2. Hardlink, symlink, rename или вложенный Git metadata path превращает allowed product write в foreign write: защищённые bytes/refs остаются прежними. Проверка в tasks 1/5.
3. В разрешённой legacy операции спрятан protected orderedId/link endpoint/file owner/track member: никаких частичных DB/blob изменений. Проверка в task 3.
4. Уже initialized MCP использует revoked/expired/stale context либо handle от другого DB connection: последующий read/write отказан. Проверка в tasks 2/4.
5. Legacy tick/reclaim/stop обрабатывает смешанный набор managed и legacy rows: managed row не попадает даже в kill callback. Проверка в task 3.

---

## Файлы и границы

| Файл | Ответственность |
| --- | --- |
| `packages/core/src/codex_permissions.ts` (новый) | Штатный Codex profile, реальный native probe и process-local verified package; без scheduler/start adapter |
| `packages/core/src/codex_native_probe.ts` (новый) | Общая реализация actual native matrix для builder и research entry; stdlib fixture, без отдельного опубликованного script asset |
| `packages/core/test/codex_permissions.test.ts` (новый) | Валидация configuration/package, отказ при неподтверждённом evidence |
| `.planning/research/orchestration/codex-native-check.mjs` (новый) | Запуск реального preflight, компактный JSON evidence без секретов |
| `.planning/research/orchestration/codex-package-check.mjs` (новый) | Реальная выдача opaque package и отказ при копировании, поздних aliases/config/argv/env changes |
| `packages/core/src/schema.ts` | Только migration v14 |
| `packages/core/src/authority.ts` (новый) | Opaque controller/run contexts, capability issuance/revoke, common guard, собственные run read/report/question |
| `packages/core/test/authority.test.ts` (новый), `packages/core/test/db.test.ts` | Scope/fence/expiry и preservation v13 upgrade |
| `packages/core/src/ops.ts`, `criteria.ts`, `files.ts`, `tracks.ts`, `claim.ts` | Guard в существующих writers; исключение managed из legacy queues/sweeps |
| `packages/core/test/managed_mutations.test.ts` (новый) | Матрица writers и отсутствие side effects при отказе |
| `packages/core/src/index.ts` | Экспорт публичных authority/native API |
| `packages/mcp/src/run_server.ts`, `run_main.ts` (новые), `packages/mcp/tsup.config.ts` | Фиксированный scoped server и доверенный stdio entry |
| `packages/mcp/test/run_server.test.ts` (новый), `packages/mcp/test/server.test.ts` | Настоящий MCP protocol; отсутствие owner methods; global compatibility |
| `packages/cli/test/contracts.test.ts`, `packages/ui/test/server.test.ts` | Реальные transport calls против isolated protected task |
| `.planning/research/orchestration/authority-check.mjs` (новый) | Повторяемые наблюдения собранных core/CLI/MCP/UI |
| Существующие tracked `dist` и Codex plugin runtime | Только штатная генерация через `pnpm build` |

Не добавлять generic authorization framework, новый sandbox engine, role registry или owner CLI. В #145 все прежние task-mutating API отказывают на managed rows; controller использует отдельные protect/issue/revoke API, run — отдельные read/report/question. Это не требует изменения всех legacy Actor signatures и не создаёт универсального controller bypass.

### Task 1: Проверить native enforcement до authority/schema/MCP

**Files:** create `packages/core/src/codex_permissions.ts`, `packages/core/test/codex_permissions.test.ts`, `.planning/research/orchestration/codex-native-check.mjs`; modify `packages/core/src/index.ts`.

**Interfaces:**
- Consumes: Node stdlib, installed Codex CLI; actual tool schema из request локальному fixture provider.
- Produces:

```ts
export interface CodexPermissionInput {
  executable: string;
  controlDir: string;
  model: string;
  cwd: string;
  readableRoots: readonly string[];
  writableRoot?: string;
  scratchDir: string;
  protectedPaths: readonly string[];
  brokerConfigPath?: string;
  brokerEntryPath?: string;
}
export interface NativeProbeResult {
  caseId: string;
  tool: string;
  outcome: 'allowed' | 'denied' | 'inconclusive';
  executed: boolean;
  unchangedProtectedBytes: boolean;
}
export interface VerifiedCodexPackage {
  readonly executable: string;
  readonly version: string;
  readonly cwd: string;
  readonly controlDir: string;
  readonly readableRoots: readonly string[];
  readonly writableRoot?: string;
  readonly scratchDir: string;
  readonly protectedPaths: readonly string[];
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly configHash: string;
  readonly results: readonly NativeProbeResult[];
}
export function preflightCodex(input: CodexPermissionInput): Promise<VerifiedCodexPackage>;
export function assertVerifiedCodexPackage(packet: VerifiedCodexPackage): void;
export function assertWritableRoots(roots: readonly string[]): readonly string[];
export function withNativeControllerLock<T>(controlDir: string, action: () => T | Promise<T>): Promise<T>;
export interface NativeLaunchInput {
  controlDir: string; writableRoots: readonly string[];
  executable: string; args: readonly string[]; cwd: string;
  env: Readonly<Record<string, string>>;
  phase: 'start' | 'resume';
  verified?: VerifiedCodexPackage;
}
export function spawnCheckedNative(input: NativeLaunchInput): Promise<ChildProcess>;
```

Verified object регистрируется внутри модуля, freeze рекурсивный; JSON-копия не является proof. `assertVerifiedCodexPackage` повторно сверяет executable/version, effective configuration и canonical roots. Сам интерфейс не является разрешением на произвольный start; adapter #150 должен потреблять тот же пакет.

Дополнение пользователя после f4f4ed6: `assertWritableRoots` проверяет **все** writable trees через lstat, не следует symlink к foreign target и отказывает на nlink > 1/неполном обходе. `spawnCheckedNative` — trusted-host primitive, не worker tool и не разрешение произвольного executable: runtime adapter связывает его с exact verified packet. Собранный observation использует тот же guard. Все controller mutations project используют `withNativeControllerLock` из protected controlDir; в #145 один project-wide mkdir lock без stale takeover, в #150/#151/#152 этот contract обязателен. Guard держится от fresh check до spawn acknowledgement; между последней проверкой и spawn нет пользовательского callback/await. После start controller также не внедряет unsafe links в active root.

Дополнительные RED→GREEN tests в `packages/core/test/codex_permissions.test.ts`: deep existing hardlink в workspace/scratch отказывает до child marker; fresh start проходит; добавленный после предыдущей проверки hardlink отказывает resume; missing root/unreadable tree/root alias swap отказывает; другой controller process не получает тот же lock в check→spawn interval; spawn failure освобождает только собственный lock; controlDir внутри writable tree отказан. Даже безопасный предыдущий package не отменяет повторный scan.

Уточнение builder после actual probe: `controlDir` обязателен для общего lock и защищённого model catalog; `model` — заданный trusted host id, выбор роли/model остаётся #149. Catalog фиксирует закрытую native tool metadata (direct/disabled multi-agent) независимо от default remote metadata. Profile/config/catalog construction одна для fixture и package. Module `codex_native_probe.ts` переиспользуется builder и research entry, не читает JSON evidence как proof. NativeLaunchInput.verified обязателен для adapter #150; без него helper используется только trusted host fixtures. Если verified передан, пакет повторно проверяется под тем же lock и любое отличие argv/env/cwd/roots от пакета отказано. Project config overlays fail closed; `.codex` недоступен native write, проверка отсутствия project config повторяется при validation/start/resume.

- [x] **1. Зафиксировать failing contract и runnable entry.**

```ts
it('rejects fabricated native evidence', () => {
  expect(() => assertVerifiedCodexPackage({} as VerifiedCodexPackage))
    .toThrow(/unverified/);
});
```

Entry создаёт `mkdtemp` fixture: source, context-only backend, отдельный Git clone/worktree, sibling workspace, fake store/registry/config/credential, scratch и TCP/Unix listeners. Все marker contents несекретные. `finally` закрывает children/listeners и удаляет fixture. Ввод `--json`, stdout — только summary; любой inconclusive case даёт exit 1.
Preflight вызывается дважды: без writableRoot для readonly и с workspace writableRoot для implementation. Probes создают только собственные marker files в fixture; реальные source/store/credentials никогда не читаются и не изменяются. Native package принимает только canonical roots, прошедшие проверки; alias/overlap protected и writable roots отклоняется.

```js
import { preflightCodex } from '../../../packages/core/dist/index.js';
// fixture paths создаются этим script, не берутся из реальной доски.
// Вызов после mkdir/git-init/clone и запуска контрольных listeners:
const packet = await preflightCodex({
  executable: '/opt/homebrew/bin/codex', cwd: workspace,
  controlDir: controllerDir, model: 'fixture-codex',
  readableRoots: [workspace, backend], writableRoot: workspace,
  scratchDir: scratch, protectedPaths: [source, sibling, store, credentials],
});
process.stdout.write(JSON.stringify({
  version: packet.version, configHash: packet.configHash, results: packet.results,
}) + '\n');
```

- [x] **2. Проверить red phase.** `pnpm --filter @kddkit/core test -- test/codex_permissions.test.ts`. Отказ из-за отсутствующих exports, а не зелёный test со stubbed success.

- [x] **3. Реализовать минимальный real-tool probe и builder.** Использовать `node:http`, `spawn`, `crypto`, `fs`, `path`; без SDK/provider dependency. Локальный Responses fixture подменяет только ответы модели. Реальный executable выполняет advertised native tool и отправляет actual tool output обратно provider. Формат событий сверяется с [официальным fixture установленной версии](https://github.com/openai/codex/blob/rust-v0.157.0/codex-rs/core/tests/common/responses.rs); код reference не копировать.

```js
const sse = (type, fields) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
res.writeHead(200, { 'content-type': 'text/event-stream' });
res.write(sse('response.created', { response: { id: responseId } }));
res.write(sse('response.output_item.done', { item: toolCall }));
res.end(sse('response.completed', { response: { id: responseId, output: [toolCall] } }));
```

`toolCall` строится по captured registry, включая namespace и function/custom input form. Для shell используются реальный `exec_command` либо advertised shell; для patch — реальный advertised `apply_patch`, не его имитация через shell/Node. Provider не печатает headers, requests или prompts. Успех только после соответствующего call output и проверки filesystem hashes. Unknown tool, parser error, missing utility, timeout, unsupported surface или отсутствие output означают **inconclusive**, а не ожидаемый permission denial. Каждый child имеет timeout 20 s и гарантированную остановку.

Начальная конфигурация выбирает `default_permissions`, `approval_policy="never"`, filesystem `:minimal` плюс явные paths, `network.enabled=false`. Writable только product workspace и scratch; `.git`, common-dir, worktree git-dir, protected data — явные read/deny overrides. Git metadata определяется через `git rev-parse`, не только `<workspace>/.git`. Configuration запускается с `--ignore-user-config --ignore-rules --strict-config`, без legacy sandbox flags. Проверить локальные `--help` и official profiles при построении argv; неизвестные overrides не игнорировать. Native env — allowlist необходимых system paths/locale/temp, без пользовательских secrets и injection variables.

Никаких user/project plugins/MCP/hooks/config, hosted web/apps/browser/computer-use/agent spawning. Если текущий CLI всё же читает project configuration или нельзя доказать закрытую surface, вернуть отказ. Сам fixture listener доступен model-provider соединению parent, но не native shell. Parent control request доказывает, что listener действительно работает.

- [x] **4. Выполнить полную обновлённую матрицу.** Unsafe existing hardlinks в workspace/scratch (в том числе deep и linked symlink inode) отказываются preflight до process/tool execution; raw `--hardlink-only` repro сохраняется отдельным диагностическим режимом, его failure не маскируется. Safe roots проходят actual Codex shell и apply_patch. Для readonly create/update/delete по 3 повторения; положительные product/scratch writes; реальные попытки создать новые links к readonly/denied files во всех writable destinations; rename, symlink, Git refs/object metadata, protected source/backend/sibling/store/config, TCP loopback/LAN/Unix socket. Generic symlink patch failure закрыть matched positive-control/readonly pair на том же target, с существующим target, валидным patch и проверкой unchanged bytes/exit status. Control policy отдельная fixture, никогда не входит в verified run package. Unknown utility, отсутствие actual call или неподтверждённый control остаются inconclusive. Start/resume повторно вызывают guard; другая controller mutation исключена от проверки до spawn. Все эти checks проходят до tasks 2–6.

```js
assert.equal(result.executed, true);
assert.equal(result.outcome, expectedOutcome);
assert.equal(result.unchangedProtectedBytes, true);
assert.equal(nativeListenerRequests, 0);
```

- [x] **5. Run:** `pnpm --filter @kddkit/core build`; `node .planning/research/orchestration/codex-broker-check.mjs`; focused test выше. **Gate:** все требуемые observations подтверждены. При ошибке записать case/tool/output class и остановить tasks 2–6; не заменять тест Node fs, не открывать сеть, не ослаблять paths. Criterion 395 остаётся unchecked.
- [x] **6. Commit:** `test: verify Codex native scope on macOS`, только перечисленные files и штатный core dist. Зафиксировать реальные counts/version/hash в #145. До зелёного gate authority tables/guards не добавлять.

### Task 2: Минимальная controller authority и migration v14

**Files:** create `packages/core/src/authority.ts`, `packages/core/test/authority.test.ts`; modify `packages/core/src/schema.ts`, `packages/core/src/index.ts`, `packages/core/test/db.test.ts`.

**Interfaces:** consumes `assertVerifiedCodexPackage(packet): void`, `projectOf`, `bindingsOf`, `repositoriesOf`, `canonicalCommonDir`, `canonicalProjectPath`, `now`, `appendEvent`, `KddError`. Produces:

```ts
export type RunOperation = 'get_context' | 'submit_report' | 'request_question';
export interface ControllerHandle { readonly kind: 'controller'; }
export interface RunContext { readonly kind: 'run'; }
export interface IssueRunInput {
  taskId: number; workItemId: string; runId: string;
  expectedGeneration: number; expiresAt: number;
  operations: readonly RunOperation[];
  repositories: readonly { repoId: string; checkoutPath: string; write: boolean }[];
  native: VerifiedCodexPackage;
}
export interface IssuedRunAuthority {
  authorityId: string; generation: number; token: string;
}
export function openController(db: Database.Database): ControllerHandle;
export function protectTask(handle: ControllerHandle, taskId: number): void;
export function issueRunAuthority(handle: ControllerHandle, input: IssueRunInput): IssuedRunAuthority;
export function revokeRunAuthority(handle: ControllerHandle, authorityId: string): void;
export function openRunContext(db: Database.Database, token: string): RunContext;
export function assertLegacyTaskMutation(db: Database.Database, taskIds: readonly number[]): void;
```

`WeakMap` регистрирует handle/context с конкретным db connection; интерфейсы не удостоверяют объект. `openRunContext` сохраняет приватный credential для **повторной** проверки каждой операции, не публичную копию grant. Controller handle не принимает Actor и не доступен в MCP/CLI/UI input.

- [x] **1. Red tests:** v13 fixture с задачами/criteria/comments/events/decision/search rows и WAL; compare rows до/после upgrade, backup остаётся v13, zero markers/authorities. Fake handle, copied handle, context от другого connection не проходит. Revoke/protect/issue не изменяет status/claim. У уже claimed legacy task protect/issue отказан: этот этап не останавливает её writer.

```ts
const db = openDb(':memory:', 'authority');
const task = addTask(db, { title: 'protected' }, { type: 'user' });
const controller = openController(db);
protectTask(controller, task.id);
expect(() => assertLegacyTaskMutation(db, [task.id])).toThrow(/managed/);
expect(() => protectTask({ kind: 'controller' }, task.id)).toThrow(/authority/);
expect(db.prepare('SELECT status, claimed_by FROM tasks WHERE id=?').get(task.id))
  .toEqual({ status: 'new', claimed_by: null });
```

- [x] **2. Run:** `pnpm --filter @kddkit/core test -- test/authority.test.ts test/db.test.ts`; expect missing API/migration failures.
- [x] **3. Append v14:** `managed_task_policy(task_id FK/PK, created_at, source)` и `run_authorities(authority_id PK, task_id FK, work_item_id, run_id, generation, expires_at, revoked_at, token_hash UNIQUE, grant_json, created_at)`. `UNIQUE(task_id,work_item_id,generation)` и partial unique current row `(task_id,work_item_id) WHERE revoked_at IS NULL`. Generation — positive integer; expiry finite future seconds; IDs и paths непустые, operations закрытый enum без duplicates; projectId берётся из singleton.

Issue внутри immediate transaction проверяет `max(generation)` с `expectedGeneration` (0 для отсутствующей history), добавляет policy, отзывает previous active row и вставляет новую. Native verified packet и repo bindings проверяются **до commit**. Repo `context_only` всегда readonly; write требует `implementation` и managed binding того же canonical common-dir. Native writableRoot должен совпасть с объявленным managed checkout; readable roots — с выданными bindings. Произвольный sibling path или source checkout не получает grant. Scratch отдельно не является repo grant.

Store confidentiality проверяется отдельно от repo membership: DB открыт по canonical realpath вне checkout/common-dir scope, DB/WAL/SHM не имеют existing hardlinks. Embedded stores fail closed до отдельного file-deny proof; lookup повторяет проверку, чтобы alias после issue не давал бессрочный credential. Existing store не переносится автоматически. Tests включают embedded DB и readonly repo alias на private DB.

```ts
const token = randomBytes(32).toString('hex');
const tokenHash = createHash('sha256').update(token).digest('hex');
// В SQL передаётся tokenHash; в audit только ids. Token/hash не логируются.
```

`assertLegacyTaskMutation` запросом на весь unique набор ids обнаруживает policy и бросает KddError до любых изменений. Никакого Actor/user/reason исключения. Events выдачи/отзыва — существующий `appendEvent`, detail только ids/generation/outcome.

- [x] **4. Green tests:** два DB connections issue с одинаковым expectedGeneration — один success; stale/revoked/expired credential и другое project/task/run не проходят; previous row revoked, marker остаётся после revoke. Запрет unknown op/context-only write/source write/native packet copy. Credential/hash отсутствуют в errors/events/JSON handles. Обработку expiry проверять controlled clock, без sleep.
- [x] **5. Run:** focused tests и `pnpm --filter @kddkit/core typecheck`; **commit:** `feat(core): add controller-issued run authority`.

### Task 3: Закрыть существующие task writers и legacy sweeps

**Files:** modify `packages/core/src/ops.ts`, `criteria.ts`, `files.ts`, `tracks.ts`, `claim.ts`; create `packages/core/test/managed_mutations.test.ts`.

**Interfaces:** consumes `assertLegacyTaskMutation(db, taskIds): void`. Existing exported Actor signatures сохраняются. Никакого универсального optional controller handle или `trusted=true` bypass. Будущие controller business operations должны иметь собственные state checks.

- [x] **1. Создать isolated fixture с legacy/protected задачами, criterion, file и общим track до protect.** Снимать DB rows всех task-related tables и blob directory hashes до каждого вызова. Проверять таблицей callbacks edit/comment/block/unblock/move/place/archive/unarchive/link, add/check/remove criterion, attach/detach, deleteTrack, failedAttempt/release/claim/renew. user Actor, ai Actor, forged manualSession и reason дают одинаковый managed refusal.

```ts
const before = db.prepare('SELECT * FROM tasks ORDER BY id').all();
expect(() => placeTask(db, legacy.id, 'new', [legacy.id, protectedTask.id], { type: 'user' }))
  .toThrow(/managed/);
expect(db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(before);
```

Обязательные варианты: protected endpoint вторым в link; foreign criterion/file id с подставленным legacy task id; track содержит legacy и protected; attach не создаёт blob; detach не удаляет blob; no-op check/reorder всё равно не выдаёт managed право. Ошибки ownership не маскируются разрешённым первым аргументом.

- [x] **2. Run:** `pnpm --filter @kddkit/core test -- test/managed_mutations.test.ts`; expect существующие Actor/reason paths пока проходят и test fails.
- [x] **3. Guard в общей функции до первого side effect, внутри той же immediate transaction.** Сохранить policy checks legacy state machine. Не помещать guard только в appendEvent, UI или MCP: это слишком поздно. Для files определить реального owner и проверить **до** byte write/unlink. Для place проверить `[id,...orderedIds]`; links — оба endpoint; deleteTrack — все затронутые tasks до UPDATE/DELETE.

```ts
return db.transaction(() => {
  assertLegacyTaskMutation(db, [id, ...orderedIds]);
  // Далее существующий placeTask body, без новых shortcuts.
}).immediate();
```

Task-mutating callback целиком держит writer lock от guard до write. Attachment source reading не даёт права, чтение protected target/binding и запись выполняются с guard в transaction. Низкоуровневые audit/SQL остаются trusted-host primitives; из native shell они недоступны благодаря task 1/5.

- [x] **4. Legacy scheduling SQL исключает protected rows.** Добавить `NOT EXISTS (SELECT 1 FROM managed_task_policy p WHERE p.task_id=tasks.id)` в claimable, expired и stop candidates. Direct claim target guard выполняется до reap/failed-attempt side effects. Передача `KillFn` никогда не включает protected ids. Проверить повторно после получения write lock; protect не создаётся для уже claimed row, поэтому legacy sweep не теряет writer между selection и kill.

```ts
expect(killedIds).toEqual([legacyExpired.id]);
expect(expiredLeases(db).map(row => row.id)).not.toContain(protectedTask.id);
expect(db.prepare('SELECT claimed_by,claim_expires FROM tasks WHERE id=?')
  .get(protectedTask.id)).toEqual(protectedClaimBefore);
```

Для mixed sweep fixture managed claim seeds trusted SQL исключительно в test, не добавляется production managed scheduler. Без KillFn/с failed KillFn сохраняются прежние legacy stuck semantics.

- [x] **5. Green:** focused test плюс существующие `ops`, `ops2`, `criteria`, `files`, `tracks`, `claim`, `driver`, `state` tests; core typecheck. Legacy user/reason/self-accept поведение должно сохраниться. **Commit:** `fix(core): guard managed tasks across legacy writers`.

### Task 4: Узкие run operations и настоящий scoped MCP

**Files:** extend `packages/core/src/authority.ts`, `packages/core/test/authority.test.ts`; create `packages/mcp/src/run_server.ts`, `run_main.ts`, `packages/mcp/test/run_server.test.ts`; modify `packages/mcp/tsup.config.ts`, `packages/mcp/test/server.test.ts`, core exports.

**Interfaces:** consumes task 2 contexts and grant storage. Produces:

```ts
export interface RunContextSnapshot {
  projectId: string; taskId: number; workItemId: string; runId: string;
  generation: number;
  task: { title: string; body: string | null; status: string };
  criteria: { id: number; text: string; checked: boolean }[];
  decisions: { slug: string; title: string }[];
}
export function runOperations(context: RunContext): readonly RunOperation[];
export function readRunContext(context: RunContext): RunContextSnapshot;
export function submitRunReport(context: RunContext, body: string): number;
export function requestRunQuestion(context: RunContext, body: string): number;
export function createRunServer(context: RunContext): McpServer;
export async function startRunServer(configPath: string): Promise<void>;
```

MCP tools `get_context({})`, `submit_report({body})`, `request_question({body})`. Нет task/project/actor/reason inputs. Report/question return existing event id; не создаются question/result lifecycle tables. Snapshot — минимальная собственная проекция, **не** `taskDetail` целиком с foreign links и absolute attachment paths, не `taskBrief`/`syncedTaskDetail`. Проверенная task row/criteria и связанный stored decisions index; backend `.planning/decisions` не читается и не синхронизируется. #148 расширит snapshot, #147 — memory.

- [x] **1. Red protocol tests через SDK `Client` + `InMemoryTransport.createLinkedPair`.** Initialize, tools/list, call собственного report, then revoke and repeat read/report. Все schemas strict: forged actor/project/id/owner command отказаны; unknown/global update_task tool недоступен. Missing operations не объявляются; direct call тоже отказан. Событие содержит controller-issued run provenance, tasks/criteria/claims/decisions rows прежние.

```ts
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await createRunServer(context).connect(serverTransport);
const client = new Client({ name: 'scope-test', version: '0' });
await client.connect(clientTransport);
expect((await client.listTools()).tools.map(tool => tool.name).sort())
  .toEqual(['get_context', 'request_question', 'submit_report']);
expect((await client.callTool({ name: 'get_context', arguments: { actor: 'user' } })).isError)
  .toBe(true);
```

- [x] **2. Run:** `pnpm --filter @kddkit/core test -- test/authority.test.ts`; `pnpm --filter @kddkit/mcp test -- test/run_server.test.ts`. Build core beforehand if workspace imports require fresh exports. Expected missing operations/server.
- [x] **3. Реализовать каждый read/write в transaction с fresh credential lookup.** Сверять singleton project, task exists, work-item/run, max generation, revoke/expiry, enum operation. Не доверять cached grant из initialize. Атрибуция `ai` плюс issued runId, body сохраняется как untrusted event через `appendEvent`; никакого commentTask bypass. `redact` переиспользовать; secret/hash, если случайно присутствуют в text, не сохранять. Body непустой и bounded существующим `CAPS.agentFieldChars`; unknown nested payload не принимается.

```ts
db.transaction(() => {
  // lookup зарегистрированного RunContext, fresh DB grant и scope/operation checks
  appendEvent(db, taskId, { type: 'ai', id: runId }, 'run_report',
    { work_item_id: workItemId, run_id: runId, generation, untrusted: true, body: safeBody });
}).immediate();
```

`runOperations` тоже требует live credential. MCP error output не содержит raw grant/credential/config. Заменить sample action на `run_question` только в отдельной question function, без статусных переходов.

- [x] **4. stdio entry:** protected mode-0600 config `{dbPath,token}` читается trusted broker, после открытия `fileMustExist` проверяется schema14 **без migration**. Произвольный selected project отсутствует. Path config передаётся в argv, token — нет. Broker не bootstrap controller. Entry допускает только один `--config <absolute-path>`; invalid JSON/unknown fields или schema — safe отказ. tsup entry добавить `src/run_main.ts`, existing global main сохранить. Startup secrets не попадают в stdout/stderr; stdout только MCP messages.
- [x] **5. Green tests:** fake/stale/expired/foreign contexts, changed credential после initialize, two-connection revoke, hidden tools, strict payload, injected secret report, empty/conflicting backend decisions. Global MCP сохраняет свои шесть tools и отказывает managed update_task. Run core/MCP tests и typecheck; **commit:** `feat(mcp): add scoped run broker`.

### Task 5: Проверить финальный native package вместе со stdio broker

**Files:** extend `packages/core/src/codex_permissions.ts`, `packages/core/src/codex_native_probe.ts`, `packages/core/test/codex_permissions.test.ts`, `packages/mcp/src/run_server.ts`; create `.planning/research/orchestration/codex-broker-check.mjs`.

**Interfaces:** consumes task 1 package API; task 4 built `packages/mcp/dist/run_main.js`, mode-0600 config `{dbPath,token}`. Existing optional `brokerConfigPath/brokerEntryPath` входят в hash и обязательные protected reads. Produces тот же `VerifiedCodexPackage`, пригодный для фиксированного broker, без нового launcher abstraction.

- [x] **1. Red test финального transport:** временный schema14 store/managed clone, controller issue grant, config вне workspace. Native shell/apply_patch пытаются прочитать config/token/store, запустить raw CLI, подделать KDD_ACTOR и обратиться к local UI; MCP read/report работает. Fake config hash, дополнительный `--add-dir`, legacy sandbox override или неизвестный native surface отказаны до package.

```js
assert.equal(protectedConfigRead.outcome, 'denied');
assert.equal(rawCliStoreRead.outcome, 'denied');
assert.equal(loopbackApiCall.outcome, 'denied');
assert.equal(scopedReport.outcome, 'allowed');
assert.equal(beforeProtectedRows, afterProtectedRows);
```

- [x] **2. Run native check после MCP build; без привязки broker test пока должен fail.** Тест использует fixture provider из task 1 и actual Codex `mcp` tool path; неизвестный/невыполненный tool даёт inconclusive.
- [x] **3. Builder добавляет только этот fixed stdio MCP, с absolute Node executable и compiled entry/config path, без token env/argv.** Effective config/tools, executable realpath/version, cwd, roots, readonly Git paths и broker paths включаются в SHA-256 package hash. Исходный profile и provider fixture одинаковы для проверки native эффектов; model-provider endpoint/фиктивная модель используются только proof, replacement service connection не расширяет native tool policy. #150 обязан повторно вызвать preflight для выбранного runtime package, а не принимать JSON evidence из карточки.

BrokerConfig token записывается только controller fixture; native env его не наследует. Grant issue/revoke остаются вне run. Проверить trusted broker successful call и одновременно deny reads тех же bytes из shell/apply_patch. Изменение code/revocation не скрывается старой проверкой initialize. После package creation изменить executable/profile/root symlink либо публичный broker binding и вызвать `assertVerifiedCodexPackage`: отказ, пакет не используется.

Обнаруженные при calibration особенности Codex 0.157.0: MCP functions объявляются в namespace `mcp__kdd_run`, а три generic resource adapters добавляются без отдельного toggle. Включить их в closed registry только вместе с actual empty-list/private-URI/foreign-server checks в обоих modes. Broker не объявляет resources/templates; ненулевые resource responses и любая новая surface дают отказ. Truthful readOnly/destructive/openWorld annotations и fixed server `auto` позволяют три scoped calls при approval=never, не расширяя native policy или grant. Full final gate: 129 baseline cases + 27 broker/resource cases = 156; independent post-rotation broker pass = 27. Calibration с trusted fixture rows не является native proof и не может выдавать capability.

Устранить цикл token → broker proof → issue: первый fixture grant создаётся с native-only пакетом task 1; его broker позволяет измерить final configuration. После final preflight controller перевыдаёт grant с expectedGeneration=1 и final packet, атомарно обновляет private broker token и повторяет observations. Hash включает entry/config paths, db identity и permission/tool configuration, **не секретные credential bytes**; token rotation не расширяет policy. Broker всегда fresh-валидирует token, старый revoked. Для final assertion public config binding должен остаться прежним; изменение dbPath/entry/permissions требует новый preflight. Никакого запуска worker или принятия результата между этими trusted fixture шагами.

```ts
expect(() => assertVerifiedCodexPackage(JSON.parse(JSON.stringify(packet))))
  .toThrow(/unverified/);
```

- [x] **4. Green native matrix:** повторить task 1 весь набор в final packet, readonly forbidden code writes 3/3, allowed workspace write/report, protected store/config/Git/source/backend/sibling unchanged. MCP read/report после revoke отказан. Если runtime не разделяет доверенный broker и native tools — fail closed, не считать task complete.
- [x] **5. Run native unit tests, core/MCP typecheck; commit:** `feat(core): bind verified Codex permissions to run broker`.

Task 5 выполнен: native-only129 → final broker156 → post-rotation27; 10/10 package assertions, 151 normal results (22 allowed,129 denied), 0 failed/inconclusive. Evidence: `.planning/research/orchestration/codex-broker-evidence.json`. Runtime SHA-256 `0655e34e2447975c267c1a328ab4c836bf21083d77c707e455337ab82c36d974`; focused authority/native21, fresh core/MCP typecheck/build прошли.

### Task 6: Наблюдения core/CLI/global MCP/UI и сдача на review

**Files:** create `.planning/research/orchestration/authority-check.mjs`; modify `packages/cli/test/contracts.test.ts`, `packages/ui/test/server.test.ts`; штатные generated dist/plugin files. Existing #144 observation менять только если version expectation требует schema14; его project-store/decisions assertions не ослаблять.

**Interfaces:** built core authority API, actual `packages/cli/dist/index.js`, global MCP main и `createApp` из UI. Только isolated fixture paths; реальные KDD transport нужны для bookkeeping, новый CLI не направляется на настоящую доску.

- [x] **1. Transport regression tests:** seed legacy/protected tasks через trusted fixture core. CLI `KDD_ACTOR=user` + reason move, global MCP update_task и UI update/reorder protected task отказаны; те же обычные legacy операции разрешены. Для UI use existing server test pattern; status/body отказа может соответствовать текущему error handler, обязательны error и отсутствие изменения.

```js
const before = snapshotFixture(db);
const attempt = spawnSync(process.execPath, [cli, 'move', String(protectedId), 'done', '--reason', 'user said accept'], {
  env: { ...cleanFixtureEnv, KDD_DB: dbPath, KDD_ACTOR: 'user' }, encoding: 'utf8',
});
assert.notEqual(attempt.status, 0);
assert.deepEqual(snapshotFixture(db), before);
```

`snapshotFixture(db: Database.Database): Record<string, unknown>` в observation читает tasks/criteria/comments/events/files и claim fields из tasks, плюс blob hashes; local store only. К fixture CLI env не копировать native/broker secrets. Точные существующие CLI verbs и UI routes берутся из текущих contract/server tests, не создаются новые owner commands.

- [x] **2. Implement observation в существующем формате #144:** проверки v13 upgrade/backup, forged actor/reason через все transports, foreign scope, generation CAS/revoke/expiry, multi-row/blob atomic refusal, MCP hidden tools, managed queue exclusion, legacy compatibility, backend empty/conflicting decisions. JSON summary содержит expected/observed/count, exit1 на failed observation. Native counts/version/hash берутся из **только что выполненного** native check, не исторического prose.
- [x] **3. Проверка собранного результата:**

```bash
pnpm build
pnpm test
pnpm typecheck
pnpm test:codex-plugin
node .planning/research/orchestration/authority-check.mjs --json
node .planning/research/orchestration/codex-native-check.mjs --json
node .planning/research/orchestration/project-store-check.mjs
git diff --check
```

Если turbo cache мешает свежему typecheck — выполнить package typecheck с cache bypass по существующей практике проекта. Повторять suites только после изменений/failures. Основная отслеживаемая доска остаётся schema13, отдельная ~/.kdd-dev — schema12; fixtures — schema14. Для bookkeeping используется установленный v13 MCP и изолированный snapshot v13 CLI/core, а не development binary.

- [x] **4. Self-review spec coverage и diff:** все shared writers защищены до side effects; ни один run input не bootstrap owner; secrets отсутствуют; custom/native packet не расширяется; compiled exports и оба MCP entries существуют; legacy behavior и decisions protection #144 сохранены. Solo route сохраняется, agent review не запускается автоматически.
- [x] **5. Commit:** `test: verify controller authority across transports`. В #145 записать точные commands/results, native tool counts/version/hash и limitations. Критерий 394 отмечать только при доказанном authority refusal во всех transports; 395 — только при actual Codex shell **и apply_patch** enforcement. Передать пользователю результат на review; карточку не закрывать без команды владельца.

Task 6 выполнен:933/933 tests (core433,MCP75,UI211,CLI214), свежие typecheck4/build/plugin fresh-install. Actual built core/CLI/global MCP/HTTP UI:7/7 observations,0 refused row/blob changes; #144 project-store/decisions:8/8. Transport regression tests добавлены после Task3 core RED→GREEN, отдельный transport RED не заявляется. Historical v12 fixture attachment seeding переведён на trusted SQL/blob перед migration; preservation assertions сохранены. Evidence: `.planning/research/orchestration/authority-evidence.json`; criteria394/395 отмечены через изолированный v13 CLI snapshot, tracked board остаётся schema13. Self-review выполнен solo; итог передаётся в review.

## Self-review плана

| Требование spec | Task |
| --- | --- |
| Реальные tools прежде product authority | 1, обязательный gate |
| Trusted bootstrap, не Actor/env/reason; secrets вне run | 2, 4, 5 |
| v14 preservation, capability fence/expiry/revoke, repo binding | 2 |
| Общие task guards, multi-row/files/criteria/tracks/queues | 3 |
| Fixed scoped MCP, live read checks, proposals без acceptance | 4 |
| Native readonly/write roots/Git/network/surface; пакет не расширяется | 1, 5 |
| Legacy/UI/CLI/MCP и backend decisions compatibility | 3, 4, 6 |
| Runnable evidence, build/typecheck, нет auto-close | 6 |

Interfaces tasks 2–5 используют те же имена/типы; дальнейшие бизнес state machines не представлены фиктивными таблицами. Пять Review Focus имеют проверки у владельца кода. Порядок выполнения solo: 1 → 2 → 3 → 4 → 5 → 6; отрицательный native gate не перепрыгивается.

## Review fix: Git common-dir binding

- [x] Regression RED: пакет принимал смену common-dir linked worktree; настоящий Git/filesystem, mocked только медленная runtime matrix для unit stamp.
- [x] Общий snapshot заново разрешает Git dir/common-dir и отказывает при несовпадении с исходной policy. Start/resume и выдача authority используют одну проверку.
- [x] GREEN:15 focused tests,934/934 full suite (core434,MCP75,UI211,CLI214), fresh build/typecheck4/plugin; authority7/7 и project-store8/8.
- [x] Повторить real native129→156→27 на новой сборке; actual package в linked worktree отказал start/resume после смены common-dir,11/11 wrapper checks.
- [x] Сохранить свежий runtime hash/evidence: `775cc7a86724aa1ac21c9bb439cdbd2ec45c8192e13cb12b20f29d11e06a313a`, `codex-broker-evidence.json`,0 failed/inconclusive.

После fix commit вернуть criterion395 и карточку в review через совместимый v13 bookkeeping; окончательный статус сдачи записывается в карточке. Не закрывать #145.

## Review fix: private scratch и operation-aware native matrix

- [x] P1 RED: настоящий branded packet/SQLite/Git, замокана только slow matrix; issue принимал DB в scratch для обоих native filesystem modes. Общий privateStore проверяет DB/WAL/SHM относительно всех writable roots до side effects; scratch сохраняется в grant для fresh lookup.
- [x] P2 RED: реальные Codex tools, get_context-only scope; matrix остановилась на absent submit_report. Новая matrix проверяет разрешённые операции, отсутствие остальных и actual unknown-tool dispatch отказ; revoke проверяет все выданные операции.
- [x] Fresh build/typecheck4/plugin,937/937 tests (core437,MCP75,UI211,CLI214), authority7/7 и project-store8/8.
- [x] Native full и get_context-only packages: каждый129→158→29,12/12 wrapper assertions, включая real packet + scratch store refusal без новых marker/grant/events;0 failed/inconclusive.
- [x] Сохранить evidence обоих scopes: codex-broker-evidence.json/codex-context-evidence.json; runtime hash `e0177701fdd7147af667b4f51eb028f0e7c77b5b6d7bdf7b74b169728e0a6251`.

После fix commit вернуть оба criteria394/395 и карточку в review через isolated v13 bookkeeping, сохранив schema13. Итог записать в карточку и progress ledger; не закрывать #145 без поручения владельца.
