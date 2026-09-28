import { afterEach, expect, it } from 'vitest';
import * as core from '../src/index.js';
import { cleanupFixtures, fixture } from './execution_fixture.js';
afterEach(cleanupFixtures);

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
  f.db.prepare("UPDATE tasks SET execution_mode='manual' WHERE id=?").run(parent.id);
  expect(core.listSubtasks(f.handle, f.ref(parent.id)).map(t => t.execution_mode)).toEqual(['orchestrated', 'manual']);
});

function split(f: ReturnType<typeof fixture>, parent: core.Task): core.CreateSubtasksInput {
  return { parent: f.ref(parent.id), expectedParentHash: core.taskContractHash(f.handle, f.ref(parent.id)),
    source: { kind: 'manual', sourceTask: f.ref(parent.id), instructionRef: 'owner:split' },
    children: [{ key: 'x', title: 'child', criteria: ['outcome'] }] };
}
it('rejects foreign numeric refs, fabricated handles and invalid batches without partial rows', () => {
  const a = fixture(), b = fixture(), parent = a.task('a'), foreign = b.task('b');
  expect(parent.id).toBe(foreign.id);
  const input = split(a, parent), before = a.db.prepare('SELECT * FROM events').all();
  const bad = [
    { ...input, parent: b.ref(foreign.id) },
    { ...input, parent: a.ref(999) },
    { ...input, source: { ...input.source, sourceTask: b.ref(foreign.id) } },
    { ...input, expectedParentHash: 'stale' },
    { ...input, children: [input.children[0], input.children[0]] },
    { ...input, children: [input.children[0], { key: 'bad', title: 'bad', criteria: [''] }] },
    { ...input, children: [{ ...input.children[0], executionMode: 'auto' }] },
    { ...input, reason: 'user said so' },
  ];
  for (const candidate of bad) expect(() => core.createSubtasks(a.handle, candidate as core.CreateSubtasksInput)).toThrow();
  for (const fake of [{ ...a.handle }, JSON.parse(JSON.stringify(a.handle)), { type: 'user' }, { kind: 'run' }]) {
    expect(() => core.createSubtasks(fake as core.ControllerHandle, input)).toThrow(/authority/);
  }
  expect(a.db.prepare('SELECT * FROM events').all()).toEqual(before);
  expect(core.listSubtasks(a.handle, a.ref(parent.id))).toEqual([]);
});
it('enforces one level through SQL and records membership independently from event provenance', () => {
  const f = fixture(), parent = f.task('root'), other = f.task('other');
  const children = core.createSubtasks(f.handle, split(f, parent));
  expect(() => f.db.prepare('UPDATE tasks SET parent_id=id WHERE id=?').run(other.id)).toThrow(/parent/);
  expect(() => f.db.prepare('UPDATE tasks SET parent_id=? WHERE id=?').run(other.id, parent.id)).toThrow(/parent/);
  expect(() => f.db.prepare('UPDATE tasks SET parent_id=? WHERE id=?').run(children.x.id, other.id)).toThrow(/parent/);
  const event = f.db.prepare("SELECT parent_id,detail FROM events WHERE action='subtask_created'").get() as { parent_id: number | null; detail: string };
  expect(event.parent_id).toBeNull();
  expect(JSON.parse(event.detail)).toEqual({ parent_task_id: parent.id, source_task_id: parent.id, instruction_ref: 'owner:split' });
});
it('uses the project default for new roots and hashes actual requirements only', () => {
  const f = fixture();
  f.db.prepare("UPDATE project SET default_execution_mode='orchestrated'").run();
  const task = f.task('root'); expect(task.execution_mode).toBe('orchestrated');
  const hash = core.taskContractHash(f.handle, f.ref(task.id));
  f.db.exec(`UPDATE tasks SET position=99,status='done'; UPDATE criteria SET checked_at=1,evidence='passed',position=99;`);
  core.commentTask(f.db, task.id, 'exit 0', { type: 'user' });
  expect(core.taskContractHash(f.handle, f.ref(task.id))).toBe(hash);
  for (const sql of ["UPDATE tasks SET title='new requirement'", "UPDATE tasks SET body='another requirement'", "UPDATE criteria SET text='new criterion'"]) {
    const before = core.taskContractHash(f.handle, f.ref(task.id)); f.db.exec(sql);
    expect(core.taskContractHash(f.handle, f.ref(task.id))).not.toBe(before);
  }
  f.db.pragma('user_version=16');
  expect(() => core.openController(f.db)).toThrow(/authority/);
  expect(() => core.taskContractHash(f.handle, f.ref(task.id))).toThrow(/authority/);
});

