import type Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { assertRunAuthorityBinding } from './authority.js';
import { pinnedInputsCurrent } from './execution_results.js';
import { assertOwnedRunInputsCurrentDb } from './run_inputs_current.js';
import { controllerDb, type ControllerHandle } from './controller.js';
import { now } from './db.js';
import { KddError } from './errors.js';
import { addTask, appendEvent, mustGetTask } from './ops.js';
import { projectOf } from './project_store.js';
import { KINDS, PRIORITIES, type Kind, type Priority } from './state.js';
import type { Task } from './types.js';

export type ExecutionMode = 'manual' | 'orchestrated';
export interface TaskRef { projectId: string; taskId: number }
export interface AuthorityBinding { authorityId: string; runId: string; workItemId: string; generation: number }
export type CreationSource =
  | { kind: 'manual'; sourceTask: TaskRef; instructionRef: string }
  | { kind: 'run'; sourceTask: TaskRef; authority: AuthorityBinding; proposalEventId: number };
export interface SubtaskDraft {
  key: string; title: string; body?: string; criteria: readonly string[];
  kind?: Kind; priority?: Priority; area?: string; trackId?: number; executionMode?: ExecutionMode;
}
export interface CreateSubtasksInput {
  parent: TaskRef; expectedParentHash: string; source: CreationSource; children: readonly SubtaskDraft[];
}

// Internal boundary helpers shared by the execution modules; never exported from the barrel.
export const controllerActor = { type: 'ai', id: 'controller' } as const;
export function shape(value: unknown, required: readonly string[], optional: readonly string[] = []): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))
    || required.some(k => !Object.hasOwn(value, k))) throw new KddError('invalid input shape');
}
export function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new KddError('invalid nonempty string');
}
export function integer(value: unknown, min = 1): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min) throw new KddError('invalid safe integer');
}
export function mode(value: unknown): asserts value is ExecutionMode {
  if (value !== 'manual' && value !== 'orchestrated') throw new KddError('invalid execution mode');
}
export function scopedTask(db: Database.Database, ref: TaskRef): Task {
  shape(ref, ['projectId', 'taskId']); text(ref.projectId); integer(ref.taskId);
  if (ref.projectId !== projectOf(db).project_id) throw new KddError('foreign project reference');
  return mustGetTask(db, ref.taskId);
}
export function contractHash(db: Database.Database, ref: TaskRef): string {
  const task = scopedTask(db, ref);
  const criteria = db.prepare('SELECT id,text FROM criteria WHERE task_id=? ORDER BY id').all(task.id);
  return createHash('sha256').update(JSON.stringify({ projectId: ref.projectId,
    taskId: task.id, title: task.title, body: task.body, criteria })).digest('hex');
}
export function taskContractHash(handle: ControllerHandle, ref: TaskRef): string {
  const db = controllerDb(handle);
  return db.transaction(() => contractHash(db, ref))();
}
export function checkAuthority(db: Database.Database, task: TaskRef, binding: AuthorityBinding): void {
  scopedTask(db, task);
  shape(binding, ['authorityId', 'workItemId', 'runId', 'generation']);
  text(binding.authorityId); text(binding.workItemId); text(binding.runId); integer(binding.generation);
  assertRunAuthorityBinding(db, task.taskId, binding);
}
function validateCreationSource(db: Database.Database, source: CreationSource): object {
  shape(source, source.kind === 'manual' ? ['kind', 'sourceTask', 'instructionRef'] : ['kind', 'sourceTask', 'authority', 'proposalEventId']);
  scopedTask(db, source.sourceTask);
  if (source.kind === 'manual') {
    text(source.instructionRef);
    return { source_task_id: source.sourceTask.taskId, instruction_ref: source.instructionRef };
  }
  if (source.kind !== 'run') throw new KddError('invalid source kind');
  checkAuthority(db, source.sourceTask, source.authority); integer(source.proposalEventId);
  const event = db.prepare("SELECT detail FROM events WHERE id=? AND task_id=? AND action='run_report'")
    .get(source.proposalEventId, source.sourceTask.taskId) as { detail: string | null } | undefined;
  const detail = event?.detail ? JSON.parse(event.detail) : null;
  if (!detail || detail.work_item_id !== source.authority.workItemId || detail.run_id !== source.authority.runId
    || detail.generation !== source.authority.generation || detail.untrusted !== true) throw new KddError('invalid proposal event');
  return { source_task_id: source.sourceTask.taskId, source_work_item_id: source.authority.workItemId,
    source_run_id: source.authority.runId, generation: source.authority.generation, proposal_event_id: source.proposalEventId };
}
export function createSubtasks(handle: ControllerHandle, input: CreateSubtasksInput): Record<string, Task> {
  const db = controllerDb(handle);
  return db.transaction(() => {
    shape(input, ['parent', 'expectedParentHash', 'source', 'children']);
    const parent = scopedTask(db, input.parent);
    if (parent.parent_id !== null) throw new KddError('parent must be a root task');
    text(input.expectedParentHash);
    if (contractHash(db, input.parent) !== input.expectedParentHash) throw new KddError('stale parent contract');
    const provenance = validateCreationSource(db, input.source);
    if (!Array.isArray(input.children) || !input.children.length) throw new KddError('empty children');
    const keys = new Set<string>();
    for (const child of input.children) {
      shape(child, ['key', 'title', 'criteria'], ['body', 'kind', 'priority', 'area', 'trackId', 'executionMode']);
      text(child.key); text(child.title);
      if (keys.has(child.key)) throw new KddError('duplicate child key'); keys.add(child.key);
      if (!Array.isArray(child.criteria) || !child.criteria.length) throw new KddError('empty criteria');
      child.criteria.forEach(text);
      if (child.body !== undefined && typeof child.body !== 'string') throw new KddError('invalid body');
      if (child.area !== undefined) text(child.area);
      if (child.trackId !== undefined) integer(child.trackId);
      if (child.kind !== undefined && !KINDS.includes(child.kind)) throw new KddError('invalid kind');
      if (child.priority !== undefined && !PRIORITIES.includes(child.priority)) throw new KddError('invalid priority');
      if (child.executionMode !== undefined) mode(child.executionMode);
    }
    const children: Record<string, Task> = Object.create(null);
    for (const child of input.children) {
      const row = addTask(db, { title: child.title, body: child.body, criteria: [...child.criteria],
        kind: child.kind, priority: child.priority, area: child.area, track_id: child.trackId }, controllerActor);
      db.prepare('UPDATE tasks SET parent_id=?,execution_mode=? WHERE id=?')
        .run(parent.id, child.executionMode ?? parent.execution_mode, row.id);
      appendEvent(db, row.id, controllerActor, 'subtask_created', { parent_task_id: parent.id, ...provenance });
      children[child.key] = mustGetTask(db, row.id);
    }
    return children;
  }).immediate();
}
export function listSubtasks(handle: ControllerHandle, parent: TaskRef): Task[] {
  const db = controllerDb(handle);
  scopedTask(db, parent);
  return db.prepare('SELECT * FROM tasks WHERE parent_id=? ORDER BY id').all(parent.taskId) as Task[];
}

