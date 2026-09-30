# Role Profiles and Pinned Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Preserved execution method: Sol Advisor `solo`; no auxiliary agent or fresh review unless newly observed risk justifies an explicitly declared route escalation.

**Goal:** Каждый новый managed run закрепляет проверенный профиль роли и версии skills, загружает Always в Codex prompt, читает Available/resources через scoped MCP и отказывает до запуска при несовместимых модели или правах.

**Architecture:** Иммутабельные ревизии роли и bytes skills живут в project SQLite вне checkout. `issueRunAuthority` закрепляет роль в уже существующем input snapshot; scoped broker читает только эти bytes. Host собирает prompt и проверяет exact Codex model/native package перед child creation. Новый scheduler или второй механизм полномочий не вводятся.

**Tech Stack:** TypeScript/Node >=22, better-sqlite3 WAL, Vitest, MCP SDK, `/usr/bin/git`, установленный Codex/macOS. Новых зависимостей нет.

**Spec:** [2026-09-29-role-profiles-skills-design.md](../specs/2026-09-29-role-profiles-skills-design.md), утверждена владельцем после commit `68e4192`.

## Global Constraints

- SELECTIVE ROUTE `solo`: root реализует, проверяет и делает self-review последовательно; subagent models: none. Если наблюдение повышает риск, сначала объявить маршрут и причину.
- Ветка `task/143-kanban-orchestrator-contract`; не создавать новую ветку и не трогать preexisting untracked `references/`. Локальные commits с одним subject, push запрещён.
- Поддерживаемый первый runtime — Codex/macOS. На 2026-09-29 installed `codex-cli 0.159.0`, прежний verified gate принимает `0.157.0`: новая версия не становится разрешённой без полной actual native matrix.
- Append migration v18, migrations 1–17 и прежние rows/ids/legacy ручные flows не переписывать. Реальную доску проекта не открывать development core/CLI.
- Единственный MCP server — scoped `kdd_run`; чужие servers/plugins/connectors/credentials и native read/write grants из profile не добавлять. Skills не пишут файлы в source checkout.
- Skill limits: 1 MiB на файл, 8 MiB и 128 файлов на skill; `read_skill_file` возвращает не более 32 KiB bytes на запрос. Always body и mandatory #148 inputs не усекать.
- Exact role/model/skill/grant hashes входят в immutable run input; старые v1 snapshots читаются для host audit, но не стартуют новый managed run. Stale/expired/revoked authority не читает skills.
- Reference patterns применять самостоятельно; имена reference repos только в planning/task docs, не в product source/schema/tests/comments/commit trailers. Credentials не писать в prompt, DB skill bytes, events или evidence.

## Review Focus

1. Одно и то же имя skill с разным регистром или в обеих группах: Task 2 проверяет отказ без новой revision.
2. Repo skill от изменившегося checkout при неизменном commit: Task 2 проверяет bytes Git object, а не working tree.
3. `read_skill_file` с offset за концом, traversal, чужим именем или revoked grant: Task 4 проверяет отказ без раскрытия private path.
4. Новый role current pointer после выдачи run: Task 3/5 проверяют неизменность старого prompt и явную новую generation.
5. Codex version/model/tool registry или context limit без доказательства: Tasks 1/5 проверяют отказ до child creation, без изменения task/grant rows.

## Файлы и интерфейсы

`packages/core/src/roles.ts` отвечает за ревизии и чтение pinned files; `role_prompt.ts` — только за deterministic prompt, model budget и запечатанный launch permit. Существующие `schema.ts`, `authority.ts`, `run_inputs.ts`, `run_inputs_current.ts` закрепляют роль в выдаче и проверяют старые/new snapshot versions. `codex_permissions.ts` и `codex_native_probe.ts` остаются единой native boundary. `packages/mcp/src/run_server.ts` объявляет одно новое scoped чтение; global MCP не меняется. Public exports добавляются только в `packages/core/src/index.ts`.

