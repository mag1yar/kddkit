import type Database from 'better-sqlite3';
import { controllerDb, type ControllerHandle } from './controller.js';
import { assertNoHandoff, liveOwner, scopedWorkItem, type AuthorityBinding, type OwnershipRef } from './execution.js';
export { openController, type ControllerHandle } from './controller.js';
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { now } from './db.js';
import { KddError } from './errors.js';
import { appendEvent, mustGetTask } from './ops.js';
import { projectOf, repositoriesOf, bindingsOf, canonicalCommonDir } from './project_store.js';
import { assertVerifiedCodexPackage, inside, type VerifiedCodexPackage } from './codex_permissions.js';
import { CAPS } from './caps.js';
import { redact } from './agent_events.js';
import { listCriteria } from './criteria.js';

export type RunOperation = 'get_context' | 'submit_report' | 'request_question';
const operations: readonly RunOperation[] = ['get_context', 'submit_report', 'request_question'];
export interface RunContext { readonly kind: 'run' }
export interface IssueRunInput {
  taskId: number; workItemId: string; runId: string; expectedGeneration: number; expiresAt: number;
  operations: readonly RunOperation[];
  repositories: readonly { repoId: string; checkoutPath: string; write: boolean }[];
  native: VerifiedCodexPackage; ownership?: OwnershipRef;
}
export interface IssuedRunAuthority { authorityId: string; generation: number; token: string }
interface Grant {
  ownership?: OwnershipRef;
  projectId: string; taskId: number; workItemId: string; runId: string; generation: number;
  operations: readonly RunOperation[];
  repositories: readonly { repoId: string; checkoutPath: string; write: boolean; commonDir: string }[];
  native: { readableRoots: readonly string[]; writableRoot?: string; scratchDir: string; configHash: string };
}
interface AuthorityRow {
  authority_id: string; task_id: number; work_item_id: string; run_id: string; generation: number;
  expires_at: number; revoked_at: number | null; token_hash: string; grant_json: string;
}
const contexts = new WeakMap<object, { db: Database.Database; token: string; authorityId: string; grant: Grant }>();
const denied = () => new KddError('run authority denied');
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const controllerActor = { type: 'ai', id: 'controller' } as const;