export type WorkItemKind = 'analysis' | 'architecture' | 'implementation' | 'check' | 'integration' | 'human_action' | 'curation';
export type WorkItemState = 'pending' | 'ready' | 'running' | 'waiting_input' | 'retry_wait' | 'completed' | 'failed' | 'cancelled';
export type DependencyKind = 'contract' | 'code' | 'merged' | 'readiness';
export interface WorkItemRef { projectId: string; workItemId: string }
export interface OwnershipRef extends WorkItemRef { revision: number; ownerId: string; fence: number }
export interface OutputRequirement { key: string; kind: DependencyKind; required: boolean; version: string; checkRefs: readonly string[] }
export interface WorkItemDefinition {
  kind: WorkItemKind; repoId: string | null; sourceTasks: readonly TaskRef[]; outputs: readonly OutputRequirement[];
}
export type DependencyBinding =
  | { kind: 'contract'; repoId: string | null; version: string }
  | { kind: 'code'; repoId: string; version: string; baseHead: string }
  | { kind: 'merged'; repoId: string; version: string; target: string; baseHead: string }
  | { kind: 'readiness'; repoId: string | null; version: string; resourceId: string; configHash: string;
      consumerScope: string; capabilities: readonly string[] };
export interface DependencyInput {
  key: string; producer: WorkItemRef; producerRevision: number; outputKey: string; binding: DependencyBinding; resultId?: string;
}
export interface WorkItemRecord {
  ref: WorkItemRef; task: TaskRef; revision: number; state: WorkItemState; fence: number; definition: WorkItemDefinition;
  inputs: readonly { task: TaskRef; hash: string }[]; inputsHash: string; dependencies: readonly DependencyInput[];
}
export interface WorkItemInput { task: TaskRef; definition: WorkItemDefinition; dependencies: readonly DependencyInput[] }
export interface SubtaskPlanInput extends CreateSubtasksInput {
  workItems: readonly { key: string; childKey: string; definition: WorkItemDefinition }[];
  dependencies: readonly { consumerKey: string; key: string; producer: { localKey: string } | { ref: WorkItemRef; revision: number };
    outputKey: string; binding: DependencyBinding; resultId?: string }[];
}