```ts
export type SkillSource =
  | { kind: 'local'; root: string; path: string }
  | { kind: 'repo'; repoId: string; checkoutPath: string; commit: string; path: string };
export interface RoleDefinition {
  name: string; prompt: string; runtime: 'codex'; model: string; effort: string;
  access: 'read' | 'workspace-write'; operations: readonly RunOperation[];
  skills: readonly { name: string; mode: 'Always' | 'Available'; description: string; source: SkillSource }[];
}
export interface RoleRef { roleId: string; revision: number }
export interface RoleReceipt extends RoleRef { hash: string; manifestHash: string }
export function saveRoleRevision(handle: ControllerHandle, input: {
  roleId?: string; expectedRevision: number; commandId: string; definition: RoleDefinition;
}): RoleReceipt;
export function roleRevision(handle: ControllerHandle, ref: RoleRef): RoleDefinition & RoleReceipt;
export function readSkillFile(context: RunContext, input: {
  skill: string; path: string; offset: number;
}): { contentBase64: string; offset: number; length: number; size: number; sha256: string; mime: string };
```

API names above are contracts between tasks; use them consistently. `roles.ts` also exports internal `roleRevisionDb(db, ref): {definition:RoleDefinition; receipt:RoleReceipt}` and `roleFilesDb(db, ref)` for issuance/prompt assembly; `nativeAccess(packet)` in `codex_permissions.ts` maps its writable root to `read` or `workspace-write`. `RoleReceipt` is host-only. `IssueRunInput` gains required `role: RoleRef` for **new** authorities. Historical v1 DB rows remain readable without inventing a role. `RunOperation` gains `read_skill_file` only when selected skills exist; role grant must include it. `RunInputSections` becomes a versioned v1/v2 union; v2 carries `{roleId,revision,hash,manifestHash,model,effort,skills:{name,mode,manifestHash}[],operations,nativeConfigHash}`. Prompt hash is recorded later in the host-only launch receipt, because the final prompt does not exist at authority issuance. Core validates both versions on historical reads but managed launch accepts only v2. Skill content is stored in separate immutable rows; input snapshot carries manifest hashes, not duplicate binary bytes.

### Task 1: Codex 0.159.0 native gate

**Files:** Modify `packages/core/src/codex_native_probe.ts`, `packages/core/src/codex_permissions.ts`, `packages/core/test/codex_permissions.test.ts`, `.planning/research/orchestration/codex-native-check.mjs`. Evidence: `.planning/research/orchestration/codex-native-evidence.json`.

**Interfaces:** Existing `observeCodexNative`, `preflightCodex`, `VerifiedCodexPackage` remain the shared boundary. Add `model` and `effort` to the frozen verified package and compare them with effective argv/catalog; `CodexPermissionInput` gains `effort`. This task does not hardcode a model list or change profile behavior.

- [ ] **Step 1: Reproduce the version refusal.** Run `codex --version` and `node .planning/research/orchestration/codex-native-check.mjs --json` against installed binary; record exact exit and reason. Expected now: 0.159.0 and refusal at the 0.157.0 assertion, no applicability claim.
- [ ] **Step 2: Write a failing unit test** in `codex_permissions.test.ts` for a fixture executable that reports 0.159.0 and asserts old/unproved versions still fail. Run `pnpm --filter @kddkit/core exec vitest run test/codex_permissions.test.ts`; verify RED for current version only.
- [ ] **Step 3: Update the exact version guard** in both native files to 0.159.0, preserving `version`/executable bytes/config/catalog binding and the full existing matrix. Bind requested model/effort to fixed argv/config and frozen package. Query installed Codex app-server `model/list` for the selected model's `model` and `supportedReasoningEfforts`; use its own `models_cache.json` only for context-window metadata when `client_version` equals the installed binary and `fetched_at` is fresh (at most 24 hours). Refuse missing/stale/mismatched data. The deterministic fixture model used by `observeCodexNative` remains an isolated test catalog, never a production model choice. Do not weaken a case or replace the matrix with a mocked result.

```ts
const SUPPORTED_CODEX_VERSION = 'codex-cli 0.159.0';
if (version !== SUPPORTED_CODEX_VERSION) throw new KddError('unsupported Codex version');
```

- [ ] **Step 4: Run actual probes on isolated temp fixtures:** `pnpm build`, then `node .planning/research/orchestration/codex-native-check.mjs --json` and the existing package/broker/context scripts. Capture JSON evidence with executable SHA, attempted/executed/fail/inconclusive counts, registry and tool outcomes. If any native case fails, revert the version allowance, record the failure on task 149 and stop implementation; do not mark Task 1 green.
- [ ] **Step 5: Verify and commit.** Run `pnpm --filter @kddkit/core exec vitest run test/codex_permissions.test.ts`, `pnpm typecheck`, `git diff --check`; commit only a proven version update and evidence with subject `fix(core): verify installed Codex native policy`.

