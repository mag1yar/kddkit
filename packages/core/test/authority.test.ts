import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, linkSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as core from '../src/index.js';
import * as authority from '../src/authority.js';
import { fixtureHash } from './memory_fixture.js';
import { roleFixture } from './role_fixture.js';

// Native execution has its own real-tool gate. These DB tests isolate issuance/fencing.
const proved = vi.hoisted(() => new WeakSet<object>());
vi.mock('../src/codex_permissions.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/codex_permissions.js')>();
  return { ...actual, assertVerifiedCodexPackage(packet: object) {
    if (!proved.has(packet)) throw new core.KddError('unverified native package');
  } };
});
let root: string, home: string, source: string, workspace: string, backend: string, dbPath: string;
let db: Database.Database;
let roleWrite: core.RoleRef, roleRead: core.RoleRef;
let saved: NodeJS.ProcessEnv;
const connections: Database.Database[] = [];
const user = { type: 'user' } as const;
const git = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
beforeEach(() => {
  saved = { ...process.env };
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kdd-authority-'))); home = join(root, 'home');
  process.env.KDD_HOME = home; delete process.env.KDD_DB; delete process.env.KDD_DECISIONS_DIR;
  source = join(root, 'source'); workspace = join(root, 'workspace'); backend = join(root, 'backend'); mkdirSync(join(root, 'scratch'));
  for (const path of [source, backend]) {
    mkdirSync(path); git(path, 'init', '-q');
    git(path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture');
  }
  git(root, 'clone', '--no-hardlinks', '-q', source, workspace);
  const resolved = core.resolveDbPath(source); dbPath = resolved.dbPath;
  db = core.openDb(dbPath, resolved.projectPath, source); connections.push(db);
  core.bindRepository(db, dbPath, home, { cwd: workspace, repoId: core.projectOf(db).primary_repo_id!, kind: 'managed' }, user);
  roleWrite = roleFixture(core.openController(db), 'workspace-write');
  roleRead = roleFixture(core.openController(db), 'read');
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const connection of connections.splice(0)) if (connection.open) connection.close();
  process.env = saved; rmSync(root, { recursive: true, force: true });
});
function native(cwd = workspace, writable = true, readableRoots = [cwd], model = 'gpt-6-sol', effort = 'high',
  brokerTools: readonly core.RunOperation[] = ['get_context', 'submit_report', 'request_question']): core.VerifiedCodexPackage {
  const packet = Object.freeze({ executable: '/fixture/codex', version: 'codex-cli 0.159.0', model, effort, contextWindow: 258400, cwd,
    brokerConfigPath: join(home, 'broker.json'), brokerTools: Object.freeze([...brokerTools]),
    controlDir: home, readableRoots: Object.freeze(readableRoots), writableRoot: writable ? cwd : undefined,
    scratchDir: join(root, 'scratch'), protectedPaths: Object.freeze([home]), argv: Object.freeze([]),
    env: Object.freeze({}), configHash: 'a'.repeat(64), results: Object.freeze([]) });
  proved.add(packet); return packet;
}
function issueInput(taskId: number) {
  return { taskId, workItemId: 'w1', runId: 'r1', expectedGeneration: 0, expiresAt: core.now() + 60,
    operations: ['get_context', 'submit_report', 'request_question'] as const,
    repositories: [{ repoId: core.projectOf(db).primary_repo_id!, checkoutPath: workspace, write: true }], native: native(), role: roleWrite };
}
function memoryInput(taskId: number | null, title = 'memory'): core.MemoryWriteInput {
  return { commandId: `memory:${title}`, entryId: null, expectedRevision: 0,
    scope: { projectId: core.projectOf(db).project_id, taskId }, applicability: { repoId: null, commit: null },
    kind: 'candidate', status: 'active', title, body: `${title} policy`,
    source: { kind: 'host', ref: 'fixture:proposal' }, author: { type: 'ai', id: 'host' } };
}
const memoryRows = () => ['memory_entries','memory_revisions'].map(table => db.prepare(`SELECT * FROM ${table}`).all());
function runProposal(taskId: number, issued: core.IssuedRunAuthority, reportEventId: number): core.MemoryWriteInput {
  return { ...memoryInput(taskId), source: { kind: 'run', task: { projectId: core.projectOf(db).project_id, taskId },
    authority: { authorityId: issued.authorityId, workItemId: 'w1', runId: 'r1', generation: issued.generation }, reportEventId },
    author: { type: 'ai', id: 'r1' } };
}
it('refuses an unprofiled managed run before writing a marker, grant or audit event', () => {
  const task = core.addTask(db, { title: 'requires role' }, user), handle = core.openController(db);
  const { role: _role, ...unprofiled } = issueInput(task.id);
  const tables = ['managed_task_policy', 'run_authorities', 'run_input_snapshots', 'events'];
  const before = tables.map(table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get());
  expect(() => core.issueRunAuthority(handle, unprofiled as unknown as core.IssueRunInput)).toThrow(/role/i);
  expect(tables.map(table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get())).toEqual(before);
});
it('pins the exact role, skill manifest, model and grants in a private v2 run snapshot', () => {
  const task = core.addTask(db, { title: 'pinned role' }, user), handle = core.openController(db);
  const skillRoot = join(root, 'skill-source'), guide = join(skillRoot, 'guide');
  mkdirSync(guide, { recursive: true }); writeFileSync(join(guide, 'SKILL.md'), '# Pinned body\n');
  const role = core.saveRoleRevision(handle, { expectedRevision: 0, commandId: 'pinned-role', definition: {
    name: 'Skilled', prompt: 'Follow the role.', runtime: 'codex', model: 'gpt-6-sol', effort: 'high',
    access: 'workspace-write', operations: ['get_context', 'submit_report', 'request_question', 'read_skill_file'],
    skills: [{ name: 'Guide', mode: 'Always', description: 'Pinned guide', source: { kind: 'local', root: skillRoot, path: 'guide' } }],
  } });
  const issued = core.issueRunAuthority(handle, { ...issueInput(task.id), role,
    operations: ['get_context', 'submit_report', 'request_question', 'read_skill_file'],
    native: native(workspace, true, [workspace], 'gpt-6-sol', 'high',
      ['get_context', 'submit_report', 'request_question', 'read_skill_file']) });
  const snapshot = core.runInputSnapshot(handle, { projectId: core.projectOf(db).project_id, authorityId: issued.authorityId });
  expect(snapshot.response.inputs).toMatchObject({ schemaVersion: 2, role: {
    roleId: role.roleId, revision: 1, hash: role.hash, manifestHash: role.manifestHash,
    model: 'gpt-6-sol', effort: 'high', operations: ['get_context', 'submit_report', 'request_question', 'read_skill_file'],
    nativeConfigHash: 'a'.repeat(64), skills: [{ name: 'Guide', mode: 'Always', manifestHash: expect.any(String) }],
  } });
  expect(JSON.stringify(snapshot)).not.toContain(skillRoot);
  expect(JSON.stringify(snapshot)).not.toContain('# Pinned body');
  const grant = JSON.parse((db.prepare('SELECT grant_json FROM run_authorities WHERE authority_id=?')
    .get(issued.authorityId) as { grant_json: string }).grant_json);
  expect(grant.role).toEqual({ roleId: role.roleId, revision: 1 });
});
it('rejects incompatible role, model, effort, access and operations before any run writes', () => {
  const task = core.addTask(db, { title: 'profile gate' }, user), handle = core.openController(db);
  const base = issueInput(task.id), limited = roleFixture(handle, 'workspace-write', ['get_context']);
  const emptySkills = roleFixture(handle, 'workspace-write', ['get_context', 'read_skill_file']);
  const revoked = roleFixture(handle); core.revokeRole(handle, revoked.roleId);
  const attempts: core.IssueRunInput[] = [
    { ...base, role: { roleId: '0'.repeat(32), revision: 1 } },
    { ...base, role: { ...roleWrite, externalMcp: 'foreign' } as never },
    { ...base, native: native(workspace, true, [workspace], 'other-model') },
    { ...base, native: native(workspace, true, [workspace], 'gpt-6-sol', 'low') },
    { ...base, role: roleRead },
    { ...base, role: revoked },
    { ...base, role: limited },
    { ...base, role: emptySkills, operations: ['get_context', 'read_skill_file'] },
    { ...base, operations: ['foreign_tool'] as never },
  ];
  const tables = ['managed_task_policy', 'run_authorities', 'run_input_snapshots', 'events'];
  const before = tables.map(table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get());
  for (const input of attempts) expect(() => core.issueRunAuthority(handle, input)).toThrow();
  expect(tables.map(table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get())).toEqual(before);
});
it('rejects an unbound or mismatched broker without rotating a live grant', () => {
  const task = core.addTask(db, { title: 'broker gate' }, user), handle = core.openController(db);
  const input = issueInput(task.id), first = core.issueRunAuthority(handle, input);
  const unbound = Object.freeze({ ...input.native, brokerConfigPath: undefined, brokerTools: [] as core.RunOperation[] });
  const mismatched = Object.freeze({ ...input.native, brokerTools: ['get_context'] as core.RunOperation[] });
  proved.add(unbound); proved.add(mismatched);
  const tables = ['managed_task_policy', 'run_authorities', 'run_input_snapshots', 'events'];
  const before = tables.map(table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get());
  for (const packet of [unbound, mismatched]) {
    expect(() => core.issueRunAuthority(handle, { ...input, expectedGeneration: 1, runId: 'r2', native: packet }))
      .toThrow(/broker/);
  }
  expect(tables.map(table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get())).toEqual(before);
  expect(core.readRunContext(core.openRunContext(db, first.token)).runId).toBe('r1');
});
it('requires file access for an Always-only skill before writing a grant', () => {
  const task = core.addTask(db, { title: 'Always skill' }, user), handle = core.openController(db);
  const root = join(workspace, 'always-skill'); mkdirSync(root);
  writeFileSync(join(root, 'SKILL.md'), '# Always\n');
  const role = core.saveRoleRevision(handle, { expectedRevision: 0, commandId: 'always-only', definition: {
    name: 'Always reader', prompt: 'Read the guide.', runtime: 'codex', model: 'gpt-6-sol', effort: 'high',
    access: 'workspace-write', operations: ['get_context', 'read_skill_file'],
    skills: [{ name: 'AlwaysGuide', mode: 'Always', description: 'Pinned guide',
      source: { kind: 'local', root: workspace, path: 'always-skill' } }],
  } });
  const input = issueInput(task.id);
  const noRead = native(workspace, true, [workspace], 'gpt-6-sol', 'high', ['get_context']);
  const before = db.prepare('SELECT COUNT(*) AS n FROM run_authorities').get();
  expect(() => core.issueRunAuthority(handle, { ...input, role, operations: ['get_context'], native: noRead }))
    .toThrow(/read operation/);
  expect(db.prepare('SELECT COUNT(*) AS n FROM run_authorities').get()).toEqual(before);
});
it('reads only pinned skill bytes in bounded chunks and fences revoked access', () => {
  const task = core.addTask(db, { title: 'skill read' }, user), handle = core.openController(db);
  const skillRoot = join(root, 'skill-library'), folder = join(skillRoot, 'guide');
  for (const name of ['', 'references', 'scripts', 'assets']) mkdirSync(join(folder, name), { recursive: true });
  writeFileSync(join(folder, 'SKILL.md'), '# Pinned guide\n');
  writeFileSync(join(folder, 'references', 'detail.md'), 'reference body');
  writeFileSync(join(folder, 'scripts', 'check.sh'), 'echo pinned\n');
  const asset = Buffer.alloc(40000, 7); writeFileSync(join(folder, 'assets', 'icon.bin'), asset);
  const operations = ['get_context', 'read_skill_file'] as never;
  const role = core.saveRoleRevision(handle, { expectedRevision: 0, commandId: 'skill-read-role', definition: {
    name: 'Reader', prompt: 'Read the selected skill.', runtime: 'codex', model: 'gpt-6-sol', effort: 'high',
    access: 'workspace-write', operations,
    skills: [{ name: 'Guide', mode: 'Available', description: 'Pinned guide', source: { kind: 'local', root: skillRoot, path: 'guide' } }],
  } });
  const issued = core.issueRunAuthority(handle, { ...issueInput(task.id), role, operations,
    native: native(workspace, true, [workspace], 'gpt-6-sol', 'high', operations) });
  const context = core.openRunContext(db, issued.token);
  const read = (path: string, offset = 0) => core.readSkillFile(context, { skill: 'Guide', path, offset });
  expect(Buffer.from(read('SKILL.md').contentBase64, 'base64').toString()).toBe('# Pinned guide\n');
  expect(Buffer.from(read('references/detail.md').contentBase64, 'base64').toString()).toBe('reference body');
  expect(Buffer.from(read('scripts/check.sh').contentBase64, 'base64').toString()).toBe('echo pinned\n');
  const first = read('assets/icon.bin'), second = read('assets/icon.bin', 32768);
  expect(first.length).toBe(32768); expect(second.length).toBe(7232);
  const joined = Buffer.concat([Buffer.from(first.contentBase64, 'base64'), Buffer.from(second.contentBase64, 'base64')]);
  expect(joined).toEqual(asset);
  expect(first.sha256).toBe(createHash('sha256').update(asset).digest('hex'));
  for (const input of [
    { skill: 'Guide', path: '../SKILL.md', offset: 0 }, { skill: 'Foreign', path: 'SKILL.md', offset: 0 },
    { skill: 'Guide', path: 'assets/icon.bin', offset: -1 }, { skill: 'Guide', path: 'assets/icon.bin', offset: 40000 },
  ]) expect(() => core.readSkillFile(context, input)).toThrow();
  core.revokeRunAuthority(handle, issued.authorityId);
  expect(() => read('SKILL.md')).toThrow();
});
it('derives inherited memory scope from the grant and preserves the context response and operations', () => {
  const handle = core.openController(db), parent = core.addTask(db,{title:'parent'},user);
  const ref = { projectId: core.projectOf(db).project_id, taskId: parent.id };
  const children = core.createSubtasks(handle,{parent:ref,expectedParentHash:core.taskContractHash(handle,ref),
    source:{kind:'manual',sourceTask:ref,instructionRef:'owner'},children:[{key:'a',title:'a',criteria:['ready']},{key:'b',title:'b',criteria:['ready']}]});
  const own = core.writeMemory(handle,memoryInput(children.a.id,'own'));
  const sibling = core.writeMemory(handle,memoryInput(children.b.id,'sibling'));
  core.writeMemory(handle,memoryInput(parent.id,'parent'));
  core.writeMemory(handle,memoryInput(null,'project'));
  const input = {...issueInput(children.a.id),operations:['get_context'] as const,
    native: native(workspace, true, [workspace], 'gpt-6-sol', 'high', ['get_context'])};
  const context = core.openRunContext(db,core.issueRunAuthority(handle,input).token), snapshot = core.readRunContext(context);
  expect(core.readRunMemory(context)).toEqual([]);
  expect(core.readRunMemory(context,{candidates:true}).map(row=>row.title).sort()).toEqual(['own','parent','project']);
  expect(core.readRunMemory(context,{entryId:own.entryId,revision:1,candidates:true})[0]).toMatchObject({kind:'candidate',effectiveStatus:'active'});
  expect(core.recallRunMemory(context,'policy',{candidates:true,k:1})).toHaveLength(1);
  expect(core.runMemoryRules(context)).toEqual([]);
  expect(core.readRunContext(context)).toEqual(snapshot);
  expect(core.runOperations(context)).toEqual(['get_context']);
  const before = memoryRows(), events = db.prepare('SELECT * FROM events').all();
  for(const bad of [{entryId:sibling.entryId,candidates:true},{revision:1},{projectId:ref.projectId},{taskId:children.b.id},
    {repositories:[]},{entryId:own.entryId,revision:null},{candidates:null}]) {
    expect(()=>core.readRunMemory(context,bad as core.RunMemoryReadInput)).toThrow();
  }
  for(const fake of [{kind:'run'},{...context},JSON.parse(JSON.stringify(context))]) {
    expect(()=>core.readRunMemory(fake)).toThrow(/authority/);
    expect(()=>core.recallRunMemory(fake,'policy')).toThrow(/authority/);
    expect(()=>core.runMemoryRules(fake)).toThrow(/authority/);
  }
  expect(memoryRows()).toEqual(before); expect(db.prepare('SELECT * FROM events').all()).toEqual(events);
  expect('assertRunMemorySource' in core).toBe(false);
});
it('binds run memory to the actual checkout HEAD and returns all active rules',()=>{
  const handle=core.openController(db), task=core.addTask(db,{title:'scope'},user), projectId=core.projectOf(db).project_id;
  const repoId=core.projectOf(db).primary_repo_id!, head=git(workspace,'rev-parse','HEAD');
  const versioned={...memoryInput(task.id,'versioned'),applicability:{repoId,commit:head}};
  const entry=core.writeMemory(handle,versioned);
  for(let i=0;i<12;i++) {
    const rule:core.MemoryWriteInput={...memoryInput(null,`rule-${i}`),kind:'rule'};
    const request:core.MemoryEvidenceRequest={operation:'create',entryId:null,expectedRevision:0,origin:'user',
      scope:rule.scope,applicability:rule.applicability,payloadHash:fixtureHash(rule),source:rule.source};
    const observed:core.MemoryEvidenceObservation={request,origin:'user',verdict:'pass',observedAt:core.now(),expiresAt:null};
    core.writeMemory(handle,rule,{observe:incoming=>JSON.stringify(incoming)===JSON.stringify(request)?observed:null});
  }
  const context=core.openRunContext(db,core.issueRunAuthority(handle,issueInput(task.id)).token);
  expect(core.readRunMemory(context,{entryId:entry.entryId,candidates:true})[0].applicability.commit).toBe(head);
  expect(core.runMemoryRules(context)).toHaveLength(12);
  expect(core.recallRunMemory(context,'policy',{k:1})).toHaveLength(1);
  git(workspace,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','next');
  expect(core.readRunMemory(context,{entryId:entry.entryId,candidates:true})[0].applicability.commit).toBe(head);
  expect(core.runMemoryRules(context)).toHaveLength(12);
});
it.each(['revoke','expire','rotate','no context','scratch alias'] as const)('rechecks initialized run memory after %s',change=>{
  const task=core.addTask(db,{title:'scope'},user),handle=core.openController(db),input=issueInput(task.id);
  const issued=core.issueRunAuthority(handle,input),context=core.openRunContext(db,issued.token);
  const proposed=runProposal(task.id,issued,core.submitRunReport(context,'candidate'));
  core.writeMemory(handle,proposed);
  expect(core.readRunMemory(context,{candidates:true})).toHaveLength(1);
  if(change==='revoke')core.revokeRunAuthority(handle,issued.authorityId);
  if(change==='expire')db.prepare('UPDATE run_authorities SET expires_at=1 WHERE authority_id=?').run(issued.authorityId);
  if(change==='rotate')core.issueRunAuthority(handle,{...input,expectedGeneration:1,runId:'r2'});
  if(change==='no context')db.prepare("UPDATE run_authorities SET grant_json=json_set(grant_json,'$.operations',json('[\"submit_report\"]')) WHERE authority_id=?").run(issued.authorityId);
  if(change==='scratch alias'){rmSync(join(root,'scratch'),{recursive:true});symlinkSync(home,join(root,'scratch'));}
  const before=memoryRows(),events=db.prepare('SELECT * FROM events').all();
  for(const call of [()=>core.readRunMemory(context,{candidates:true}),()=>core.recallRunMemory(context,'policy'),()=>core.runMemoryRules(context)])expect(call).toThrow(/authority/);
  if(change!=='no context')expect(()=>core.writeMemory(handle,proposed)).toThrow(/authority/);
  expect(memoryRows()).toEqual(before);expect(db.prepare('SELECT * FROM events').all()).toEqual(events);
});
it('permits only current own candidate provenance from an actual submit_report event',()=>{
  const task=core.addTask(db,{title:'own'},user), other=core.addTask(db,{title:'other'},user), handle=core.openController(db);
  const issued=core.issueRunAuthority(handle,issueInput(task.id)),context=core.openRunContext(db,issued.token);
  const report=core.submitRunReport(context,'candidate'),question=core.requestRunQuestion(context,'question');
  const otherIssued=core.issueRunAuthority(handle,{...issueInput(other.id),runId:'other'});
  const otherReport=core.submitRunReport(core.openRunContext(db,otherIssued.token),'other');
  const proposed=runProposal(task.id,issued,report),stored=core.writeMemory(handle,proposed);
  const backendId=core.addRepository(db,dbPath,home,{cwd:backend,purpose:'backend',access:'context_only'},user).repository.repo_id;
  expect(core.writeMemory(handle,proposed)).toMatchObject({entryId:stored.entryId,created:false});
  const source=proposed.source as Extract<core.MemorySource,{kind:'run'}>;
  const bad:core.MemoryWriteInput[]=[
    {...proposed,scope:{...proposed.scope,taskId:null}}, {...proposed,scope:{...proposed.scope,taskId:other.id}},
    {...proposed,kind:'rule'}, {...proposed,kind:'fact'}, {...proposed,author:{type:'ai',id:'other'}},
    {...proposed,author:{type:'user',id:'r1'}}, {...proposed,source:{...source,reportEventId:question}},
    {...proposed,source:{...source,reportEventId:otherReport}}, {...proposed,source:{...source,reportEventId:0}},
    {...proposed,source:{...source,authority:{...source.authority,generation:2}}},
    {...proposed,source:{...source,authority:{...source.authority,runId:'other'}}},
    {...proposed,applicability:{repoId:backendId,commit:git(backend,'rev-parse','HEAD')}},
  ];
  const before=memoryRows(),events=db.prepare('SELECT * FROM events').all();
  for(const [i,input] of bad.entries())expect(()=>core.writeMemory(handle,{...input,commandId:`bad-${i}`})).toThrow();
  db.prepare("UPDATE run_authorities SET grant_json=json_set(grant_json,'$.operations',json('[\"get_context\"]')) WHERE authority_id=?").run(issued.authorityId);
  expect(()=>core.writeMemory(handle,proposed)).toThrow(/authority/);
  expect(memoryRows()).toEqual(before);expect(db.prepare('SELECT * FROM events').all()).toEqual(events);
});
it('protects a task only through an authentic connection-bound handle, without a legacy claim', () => {
  const task = core.addTask(db, { title: 'protected' }, user);
  const handle = authority.openController(db);
  const before = core.mustGetTask(db, task.id);
  for (const fake of [{ kind: 'controller' }, { ...handle }, JSON.parse(JSON.stringify(handle))]) {
    expect(() => authority.protectTask(fake as authority.ControllerHandle, task.id)).toThrow(/authority/);
  }
  authority.protectTask(handle, task.id);
  expect(core.mustGetTask(db, task.id)).toEqual(before);
  expect(() => authority.assertLegacyTaskMutation(db, [task.id])).toThrow(/managed/);
  authority.protectTask(handle, task.id);
  expect(db.prepare('SELECT COUNT(*) n FROM managed_task_policy').get()).toEqual({ n: 1 });
  const claimed = core.addTask(db, { title: 'old writer', criteria: ['ready'] }, user);
  db.prepare("UPDATE tasks SET status='in_progress',claimed_by='legacy' WHERE id=?").run(claimed.id);
  expect(() => authority.protectTask(handle, claimed.id)).toThrow(/claimed|writer/);
  expect(() => authority.issueRunAuthority(handle, issueInput(claimed.id))).toThrow(/claimed|writer/);
});
it('fences two connections, revokes the previous credential and retains the managed marker', () => {
  const task = core.addTask(db, { title: 'scoped' }, user);
  const handle = authority.openController(db), input = issueInput(task.id);
  const second = core.openDb(dbPath, core.canonicalCommonDir(source), source); connections.push(second);
  const other = authority.openController(second);
  const first = authority.issueRunAuthority(handle, input);
  expect(first.token).toMatch(/^[0-9a-f]{64}$/);
  const context = authority.openRunContext(second, first.token);
  expect(JSON.stringify(context)).not.toContain(first.token);
  expect(() => authority.issueRunAuthority(other, input)).toThrow(/generation|fence/);
  const next = authority.issueRunAuthority(other, { ...input, runId: 'r2', expectedGeneration: 1 });
  expect(next.generation).toBe(2);
  expect(() => authority.openRunContext(db, first.token)).toThrow(/authority/);
  authority.openRunContext(db, next.token);
  authority.revokeRunAuthority(handle, next.authorityId);
  expect(() => authority.openRunContext(second, next.token)).toThrow(/authority/);
  expect(() => authority.assertLegacyTaskMutation(db, [task.id])).toThrow(/managed/);
  const audit = JSON.stringify(db.prepare('SELECT detail FROM events').all());
  const hash = (db.prepare('SELECT token_hash FROM run_authorities WHERE authority_id=?').get(first.authorityId) as { token_hash: string }).token_hash;
  expect(audit).not.toContain(first.token); expect(audit).not.toContain(hash);
  expect(core.mustGetTask(db, task.id).status).toBe('new');
});
it('rejects expired/foreign credentials and malformed grants atomically', () => {
  const task = core.addTask(db, { title: 'scoped' }, user), handle = authority.openController(db), input = issueInput(task.id);
  const before = db.prepare('SELECT * FROM events').all();
  const invalid = [
    { ...input, operations: ['update_task'] }, { ...input, operations: ['get_context', 'get_context'] },
    { ...input, workItemId: '' }, { ...input, expiresAt: Infinity }, { ...input, expiresAt: core.now() },
    { ...input, expectedGeneration: 0.5 }, { ...input, native: { ...input.native } },
  ];
  for (const candidate of invalid) expect(() => authority.issueRunAuthority(handle, candidate as authority.IssueRunInput)).toThrow();
  expect(db.prepare('SELECT * FROM events').all()).toEqual(before);
  expect(db.prepare('SELECT COUNT(*) n FROM run_authorities').get()).toEqual({ n: 0 });
  expect(db.prepare('SELECT COUNT(*) n FROM managed_task_policy').get()).toEqual({ n: 0 });
  const issued = authority.issueRunAuthority(handle, input);
  const foreign = core.openDb(':memory:'); connections.push(foreign);
  expect(() => authority.openRunContext(foreign, issued.token)).toThrow(/authority/);
  vi.spyOn(Date, 'now').mockReturnValue((input.expiresAt + 1) * 1000);
  expect(() => authority.openRunContext(db, issued.token)).toThrow(/authority/);
});
it('permits context-only reads but refuses source/sibling writes and unmatched native roots', () => {
  const task = core.addTask(db, { title: 'scoped' }, user), handle = authority.openController(db), input = issueInput(task.id);
  const added = core.addRepository(db, dbPath, home, { cwd: backend, purpose: 'backend', access: 'context_only' }, user);
  const readonly = { ...input, role: roleRead, repositories: [{ repoId: added.repository.repo_id, checkoutPath: backend, write: false }], native: native(backend, false) };
  authority.issueRunAuthority(handle, readonly);
  expect(() => authority.issueRunAuthority(handle, { ...readonly, expectedGeneration: 1,
    role: roleWrite, repositories: [{ ...readonly.repositories[0], write: true }], native: native(backend) })).toThrow(/scope|repository|write/);
  expect(() => authority.issueRunAuthority(handle, { ...input, expectedGeneration: 1,
    repositories: [{ ...input.repositories[0], checkoutPath: source }], native: native(source) })).toThrow(/scope|repository|write/);
  expect(() => authority.issueRunAuthority(handle, { ...input, expectedGeneration: 1, native: native(backend) })).toThrow(/scope|repository/);
});
it('rechecks every run operation and keeps reports/questions as attributed untrusted events', () => {
  const task = core.addTask(db, { title: 'own', body: 'context', criteria: ['proof'] }, user);
  const other = core.addTask(db, { title: 'foreign' }, user);
  core.linkTasks(db, task.id, other.id, 'depends', user);
  db.prepare("INSERT INTO decisions(slug,title,path,content_hash,source_tasks) VALUES('own','Stored','never-read','hash',?)").run(JSON.stringify([task.id]));
  const backendRepo = core.addRepository(db, dbPath, home, { cwd: backend, purpose: 'backend', access: 'context_only' }, user).repository.repo_id;
  const input = { ...issueInput(task.id), native: native(workspace, true, [workspace, backend]),
    repositories: [...issueInput(task.id).repositories, { repoId: backendRepo, checkoutPath: backend, write: false }] };
  const controller = authority.openController(db);
  const issued = authority.issueRunAuthority(controller, input), context = authority.openRunContext(db, issued.token);
  const before = ['tasks', 'criteria', 'comments', 'decisions'].map(table => db.prepare(`SELECT * FROM ${table}`).all());
  const snapshot = authority.readRunContext(context);
  expect(snapshot).toMatchObject({ taskId: task.id, runId: 'r1', generation: 1, task: { title: 'own', body: 'context' }, decisions: [{ slug: 'own', title: 'Stored' }] });
  expect(JSON.stringify(snapshot)).not.toContain('foreign'); expect(JSON.stringify(snapshot)).not.toContain('never-read');
  const decisionsDir = join(backend, '.planning', 'decisions'); mkdirSync(decisionsDir, { recursive: true });
  expect(authority.readRunContext(context)).toEqual(snapshot);
  writeFileSync(join(decisionsDir, 'own.md'), '# Conflicting backend decision');
  expect(authority.readRunContext(context)).toEqual(snapshot);
  const hash = (db.prepare('SELECT token_hash FROM run_authorities WHERE authority_id=?').get(issued.authorityId) as { token_hash: string }).token_hash;
  const reportId = authority.submitRunReport(context, `result ${issued.token} ${hash}`);
  const questionId = authority.requestRunQuestion(context, 'which env?');
  const event = db.prepare('SELECT * FROM events WHERE id=?').get(reportId) as { actor_type: string; actor_id: string; action: string; detail: string };
  expect(event).toMatchObject({ actor_type: 'ai', actor_id: 'r1', action: 'run_report' });
  expect(JSON.parse(event.detail)).toMatchObject({ work_item_id: 'w1', run_id: 'r1', generation: 1, untrusted: true });
  expect(event.detail).not.toContain(issued.token); expect(event.detail).not.toContain(hash);
  expect(db.prepare('SELECT action FROM events WHERE id=?').get(questionId)).toEqual({ action: 'run_question' });
  for (const body of ['', ' '.repeat(4), 'x'.repeat(core.CAPS.agentFieldChars + 1)]) expect(() => authority.submitRunReport(context, body)).toThrow();
  for (const fake of [{ kind: 'run' }, { ...context }]) expect(() => authority.readRunContext(fake as authority.RunContext)).toThrow(/authority/);
  expect(['tasks', 'criteria', 'comments', 'decisions'].map(table => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
  const next = authority.issueRunAuthority(controller, { ...input, expectedGeneration: 1, runId: 'r2',
    operations: ['get_context'], native: native(workspace, true, [workspace, backend], 'gpt-6-sol', 'high', ['get_context']) });
  for (const call of [() => authority.runOperations(context), () => authority.readRunContext(context), () => authority.submitRunReport(context, 'late')]) expect(call).toThrow(/authority/);
  const readOnly = authority.openRunContext(db, next.token);
  expect(authority.runOperations(readOnly)).toEqual(['get_context']);
  expect(() => authority.requestRunQuestion(readOnly, 'hidden')).toThrow(/authority/);
  vi.spyOn(Date, 'now').mockReturnValue((input.expiresAt + 1) * 1000);
  expect(() => authority.readRunContext(readOnly)).toThrow(/authority/);
  vi.restoreAllMocks();
  authority.revokeRunAuthority(controller, next.authorityId);
  expect(() => authority.readRunContext(readOnly)).toThrow(/authority/);
});
it('preserves all v13 rows and a WAL-aware backup, without implicitly managing legacy tasks', () => {
  const path = join(root, 'v13.db'), raw = new Database(path);
  raw.pragma('journal_mode=WAL');
  for (const migration of core.MIGRATIONS.slice(0, 13)) raw.exec(migration);
  raw.pragma('user_version=13');
  raw.exec("INSERT INTO tasks(id,title,created_at,updated_at) VALUES(77,'preserved',1,1); INSERT INTO criteria(id,task_id,text,created_at) VALUES(78,77,'criterion',1); INSERT INTO comments(id,task_id,author,body,created_at) VALUES(79,77,'user','comment',1); INSERT INTO events(id,task_id,actor_type,action,created_at) VALUES(80,77,'user','created',1); INSERT INTO decisions(slug,title,path,content_hash,source_tasks) VALUES('d','Decision','fixture','hash','[77]'); INSERT INTO search_index(kind,ref,title,body) VALUES('decision','d','Decision','body');");
  const tables = ['tasks', 'criteria', 'comments', 'events', 'decisions', 'search_index', 'project'];
  const before = Object.fromEntries(tables.map(table => [table, raw.prepare(`SELECT * FROM ${table}`).all()]));
  const upgraded = core.openDb(path); connections.push(upgraded);
  expect(upgraded.pragma('user_version', { simple: true })).toBe(core.MIGRATIONS.length);
  for (const table of tables) {
    const rows = upgraded.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    expect(table === 'tasks' ? rows.map(({ parent_id, execution_mode, ...old }) => old) : rows).toEqual(before[table]);
  }
  expect(upgraded.prepare('SELECT COUNT(*) n FROM managed_task_policy').get()).toEqual({ n: 0 });
  expect(upgraded.prepare('SELECT COUNT(*) n FROM run_authorities').get()).toEqual({ n: 0 });
  const backup = new Database(`${path}.v13.bak`, { readonly: true });
  expect(backup.pragma('user_version', { simple: true })).toBe(13);
  for (const table of tables) expect(backup.prepare(`SELECT * FROM ${table}`).all()).toEqual(before[table]);
  backup.close(); raw.close();
});
it('refuses stores visible through repo/Git reads or hardlinked private DB files', () => {
  const task = core.addTask(db, { title: 'scoped' }, user), input = issueInput(task.id);
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    linkSync(path, join(backend, 'db-alias'));
    expect(() => authority.issueRunAuthority(authority.openController(db), input)).toThrow(/alias/);
    rmSync(join(backend, 'db-alias'));
  }
  const aliasPath = join(root, 'board-alias.db'); symlinkSync(dbPath, aliasPath);
  const aliased = new Database(aliasPath); connections.push(aliased);
  expect(() => authority.issueRunAuthority(authority.openController(aliased), input)).toThrow(/alias/);
  const issued = authority.issueRunAuthority(authority.openController(db), input);
  const before = db.prepare('SELECT * FROM events').all(), scratch = join(root, 'scratch');
  rmSync(scratch, { recursive: true }); symlinkSync(dirname(dbPath), scratch);
  expect(() => authority.openRunContext(db, issued.token)).toThrow(/authority/);
  expect(db.prepare('SELECT * FROM events').all()).toEqual(before);
  rmSync(scratch); mkdirSync(scratch);
  authority.openRunContext(db, issued.token);
  linkSync(dbPath, join(backend, 'db-alias'));
  expect(() => authority.openRunContext(db, issued.token)).toThrow(/authority/);
  rmSync(join(backend, 'db-alias'));
  const embedded = core.openDb(join(workspace, 'unsafe.db')); connections.push(embedded);
  for (const repo of core.repositoriesOf(db)) embedded.prepare('INSERT INTO repositories VALUES(@repo_id,@purpose,@access,@remote,@created_at)').run(repo);
  for (const binding of core.bindingsOf(db)) embedded.prepare('INSERT INTO repository_bindings VALUES(@common_dir,@repo_id,@checkout_path,@kind,@created_at)').run(binding);
  const own = core.addTask(embedded, { title: 'embedded store' }, user);
  const embeddedRole = roleFixture(authority.openController(embedded));
  expect(() => authority.issueRunAuthority(authority.openController(embedded), { ...input, taskId: own.id, role: embeddedRole })).toThrow(/store|scope/);
  expect(embedded.prepare('SELECT COUNT(*) n FROM run_authorities').get()).toEqual({ n: 0 });
});

it('refuses a persisted grant without its scratch scope on every later operation', () => {
  const task = core.addTask(db, { title: 'scope freshness' }, user);
  const issued = authority.issueRunAuthority(authority.openController(db), issueInput(task.id));
  const context = authority.openRunContext(db, issued.token);
  db.prepare("UPDATE run_authorities SET grant_json=json_remove(grant_json,'$.native.scratchDir') WHERE authority_id=?").run(issued.authorityId);
  const before = db.prepare('SELECT * FROM events').all();
  expect(() => authority.openRunContext(db, issued.token)).toThrow(/authority/);
  expect(() => authority.readRunContext(context)).toThrow(/authority/);
  expect(() => authority.submitRunReport(context, 'late')).toThrow(/authority/);
  expect(db.prepare('SELECT * FROM events').all()).toEqual(before);
});

it('binds subtask provenance to an actual current scoped report, never a question or worker JSON', () => {
  const parent = core.addTask(db, { title: 'BA parent', criteria: ['deliver'] }, user);
  const handle = core.openController(db), issued = core.issueRunAuthority(handle, issueInput(parent.id));
  const context = core.openRunContext(db, issued.token), report = core.submitRunReport(context, 'proposed children');
  const question = core.requestRunQuestion(context, 'question');
  const ref = { projectId: core.projectOf(db).project_id, taskId: parent.id };
  const input: core.CreateSubtasksInput = { parent: ref, expectedParentHash: core.taskContractHash(handle, ref),
    source: { kind: 'run', sourceTask: ref, authority: { authorityId: issued.authorityId,
      workItemId: 'w1', runId: 'r1', generation: 1 }, proposalEventId: report },
    children: [{ key: 'a', title: 'child', criteria: ['outcome'] }] };
  expect(core.createSubtasks(handle, input).a.parent_id).toBe(parent.id);
  const before = db.prepare('SELECT * FROM events').all();
  expect(() => core.createSubtasks(handle, { ...input, source: { ...input.source as Extract<core.CreationSource, {kind:'run'}>, proposalEventId: question } })).toThrow(/proposal/);
  expect(() => core.createSubtasks(context as unknown as core.ControllerHandle, input)).toThrow(/authority/);
  core.revokeRunAuthority(handle, issued.authorityId);
  const afterRevoke = db.prepare('SELECT * FROM events').all();
  expect(() => core.createSubtasks(handle, input)).toThrow(/authority/);
  expect(db.prepare('SELECT * FROM events').all()).toEqual(afterRevoke);
  expect(before).toHaveLength(afterRevoke.length - 1);
});

function modeledTask(repoId: string|null = core.projectOf(db).primary_repo_id, kind: core.WorkItemKind = 'implementation', write = true) {
  const task=core.addTask(db,{title:'modeled'},user), handle=core.openController(db);
  const item=core.createWorkItem(handle,{task:{projectId:core.projectOf(db).project_id,taskId:task.id},
    definition:{kind,repoId,sourceTasks:[],outputs:[]},dependencies:[]});
  const owner=core.reserveWorkItem(handle,{ref:item.ref,expectedRevision:1,expectedFence:0,expectedMode:'manual',ownerId:'host',write});
  return {task,handle,item,owner,input:{...issueInput(task.id),workItemId:item.ref.workItemId,ownership:owner.ref}};
}
it('refuses a run proposal after its modeled parent inputs become stale without creating children',()=>{
  const parent=core.addTask(db,{title:'main requirements',body:'original',criteria:['deliver']},user);
  const handle=core.openController(db),projectId=core.projectOf(db).project_id;
  const parentRef={projectId,taskId:parent.id};
  const child=core.createSubtasks(handle,{parent:parentRef,expectedParentHash:core.taskContractHash(handle,parentRef),
    source:{kind:'manual',sourceTask:parentRef,instructionRef:'owner:BA'},children:[{key:'ba',title:'BA',criteria:['proposal']}]}).ba;
  const childRef={projectId,taskId:child.id};
  const item=core.createWorkItem(handle,{task:childRef,definition:{kind:'analysis',repoId:null,sourceTasks:[],outputs:[]},dependencies:[]});
  const owner=core.reserveWorkItem(handle,{ref:item.ref,expectedRevision:1,expectedFence:0,expectedMode:'manual',ownerId:'BA',write:false});
  const input=issueInput(child.id);
  const issued=core.issueRunAuthority(handle,{...input,role:roleRead,workItemId:item.ref.workItemId,ownership:owner.ref,native:native(workspace,false),
    repositories:input.repositories.map(repo=>({...repo,write:false}))});
  const context=core.openRunContext(db,issued.token),report=core.submitRunReport(context,'proposed children');
  const proposal:core.CreateSubtasksInput={parent:parentRef,expectedParentHash:core.taskContractHash(handle,parentRef),
    source:{kind:'run',sourceTask:childRef,authority:{authorityId:issued.authorityId,workItemId:item.ref.workItemId,runId:'r1',generation:1},proposalEventId:report},
    children:[{key:'work',title:'implementation',criteria:['deliver']}]};
  expect(core.createSubtasks(handle,proposal).work.parent_id).toBe(parent.id);
  core.editTask(db,parent.id,{body:'changed requirements'},user);
  expect(core.inspectDependencies(handle,item.ref).inputsCurrent).toBe(false);
  expect(()=>core.readRunContext(context)).toThrow(/authority/);
  expect(()=>core.readRunMemory(context,{candidates:true})).toThrow(/authority/);
  expect(()=>core.recallRunMemory(context,'proposal')).toThrow(/authority/);
  expect(()=>core.runMemoryRules(context)).toThrow(/authority/);
  const freshParent={...proposal,expectedParentHash:core.taskContractHash(handle,parentRef)};
  const before={tasks:db.prepare('SELECT * FROM tasks').all(),events:db.prepare('SELECT * FROM events').all()};
  expect(()=>core.createSubtasks(handle,freshParent)).toThrow(/authority/);
  expect(()=>core.createSubtaskPlan(handle,{...freshParent,workItems:[],dependencies:[]})).toThrow(/authority/);
  expect({tasks:db.prepare('SELECT * FROM tasks').all(),events:db.prepare('SELECT * FROM events').all()}).toEqual(before);
});
it('requires modeled ownership and binds native writes to its definition repository and write access',()=>{
  const f=modeledTask();const {ownership,...without}=f.input;
  const before=db.prepare('SELECT * FROM events').all();
  expect(()=>core.issueRunAuthority(f.handle,without)).toThrow(/ownership/);
  for(const patch of [{fence:2},{ownerId:'other'},{revision:999},{projectId:'foreign'}]) {
    expect(()=>core.issueRunAuthority(f.handle,{...f.input,ownership:{...f.owner.ref,...patch}})).toThrow();
  }
  expect(db.prepare('SELECT * FROM events').all()).toEqual(before);
  const issued=core.issueRunAuthority(f.handle,f.input), context=core.openRunContext(db,issued.token);
  expect(core.readRunContext(context).workItemId).toBe(f.item.ref.workItemId);
  const nullRepo=modeledTask(null);
  expect(()=>core.issueRunAuthority(nullRepo.handle,nullRepo.input)).toThrow(/repository/);
  const readonly=modeledTask(core.projectOf(db).primary_repo_id,'analysis',false);
  expect(()=>core.issueRunAuthority(readonly.handle,readonly.input)).toThrow(/repository/);
  const packet={...readonly.input,role:roleRead,native:native(workspace,false),repositories:[{...readonly.input.repositories[0],write:false}]};
  const readGrant=core.issueRunAuthority(readonly.handle,packet);
  expect(core.readRunContext(core.openRunContext(db,readGrant.token)).taskId).toBe(readonly.task.id);
  db.prepare("UPDATE run_authorities SET grant_json=json_set(grant_json,'$.ownership.fence',2) WHERE authority_id=?").run(issued.authorityId);
  expect(()=>core.readRunContext(context)).toThrow(/authority/);
});
it('rotates credentials independently of owner fence and does not strand handoff on revoke or expiry',async()=>{
  const f=modeledTask();const first=core.issueRunAuthority(f.handle,f.input);
  const second=core.issueRunAuthority(f.handle,{...f.input,expectedGeneration:1,runId:'r2'});
  expect(second.generation).toBe(2);expect(core.ownership(f.handle,f.owner.ref).ref.fence).toBe(1);
  const binding={authorityId:second.authorityId,workItemId:f.item.ref.workItemId,runId:'r2',generation:2};
  core.recordLaunchIntent(f.handle,{owner:f.owner.ref,intent:{launchId:'launch',writerScopeId:'writers',authority:binding}});
  const transfer=core.beginHandoff(f.handle,{commandId:'transfer',task:f.item.task,expectedMode:'manual',targetMode:'manual',expectedOwners:[f.owner.ref]});
  const before=db.prepare('SELECT * FROM events').all();
  expect(()=>core.issueRunAuthority(f.handle,{...f.input,expectedGeneration:2})).toThrow(/handoff/);
  expect(db.prepare('SELECT * FROM events').all()).toEqual(before);
  core.revokeRunAuthority(f.handle,second.authorityId);
  db.prepare('UPDATE run_authorities SET expires_at=1 WHERE authority_id=?').run(first.authorityId);
  expect((await core.finishHandoff(f.handle,{handoffId:transfer.id})).status).toBe('held');
  expect(core.ownership(f.handle,f.owner.ref).releasedAt).toBeNull();
  const finished=await core.finishHandoff(f.handle,{handoffId:transfer.id},async owner=>({observationId:'host:full-stop',owner:owner.ref,
    launchId:owner.launchIntent!.launchId,writerScopeId:owner.launchIntent!.writerScopeId,observedAt:core.now(),verdict:'stopped',complete:true,writers:[{id:'writer',state:'gone'}]}));
  expect(finished.status).toBe('complete');expect(core.ownership(f.handle,f.owner.ref).releasedAt).not.toBeNull();
  expect(()=>core.openRunContext(db,second.token)).toThrow(/authority/);
});
it('atomically revokes still-live modeled credentials at never-started handoff and retains the marker',async()=>{
  const f=modeledTask(),issued=core.issueRunAuthority(f.handle,f.input), context=core.openRunContext(db,issued.token);
  const transfer=core.beginHandoff(f.handle,{commandId:'no launch',task:f.item.task,expectedMode:'manual',targetMode:'orchestrated',expectedOwners:[f.owner.ref]});
  expect(core.readRunContext(context).taskId).toBe(f.task.id);
  const finished=await core.finishHandoff(f.handle,{handoffId:transfer.id});
  expect(finished).toMatchObject({status:'complete',receipt:{revokedAuthorityIds:[issued.authorityId]}});
  expect(()=>core.readRunContext(context)).toThrow(/authority/);
  expect(()=>core.assertLegacyTaskMutation(db,[f.task.id])).toThrow(/managed/);
});

it.each(['live','revoked','expired'] as const)('holds handoff for an unmodeled %s credential even beside a known owner',async state=>{
  const f=modeledTask(), known=core.issueRunAuthority(f.handle,f.input);
  const issued=core.issueRunAuthority(f.handle,{...issueInput(f.task.id),workItemId:'external-work-id'});
  const context=core.openRunContext(db,issued.token);
  if(state==='revoked')core.revokeRunAuthority(f.handle,issued.authorityId);
  if(state==='expired')db.prepare('UPDATE run_authorities SET expires_at=1 WHERE authority_id=?').run(issued.authorityId);
  const transfer=core.beginHandoff(f.handle,{commandId:'unknown writer',task:f.item.task,
    expectedMode:'manual',targetMode:'orchestrated',expectedOwners:[f.owner.ref]});
  expect(transfer.authorities.map(a=>a.authorityId).sort()).toEqual([known.authorityId,issued.authorityId].sort());
  expect(await core.finishHandoff(f.handle,{handoffId:transfer.id})).toMatchObject({status:'held',reason:'unknown'});
  expect(core.mustGetTask(db,f.task.id).execution_mode).toBe('manual');
  expect(core.ownership(f.handle,f.owner.ref).releasedAt).toBeNull();
  expect(()=>core.reserveWorkItem(f.handle,{ref:f.item.ref,expectedRevision:1,expectedFence:1,expectedMode:'manual',ownerId:'next',write:true})).toThrow(/handoff/);
  if(state==='live')expect(core.readRunContext(context).taskId).toBe(f.task.id);
});

it('recognizes grants retired by a completed handoff when transferring the next owner',async()=>{
  const f=modeledTask(), first=core.issueRunAuthority(f.handle,f.input);
  const transfer=core.beginHandoff(f.handle,{commandId:'first owner',task:f.item.task,
    expectedMode:'manual',targetMode:'orchestrated',expectedOwners:[f.owner.ref]});
  expect((await core.finishHandoff(f.handle,{handoffId:transfer.id})).status).toBe('complete');
  const owner=core.reserveWorkItem(f.handle,{ref:f.item.ref,expectedRevision:1,expectedFence:1,expectedMode:'orchestrated',ownerId:'next',write:true});
  const second=core.issueRunAuthority(f.handle,{...f.input,ownership:owner.ref,expectedGeneration:1,runId:'next'});
  const next=core.beginHandoff(f.handle,{commandId:'next owner',task:f.item.task,
    expectedMode:'orchestrated',targetMode:'manual',expectedOwners:[owner.ref]});
  expect(next.authorities).toHaveLength(2);
  expect(await core.finishHandoff(f.handle,{handoffId:next.id})).toMatchObject({status:'complete',receipt:{revokedAuthorityIds:[second.authorityId]}});
  for(const grant of [first,second])expect(()=>core.openRunContext(db,grant.token)).toThrow(/authority/);
});

it.each(['invalidation','upstream invalidation','artifact change','producer requirements change'] as const)
('closes launch and saved BA proposals after pinned input %s without losing ownership',async change=>{
  const handle=core.openController(db), projectId=core.projectOf(db).project_id;
  const ref=(taskId:number)=>({projectId,taskId});
  const definition:core.WorkItemDefinition={kind:'architecture',repoId:null,sourceTasks:[],
    outputs:[{key:'api',kind:'contract',required:true,version:'v1',checkRefs:['check:api']}]};
  const upstreamTask=core.addTask(db,{title:'upstream API'},user), producerTask=core.addTask(db,{title:'derived API'},user);
  const artifact=join(root,'api.json');writeFileSync(artifact,'API v1');
  const payload:core.ResultPayload={kind:'contract',repoId:null,head:null,version:'v1',checkRefs:['check:api'],
    artifact:{path:artifact,sha256:createHash('sha256').update('API v1').digest('hex')}};
  const observed:core.ResultObservers={observe:request=>({request:structuredClone(request),verdict:'pass',origin:'host',observedAt:core.now(),expiresAt:null})};
  const edge=(producer:core.WorkItemRecord):core.DependencyInput=>({key:'api',producer:producer.ref,producerRevision:1,outputKey:'api',
    binding:{kind:'contract',repoId:null,version:'v1'}});
  const upstream=core.createWorkItem(handle,{task:ref(upstreamTask.id),definition,dependencies:[]});
  const publish=(item:core.WorkItemRecord,commandId:string)=>{
    const source:core.ResultSource={kind:'manual',sourceTask:item.task,instructionRef:'publish'};
    const result=core.publishResult(handle,{commandId,producer:item.ref,expectedRevision:1,outputKey:'api',expectedResultId:null,source,payload},observed);
    core.completeWorkItem(handle,{ref:item.ref,expectedRevision:1,source},observed);return result;
  };
  const upstreamResult=publish(upstream,'upstream');
  const producer=core.createWorkItem(handle,{task:ref(producerTask.id),definition,dependencies:[edge(upstream)]});
  const published=publish(producer,'derived');
  const parent=core.addTask(db,{title:'BA consumer',criteria:['deliver']},user);
  const consumer=core.createWorkItem(handle,{task:ref(parent.id),definition:{kind:'analysis',repoId:core.projectOf(db).primary_repo_id,sourceTasks:[],outputs:[]},dependencies:[edge(producer)]});
  const owner=core.reserveWorkItem(handle,{ref:consumer.ref,expectedRevision:1,expectedFence:0,expectedMode:'manual',ownerId:'BA',write:true},observed);
  const input={...issueInput(parent.id),workItemId:consumer.ref.workItemId,ownership:owner.ref,contextObservers:observed};
  const issued=core.issueRunAuthority(handle,input), context=core.openRunContext(db,issued.token);
  const proposal:core.CreateSubtasksInput={parent:ref(parent.id),expectedParentHash:core.taskContractHash(handle,ref(parent.id)),
    source:{kind:'run',sourceTask:ref(parent.id),authority:{authorityId:issued.authorityId,workItemId:consumer.ref.workItemId,runId:'r1',generation:1},
      proposalEventId:core.submitRunReport(context,'split work based on API v1')},children:[{key:'child',title:'frontend',criteria:['deliver']}]};
  expect(core.createSubtasks(handle,proposal).child.parent_id).toBe(parent.id);
  expect(core.readRunContext(context).taskId).toBe(parent.id);
  if(change==='invalidation'||change==='upstream invalidation')core.invalidateResult(handle,{commandId:'withdraw',
    resultId:change==='invalidation'?published.id:upstreamResult.id,reason:'API withdrawn'});
  if(change==='artifact change')writeFileSync(artifact,'different API');
  if(change==='producer requirements change')core.editTask(db,producerTask.id,{body:'changed requirements'},user);
  expect(core.inspectDependencies(handle,consumer.ref,observed).ready).toBe(false);
  const before=['tasks','events','work_item_owners','run_authorities'].map(table=>db.prepare(`SELECT * FROM ${table}`).all());
  expect(()=>core.recordLaunchIntent(handle,{owner:owner.ref,intent:{launchId:'late',writerScopeId:'stale-input'}})).toThrow(/stale|inputs/);
  expect(()=>core.issueRunAuthority(handle,{...input,runId:'late',expectedGeneration:1})).toThrow(/stale|inputs/);
  const memoryProposal:core.MemoryWriteInput={...memoryInput(parent.id),source:{kind:'run',task:ref(parent.id),
    authority:(proposal.source as Extract<core.CreationSource,{kind:'run'}>).authority,
    reportEventId:(proposal.source as Extract<core.CreationSource,{kind:'run'}>).proposalEventId},author:{type:'ai',id:'r1'}};
  for(const call of [()=>core.readRunContext(context),()=>core.submitRunReport(context,'late'),()=>core.requestRunQuestion(context,'late'),
    ()=>core.readRunMemory(context),()=>core.recallRunMemory(context,'API'),()=>core.runMemoryRules(context),
    ()=>core.writeMemory(handle,memoryProposal),
    ()=>core.createSubtasks(handle,proposal),()=>core.createSubtaskPlan(handle,{...proposal,workItems:[],dependencies:[]})])expect(call).toThrow(/authority/);
  expect(['tasks','events','work_item_owners','run_authorities'].map(table=>db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
  expect(core.ownership(handle,owner.ref)).toEqual(owner);
  const transfer=core.beginHandoff(handle,{commandId:'stop stale owner',task:ref(parent.id),expectedMode:'manual',targetMode:'manual',expectedOwners:[owner.ref]});
  expect((await core.finishHandoff(handle,{handoffId:transfer.id})).status).toBe('complete');
});