export const newId = () => randomBytes(16).toString('hex');
export function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(sort(value));
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export function strings(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value)) throw new KddError('invalid strings'); value.forEach(text);
  if (new Set(value).size !== value.length) throw new KddError('duplicate strings');
}
export function dependencyKind(value: unknown): asserts value is DependencyKind {
  if (!['contract','code','merged','readiness'].includes(value as string)) throw new KddError('invalid dependency kind');
}
export function checkRepo(db: Database.Database, repoId: string | null): void {
  if (repoId === null) return;
  text(repoId);
  if (!db.prepare('SELECT 1 FROM repositories WHERE repo_id=?').get(repoId)) throw new KddError('unknown repository');
}
export function assertNoHandoff(db: Database.Database, taskId: number): void {
  if (db.prepare('SELECT 1 FROM execution_handoffs WHERE task_id=? AND completed_at IS NULL').get(taskId)) {
    throw new KddError('task handoff pending');
  }
}
export function scopedWorkItem(db: Database.Database, ref: WorkItemRef, revision?: number): WorkItemRecord {
  shape(ref, ['projectId','workItemId']); text(ref.projectId); text(ref.workItemId);
  if (ref.projectId !== projectOf(db).project_id) throw new KddError('foreign project reference');
  const row = db.prepare('SELECT * FROM work_items WHERE id=?').get(ref.workItemId) as {
    id: string; task_id: number; current_revision: number; state: WorkItemState; fence: number;
  } | undefined;
  if (!row) throw new KddError('work item not found');
  if (revision !== undefined) integer(revision);
  const rev = revision ?? row.current_revision;
  const contract = db.prepare('SELECT * FROM work_item_revisions WHERE work_item_id=? AND revision=?').get(row.id, rev) as {
    definition_json: string; inputs_json: string; inputs_hash: string;
  } | undefined;
  if (!contract) throw new KddError('work item revision not found');
  const dependencies = (db.prepare(`SELECT * FROM work_item_dependencies WHERE consumer_id=? AND consumer_revision=? ORDER BY edge_key`)
    .all(row.id, rev) as { edge_key: string; producer_id: string; producer_revision: number; output_key: string;
      binding_json: string; pinned_result_id: string | null }[]).map(d => ({ key: d.edge_key,
    producer: { projectId: ref.projectId, workItemId: d.producer_id }, producerRevision: d.producer_revision,
    outputKey: d.output_key, binding: JSON.parse(d.binding_json) as DependencyBinding,
    ...(d.pinned_result_id === null ? {} : { resultId: d.pinned_result_id }) }));
  return { ref: { ...ref }, task: { projectId: ref.projectId, taskId: row.task_id }, revision: rev,
    state: row.state, fence: row.fence, definition: JSON.parse(contract.definition_json),
    inputs: JSON.parse(contract.inputs_json), inputsHash: contract.inputs_hash, dependencies };
}
export function inputsCurrent(db: Database.Database, item: WorkItemRecord): boolean {
  return item.inputs.every(input => contractHash(db, input.task) === input.hash);
}
function checkDefinition(db: Database.Database, definition: WorkItemDefinition): void {
  shape(definition, ['kind','repoId','sourceTasks','outputs']);
  if (!['analysis','architecture','implementation','check','integration','human_action','curation'].includes(definition.kind)) {
    throw new KddError('invalid work item kind');
  }
  checkRepo(db, definition.repoId);
  if (!Array.isArray(definition.sourceTasks) || !Array.isArray(definition.outputs)) throw new KddError('invalid definition arrays');
  const sources = new Set<number>(), outputs = new Set<string>();
  for (const ref of definition.sourceTasks) {
    scopedTask(db, ref);
    if (sources.has(ref.taskId)) throw new KddError('duplicate source task'); sources.add(ref.taskId);
  }
  for (const output of definition.outputs) {
    shape(output, ['key','kind','required','version','checkRefs']);
    text(output.key); text(output.version); dependencyKind(output.kind); strings(output.checkRefs);
    if (typeof output.required !== 'boolean') throw new KddError('invalid output requirement');
    if (outputs.has(output.key)) throw new KddError('duplicate output key'); outputs.add(output.key);
    if ((output.kind === 'code' || output.kind === 'merged') && definition.repoId === null) throw new KddError('output requires repository');
  }
}
export function checkBinding(db: Database.Database, binding: DependencyBinding): void {
  dependencyKind(binding?.kind);
  const extra = { contract: [], code: ['baseHead'], merged: ['target','baseHead'],
    readiness: ['resourceId','configHash','consumerScope','capabilities'] }[binding.kind];
  shape(binding, ['kind','repoId','version',...extra]);
  checkRepo(db, binding.repoId); text(binding.version);
  if (binding.kind === 'code' || binding.kind === 'merged') {
    if (binding.repoId === null) throw new KddError('dependency requires repository'); text(binding.baseHead);
    if (binding.kind === 'merged') text(binding.target);
  }
  if (binding.kind === 'readiness') {
    text(binding.resourceId); text(binding.configHash); text(binding.consumerScope); strings(binding.capabilities);
  }
}
function insertRevision(db: Database.Database, id: string, task: TaskRef, revision: number, definition: WorkItemDefinition): void {
  checkDefinition(db, definition);
  const card = scopedTask(db, task), ids = new Set([card.id, ...definition.sourceTasks.map(t => t.taskId)]);
  if (card.parent_id !== null) ids.add(card.parent_id);
  const inputs = [...ids].sort((a,b) => a-b).map(taskId => {
    const ref = { projectId: task.projectId, taskId }; return { task: ref, hash: contractHash(db, ref) };
  });
  db.prepare('INSERT INTO work_item_revisions VALUES(?,?,?,?,?,?)')
    .run(id, revision, canonical(definition), canonical(inputs), digest(inputs), now());
}
function insertEdges(db: Database.Database, item: WorkItemRecord, dependencies: readonly DependencyInput[]): void {
  if (!Array.isArray(dependencies)) throw new KddError('invalid dependencies');
  const keys = new Set<string>();
  for (const dep of dependencies) {
    shape(dep, ['key','producer','producerRevision','outputKey','binding'], ['resultId']);
    text(dep.key); text(dep.outputKey); integer(dep.producerRevision); checkBinding(db, dep.binding);
    if (keys.has(dep.key)) throw new KddError('duplicate edge key'); keys.add(dep.key);
    const producer = scopedWorkItem(db, dep.producer, dep.producerRevision);
    if (item.ref.workItemId === producer.ref.workItemId) throw new KddError('self dependency cycle');
    const output = producer.definition.outputs.find(o => o.key === dep.outputKey);
    if (!output || output.kind !== dep.binding.kind || output.version !== dep.binding.version
      || producer.definition.repoId !== dep.binding.repoId) throw new KddError('incompatible dependency output or scope');
    if (dep.binding.kind === 'code' && (item.definition.repoId === null || item.definition.repoId !== producer.definition.repoId)) {
      throw new KddError('cross repository code dependency denied');
    }
    if (dep.resultId !== undefined) {
      text(dep.resultId);
      const result = db.prepare('SELECT payload_json FROM work_item_results WHERE id=? AND producer_id=? AND producer_revision=? AND output_key=? AND kind=?')
        .get(dep.resultId, producer.ref.workItemId, producer.revision, dep.outputKey, dep.binding.kind) as { payload_json: string } | undefined;
      const payload = result ? JSON.parse(result.payload_json) : null;
      if (!payload || payload.version !== dep.binding.version || payload.repoId !== dep.binding.repoId) throw new KddError('result binding mismatch');
    }
    db.prepare('INSERT INTO work_item_dependencies VALUES(?,?,?,?,?,?,?,?,?)').run(item.ref.workItemId, item.revision,
      dep.key, producer.ref.workItemId, producer.revision, dep.binding.kind, dep.outputKey, canonical(dep.binding), dep.resultId ?? null);
  }
}
function assertDag(db: Database.Database, refs: readonly WorkItemRef[]): void {
  const cycle = db.prepare(`WITH RECURSIVE active(consumer,producer) AS (
    SELECT d.consumer_id,d.producer_id FROM work_item_dependencies d
    JOIN work_items w ON w.id=d.consumer_id AND w.current_revision=d.consumer_revision
  ), reachable(id) AS (SELECT producer FROM active WHERE consumer=?
    UNION SELECT a.producer FROM active a JOIN reachable r ON a.consumer=r.id)
    SELECT 1 FROM reachable WHERE id=? LIMIT 1`);
  for (const ref of refs) if (cycle.get(ref.workItemId, ref.workItemId)) throw new KddError('dependency cycle');
}
export function createWorkItem(handle: ControllerHandle, input: WorkItemInput): WorkItemRecord {
  const db = controllerDb(handle);
  return db.transaction(() => {
    shape(input, ['task','definition','dependencies']); const task = scopedTask(db, input.task);
    assertNoHandoff(db, task.id);
    const ref = { projectId: input.task.projectId, workItemId: newId() };
    db.prepare('INSERT INTO work_items(id,task_id,current_revision,created_at) VALUES(?,?,1,?)').run(ref.workItemId, task.id, now());
    insertRevision(db, ref.workItemId, input.task, 1, input.definition);
    insertEdges(db, scopedWorkItem(db, ref), input.dependencies); assertDag(db, [ref]);
    appendEvent(db, task.id, controllerActor, 'work_item_created', { work_item_id: ref.workItemId, revision: 1 });
    return scopedWorkItem(db, ref);
  }).immediate();
}
export function reviseWorkItem(handle: ControllerHandle, input: {
  ref: WorkItemRef; expectedRevision: number; definition: WorkItemDefinition; dependencies: readonly DependencyInput[];
}): WorkItemRecord {
  const db = controllerDb(handle);
  return db.transaction(() => {
    shape(input, ['ref','expectedRevision','definition','dependencies']); integer(input.expectedRevision);
    const item = scopedWorkItem(db, input.ref); assertNoHandoff(db, item.task.taskId);
    if (item.revision !== input.expectedRevision || item.revision === Number.MAX_SAFE_INTEGER) throw new KddError('revision conflict or overflow');
    if (['completed','failed','cancelled'].includes(item.state)) throw new KddError('terminal work item requires new work');
    if (db.prepare('SELECT 1 FROM work_item_owners WHERE work_item_id=? AND released_at IS NULL').get(item.ref.workItemId)) {
      throw new KddError('owned work item cannot change revision');
    }
    const revision = item.revision + 1;
    insertRevision(db, item.ref.workItemId, item.task, revision, input.definition);
    db.prepare('UPDATE work_items SET current_revision=?,state=\'pending\' WHERE id=? AND current_revision=?')
      .run(revision, item.ref.workItemId, input.expectedRevision);
    insertEdges(db, scopedWorkItem(db, item.ref), input.dependencies); assertDag(db, [item.ref]);
    appendEvent(db, item.task.taskId, controllerActor, 'work_item_revised', { work_item_id: item.ref.workItemId, revision });
    return scopedWorkItem(db, item.ref);
  }).immediate();
}
export function workItem(handle: ControllerHandle, ref: WorkItemRef): WorkItemRecord {
  const db = controllerDb(handle); return db.transaction(() => scopedWorkItem(db, ref))();
}
export function taskWorkItems(handle: ControllerHandle, task: TaskRef): WorkItemRecord[] {
  const db = controllerDb(handle);
  return db.transaction(() => {
    scopedTask(db, task);
    return (db.prepare('SELECT id FROM work_items WHERE task_id=? ORDER BY id').all(task.taskId) as { id: string }[])
      .map(row => scopedWorkItem(db, { projectId: task.projectId, workItemId: row.id }));
  })();
}
export function createSubtaskPlan(handle: ControllerHandle, input: SubtaskPlanInput): {
  tasks: Record<string, Task>; workItems: Record<string, WorkItemRecord>;
} {
  const db = controllerDb(handle);
  return db.transaction(() => {
    shape(input, ['parent','expectedParentHash','source','children','workItems','dependencies']);
    if (!Array.isArray(input.workItems) || !Array.isArray(input.dependencies)) throw new KddError('invalid plan arrays');
    const tasks = createSubtasks(handle, { parent: input.parent, expectedParentHash: input.expectedParentHash,
      source: input.source, children: input.children });
    const refs: Record<string, WorkItemRef> = Object.create(null);
    for (const draft of input.workItems) {
      shape(draft, ['key','childKey','definition']); text(draft.key); text(draft.childKey);
      if (Object.hasOwn(refs, draft.key) || !Object.hasOwn(tasks, draft.childKey)) throw new KddError('invalid plan work item key');
      const ref = { projectId: input.parent.projectId, workItemId: newId() }; refs[draft.key] = ref;
      db.prepare('INSERT INTO work_items(id,task_id,current_revision,created_at) VALUES(?,?,1,?)').run(ref.workItemId, tasks[draft.childKey].id, now());
      insertRevision(db, ref.workItemId, { projectId: ref.projectId, taskId: tasks[draft.childKey].id }, 1, draft.definition);
    }
    const dependencies: Record<string, DependencyInput[]> = Object.fromEntries(Object.keys(refs).map(k => [k, []]));
    for (const dep of input.dependencies) {
      shape(dep, ['consumerKey','key','producer','outputKey','binding'], ['resultId']); text(dep.consumerKey);
      if (!Object.hasOwn(refs, dep.consumerKey)) throw new KddError('missing consumer key');
      shape(dep.producer, Object.hasOwn(dep.producer, 'localKey') ? ['localKey'] : ['ref','revision']);
      let producer: WorkItemRef, producerRevision: number;
      if ('localKey' in dep.producer) {
        text(dep.producer.localKey);
        if (!Object.hasOwn(refs, dep.producer.localKey)) throw new KddError('missing producer key');
        producer = refs[dep.producer.localKey]; producerRevision = 1;
      } else { producer = dep.producer.ref; producerRevision = dep.producer.revision; }
      dependencies[dep.consumerKey].push({ key: dep.key, producer, producerRevision, outputKey: dep.outputKey,
        binding: dep.binding, ...(dep.resultId === undefined ? {} : { resultId: dep.resultId }) });
    }
    for (const key of Object.keys(refs)) insertEdges(db, scopedWorkItem(db, refs[key]), dependencies[key]);
    assertDag(db, Object.values(refs));
    const workItems = Object.fromEntries(Object.keys(refs).map(key => [key, scopedWorkItem(db, refs[key])]));
    appendEvent(db, input.parent.taskId, controllerActor, 'subtask_plan_created', {
      tasks: Object.fromEntries(Object.entries(tasks).map(([k,t]) => [k,t.id])), work_items: refs });
    return { tasks, workItems };
  }).immediate();
}