### Task 2: Immutable role revisions and skill bytes

**Files:** Create `packages/core/src/roles.ts`, `packages/core/test/roles.test.ts`; modify `packages/core/src/schema.ts`, `packages/core/src/index.ts`, `packages/core/test/db.test.ts`.

**Interfaces:** Implement `SkillSource`, `RoleDefinition`, `RoleRef`, `RoleReceipt`, `saveRoleRevision`, `roleRevision`; internal `roleFilesDb(db, ref)` returns sorted `{skill,path,bytes,sha256,mime}` rows. Use existing `canonical`, `digest`, `ControllerHandle`, project/repository bindings and `redact` detection.

- [ ] **Step 1: Add RED tests** using temp Git/SQLite: populated v17 WAL → v18 keeps old row snapshots; two revisions keep original bytes; same expectedRevision in two connections has one winner; `Example`+`example` and Always+Available duplicate reject; local symlink/hardlink/special/traversal/oversize reject; repo skill reads committed blob after checkout mutation. Run `pnpm --filter @kddkit/core exec vitest run test/roles.test.ts test/db.test.ts` and confirm expected failures.
- [ ] **Step 2: Append only migration v18** for `role_profiles`, `role_revisions`, `role_skill_files` with PK/FK, current revision, JSON/hash checks and immutable UPDATE/DELETE triggers on revisions/files. Never edit SQL for versions 1–17.

```sql
CREATE TABLE role_profiles (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
  name TEXT NOT NULL, current_revision INTEGER NOT NULL CHECK(current_revision > 0)
);
CREATE TABLE role_revisions (
  role_id TEXT NOT NULL REFERENCES role_profiles(id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
  hash TEXT NOT NULL, manifest_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
  command_id TEXT NOT NULL UNIQUE, command_hash TEXT NOT NULL,
  PRIMARY KEY(role_id, revision)
);
CREATE TABLE role_skill_files (
  role_id TEXT NOT NULL, revision INTEGER NOT NULL,
  skill_name TEXT NOT NULL, relative_path TEXT NOT NULL,
  sha256 TEXT NOT NULL, mime TEXT NOT NULL, bytes BLOB NOT NULL,
  PRIMARY KEY(role_id,revision,skill_name,relative_path),
  FOREIGN KEY(role_id,revision) REFERENCES role_revisions(role_id,revision)
);
CREATE TRIGGER role_revisions_immutable_update BEFORE UPDATE ON role_revisions
BEGIN SELECT RAISE(ABORT,'immutable role revision'); END;
CREATE TRIGGER role_skill_files_immutable_update BEFORE UPDATE ON role_skill_files
BEGIN SELECT RAISE(ABORT,'immutable skill file'); END;
```

- [ ] **Step 3: Implement one import path in `roles.ts`.** Local source: canonical root and `lstat`/file-handle identity before/after each read; Git source: verify repo binding and use `/usr/bin/git` against exact commit tree, reject mode symlink/submodule. Sort paths and enforce 1 MiB/file, 8 MiB/skill, 128 files; `SKILL.md` strict UTF-8. Reject known credential patterns via existing detector before saving bytes. Compute SHA-256 per file and deterministic manifest hash. Write revision/files/current pointer/audit inside one immediate transaction with commandId replay/CAS.
- [ ] **Step 4: Make tests GREEN**, including incomplete write rollback, same commandId/different payload refusal, historical reads and older-schema refusal. Run focused Vitest plus `pnpm typecheck`; review migration and `git diff --check`.
- [ ] **Step 5: Commit** `feat(core): store immutable role and skill revisions`.

### Task 3: Bind role to authority and input snapshot

**Files:** Modify `packages/core/src/authority.ts`, `packages/core/src/run_inputs.ts`, `packages/core/src/run_inputs_current.ts`, `packages/core/src/index.ts`, `packages/core/test/authority.test.ts`, `packages/core/test/run_inputs.test.ts`, `packages/core/test/run_inputs_current.test.ts`, `packages/core/test/run_inputs_fixture.ts`, `packages/core/test/authority_store.test.ts`.

**Interfaces:** `IssueRunInput.role: RoleRef`; `RunInputSections` accepts v1 history and emits v2 for new issuance; v2 role payload is `{ roleId, revision, hash, manifestHash, model, effort, skills, operations, nativeConfigHash }`. Public projection omits local source paths and skill bytes. Task 4 consumes the `read_skill_file` operation through existing `RunContext`; Task 5 consumes the role pin and provisional #148 snapshot to compute prompt hash before issuance.