const definition: core.WorkItemDefinition = { kind: 'architecture', repoId: null, sourceTasks: [],
  outputs: [{ key: 'api', kind: 'contract', required: true, version: 'v1', checkRefs: [] }] };
const edge = (producer: core.WorkItemRecord): core.DependencyInput => ({ key: 'needs-api', producer: producer.ref,
  producerRevision: producer.revision, outputKey: 'api', binding: { kind: 'contract', repoId: null, version: 'v1' } });
it('includes parent inputs and preserves immutable previous revisions', () => {
  const f = fixture(), parent = f.task('main');
  const child = core.createSubtasks(f.handle, split(f, parent)).x;
  const first = core.createWorkItem(f.handle, { task: f.ref(child.id), definition, dependencies: [] });
  expect(first.inputs.map(i => i.task.taskId)).toEqual([parent.id, child.id]);
  const second = core.reviseWorkItem(f.handle, { ref: first.ref, expectedRevision: 1,
    definition: { ...definition, outputs: [{ ...definition.outputs[0], version: 'v2' }] }, dependencies: [] });
  expect(second.revision).toBe(2);
  expect(f.db.prepare('SELECT count(*) n FROM work_item_revisions WHERE work_item_id=?').get(first.ref.workItemId)).toEqual({ n: 2 });
  expect(() => core.reviseWorkItem(f.handle, { ref: first.ref, expectedRevision: 1, definition, dependencies: [] })).toThrow(/revision/);
  expect(() => f.db.prepare("UPDATE work_item_revisions SET inputs_hash='fake'").run()).toThrow(/immutable/);
});
it('rejects a cross-task cycle atomically, even through a pinned older producer revision', () => {
  const f = fixture(), a = f.task('A'), b = f.task('B');
  const wa = core.createWorkItem(f.handle, { task: f.ref(a.id), definition, dependencies: [] });
  const wb = core.createWorkItem(f.handle, { task: f.ref(b.id), definition, dependencies: [] });
  core.reviseWorkItem(f.handle, { ref: wa.ref, expectedRevision: 1, definition, dependencies: [edge(wb)] });
  const before = f.db.prepare('SELECT * FROM events').all();
  expect(() => core.reviseWorkItem(f.handle, { ref: wb.ref, expectedRevision: 1, definition, dependencies: [edge(wa)] })).toThrow(/cycle/);
  expect(core.workItem(f.handle, wb.ref).revision).toBe(1);
  expect(f.db.prepare('SELECT * FROM events').all()).toEqual(before);
});

