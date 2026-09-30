# Managed runtime lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Выполнить KDD #150: проверяемые start/stop/resume одной provider session для Claude и Codex на macOS, долговечные attempts/events и отказ при неподтверждённых ограничениях.

**Architecture:** Session хранит provider identity и semantic compatibility pins; каждая попытка получает новую authority generation и существующий ownership fence. Authentic role permit и exact-version native package разрешают запуск; durable intent предшествует spawn. Provider terminal, host exit и подтверждение остановки writers проверяются независимо. Общий journal не принимает результат задачи и не заменяет ownership #146.

**Tech Stack:** TypeScript 5.9.3, Node child_process/fs/crypto/TextDecoder, better-sqlite3 12.11.1, существующий Vitest 4.1.10; установленные `codex-cli 0.159.0` и Claude Code `2.1.263`. Новые dependencies не нужны.

**Spec:** [Утверждённый контракт #150](../specs/2026-09-30-runtime-lifecycle-design.md).

## Global Constraints

- «Начальная платформа — macOS. Остальные платформы дают `unsupported` до запуска managed child.»
- «Runtime completion не публикует dependency result, не принимает задачу и не меняет её business status.»
- «Session storage должен быть доступен самому runtime и закрыт от его native tools, соседних sessions и target source.»
- «Bypass-permissions или инструкции в prompt не заменяют enforcement.»
- «Unknown context size, неподтверждённый overhead или невозможность подтвердить помещающуюся историю блокируют launch.»
- «Usage/cost отсутствует — `unknown`, не 0.»
- «Живой/unknown writer удерживает reservation даже после terminal provider message, expiry, revoke или crash.»
- Один append-only schema upgrade v18 → v19; historical v1/v2 snapshots и role revisions сохраняют исходные bytes/hashes. Новые snapshots используют v3.
- Не включать scheduler #152, workspace provisioning #151, вопросы #155, acceptance #156/#157, public CLI/UI #159/#161, экономическую policy #168.
- Не менять legacy worker/tick на новый transport. Не удалять checkout/artifacts, не reset/clean Git.
- Reference names допустимы в planning/evidence, запрещены в production source/schema/tests/comments/commit trailers. Изучать идеи, не копировать source.
- Выполнять на существующей feature branch `task/143-kanban-orchestrator-contract`; исходный HEAD `b0794d918da6e34562db71ab7c707e2feeea59cd`. Untracked `references/` не stage.
- Route `audit`: primary implementation, затем свежий read-only `gpt-6.1-sol/high`; reviewer не исправляет код. Primary model metadata не наблюдалась, переключение не заявлять.
- Локальные commits без push. Done только по слову владельца; criteria 404/405 остаются unchecked до измерений.

## Review Focus

1. Controller умер после durable intent, но до сохранения PID: повтор команды не запускает второй процесс. Task 1/6 — persisted intent/reopen/concurrent command tests.
2. SIGTERM принялся, leader умер, child продолжает писать либо унаследовал stdout: owner не освобождается по `killed` или `exit`. Task 3/6 — настоящие process fixtures и finite drain.
3. Provider сообщил success, но stream malformed, session чужая, exit nonzero либо grant уже revoked: нет completed. Task 2/6 — invalid protocol и terminal/exit/revoke races.
4. Resume получает новую generation/token/config hash при прежних semantic rights; changed requirements или role не подменяются старой conversation. Task 5/6 — совместимость и current-inputs CAS.
5. Native settings и session файлы меняются после preflight; malformed settings молча игнорируются CLI: authentic permit становится недействителен, отрицательные проверки имеют положительные controls. Task 4/7 — реальные tools при start и exact-ID resume.

## Execution record and preconditions

2026-09-30: `codex login status` → `Logged in using ChatGPT` (сообщение идёт в stderr); `claude auth status` → exit 1, `loggedIn:false`, `authMethod:"none"`. Это проверка login, не provider smoke. Не читать/печатать tokens или account identity. Реальные Claude provider requests требуют локальной авторизации пользователя; unit tests, SQLite, process tests и isolated native probes с local protocol server от этого не зависят.

Claude `--help` предупреждает, что invalid settings в print mode могут быть silently ignored. Поэтому JSON/argv сами по себе не attestation. `--bare` исключает OAuth/keychain: не включать его как универсальный isolation shortcut. Для metadata использовать реально доступный authenticated provider/runtime путь, проверять resolved model и effort; не принимать CLI default window за подтверждение. [Models API](https://platform.claude.com/docs/en/api/http/models/retrieve) возвращает `max_input_tokens`, `max_tokens`, capabilities; отсутствие доступа/nonnull values не заменять hardcoded list. [Sandbox docs](https://code.claude.com/docs/en/sandboxing) и [settings precedence](https://code.claude.com/docs/en/settings) направляют probes, не доказывают их результат.

Execution method уже выбран: native primary + один финальный reviewer. Эта версия плана ещё не исполнена. Для исполнения применить ledger в `.superpowers/sdd/2026-09-30-runtime-lifecycle/`, записать BASE каждого task и наблюдённые RED/GREEN. Документация игнорируется через `.git/info/exclude`; stage только exact document paths с `git add -f`.

## File responsibilities and interfaces

Существующие `execution_ownership.ts`, `codex_permissions.ts`, `authority.ts`, `roles.ts`, `role_prompt.ts`, `run_inputs.ts`, `run_inputs_current.ts`, `schema.ts` расширяются на месте. Новые файлы нужны для трёх самостоятельных механизмов: `runtime_events.ts` (bounded protocol parser), `runtime_process.ts` (host process observation/stop), `runtime.ts` (durable journal + host lifecycle). Claude attestation живёт в `claude_permissions.ts` и `claude_native_probe.ts`, общий authentic dispatch — в `native_permissions.ts`. Не вводить SDK/ACP interface, transport factories или отдельный owner registry.

Публичные lifecycle signatures после Tasks 1–6:

```ts
type RuntimeKind = 'claude' | 'codex';
type RuntimeState = 'created' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
interface RuntimeRef { projectId: string; sessionId: string; attemptId: string }
interface RuntimeLimits {
  timeoutMs: number; idleTimeoutMs: number; stopGraceMs: number; drainMs: number;
  maxPromptBytes: number; maxEventBytes: number; maxStreamBytes: number;
  maxStderrBytes: number; maxConcurrentAttempts: number;
}
interface RuntimeAttempt {
  ref: RuntimeRef; owner: OwnershipRef; authority: AuthorityBinding;
  phase: 'start' | 'resume'; state: RuntimeState; providerSessionId: string | null;
  reason: RuntimeReason | null; writersStopped: boolean; lastSequence: number;
}
type RuntimeReason = 'unsupported' | 'spawn_failed' | 'protocol_error' | 'provider_error'
  | 'timeout' | 'idle_timeout' | 'cancelled' | 'authority_revoked' | 'update_required'
  | 'session_unavailable' | 'stop_unknown' | 'context_overflow';
interface RuntimeEvent {
  sequence: number; kind: 'session' | 'attempt_start' | 'text' | 'tool_start'
    | 'tool_finish' | 'usage' | 'error' | 'provider_terminal' | 'host_stop' | 'attempt_end';
  detail: object;
}
function startRuntime(handle: ControllerHandle, input: {
  commandId: string; permit: RoleLaunchPermit; limits: RuntimeLimits;
}): Promise<RuntimeAttempt>;
function resumeRuntime(handle: ControllerHandle, input: {
  commandId: string; sessionId: string; permit: RoleLaunchPermit; limits: RuntimeLimits;
}): Promise<RuntimeAttempt>;
function stopRuntime(handle: ControllerHandle, input: {
  commandId: string; ref: RuntimeRef;
}): Promise<RuntimeAttempt>;
function runtimeAttempt(handle: ControllerHandle, ref: RuntimeRef): RuntimeAttempt;
function runtimeEvents(handle: ControllerHandle, input: {
  ref: RuntimeRef; afterSequence: number; limit: number;
}): RuntimeEvent[];
```

Все команды exact-shape validated. `startRuntime`/`resumeRuntime` возвращают durable admitted attempt после spawn/отказа, не ждут завершения provider turn; состояние читается через `runtimeAttempt`. `stopRuntime` ждёт finite stop/drain наблюдения. Повтор command возвращает тот же attempt; другой payload под тем же command даёт conflict. Credentials остаются в protected broker files, отсутствуют в public records/events.

### Task 1: Durable attempt admission and schema v19

**Files:** Modify `packages/core/src/schema.ts`, `packages/core/src/execution.ts`, `packages/core/src/index.ts`, `packages/core/test/db.test.ts`; Create `packages/core/src/runtime.ts`, `packages/core/test/runtime.test.ts`. Use `packages/core/test/execution_fixture.ts`, `packages/core/test/db.test.ts` migration patterns. В existing v17 upgrade test expected final version заменить с 18 на `MIGRATIONS.length`; сохранение role rows продолжает проверяться отдельно.

**Interfaces:** Consumes `ControllerHandle`, `controllerDb`, `OwnershipRef`, `AuthorityBinding`, `checkOwnershipRef`, `scopedWorkItem`, `canonical`, `digest`, `newId`, `now`. Produces runtime types above, `runtimeAttempt`, `runtimeEvents` and internal SQL admission `admitRuntimeDb(db, input): RuntimeAttempt`, callable only inside an immediate controller transaction. Input contains command payload hash, owner/authority, runtime identity/version/model/effort, semanticHash, inputHash, phase/session and finite limits; never credentials or raw env.

- [ ] **Step 1: Write migration and admission failing tests.** Seed a v18 WAL database with tasks, attachments, role bytes and v1/v2 snapshots, save ordered rows/hashes, reopen through v19 and compare; check backup/reopen/future-schema refusal. For admission use an actual owned work item and seeded scoped authority as in authority fixtures; assert same command replay, conflicting payload, two controllers competing, no new attempt after controller reopen. No child is spawned in this task.

```ts
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {it,expect} from 'vitest';
import {MIGRATIONS,openDb} from '../src/index.js';

it('upgrades v18 without changing historical inputs', () => {
  const root=mkdtempSync(join(tmpdir(),'kdd-runtime-migration-'));
  const path=join(root,'board.db');
  const db = new Database(path);
  db.pragma('journal_mode=WAL'); db.pragma('foreign_keys=ON');
  for (const migration of MIGRATIONS.slice(0, 18)) db.exec(migration);
  db.pragma('user_version=18');
  db.prepare("INSERT INTO meta VALUES('runtime-migration-marker','retained')").run();
  db.close();
  const upgraded = openDb(path);
  expect(upgraded.pragma('user_version', {simple:true})).toBe(19);
  expect(upgraded.prepare("SELECT value FROM meta WHERE key='runtime-migration-marker'").get())
    .toEqual({value:'retained'});
  for (const table of ['runtime_sessions','runtime_attempts','runtime_events','work_item_retirements']) {
    expect(upgraded.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual({n:0});
  }
  upgraded.close(); rmSync(root,{recursive:true,force:true});
});
```

- [ ] **Step 2: Run RED.** `pnpm --filter @kddkit/core exec vitest run test/runtime.test.ts`. Expected: v19 assertion fails; new tables/admission unavailable, historical fixtures remain valid.
- [ ] **Step 3: Append one migration and implement journal admission.** Rebuild `work_item_owners` preserving every column/value and live index, because its original CHECK requires a handoff for every release. Add `release_retirement_id` with exclusive release-source CHECK. No historical migration edits. New tables: sessions (local id/project/task/work-item/runtime/provider id/version/semantic hash/created time); attempts (id/session/command+payload hash/run/authority generation/exact owner fence+revision+id/input hash/limits/launch+writer scope/phase/state/PID+host identity/spawn intent time/stop intent time/terminal+exit observations/reason/end time); append-only events (attempt/sequence/kind/redacted bounded detail/time); retirements (id/command+hash/exact owner/launch/writer scope/receipt/time). Add FK/unique/immutable constraints: one active attempt per session and work item, unique `(work_item_id,run_id,generation)`, one provider binding per session, contiguous event sequence assigned inside transaction, no UPDATE/DELETE events, no terminal attempt mutation. Null provider id is unbound, never resumable. Admission and `recordLaunchIntent` run in the same outer transaction.

```sql
CREATE UNIQUE INDEX idx_runtime_session_active ON runtime_attempts(session_id)
  WHERE ended_at IS NULL;
CREATE UNIQUE INDEX idx_runtime_work_active ON runtime_attempts(work_item_id)
  WHERE ended_at IS NULL;
CREATE TRIGGER runtime_events_no_update BEFORE UPDATE ON runtime_events
BEGIN SELECT RAISE(ABORT,'immutable runtime event'); END;
CREATE TRIGGER runtime_events_no_delete BEFORE DELETE ON runtime_events
BEGIN SELECT RAISE(ABORT,'immutable runtime event'); END;
```

`admitRuntimeDb` first looks up command and validates payload equality; only absent commands insert session/attempt and durable launch intent. A persisted intent with no host observation is uncertain, not permission to spawn on replay. Live indices remain held through exit until writer stop is confirmed. Validate all supplied integer limits before any write; reject hard monetary cap fields with exact shape validation.

- [ ] **Step 4: Run GREEN.** Same command plus `pnpm --filter @kddkit/core exec vitest run test/db.test.ts test/execution_ownership.test.ts`. Expected: migration/admission, prior owners/handoffs and v18 seed round-trip pass.
- [ ] **Step 5: Commit.** `git add packages/core/src/schema.ts packages/core/src/execution.ts packages/core/src/index.ts packages/core/src/runtime.ts packages/core/test/runtime.test.ts packages/core/test/db.test.ts && git commit -m 'feat(core): persist runtime sessions and fenced attempts'`.

### Task 2: Bounded protocol parser and explicit terminal validation

**Files:** Create `packages/core/src/runtime_events.ts`, `packages/core/test/runtime_events.test.ts`; modify `runtime.ts` for safe event persistence. Keep legacy `agent_events.ts` parser unchanged; reuse `redact` and `capDetail` only for display projection, not success validation.

**Interfaces:** Consumes `RuntimeKind`, `RuntimeEvent`, `RuntimeReason`. Produces `RuntimeParser` with constructor `(runtime: RuntimeKind, expectedSessionId: string | null, limits: Pick<RuntimeLimits,'maxEventBytes'|'maxStreamBytes'>)`, `push(bytes: Uint8Array): RuntimeEvent[]`, `end(): RuntimeEvent[]`, `result(): {sessionId:string|null;terminal:'success'|'failure'|null;reason:RuntimeReason|null}`. Parser-local sequence is not durable journal sequence; persistence assigns the latter.

- [ ] **Step 1: Write failing protocol tests.** Cover each UTF-8 boundary, invalid/truncated UTF-8, EOF tail without newline, malformed JSON, depth>32, line/stream oversize, empty stream, init/result id conflict, missing terminal, duplicate/conflicting terminal, unknown outcome, known telemetry, tool correlation and missing usage. Recorded exact CLI fixtures determine accepted envelopes, not hand-written assumptions about successful terminal fields.

```ts
it('keeps multibyte text across every byte boundary', () => {
  const wire = Buffer.from(JSON.stringify({type:'assistant',session_id:id,
    message:{content:[{type:'text',text:'Привет 🙂'}]}})+'\n');
  for (let at=1; at<wire.length; at++) {
    const p = new RuntimeParser('claude', id, {maxEventBytes:65536,maxStreamBytes:1048576});
    const events = [...p.push(wire.subarray(0,at)), ...p.push(wire.subarray(at)), ...p.end()];
    expect(events.filter(e=>e.kind==='text').map(e=>e.detail)).toContainEqual({text:'Привет 🙂'});
    expect(p.result().terminal).toBeNull();
  }
});
```

- [ ] **Step 2: Run RED.** `pnpm --filter @kddkit/core exec vitest run test/runtime_events.test.ts`. Expected: parser missing, then assertions fail until protocol implementation exists.
- [ ] **Step 3: Implement incremental fatal UTF-8 and closed terminal rules.** Check total bytes and per-line bytes before parsing; scan JSON nesting with string/escape awareness before `JSON.parse`; `TextDecoder('utf-8',{fatal:true})` uses `stream:true` until EOF. Claude `system/init` binds session, `assistant/user` map text/tool ids, `result` requires recognised success subtype, `is_error===false` and same id; error subtype or `is_error` sets non-success. Codex `thread.started` binds id, item events preserve ids, `turn.completed` alone supplies a positive terminal; turn failure/error sets non-success. Explicitly list ignorable known telemetry from observed exact-version fixtures; other unknown envelopes set `protocol_error`. No guessed success based on text, absence of errors, EOF or exit0. Redact whole bounded text before truncation and replace exact token/credential markers supplied privately by host before persistence. Tool events save id/name/status and bounded safe text, not arbitrary raw input/config/env.

```ts
const decoder = new TextDecoder('utf-8', {fatal:true});
const decoded = decoder.decode(chunk, {stream:true});
// At EOF, flush once; an incomplete codepoint throws and poisons this attempt.
const tail = decoder.decode();
const successful = protocol.terminal==='success' && protocol.reason===null;
```

Usage fields stay null when absent; reject nonfinite/negative/noninteger token counts; mark Claude reported cumulative cost as `session_cumulative`, Codex observed turn usage as `attempt`. Do not compute deltas or sum cumulative cost.

- [ ] **Step 4: Run GREEN.** Same parser command and `test/agent_events.test.ts`; expected byte-boundary success and 0 false-positive terminals in the rejection matrix; legacy display behaviour remains unchanged.
- [ ] **Step 5: Commit.** Stage exact new parser/test and changed runtime paths; `git commit -m 'feat(core): validate bounded runtime protocol events'`.

### Task 3: Scoped owner retirement and finite process stop

**Files:** Modify `execution_ownership.ts`, `execution.ts`, `index.ts`, `test/execution_ownership.test.ts`; create `runtime_process.ts`, `test/runtime_process.test.ts`, `test/fixtures/runtime_tree.mjs`. Reuse stopReason validation and real process fixture patterns from existing ownership tests, not the CLI marker-based ps helper.

**Interfaces:** Consumes `StopObservation`, `StopObserver`, `OwnershipRecord`, existing authority revoke. Produces `retireOwnership(handle, {commandId:string,owner:OwnershipRef}, observer?:StopObserver): Promise<{status:'complete';receipt:RetirementReceipt}|{status:'held';reason:'missing_observer'|'observer_error'|'unknown'|'live'|'stale_observation'|'snapshot_changed'}>`; receipt contains id, exact owner, launch scope, stop evidence and revoked authority ids. Produces internal `observeRuntimeWriters(binding): StopObservation` and `stopRuntimeWriters(binding, graceMs:number): Promise<StopObservation>`; binding contains owned launch intent, detached child PID/start identity/group and observed descendant identities. These are trusted-host functions, never worker-controlled stop observations.

```ts
interface RetirementReceipt {
  id:string; commandId:string; owner:OwnershipRef; revokedAuthorityIds:readonly string[];
  stop:{outcome:'never_started'} | {
    outcome:'stopped'; observationId:string; launchId:string; writerScopeId:string;
  };
}
interface RuntimeProcessBinding {
  owner:OwnershipRecord; pid:number; pgid:number; startedIdentity:string;
  descendants:readonly {pid:number;startedIdentity:string}[];
  coverage:'complete'|'unknown';
}
function observeRuntimeWriters(binding:RuntimeProcessBinding):StopObservation;
function stopRuntimeWriters(binding:RuntimeProcessBinding,graceMs:number):Promise<StopObservation>;
```

- [ ] **Step 1: Write RED tests.** Two work items under one task with separate owners/grants: retiring A leaves B unchanged; wrong scope/fence, live/unknown/stale/empty writers hold A; command replay adds no events; changed inputs still allow safe retirement without pretending inputs current; later task handoff recognises A's retirement. A stopped running item becomes ready only with exact revision/fence and current input/dependency verification; changed inputs retain explicit update requirement. Completed/failed/cancelled items never become ready. Confirm every grant bound to retired owner is revoked, foreign grants are unaffected.

```ts
it('holds a writer after SIGTERM was accepted', async () => {
  const child = spawn(process.execPath,[fixture,'ignore-term'],
    {detached:true,stdio:['ignore','pipe','pipe']});
  try {
    await once(child.stdout!, 'data');
    expect(child.kill('SIGTERM')).toBe(true);
    expect(child.killed).toBe(true);
    expect(()=>process.kill(child.pid!,0)).not.toThrow();
    // stopRuntimeWriters must inspect the owned group and force survivors,
    // not skip escalation because killed=true. This preliminary probe only
    // proves subprocess semantics; the bound stop test calls the host API.
  } finally {
    const closed=once(child,'close');
    process.kill(-child.pid!,'SIGKILL'); await closed;
  }
});
```

Process tests always clean up owned fixture group in `finally`. Add leader-exits/child-writes, TERM-ignore, zombie leader with live child, inherited pipes and escaped-child cases. No test sends signals to arbitrary reused/foreign PIDs.

- [ ] **Step 2: Run RED.** `pnpm --filter @kddkit/core exec vitest run test/execution_ownership.test.ts test/runtime_process.test.ts`. Expected: retirement API missing/new invariants fail; existing handoff tests pass.
- [ ] **Step 3: Implement scoped retirement in the existing ownership module.** Read immutable owner via `ownership`, record intent/replay before awaiting observer, observe outside SQL, call shared `stopReason`, then recheck exact owner/launch/fence/task mode and no concurrent handoff inside immediate transaction. Release only that owner, set retirement source, revoke only grants with that exact owner binding, save immutable receipt atomically. `authorityTracked` accepts completed scoped receipts as well as completed task handoffs; mere revocation remains insufficient. Make ready transition conditional; do not publish/accept outputs or start retries.

For processes use `/bin/ps` bounded `execFileSync` snapshots of PID/PPID/PGID/state/start identity on macOS, with explicit errors→unknown. Track descendants before leader disappears; check detached group independently of leader; `Z` is not an executing writer but does not hide living members. Unknown coverage, escape or identity reuse prevents complete=true. Only verified own PGID>1 receives group signals; never own host group. TERM, finite deadline, KILL verified survivors, bounded observation until no executing tracked writers/group. No polling beyond supplied deadline. Keep inherited-stream drain separately bounded.

```ts
if (observation.verdict!=='stopped' || !observation.complete
  || observation.writers.some(writer=>writer.state!=='gone')) {
  return {status:'held',reason:observation.verdict==='live'?'live':'unknown'};
}
// release_retirement_id and released_at update in the same transaction as
// authority revocation and immutable receipt; sibling owners are not selected.
```

- [ ] **Step 4: Run GREEN.** Same tests plus `test/execution_races.test.ts`, `test/execution_results.test.ts`; expected observed stop safety, sibling isolation and old handoff/output validity.
- [ ] **Step 5: Commit.** Exact paths from this task; `git commit -m 'feat(core): retire stopped runtime ownership by scope'`.

### Task 4: Authentic persistent native packages for both CLIs

**Files:** Modify `codex_permissions.ts`, `codex_native_probe.ts`, `test/codex_permissions.test.ts`, `test/codex_git_binding.test.ts`; Create `native_permissions.ts`, `claude_permissions.ts`, `claude_native_probe.ts`, `test/claude_permissions.test.ts`, `.planning/research/orchestration/runtime-native-check.mjs`. Preserve ephemeral Codex default for legacy callers.

**Interfaces:** Consumes existing `CodexPermissionInput`, `NativeProbeResult`, `codexBrokerBinding`, root scans/lock. Produces `VerifiedNativePackage = VerifiedCodexPackage | VerifiedClaudePackage`, `assertVerifiedNativePackage(packet:unknown): asserts packet is VerifiedNativePackage`, `nativeRuntime(packet):RuntimeKind`, `nativeAccess(packet):'read'|'workspace-write'`, `preflightClaude(input:CodexPermissionInput):Promise<VerifiedClaudePackage>`. Claude packet shares existing bound fields, adds `runtime:'claude'`, persistent session binding and checked start/resume templates. Codex gains optional `persistent:true` input/profile; existing ephemeral packets cannot resume. `spawnCheckedNative` accepts exact branded start/resume command built from package + validated UUID; managed lifecycle additionally requires `detached:true` validated at this boundary. No caller-supplied alternative executable/argv/env.

- [ ] **Step 1: Write RED tests.** Fabricated/cloned/mutated packet rejected; wrong version/model/effort/context rejected before managed spawn; unknown or zero context refuses; permission-file/config/executable/Git pointer change invalidates permit; ephemeral Codex resume refused; native roots/args differ refused; Claude invalid settings rejects even when CLI would ignore them. Test model metadata resolution timeout/status/body-size/null capabilities and never log credentials.

```ts
it('does not turn an ephemeral proof into a persistent resume permit', async () => {
  const packet = await preflightCodex(input);
  await expect(spawnCheckedNative({...launch,verified:packet,phase:'resume',
    args:['exec','resume',sessionId,prompt]})).rejects.toThrow();
});
```

- [ ] **Step 2: Run RED.** `pnpm --filter @kddkit/core exec vitest run test/codex_permissions.test.ts test/claude_permissions.test.ts`. Unit boundary tests may shim costly probes with the existing attestation test pattern; this does not count as real native evidence.
- [ ] **Step 3: Build exact templates and real-tool attestation.** Start Codex persistent profile omits `--ephemeral`; resume uses `exec resume` options supported by its own installed help (no `-C`), fixes cwd at spawn and inserts exact UUID before one positional prompt. Preserve closed catalog, strict/ignored user config/rules, no network/extra surfaces, protected roots and session store deny to tools. Validate owned session files by no-follow open, single link, bounded size, identity/hash, version/model binding; missing/foreign/tampered files reject rather than start afresh.

Claude profile fixes `--print --output-format stream-json --verbose --restricted --permission-prompts none --strict-mcp-config --setting-sources '' --disable-slash-commands`, explicit built-in tool whitelist and protected settings/MCP. Separate `--session-id` start and `--resume <exact-uuid>` templates. Do not use fork/continue/bg or permissive modes. Validate settings schema before passing them, disable host/project hooks/plugins/skills/memory discovery and assert effective tool surface from observed request. If Bash is exposed, native sandbox must be enabled without unsandboxed fallback; otherwise refuse package until an exact hashed macOS wrapper proves equivalent limits. Auth policy must preserve authorised login mechanism while preventing tools reading auth/session/config files.

```ts
const resumeArgv = ['exec','resume','--ignore-user-config','--ignore-rules',
  '--strict-config','--skip-git-repo-check','--json','-m',model,
  ...config.flatMap(value=>['-c',value]),'--',exactSessionId,prompt];
const claudeSessionArgs = phase==='start'
  ? ['--session-id',exactSessionId] : ['--resume',exactSessionId];
```

Extend existing local protocol-server probe mechanism to actual persistent sessions and tool calls on resume, not relabelled fresh invocations. Probe both read/workspace-write, every exposed filesystem/shell class, foreign/protected roots, symlink/hardlink, Git/config/session files, outbound network and allowed positives. Probe actual scoped MCP discovery/resources/templates/unknown ops/foreign task/path/skill/live revoke. Evidence records exact version/executable/template/config hashes and expected/actual operation effects. Authenticated provider metadata supplies model/effort/context; fake model server only proves CLI/tool behaviour. WeakMap brands bind every checked artifact and metadata expiry; `assertVerifiedNativePackage` dispatches by actual registered brand, never a spoofable `runtime` string.

- [ ] **Step 4: Run GREEN and real matrix.** Unit command above, then `pnpm --filter @kddkit/core build && pnpm --filter @kddkit/mcp build && node .planning/research/orchestration/runtime-native-check.mjs`. Expected: positive controls execute, all declared denials hold at start and real resume, no raw diagnostics/secrets. Without auth/metadata/enforcement evidence package remains unverified; record precise gaps and do not weaken the grant.
- [ ] **Step 5: Commit.** Exact package/probe/tests/script paths; `git commit -m 'feat(core): attest persistent Claude and Codex packages'`.

### Task 5: Runtime-bound v3 inputs and semantic resume compatibility

**Files:** Modify `roles.ts`, `authority.ts`, `role_prompt.ts`, `run_inputs.ts`, `run_inputs_current.ts`, `index.ts`, `test/roles.test.ts`, `test/authority.test.ts`, `test/role_prompt.test.ts`, `test/run_inputs.test.ts`, `test/run_inputs_current.test.ts`, `test/run_inputs_fixture.ts`.

**Interfaces:** Consumes Task 4 authentic dispatch. Produces `RunRuntimePin {runtime:RuntimeKind;version:string;model:string;effort:string;nativeConfigHash:string;contextWindow:number}`, `RunInputSections` v3 branch with role + runtime pin, `semanticRunInputs(snapshot:RunInputSnapshot,native:VerifiedNativePackage): {hash:string;pins:object}`, internal `checkedRoleLaunch(handle,permit): {authority:AuthorityBinding;owner:OwnershipRef;snapshot:RunInputSnapshot;native:VerifiedNativePackage;prompt:string;promptHash:string}`. Existing `prepareRoleLaunch` now accepts branded union; copied/fabricated permits still fail. Old v1/v2 verification reconstructs their original shape, without new runtime fields.

- [ ] **Step 1: Write RED tests.** Save Codex and Claude roles; actual brand/runtime mismatch refuses. Historical snapshots retain hashes; v3 pins runtime/version. Same selected semantic inputs but different authority/generation/fence/timestamp/token-bound config hash are compatible; changed requirements/rules/knowledge/dependency artifact/role bytes/model/effort/tool/network/root/repo commit is incompatible. Always/Available skill tests run through both runtime roles. Revocation/current input guard applies to v2 and v3.

```ts
it('excludes only attempt identity from resume compatibility', () => {
  const a = semanticRunInputs(first.snapshot, first.native);
  const b = semanticRunInputs(next.snapshot, next.native);
  expect(first.snapshot.inputHash).not.toBe(next.snapshot.inputHash);
  expect(a.hash).toBe(b.hash);
  expect(semanticRunInputs(changed.snapshot, changed.native).hash).not.toBe(a.hash);
});
```

- [ ] **Step 2: Run RED.** `pnpm --filter @kddkit/core exec vitest run test/roles.test.ts test/authority.test.ts test/role_prompt.test.ts test/run_inputs.test.ts test/run_inputs_current.test.ts`. Expected new runtime/v3/compatibility assertions fail, legacy hash fixtures still pass.
- [ ] **Step 3: Generalise the shared boundary.** Role validation admits `claude|codex` and preserves immutable revisions; issueRunAuthority verifies matching branded runtime, rights/model/effort, broker and current owner. Build v3 runtime pin only for new grants. Read old shapes through version-specific reconstruction. Audit every `schemaVersion===2` caller, especially role revocation and read_skill_file; v3 must not bypass old guards. `checkedRoleLaunch` uses the existing permit WeakMap, validates exact controller, authentic package, broker token hash, authority and inputs on each call; managed lifecycle refuses unmodeled/no-owner grants.

Semantic pins are an explicit allowlist of requirements hashes/full selected rule/knowledge revisions/dependency binding+artifact hashes/role receipt+manifest/model/effort/runtime version/roots+rights/network/tools/repository identity+commits. Exclude attempt-only fields without discarding semantic rights embedded in config. Do not use a generic recursive removal of keys named id/hash/fence. Session pins are frozen at first admission.

```ts
const roleSupported = inputs.schemaVersion===2 || inputs.schemaVersion===3;
if (!roleSupported || !roleActiveDb(db,inputs.role.roleId)) throw denied();
const compatibility = digest({requirements, rules, knowledge, dependencies,
  role:roleReceipt, runtime:{kind,version,model,effort}, repositories,
  permissions:{readableRoots,writableRoot,protectedPaths,network,tools}});
```

- [ ] **Step 4: Run GREEN.** Same tests plus `test/authority_store.test.ts`, `test/managed_mutations.test.ts`; expected old hashes/guards preserved and both authentic runtime paths pass.
- [ ] **Step 5: Commit.** Exact task paths; `git commit -m 'feat(core): pin runtime inputs and resume compatibility'`.

### Task 6: Wire lifecycle, stop, recovery and final outcome

**Files:** Modify `runtime.ts`, `runtime_process.ts`, `role_prompt.ts`, `codex_permissions.ts`, `native_permissions.ts`, `index.ts`, `test/runtime.test.ts`, `test/runtime_process.test.ts`; create `test/runtime_lifecycle.test.ts`.

**Interfaces:** Consumes Tasks 1–5 journal/parser/retirement/checked permit/native spawn. Produces `startRuntime`, `resumeRuntime`, `stopRuntime`, read APIs and lifecycle signatures in the shared header. Internal process map keyed by attempt id tracks only host observations; SQLite remains authority, conversation identity and durable command record.

- [ ] **Step 1: Write RED lifecycle tests with real local subprocesses.** Count spawned fixture processes for duplicate concurrent command/reopen; inject crash before PID persistence and retain unknown reservation without replay spawn; invalid limits refuse before intent. Race result/error/exit/stop/revoke and assert one terminal outcome. Old-generation late events cannot mutate successor. Stop A preserves sibling B. Missing/tampered checkpoint/version change refuses resume; unchanged pins use exact id/new runId/generation/fence; changed pins require fresh session. Reopened terminal journal is immutable and readable. Test completed as conjunction of valid terminal+exit0+current grant+current inputs+confirmed writers gone.

```ts
it('does not complete a process that exited zero without a terminal result', async () => {
  const attempt = await startRuntime(handle,{commandId:'no-result',permit,limits});
  await waitUntil(()=>runtimeAttempt(handle,attempt.ref).state==='failed');
  expect(runtimeAttempt(handle,attempt.ref).reason).toBe('protocol_error');
  expect(taskWorkItems(handle,taskRef)[0].state).not.toBe('completed');
});
```

`waitUntil` belongs to test utilities, with finite deadline; never add poll-until-done production scheduling.

- [ ] **Step 2: Run RED.** `pnpm --filter @kddkit/core exec vitest run test/runtime_lifecycle.test.ts test/runtime.test.ts test/runtime_process.test.ts`. Expected lifecycle missing or rejection/race tests fail.
- [ ] **Step 3: Integrate under existing lock and durable fence.** Validate finite limits, authentic current permit, compatible owned session and bounded protected checkpoint before admission. Whole prompt+schemas/system reserve+output reserve+verified checkpoint/history must fit confirmed model window; refuse unknown/truncated/compacted history unless separate proof exists. Record session/attempt/command/launch intent transactionally before direct detached spawn; under controller lock rescan roots, check grant/current pins again immediately before spawn, bind exact command to native profile. Store PID+start identity immediately after spawn; failures after side effect hold uncertain owner. A repeated persisted command never spawns anew. Attach bounded stdout/stderr handlers immediately; persist safe events before allowing session continuation; disk/write failure invalidates success and initiates stop.

Timers enforce total/idle deadline; update activity on valid protocol traffic, not unbounded junk. Stop command records durable idempotent intent, revokes current grant and calls finite writer-stop/retirement path; terminal reason keeps timeout/idle/cancelled precedence, no success after stop. Separate leader exit from stdio close; drain until limit, then close inherited pipes and preserve unknown coverage where required. On restart expose uncertain attempts for trusted observation/stop; no automatic process rediscovery/adoption/retry scheduler. History/session binding persistence failure blocks resume.

```ts
const completed = parserResult.terminal==='success' && parserResult.reason===null
  && exitCode===0 && signal===null && currentGrant && currentInputs
  && stopped.verdict==='stopped' && stopped.complete && !stopIntent;
const terminalState = completed ? 'completed' : stopIntent ? 'cancelled' : 'failed';
// The winning immediate transaction sets ended_at once and appends attempt_end.
// Non-success with unknown writers keeps live admission/ownership held.
```

Ensure terminal attempt immutability and active admission lifetime do not conflict: persist terminal outcome only when stop status is resolved; unknown attempts expose reason/stop diagnostics while ownership remains held. Do not mark process failure as accepted/completed work item. Use scoped retirement only after actual host proof; otherwise leave exact owner held.

- [ ] **Step 4: Run GREEN.** Same tests plus ownership/authority/current-input suites. Expected one outcome, ≤1 spawn per command, no false completion, exact-id resume and source preservation.
- [ ] **Step 5: Commit.** Exact task paths; `git commit -m 'feat(core): execute fenced runtime start stop and resume'`.

### Task 7: Real-provider smoke, final fit and independent review

**Files:** Create `.planning/research/orchestration/runtime-check.mjs`, `.planning/research/orchestration/runtime-evidence.json`; update this plan's checkboxes, spec evidence/status and #150 comment. No changes to product status from the smoke.

**Interfaces:** Consumes exported lifecycle API plus real authentic preflights. Produces reproducible evidence with version/executable/template/config hashes, attempt/session ids, semantic pins, stop receipts, expected/actual markers, terminal/exit verdicts and failures; no tokens, raw env, provider logs containing credentials or account data.

- [ ] **Step 1: Build isolated smoke.** Create temporary Git source+managed clone/private SQLite/skills/scratch/control dirs as existing `role-check.mjs`; create modeled work item, owner and role, issue bounded grant with actual broker. Snapshot source refs/tracked/untracked bytes. Every cycle starts a fresh session with random memory marker, executes a long follow-up and stops it, then reserves new fence/issues new generation and resumes exact id asking for the earlier marker without putting that marker in the new prompt. Run 3 independent cycles for each runtime; assert same provider id through all turns, new attempt identities and confirmed scoped stop receipt. Fresh session mismatch must fail, never silently replace id. Record exact native start/resume matrices from Task 4.

```js
assert.equal(cycle.start.providerSessionId, cycle.resume.providerSessionId);
assert.notEqual(cycle.start.ref.attemptId, cycle.resume.ref.attemptId);
assert.equal(cycle.markerObservedAfterResume, true);
assert.equal(cycle.stop.writersStopped, true);
assert.equal(cycle.sourcePreserved, true);
```

- [ ] **Step 2: Run observed smoke.** `pnpm build && node .planning/research/orchestration/runtime-check.mjs`. Expected both provider groups 3/3. Missing login/metadata/native proof is an explicit failed precondition, not skipped pass; keep corresponding criterion unchecked. Store safe evidence through temp file + rename, inspect every failure.
- [ ] **Step 3: Run regression gates once after fixes.** `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm test:codex-plugin`. Expected separate green results; inspect logs, name unrelated failures instead of hiding them. Preserve legacy manual CLI/MCP/worker behaviour; no scheduler adoption.
- [ ] **Step 4: Final source fit check.** Re-open decisive pinned source ranges listed in spec §10: exact-session resume versus fork, group surviving leader/zombie and signal acceptance, explicit terminal success, UTF-8 chunk corruption counterexample, scoped native permissions. Map preserved conditions to final production paths/test/evidence; record changed verdict/gap when actual implementation differs. Do not cite a code path as proof that its real provider smoke passed.
- [ ] **Step 5: Fresh read-only audit.** Prepare cumulative diff from `b0794d9`, spec, plan, ledger rulings, reference pointers and measured evidence. Select `gpt-6.1-sol/high`, `fork_turns:none`, read-only reviewer packet; record observed enforcement/isolation honestly. Compare repository state before/after reviewer. Require `ship`; `fix-first` means primary fixes and re-verifies, then fresh review of changed accumulated diff. Never call primary self-review independent.
- [ ] **Step 6: Commit and report.** Commit exact code/evidence/docs paths, with forced add for ignored docs only; update #150 with actual commands/counts/reference final fit and review verdict. Criteria 404 requires both runtime L02 plus stop receipts L03/L07; 405 requires real start/resume native enforcement and rejection matrix L04–L06/L08. Move to review only after criteria verified; done remains owner acceptance. No push.

## Coverage and dependency self-review

| Spec requirement | Owner tasks | Proof |
| --- | --- | --- |
| Session/attempt/new generation, exact identity | 1,5,6,7 | Unique admission, semantic pins, provider 3/3 |
| Durable intent, command replay, restart uncertainty | 1,6 | Real controllers/subprocess crash tests |
| Scoped retirement, siblings, later task handoff | 1,3,6 | SQLite receipts + real process matrix |
| Both authentic native packages and true resumed tools | 4,5,7 | Exact-version positive/negative native matrix |
| v3 inputs and historical v1/v2 hashes | 1,5 | WAL upgrade and old snapshot fixtures |
| Whole request/resumed history budget, unknown refusal | 4,5,6 | Verified metadata/history; refused unknown cases |
| UTF-8, malformed/unknown/missing/conflicting terminals | 2,6 | Boundary/rejection/exit race matrix |
| Usage unknown/cumulative, redaction, finite limits | 1,2,6,7 | Protocol tests, admission limits, safe export |
| Source/manual flows/build/plugin regression | 3,6,7 | Actual source snapshots + independent commands |
| Reference second pass/final fit, independent audit | 7 | Spec evidence pointers + observed ship verdict |

Pre-flight interface chain: 1→2 journal sequencing; 1→3 release-source schema; 4→5 authentic package union; 2/3/4/5→6 lifecycle; 6→7 public API. v19 release CHECK must accept exactly one of handoff or retirement. Terminal immutability must not prematurely release active admission while writers unknown. Codex legacy ephemeral profile remains distinct from new persistent attestation. Old v2 role guards must explicitly include v3. These are requirements of this plan, not permission to simplify security.

Plan self-review: every spec section has a task; new public types are defined above, local internal functions have signatures in their producer task; every Review Focus item has an owned regression; each task has RED/GREEN commands and local commit; no current runtime implementation or smoke is claimed. External gap remains Claude login and unobserved native/metadata proof, to be reported rather than filled with defaults.