- [ ] **Step 1: RED tests:** missing/foreign/unknown role, wrong native model/effort, write access beyond profile, unlisted operation or external MCP request all reject with unchanged `managed_task_policy`, grant and event counts; successful issue stores exact role/skills/grants in snapshot; old v1 snapshot reopens for host audit but cannot produce a new managed launch. Run `pnpm --filter @kddkit/core exec vitest run test/authority.test.ts test/run_inputs.test.ts`.
- [ ] **Step 2: Extend issuance under its existing immediate transaction.** Load exact role revision, verify role operations and access class against native package, and produce v2 snapshot/manifest before mark/revoke/insert. Build the v2 hash through existing `runInputHash`; never store skill bytes or token in public snapshot. Update common test fixtures with a real temp role instead of a fabricated default.

```ts
if (!input.role) throw new KddError('managed role required');
const role = roleRevisionDb(db, input.role);
if (role.definition.model !== native.model || role.definition.effort !== native.effort
  || role.definition.access !== nativeAccess(native))
  throw new KddError('run role/native mismatch');
if (input.operations.some(op => !role.definition.operations.includes(op)))
  throw new KddError('run operation outside role');
```

- [ ] **Step 3: Keep v1 validation only for historical reads.** Add a discriminated `schemaVersion` branch to `readRunInputSnapshotDb`; v2 validates role hash, manifest and native binding. `runInputChangesDb` checks selected role revision/files and explicit revocation; a later current pointer alone does not mutate old snapshot. New issue/launch without role v2 refuses. Update all callers in `authority.test.ts`, `authority_store.test.ts`, `run_inputs*.test.ts`, `run_inputs_fixture.ts` and `packages/mcp/test/run_server.test.ts` to create a real temp role and pass its ref; do not let tests mint a synthetic default.
- [ ] **Step 4: Run focused tests**, `pnpm --filter @kddkit/core typecheck` and `git diff --check`; commit `feat(core): pin role profile to run authority`.

### Task 4: Pinned skill reads through scoped MCP

**Files:** Modify `packages/core/src/authority.ts`, `packages/core/src/index.ts`, `packages/mcp/src/run_server.ts`, `packages/mcp/test/run_server.test.ts`, `packages/core/test/authority.test.ts`, `packages/core/src/codex_permissions.ts`, `packages/core/src/codex_native_probe.ts`.

**Interfaces:** `RunOperation` adds `read_skill_file`; `readSkillFile(context,{skill,path,offset})` returns the interface above. No global MCP mutation/tool. Native catalog's enabled tools match the selected grant and preflight observes the fourth operation plus absence/revoke cases.

- [ ] **Step 1: RED core and stdio MCP tests.** A grant with skills announces `read_skill_file`; a grant without skills does not. Read `SKILL.md`, reference, script and binary asset at offsets 0/32768; exact reconstructed SHA matches manifest. Invalid/negative/too-large offset, traversal, foreign skill, stale/revoked token and direct call of unannounced tool fail without source/DB path disclosure.
- [ ] **Step 2: Implement core read via `live(context,'read_skill_file')`** and v2 snapshot role pin. Decode only validated relative paths, SELECT exact pinned file, verify blob hash, return <=32768 bytes as base64 with total size/full SHA/MIME/offset. No filesystem read in broker. Keep MCP resources/templates empty.

```ts
const start = input.offset;
if (!Number.isSafeInteger(start) || start < 0
  || start > bytes.length || (bytes.length > 0 && start === bytes.length))
  throw new KddError('skill file range denied');
return { contentBase64: bytes.subarray(start, start + 32768).toString('base64'),
  offset: start, length: Math.min(32768, bytes.length - start), size: bytes.length,
  sha256: file.sha256, mime: file.mime };
```

- [ ] **Step 3: Register a single strict MCP tool** in `run_server.ts` only when `runOperations(context)` includes it; `z.object({skill:z.string(),path:z.string(),offset:z.number().int().nonnegative()}).strict()`. Keep existing bounded error text and truthful read-only annotations. Update closed Codex MCP config/registry and actual native probe for allowed, absent and revoked operation, both readonly and workspace-write modes.
- [ ] **Step 4: Run** `pnpm --filter @kddkit/core exec vitest run test/authority.test.ts`, `pnpm --filter @kddkit/mcp exec vitest run test/run_server.test.ts`, `pnpm build`, actual broker probe; retain measured JSON only if all cases pass. `git diff --check`; commit `feat(mcp): serve pinned skill files to scoped runs`.