export function assertLegacyTaskMutation(db: Database.Database, taskIds: readonly number[]): void {
  const ids = [...new Set(taskIds)];
  if (ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new KddError('invalid task ids');
  if (ids.length && db.prepare(`SELECT task_id FROM managed_task_policy WHERE task_id IN (${ids.map(() => '?').join(',')}) LIMIT 1`).get(...ids)) {
    throw new KddError('managed task requires controller authority');
  }
  if (ids.length && db.prepare(`SELECT task_id FROM execution_handoffs WHERE completed_at IS NULL AND task_id IN (${ids.map(() => '?').join(',')}) LIMIT 1`).get(...ids)) {
    throw new KddError('task handoff requires controller authority');
  }
}
function mark(db: Database.Database, taskId: number): void {
  if (!Number.isSafeInteger(taskId) || taskId < 1) throw denied();
  const task = mustGetTask(db, taskId);
  if (task.claimed_by !== null) throw new KddError('claimed legacy writer must stop before controller protection');
  if (db.prepare("INSERT OR IGNORE INTO managed_task_policy(task_id,created_at,source) VALUES(?,?,'controller')").run(taskId, now()).changes) {
    appendEvent(db, taskId, controllerActor, 'task_protected');
  }
}
export function protectTask(handle: ControllerHandle, taskId: number): void {
  const db = controllerDb(handle); db.transaction(() => mark(db, taskId)).immediate();
}
function modeledOwnership(db: Database.Database, input: Pick<IssueRunInput, 'taskId' | 'workItemId' | 'ownership'>, scope: Grant['repositories']): void {
  const modeled = db.prepare('SELECT 1 FROM work_items WHERE id=?').get(input.workItemId);
  if (!modeled) { if (input.ownership !== undefined) throw denied(); return; }
  if (!input.ownership) throw new KddError('modeled work requires ownership');
  const owner = liveOwner(db, input.ownership);
  const item = scopedWorkItem(db, { projectId: input.ownership.projectId, workItemId: input.workItemId });
  if (owner.work_item_id !== input.workItemId || item.task.taskId !== input.taskId) throw denied();
  if (scope.some(repo => repo.write && (!owner.write_access || item.definition.repoId === null || item.definition.repoId !== repo.repoId))) {
    throw new KddError('ownership writable repository mismatch');
  }
}
function canonicalCheckout(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path) || !lstatSync(path).isDirectory()) throw new KddError('invalid repository scope');
  return realpathSync(path);
}
function repositoryScope(db: Database.Database, input: IssueRunInput['repositories'], native: Pick<VerifiedCodexPackage, 'readableRoots' | 'writableRoot'>): Grant['repositories'] {
  if (!Array.isArray(input) || !input.length) throw new KddError('empty repository scope');
  const repos = repositoriesOf(db), bindings = bindingsOf(db);
  const scope = input.map(resource => {
    const checkoutPath = canonicalCheckout(resource.checkoutPath), commonDir = canonicalCommonDir(checkoutPath);
    const repo = repos.find(repo => repo.repo_id === resource.repoId);
    const binding = bindings.find(binding => binding.repo_id === resource.repoId && binding.common_dir === commonDir);
    if (!repo || !binding || typeof resource.write !== 'boolean'
      || (resource.write && (repo.access !== 'implementation' || binding.kind !== 'managed'))) throw new KddError('repository write/scope denied');
    return { repoId: repo.repo_id, checkoutPath, commonDir, write: resource.write };
  });
  const paths = scope.map(resource => resource.checkoutPath), writes = scope.filter(resource => resource.write).map(resource => resource.checkoutPath);
  if (new Set(paths).size !== paths.length || writes.length > 1
    || JSON.stringify([...paths].sort()) !== JSON.stringify([...native.readableRoots].sort())
    || writes[0] !== native.writableRoot) throw new KddError('native repository scope differs from grant');
  return scope;
}
function privateStore(db: Database.Database, scope: Grant['repositories'], native: Pick<VerifiedCodexPackage, 'scratchDir' | 'writableRoot'>): void {
  if (db.memory) return;
  const path = realpathSync(db.name);
  if (db.name !== path) throw new KddError('project store alias denied');
  // ponytail: embedded stores refuse managed grants; support them only with explicit file-deny proof.
  if (scope.some(resource => inside(resource.checkoutPath, path) || inside(resource.commonDir, path))) throw new KddError('native repository scope exposes project store');
  const writableRoots = [canonicalCheckout(native.scratchDir), ...(native.writableRoot ? [canonicalCheckout(native.writableRoot)] : [])];
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (writableRoots.some(root => inside(root, file))) throw new KddError('native writable scope exposes project store');
    try { if (!lstatSync(file).isFile() || lstatSync(file).nlink !== 1) throw new KddError('project store alias denied'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
export function issueRunAuthority(handle: ControllerHandle, input: IssueRunInput): IssuedRunAuthority {
  const db = controllerDb(handle);
  return db.transaction(() => {
    if (!Number.isSafeInteger(input.taskId) || input.taskId < 1
      || typeof input.workItemId !== 'string' || !input.workItemId.trim()
      || typeof input.runId !== 'string' || !input.runId.trim()
      || !Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0 || input.expectedGeneration === Number.MAX_SAFE_INTEGER
      || !Number.isFinite(input.expiresAt) || input.expiresAt <= now()
      || !Array.isArray(input.operations) || !input.operations.length || new Set(input.operations).size !== input.operations.length
      || input.operations.some(operation => !operations.includes(operation))) throw denied();
    assertNoHandoff(db, input.taskId);
    const generation = (db.prepare('SELECT COALESCE(MAX(generation),0) generation FROM run_authorities WHERE task_id=? AND work_item_id=?')
      .get(input.taskId, input.workItemId) as { generation: number }).generation;
    if (generation !== input.expectedGeneration) throw new KddError('run authority generation fence changed');
    assertVerifiedCodexPackage(input.native);
    const repositories = repositoryScope(db, input.repositories, input.native);
    modeledOwnership(db, input, repositories);
    privateStore(db, repositories, input.native);
    mark(db, input.taskId);
    const grant: Grant = { projectId: projectOf(db).project_id, taskId: input.taskId,
      workItemId: input.workItemId, runId: input.runId, generation: generation + 1,
      operations: [...input.operations], repositories, ...(input.ownership ? { ownership: { ...input.ownership } } : {}),
      native: { readableRoots: [...input.native.readableRoots], writableRoot: input.native.writableRoot, scratchDir: input.native.scratchDir, configHash: input.native.configHash } };
    const token = randomBytes(32).toString('hex'), authorityId = randomBytes(16).toString('hex');
    db.prepare('UPDATE run_authorities SET revoked_at=? WHERE task_id=? AND work_item_id=? AND revoked_at IS NULL').run(now(), input.taskId, input.workItemId);
    db.prepare('INSERT INTO run_authorities(authority_id,task_id,work_item_id,run_id,generation,expires_at,token_hash,grant_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(authorityId, input.taskId, input.workItemId, input.runId, grant.generation, input.expiresAt, tokenHash(token), JSON.stringify(grant), now());
    appendEvent(db, input.taskId, controllerActor, 'authority_issued', { authorityId, workItemId: grant.workItemId, runId: grant.runId, generation: grant.generation });
    return { authorityId, generation: grant.generation, token };
  }).immediate();
}
export function revokeRunAuthority(handle: ControllerHandle, authorityId: string): void {
  const db = controllerDb(handle);
  db.transaction(() => {
    const row = db.prepare('SELECT task_id,generation FROM run_authorities WHERE authority_id=?').get(authorityId) as { task_id: number; generation: number } | undefined;
    if (!row) throw denied();
    if (db.prepare('UPDATE run_authorities SET revoked_at=? WHERE authority_id=? AND revoked_at IS NULL').run(now(), authorityId).changes) {
      appendEvent(db, row.task_id, controllerActor, 'authority_revoked', { authorityId, generation: row.generation });
    }
  }).immediate();
}
function currentAuthority(db: Database.Database, row: AuthorityRow | undefined): { row: AuthorityRow; grant: Grant } {
  if (!row || row.revoked_at !== null || !Number.isFinite(row.expires_at) || row.expires_at <= now()) throw denied();
  let grant: Grant;
  try { grant = JSON.parse(row.grant_json) as Grant; }
  catch { throw denied(); }
  const latest = (db.prepare('SELECT MAX(generation) generation FROM run_authorities WHERE task_id=? AND work_item_id=?')
    .get(row.task_id, row.work_item_id) as { generation: number }).generation;
  if (!grant || !Array.isArray(grant.operations) || !grant.operations.length
    || new Set(grant.operations).size !== grant.operations.length || grant.operations.some(operation => !operations.includes(operation))
    || grant.projectId !== projectOf(db).project_id || grant.taskId !== row.task_id || grant.workItemId !== row.work_item_id
    || grant.runId !== row.run_id || grant.generation !== row.generation || latest !== row.generation
    || !db.prepare('SELECT task_id FROM managed_task_policy WHERE task_id=?').get(row.task_id)) throw denied();
  mustGetTask(db, row.task_id);
  try {
    const repositories = repositoryScope(db, grant.repositories, grant.native);
    if (JSON.stringify(repositories) !== JSON.stringify(grant.repositories)) throw denied();
    modeledOwnership(db, grant, repositories);
    privateStore(db, repositories, grant.native);
  } catch { throw denied(); }
  return { row, grant };
}
// Internal host boundary: the same live scope guard as token-backed run operations.
export function assertRunAuthorityBinding(db: Database.Database, taskId: number, binding: AuthorityBinding): void {
  const row = db.prepare(`SELECT * FROM run_authorities WHERE authority_id=? AND task_id=?
    AND work_item_id=? AND run_id=? AND generation=?`)
    .get(binding.authorityId, taskId, binding.workItemId, binding.runId, binding.generation) as AuthorityRow | undefined;
  currentAuthority(db, row);
}
function lookup(db: Database.Database, token: string): { row: AuthorityRow; grant: Grant } {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) throw denied();
  const row = db.prepare('SELECT * FROM run_authorities WHERE token_hash=?').get(tokenHash(token)) as AuthorityRow | undefined;
  return currentAuthority(db, row);
}
export function openRunContext(db: Database.Database, token: string): RunContext {
  return db.transaction(() => {
    const { row, grant } = lookup(db, token);
    const context = Object.freeze({ kind: 'run' as const });
    contexts.set(context, { db, token, authorityId: row.authority_id, grant }); return context;
  }).immediate();
}

export interface RunContextSnapshot {
  projectId: string; taskId: number; workItemId: string; runId: string; generation: number;
  task: { title: string; body: string | null; status: string };
  criteria: { id: number; text: string; checked: boolean }[];
  decisions: { slug: string; title: string }[];
}
function registered(context: RunContext) {
  const stored = typeof context === 'object' && context !== null ? contexts.get(context) : undefined;
  if (!stored?.db.open) throw denied();
  return stored;
}
function live(context: RunContext, operation?: RunOperation) {
  const stored = registered(context), { row, grant } = lookup(stored.db, stored.token);
  if (row.authority_id !== stored.authorityId || JSON.stringify(grant) !== JSON.stringify(stored.grant)
    || (operation && !grant.operations.includes(operation))) throw denied();
  return { ...stored, grant };
}
export function runOperations(context: RunContext): readonly RunOperation[] {
  return registered(context).db.transaction(() => Object.freeze([...live(context).grant.operations])).immediate();
}
export function readRunContext(context: RunContext): RunContextSnapshot {
  return registered(context).db.transaction(() => {
    const { db, grant } = live(context, 'get_context'), task = mustGetTask(db, grant.taskId);
    return { projectId: grant.projectId, taskId: grant.taskId, workItemId: grant.workItemId,
      runId: grant.runId, generation: grant.generation,
      task: { title: task.title, body: task.body, status: task.status },
      criteria: listCriteria(db, task.id).map(c => ({ id: c.id, text: c.text, checked: c.checked_at !== null })),
      decisions: db.prepare(`SELECT d.slug,d.title FROM decisions d,json_each(d.source_tasks) s
        WHERE CAST(s.value AS INTEGER)=? ORDER BY d.slug`).all(task.id) as { slug: string; title: string }[] };
  }).immediate();
}
function runEvent(context: RunContext, operation: 'submit_report' | 'request_question', body: string): number {
  return registered(context).db.transaction(() => {
    const { db, token, grant } = live(context, operation);
    if (typeof body !== 'string' || !body.trim() || body.length > CAPS.agentFieldChars) throw new KddError('invalid run body');
    const safe = redact(body.replaceAll(token, '[redacted]').replaceAll(tokenHash(token), '[redacted]'));
    return appendEvent(db, grant.taskId, { type: 'ai', id: grant.runId },
      operation === 'submit_report' ? 'run_report' : 'run_question',
      { work_item_id: grant.workItemId, run_id: grant.runId, generation: grant.generation, untrusted: true, body: safe });
  }).immediate();
}
export const submitRunReport = (context: RunContext, body: string): number => runEvent(context, 'submit_report', body);
export const requestRunQuestion = (context: RunContext, body: string): number => runEvent(context, 'request_question', body);