it('creates a complete sibling graph in one transaction and rolls back a bad last edge', () => {
  const f = fixture(), parent = f.task('parent');
  const input: core.SubtaskPlanInput = { ...split(f, parent),
    children: ['a','b','c'].map(key => ({ key, title: key, criteria: ['outcome'] })),
    workItems: ['a','b','c'].map(key => ({ key, childKey: key, definition })),
    dependencies: [{ consumerKey: 'c', key: 'api', producer: { localKey: 'a' }, outputKey: 'api',
      binding: { kind: 'contract', repoId: null, version: 'v1' } }] };
  const counts = () => f.db.prepare(`SELECT (SELECT count(*) FROM tasks)t,(SELECT count(*) FROM criteria)c,
    (SELECT count(*) FROM work_items)w,(SELECT count(*) FROM work_item_revisions)r,
    (SELECT count(*) FROM work_item_dependencies)d,(SELECT count(*) FROM events)e`).get();
  const before = counts();
  expect(() => core.createSubtaskPlan(f.handle, { ...input,
    dependencies: [...input.dependencies, { ...input.dependencies[0], consumerKey: 'a', producer: { localKey: 'c' } }] })).toThrow(/cycle/);
  expect(counts()).toEqual(before);
  const plan = core.createSubtaskPlan(f.handle, input);
  expect(plan.workItems.a.revision).toBe(1);
  expect([plan.workItems.a.dependencies.length,plan.workItems.b.dependencies.length,plan.workItems.c.dependencies.length]).toEqual([0,0,1]);
  expect(plan.workItems.c.dependencies[0].producer).toEqual(plan.workItems.a.ref);
  core.linkTasks(f.db, plan.tasks.a.id, plan.tasks.b.id, 'depends_on', { type: 'user' });
  expect(core.workItem(f.handle, plan.workItems.b.ref).dependencies).toEqual([]);
  expect(core.taskWorkItems(f.handle, f.ref(parent.id))).toEqual([]);
});
it('rejects malformed edges and foreign ids without changing the active graph', () => {
  const f = fixture(), other = fixture(), a = f.task('a'), b = f.task('b');
  const wa = core.createWorkItem(f.handle, { task: f.ref(a.id), definition, dependencies: [] });
  const wb = core.createWorkItem(f.handle, { task: f.ref(b.id), definition, dependencies: [] });
  const good = edge(wb), before = f.db.prepare('SELECT * FROM events').all();
  const bad = [edge(wa), { ...good, producer: { ...wb.ref, projectId: other.projectId } },
    { ...good, producer: { ...wb.ref, workItemId: 'missing' } }, { ...good, producerRevision: 999 },
    { ...good, producerRevision: Infinity }, { ...good, outputKey: 'missing' },
    { ...good, binding: { ...good.binding, version: 'wrong' } },
    { ...good, binding: { ...good.binding, passed: true } }, { ...good, resultId: 'missing' }, { ...good, reason: 'override' }];
  for (const dep of bad) expect(() => core.reviseWorkItem(f.handle, { ref: wa.ref, expectedRevision: 1,
    definition, dependencies: [dep as core.DependencyInput] })).toThrow();
  expect(() => core.reviseWorkItem(f.handle, { ref: wa.ref, expectedRevision: 1, definition, dependencies: [good,good] })).toThrow(/duplicate/);
  expect(core.workItem(f.handle, wa.ref).revision).toBe(1);
  expect(f.db.prepare('SELECT * FROM events').all()).toEqual(before);
});

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
it('rejects backend code for frontend without changing Git or SQL, while allowing an API contract', () => {
  const f = fixture(), frontendId = core.projectOf(f.db).primary_repo_id!;
  const backend = join(f.root,'backend'); mkdirSync(backend);
  const git = (...args: string[]) => execFileSync('git',args,{cwd:backend,encoding:'utf8',stdio:'pipe'}).trim();
  git('init'); git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','seed');
  const backendId = core.addRepository(f.db,f.dbPath,f.home,{cwd:backend,purpose:'backend',access:'context_only'},{type:'user'}).repository.repo_id;
  const a = f.task('frontend'), b = f.task('backend');
  const codeDefinition: core.WorkItemDefinition = { ...definition, repoId: backendId,
    outputs: [{ key:'api',kind:'code',required:true,version:'v1',checkRefs:[] }] };
  const producer = core.createWorkItem(f.handle,{task:f.ref(b.id),definition:codeDefinition,dependencies:[]});
  const consumer = core.createWorkItem(f.handle,{task:f.ref(a.id),definition:{...definition,repoId:frontendId},dependencies:[]});
  const before = [f.git('rev-parse','HEAD'), f.git('for-each-ref'), f.db.prepare('SELECT * FROM events').all()];
  const dep: core.DependencyInput = { ...edge(producer), binding:{kind:'code',repoId:backendId,version:'v1',baseHead:git('rev-parse','HEAD')} };
  expect(() => core.reviseWorkItem(f.handle,{ref:consumer.ref,expectedRevision:1,definition:consumer.definition,dependencies:[dep]})).toThrow(/repository/);
  expect([f.git('rev-parse','HEAD'), f.git('for-each-ref'), f.db.prepare('SELECT * FROM events').all()]).toEqual(before);
  const same = core.createWorkItem(f.handle,{task:f.ref(b.id),definition:codeDefinition,dependencies:[dep]});
  expect(same.dependencies).toHaveLength(1);
  const api = core.createWorkItem(f.handle,{task:f.ref(b.id),definition:{...definition,repoId:backendId},dependencies:[]});
  expect(core.reviseWorkItem(f.handle,{ref:consumer.ref,expectedRevision:1,definition:consumer.definition,
    dependencies:[{...edge(api),binding:{kind:'contract',repoId:backendId,version:'v1'}}]}).dependencies).toHaveLength(1);
  expect([f.git('rev-parse','HEAD'), f.git('for-each-ref')]).toEqual(before.slice(0,2));
});