### Task 5: Prompt, model budget and actual delivery proof

**Files:** Create `packages/core/src/role_prompt.ts`, `packages/core/test/role_prompt.test.ts`, `.planning/research/orchestration/role-check.mjs`; modify `packages/core/src/index.ts`, `packages/core/src/codex_permissions.ts`, `packages/core/src/authority.ts`. Evidence: `.planning/research/orchestration/role-evidence.json`.

**Interfaces:** `prepareRoleLaunch(handle,{projectId,authorityId,native,outputReserveTokens})` returns process-local `{prompt,promptHash,model,effort,native}` permit. `spawnCheckedRoleRun` consumes only this permit, delegates final root/config check to existing `spawnCheckedNative`; neither caller nor run can override argv/env/cwd/prompt. Historical v1 has no permit.

- [ ] **Step 1: RED tests:** exact full Always body and #148 mandatory inputs appear once in deterministic prompt; Available body appears only after MCP request; later current revision does not alter old prompt; unknown model/effort/context limit or mandatory overflow refuses before child/marker/grant; forged/serialized permit and changed native package refuse. A zero-byte non-SKILL resource is readable at offset 0 with length 0. Use one real temp Git/SQLite fixture and `pnpm --filter @kddkit/core exec vitest run test/role_prompt.test.ts`.
- [ ] **Step 2: Implement deterministic assembly** from persisted snapshot and role bytes only. Include stable section boundaries, full `SKILL.md` bodies and bounded Available index. Hash exact UTF-8 prompt bytes and hold the host-only launch receipt in a process-local sealed permit bound to authority/generation; audit only its hash, never store prompt bytes or token in public snapshot/event. Old snapshots remain unchanged.

```ts
const prompt = [role.definition.prompt, ...always.map(s => s.body),
  JSON.stringify(snapshot.response.inputs), availableIndex].join('\n\n');
const promptHash = createHash('sha256').update(Buffer.from(prompt,'utf8')).digest('hex');
```

- [ ] **Step 3: Verify model and budget before issuance and launch.** `model/list` from installed app-server proves selected model/effort availability; same-version, <=24-hour `models_cache.json` supplies `context_window` and `effective_context_window_percent`, whose hash is bound into native package. Limit is `floor(context_window * percent / 100)`. Count UTF-8 bytes of all explicit prompt/tool-schema/base-instruction text as a conservative upper bound on text tokens, add measured fixed Codex framing overhead and an 8192-token output reserve. If actual runtime usage cannot bound framing overhead, refuse rather than guess. Run this check during `issueRunAuthority` after its provisional #148 snapshot is assembled but **before mark/revoke/insert**, then again immediately before launch. Keep `#148` byte cap separate. Implement process-local permit and launch wrapper with no late flags or prompt replacement. Cache alone never proves model availability.
- [ ] **Step 4: Observe a real Codex session** with two fixture skills, distinct secret-free markers, selected role and configured broker: inspect child JSON/tool calls and `get_context`; marker Always must be present at first model turn, Available marker absent until `read_skill_file`, reference/script/asset hashes match, native grants refuse write/foreign repo and live revoke denies all tools. Run both readonly and writable modes, ≥3 repetitions for each. Save counts/version/executable/config/model/manifest hashes, result and failure diagnostics in `role-evidence.json`; failing/inconclusive observation leaves acceptance unchecked.
- [ ] **Step 5: Final gates after last product edit.** Run `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm test:codex-plugin`, actual native package/broker/context gates and `node .planning/research/orchestration/role-check.mjs`; check `git diff --check`, generated runtime sync and changed-file scope. Commit `feat(core): verify role prompt and model budget`. Update task 149 with measured numbers; check 402/403 only if real observations satisfy both, then move to review. Never self-accept or push.

## Execution checkpoint

Tasks 1–5 run sequentially. Task 1 is a hard gate: if installed Codex cannot reproduce the complete native policy, record actual failed cases and stop rather than weakening #145. After each task, inspect the diff, run its focused check and commit its own deliverable. Any implementation correction invalidates prior runtime evidence; re-run affected native/broker tests before claiming readiness.