export interface OwnerRow {
  work_item_id: string; fence: number; revision: number; owner_id: string; mode: ExecutionMode;
  write_access: number; inputs_json: string; launch_id: string | null; launch_json: string | null;
  created_at: number; released_at: number | null; release_handoff_id: string | null;
}
export function checkOwnershipRef(db: Database.Database, ref: OwnershipRef): void {
  shape(ref, ['projectId','workItemId','revision','ownerId','fence']);
  text(ref.ownerId); integer(ref.revision); integer(ref.fence);
  scopedWorkItem(db, {projectId:ref.projectId,workItemId:ref.workItemId}, ref.revision);
}
export function liveOwner(db: Database.Database, ref: OwnershipRef): OwnerRow {
  checkOwnershipRef(db, ref);
  const item = scopedWorkItem(db, {projectId:ref.projectId,workItemId:ref.workItemId});
  const row = db.prepare('SELECT * FROM work_item_owners WHERE work_item_id=? AND fence=? AND owner_id=? AND revision=? AND released_at IS NULL')
    .get(ref.workItemId, ref.fence, ref.ownerId, ref.revision) as OwnerRow | undefined;
  if (!row || item.revision !== ref.revision || item.fence !== ref.fence || !inputsCurrent(db,item)
    || JSON.parse(row.inputs_json).inputsHash !== item.inputsHash
    || !pinnedInputsCurrent(db,item,JSON.parse(row.inputs_json).inputResults)) throw new KddError('ownership fence or inputs stale');
  assertOwnedRunInputsCurrentDb(db,ref);
  return row;
}

export const LEGACY_EXECUTION_SQL = `execution_mode='manual'
  AND NOT EXISTS (SELECT 1 FROM managed_task_policy p WHERE p.task_id=tasks.id)
  AND NOT EXISTS (SELECT 1 FROM execution_handoffs h WHERE h.task_id=tasks.id AND h.completed_at IS NULL)`;
