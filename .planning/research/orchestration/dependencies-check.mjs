// Standalone observations of compiled APIs and real transports/processes, isolated stores only.
// Persisted credential fixtures exercise authority lifecycle; native enforcement is a separate gate.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawnSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from '../../../packages/core/node_modules/better-sqlite3/lib/index.js';
import * as core from '../../../packages/core/dist/index.js';
import { runRace } from '../../../packages/core/test/fixtures/execution_race.mjs';
import { Client } from '../../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'kdd-dependencies-'))), saved = { ...process.env };
const home = join(root, 'private'), handles = [], clients = [];
const user = { type: 'user' }, sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (cwd, ...args) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const repo = name => {
  const path = join(root, name); mkdirSync(path);
  git(path, 'init', '-q'); git(path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'seed');
  return path;
};
const track = db => { handles.push(db); return db; };
const pause = () => new Promise(resolve => setTimeout(resolve, 25));
const waitUntil = async condition => {
  const end = Date.now() + 5000;
  while (!condition()) { if (Date.now() > end) throw Error('fixture lifecycle timeout'); await pause(); }
};
const evidence = { observedAt: new Date().toISOString(), node: process.version, schema: core.MIGRATIONS.length,
  runtimeHash: sha(readFileSync(new URL('../../../packages/core/dist/index.js', import.meta.url))),
  credentialFixtures: 'persisted scoped rows; no native proof fabricated', checks: [], raceRounds: { edges: 20, reservations: 20 } };
const record = (id, details) => evidence.checks.push({ id, outcome: 'pass', ...details });
try {
  process.env.KDD_HOME = home; delete process.env.KDD_DB; delete process.env.KDD_DECISIONS_DIR;
  mkdirSync(home); const source = repo('frontend'), backend = repo('backend'), historicalSource = repo('historical');
  const oldPath = join(home, 'v14.db'), raw = track(new Database(oldPath));
  raw.pragma('journal_mode=WAL'); raw.pragma('wal_autocheckpoint=0');
  for (const sql of core.MIGRATIONS.slice(0, 14)) raw.exec(sql);
  raw.pragma('user_version=14'); const oldRepo = 'a'.repeat(32), oldCommon = core.canonicalCommonDir(historicalSource);
  raw.prepare('INSERT INTO repositories VALUES(?,?,?,?,?)').run(oldRepo, 'primary', 'implementation', null, 1);
  raw.prepare("UPDATE project SET primary_repo_id=?,legacy_decisions_dir=?,autonomy_enabled=1,default_execution_mode='orchestrated'")
    .run(oldRepo, join(historicalSource, '.planning', 'decisions'));
  raw.prepare('INSERT INTO repository_bindings VALUES(?,?,?,?,?)').run(oldCommon, oldRepo, historicalSource, 'source', 1);
  raw.prepare("INSERT INTO meta VALUES('project_path',?)").run(oldCommon);
  raw.prepare("INSERT INTO meta VALUES('project_toplevel',?)").run(historicalSource);
  raw.exec(`INSERT INTO tracks VALUES(8,'old track','keep','active',1);
    INSERT INTO tasks(id,title,status,created_at,updated_at,track_id,claimed_by,claim_expires)
      VALUES(41,'protected old task','new',1,1,8,NULL,NULL),(42,'old lease','in_progress',1,1,8,'old-worker',1);
    INSERT INTO criteria(id,task_id,text,checked_at,created_at,evidence,checked_by) VALUES(9,41,'old criterion',2,1,'keep','ai:old');
    INSERT INTO comments VALUES(7,41,'ai:old','keep comment',1);
    INSERT INTO events(id,task_id,actor_type,action,detail,created_at) VALUES(6,41,'user','created','{"provenance":"keep"}',1);
    INSERT INTO task_links VALUES(42,41,'depends_on');
    INSERT INTO agent_events VALUES(4,41,'old-worker','text',NULL,'keep report',1);
    INSERT INTO errors VALUES(2,'old','keep error',1);
    INSERT INTO managed_task_policy VALUES(41,1,'old-controller');
    INSERT INTO run_authorities VALUES('old-authority',41,'old-work','old-run',1,1,NULL,'old-hash','{"keep":true}',1);`);
  raw.prepare('INSERT INTO decisions VALUES(?,?,?,?,?,?,?)').run('keep', 'Keep', join(root, 'old-decision.md'), 'keep-hash', '2026-01-01', null, '[41]');
  raw.prepare('INSERT INTO search_index VALUES(?,?,?,?)').run('decision', 'keep', 'Keep', 'originaltoken');
  const oldBlob = 'retained bytes', blobHash = sha(oldBlob); mkdirSync(core.filesDir(oldPath));
  writeFileSync(join(core.filesDir(oldPath), blobHash + '.txt'), oldBlob);
  raw.prepare("INSERT INTO files(task_id,sha256,ext,original_name,size_bytes,created_at) VALUES(41,?,'txt','old.txt',?,1)").run(blobHash, Buffer.byteLength(oldBlob));
  const oldTables = ['tasks','criteria','comments','events','tracks','task_links','files','decisions','search_index','agent_events','errors','meta','project','repositories','repository_bindings','managed_task_policy','run_authorities'];
  const historical = db => oldTables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => {
    if (table !== 'tasks') return row;
    const { parent_id, execution_mode, ...old } = row; return old;
  }));
  const oldRows = historical(raw), upgraded = track(core.openDb(oldPath, oldCommon, historicalSource));
  assert.deepEqual(historical(upgraded), oldRows);
  assert.deepEqual(upgraded.prepare('SELECT parent_id,execution_mode FROM tasks ORDER BY id').all(),
    [{ parent_id: null, execution_mode: 'manual' }, { parent_id: null, execution_mode: 'manual' }]);
  const backup = track(new Database(oldPath + '.v14.bak', { readonly: true }));
  assert.equal(backup.pragma('user_version', { simple: true }), 14); assert.deepEqual(historical(backup), oldRows);
  assert.equal(readFileSync(join(core.filesDir(oldPath), blobHash + '.txt'), 'utf8'), oldBlob);
  const reopened = track(core.openDb(oldPath)); assert.deepEqual(historical(reopened), oldRows);
  for (const table of ['work_items','work_item_revisions','work_item_dependencies','work_item_results','work_item_owners','execution_handoffs']) {
    assert.equal(reopened.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  }
  assert.equal(reopened.prepare("SELECT count(*) n FROM events WHERE action LIKE '%launch%'").get().n, 0);
  assert.deepEqual(reopened.pragma('foreign_key_check'), []);
  record('D01', { historicalTables: oldTables.length, projectId: core.projectOf(upgraded).project_id,
    backupVersion: 14, oldTasks: [41,42], defaults: 'manual/root', newOwners: 0, launches: 0 });

  const dbPath = join(home, 'board.db'), db = track(core.openDb(dbPath, core.canonicalCommonDir(source), source));
  const handle = core.openController(db), projectId = core.projectOf(db).project_id, repoId = core.projectOf(db).primary_repo_id;
  const ref = taskId => ({ projectId, taskId });
  const task = title => core.addTask(db, { title, body: 'requirements', criteria: ['outcome'] }, user);
  const definition = (outputs = [], kind = 'analysis', repoId = null) => ({ kind, repoId, sourceTasks: [], outputs });
  const output = (key = 'api', kind = 'contract', checkRefs = []) => ({ key, kind, required: true, version: 'v1', checkRefs });
  const item = (title, def = definition(), dependencies = []) => core.createWorkItem(handle, { task: ref(task(title).id), definition: def, dependencies });
  const edge = producer => ({ key: 'api', producer: producer.ref, producerRevision: producer.revision,
    outputKey: 'api', binding: { kind: 'contract', repoId: producer.definition.repoId, version: 'v1' } });
  const manual = work => ({ kind: 'manual', sourceTask: work.task, instructionRef: 'fixture:owner instruction' });
  let serial = 0;
  const artifact = () => {
    const path = join(root, 'api-' + ++serial + '.json'); writeFileSync(path, '{"schema":"v1"}\n');
    return { path, sha256: sha(readFileSync(path)) };
  };
  const publication = (producer, overrides = {}) => ({ commandId: 'publish:' + ++serial, producer: producer.ref,
    expectedRevision: producer.revision, outputKey: 'api', expectedResultId: null, source: manual(producer),
    payload: { kind: 'contract', repoId: producer.definition.repoId, head: null, version: 'v1', checkRefs: [], artifact: artifact() }, ...overrides });
  const complete = (producer, observers) => core.completeWorkItem(handle, { ref: producer.ref, expectedRevision: producer.revision, source: manual(producer) }, observers);
  const flow = (title, checkRefs = []) => {
    const producer = item(title + ':producer', definition([output('api', 'contract', checkRefs)]));
    const consumer = item(title + ':consumer', definition(), [edge(producer)]);
    return { producer, consumer, publication: publication(producer) };
  };
  const tables = ['tasks','criteria','events','work_items','work_item_revisions','work_item_dependencies','work_item_results','work_item_owners','execution_handoffs','managed_task_policy','run_authorities'];
  const snapshot = () => tables.map(t => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
  const noWrites = (action, reason) => { const before = snapshot(); assert.throws(action, reason); assert.deepEqual(snapshot(), before); };
  const reservation = (work, ownerId = 'host', write = false) => ({ ref: work.ref, expectedRevision: work.revision,
    expectedFence: work.fence, expectedMode: core.mustGetTask(db, work.task.taskId).execution_mode, ownerId, write });

  const parent = task('D02 parent'); db.prepare("UPDATE tasks SET execution_mode='orchestrated' WHERE id=?").run(parent.id);
  const split = { parent: ref(parent.id), expectedParentHash: core.taskContractHash(handle, ref(parent.id)),
    source: { kind: 'manual', sourceTask: ref(parent.id), instructionRef: 'split fixture' },
    children: [{ key: 'a', title: 'child A', criteria: ['A'] }, { key: 'b', title: 'child B', criteria: ['B'], executionMode: 'manual' }] };
  const children = core.createSubtasks(handle, split);
  assert.notEqual(children.a.id, children.b.id); assert.equal(children.a.parent_id, parent.id);
  assert.deepEqual([children.a.execution_mode, children.b.execution_mode], ['orchestrated','manual']);
  const foreignRepo = repo('foreign'), foreign = track(core.openDb(join(home, 'foreign.db'), core.canonicalCommonDir(foreignRepo), foreignRepo));
  const foreignTask = core.addTask(foreign, { title: 'collision' }, user); assert.equal(foreignTask.id, parent.id);
  noWrites(() => core.createSubtasks(handle, { ...split, parent: { projectId: core.projectOf(foreign).project_id, taskId: foreignTask.id } }), /foreign/);
  noWrites(() => core.createSubtasks(handle, { ...split, parent: ref(children.a.id), expectedParentHash: core.taskContractHash(handle, ref(children.a.id)) }), /parent/);
  noWrites(() => db.prepare('UPDATE tasks SET parent_id=? WHERE id=?').run(children.a.id, children.b.id), /parent/);
  noWrites(() => db.prepare('UPDATE tasks SET parent_id=id WHERE id=?').run(parent.id), /parent/);
  const badPlan = { ...split, children: [{ key:'bad', title:'rolled back', criteria:['proof'] }],
    workItems: [{ key:'work', childKey:'bad', definition: definition([output()]) }],
    dependencies: [{ consumerKey:'work', key:'self', producer:{localKey:'work'}, outputKey:'api', binding:{kind:'contract',repoId:null,version:'v1'} }] };
  noWrites(() => core.createSubtaskPlan(handle, badPlan), /self|cycle/);
  const provenance = JSON.parse(db.prepare("SELECT detail FROM events WHERE task_id=? AND action='subtask_created'").get(children.a.id).detail);
  assert.equal(provenance.source_task_id, parent.id); assert.equal(provenance.parent_task_id, parent.id);
  assert.equal(db.prepare("SELECT parent_id FROM events WHERE task_id=? AND action='subtask_created'").get(children.a.id).parent_id, null);
  const modeHandoff = core.beginHandoff(handle, { commandId:'parent-mode', task:ref(parent.id), expectedMode:'orchestrated', targetMode:'manual', expectedOwners:[] });
  assert.equal((await core.finishHandoff(handle, { handoffId:modeHandoff.id })).status, 'complete');
  assert.deepEqual(core.listSubtasks(handle, ref(parent.id)).map(t=>t.execution_mode), ['orchestrated','manual']);
  record('D02', { parentId:parent.id, childIds:Object.values(children).map(t=>t.id), foreignCollisionId:foreignTask.id,
    parentMode:'manual', childModes:['orchestrated','manual'], failedBatchRows:0, provenance });

  for (const child of Object.values(children)) {
    const work = core.createWorkItem(handle, { task:ref(child.id), definition:definition(), dependencies:[] });
    db.prepare("INSERT INTO task_links VALUES(?,?,'depends_on')").run(child.id, parent.id);
    assert.equal(core.workItem(handle, work.ref).dependencies.length, 0);
  }
  const graph = core.createSubtaskPlan(handle, { ...split, children:['parallel-a','parallel-b','dependent'].map(key=>({key,title:key,criteria:['outcome']})),
    workItems:['parallel-a','parallel-b','dependent'].map(key=>({key,childKey:key,definition:definition([output()])})),
    dependencies:[{consumerKey:'dependent',key:'api',producer:{localKey:'parallel-a'},outputKey:'api',binding:{kind:'contract',repoId:null,version:'v1'}}] });
  const a = graph.workItems['parallel-a'], b = graph.workItems['parallel-b'], c = graph.workItems.dependent;
  assert.equal(core.inspectDependencies(handle,a.ref).ready,true); assert.equal(core.inspectDependencies(handle,b.ref).ready,true);
  assert.equal(core.inspectDependencies(handle,c.ref).ready,false);
  const siblingResult = core.publishResult(handle,publication(a)); assert.equal(core.inspectDependencies(handle,c.ref).ready,false); complete(a);
  const pin = core.resolveDependencies(handle,{ref:c.ref,expectedRevision:1});
  assert.deepEqual(pin.edges.map(e=>({id:e.resultId,pinned:e.pinned,satisfied:e.satisfied})),[{id:siblingResult.id,pinned:true,satisfied:true}]);
  record('D03',{ independent:[a.ref,b.ref], dependent:c.ref, pinnedResultId:siblingResult.id, implicitParentAndLegacyEdges:0 });

  const cycleA = item('D04 main A',definition([output()])), cycleB = item('D04 main B',definition([output()]));
  core.reviseWorkItem(handle,{ref:cycleA.ref,expectedRevision:1,definition:cycleA.definition,dependencies:[edge(cycleB)]});
  noWrites(()=>core.reviseWorkItem(handle,{ref:cycleB.ref,expectedRevision:1,definition:cycleB.definition,dependencies:[edge(cycleA)]}),/cycle/);
  noWrites(()=>core.reviseWorkItem(handle,{ref:cycleA.ref,expectedRevision:1,definition:cycleA.definition,dependencies:[]}),/revision/);
  const edgeRaces=[];
  for(let round=0;round<20;round++) {
    const x=item('edge A '+round,definition([output()])), y=item('edge B '+round,definition([output()]));
    const proposal=(consumer,producer)=>({op:'revise',input:{ref:consumer.ref,expectedRevision:1,definition:consumer.definition,dependencies:[edge(producer)]}});
    const before=db.prepare("SELECT count(*) n FROM events WHERE action='work_item_revised'").get().n;
    const outcomes=await runRace(dbPath,[proposal(x,y),proposal(y,x)]);
    assert.equal(outcomes.filter(o=>o.ok).length,1); assert.match(outcomes.find(o=>!o.ok).error,/cycle|revision/);
    const current=[core.workItem(handle,x.ref),core.workItem(handle,y.ref)];
    assert.deepEqual(current.map(w=>w.revision).sort(),[1,2]); assert.equal(current.flatMap(w=>w.dependencies).length,1);
    assert.equal(db.prepare("SELECT count(*) n FROM events WHERE action='work_item_revised'").get().n,before+1);
    assert.equal(db.prepare(`WITH RECURSIVE active(c,p) AS (SELECT d.consumer_id,d.producer_id FROM work_item_dependencies d
      JOIN work_items w ON w.id=d.consumer_id AND w.current_revision=d.consumer_revision),
      paths(c,p) AS (SELECT c,p FROM active UNION SELECT paths.c,active.p FROM paths JOIN active ON active.c=paths.p)
      SELECT 1 FROM paths WHERE c=p LIMIT 1`).get(),undefined);
    edgeRaces.push({ids:current.map(w=>w.ref.workItemId),revisions:current.map(w=>w.revision),commits:1});
  }
  record('D04',{crossMainTasks:[cycleA.task,cycleB.task],opposingProcessRounds:edgeRaces,cycles:0});

  const statusFlow=flow('D05 legacy signals'), criterion=core.listCriteria(db,statusFlow.producer.task.taskId)[0];
  core.setCriterionChecked(db,statusFlow.producer.task.taskId,criterion.id,true,user,'exit 0');
  core.commentTask(db,statusFlow.producer.task.taskId,'ready, verified, exit 0',user);
  core.moveTask(db,statusFlow.producer.task.taskId,'done',user,'fixture legacy acceptance');
  assert.equal(core.inspectDependencies(handle,statusFlow.consumer.ref).ready,false);
  noWrites(()=>complete(statusFlow.producer),/missing_output/);
  const result=core.publishResult(handle,statusFlow.publication); complete(statusFlow.producer);
  assert.equal(core.resolveDependencies(handle,{ref:statusFlow.consumer.ref,expectedRevision:1}).edges[0].resultId,result.id);
  const contractBytes=readFileSync(statusFlow.publication.payload.artifact.path);
  writeFileSync(statusFlow.publication.payload.artifact.path,'changed artifact');
  assert.equal(core.inspectDependencies(handle,statusFlow.consumer.ref).ready,false);
  noWrites(()=>core.reserveWorkItem(handle,reservation(statusFlow.consumer)),/dependencies/);
  rmSync(statusFlow.publication.payload.artifact.path);
  assert.equal(core.inspectDependencies(handle,statusFlow.consumer.ref).ready,false);
  writeFileSync(statusFlow.publication.payload.artifact.path,contractBytes);
  assert.equal(core.inspectDependencies(handle,statusFlow.consumer.ref).ready,true);
  const terminal=[];
  for(const state of ['failed','cancelled','waiting_input']) {
    const f=flow('D05 '+state); core.publishResult(handle,f.publication);
    const input={ref:f.producer.ref,expectedRevision:1,source:manual(f.producer)};
    if(state==='waiting_input')core.setWorkItemWaiting(handle,input);else core.endWorkItem(handle,{...input,state});
    assert.equal(core.inspectDependencies(handle,f.consumer.ref).ready,false); terminal.push(state);
  }
  const checked=flow('D05 checks',['host:api']); checked.publication.payload.checkRefs=['host:api'];
  noWrites(()=>core.publishResult(handle,checked.publication),/checks_not_passed/);
  const hostCheck={observe:request=>{
    if(request.kind!=='check'||request.ref!=='host:api'||request.binding.producer.workItemId!==checked.producer.ref.workItemId
      ||request.binding.inputsHash!==checked.producer.inputsHash||sha(readFileSync(checked.publication.payload.artifact.path))!==checked.publication.payload.artifact.sha256)return null;
    return {request:structuredClone(request),verdict:'pass',origin:'host',observedAt:core.now(),expiresAt:null};
  }};
  const checkedResult=core.publishResult(handle,checked.publication,hostCheck); complete(checked.producer,hostCheck);
  assert.equal(core.inspectDependencies(handle,checked.consumer.ref).ready,false);
  assert.equal(core.resolveDependencies(handle,{ref:checked.consumer.ref,expectedRevision:1},hostCheck).edges[0].resultId,checkedResult.id);
  record('D05',{legacySignalsOpened:false,requiredResultId:result.id,closedStates:terminal,checkedResultId:checkedResult.id,checks:'fresh local host artifact check'});

  const backendId=core.addRepository(db,dbPath,home,{cwd:backend,purpose:'backend',access:'context_only'},user).repository.repo_id;
  const api=item('D06 backend contract',definition([output()],'architecture',backendId));
  const frontend=item('D06 frontend',definition([],'implementation',repoId),[edge(api)]);
  const frontendBefore=[git(source,'rev-parse','HEAD'),git(source,'show-ref'),git(source,'status','--porcelain')];
  const codeBackend=item('D06 backend code',definition([output('api','code')],'implementation',backendId));
  noWrites(()=>core.createWorkItem(handle,{task:frontend.task,definition:frontend.definition,dependencies:[{
    key:'backend-code',producer:codeBackend.ref,producerRevision:1,outputKey:'api',binding:{kind:'code',repoId:backendId,version:'v1',baseHead:frontendBefore[0]}}]}),/repository/);
  const apiInput=publication(api), apiPath=join(backend,'api.json'); writeFileSync(apiPath,readFileSync(apiInput.payload.artifact.path));
  apiInput.payload.artifact.path=apiPath; const apiResult=core.publishResult(handle,apiInput); complete(api);
  assert.equal(core.resolveDependencies(handle,{ref:frontend.ref,expectedRevision:1}).edges[0].resultId,apiResult.id);
  assert.equal(core.result(handle,apiResult.id).binding.repoId,backendId);
  assert.deepEqual([git(source,'rev-parse','HEAD'),git(source,'show-ref'),git(source,'status','--porcelain')],frontendBefore);
  const baseHead=git(source,'rev-parse','HEAD'); writeFileSync(join(source,'code.txt'),'new producer commit'); git(source,'add','code.txt');
  git(source,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','code proof'); const head=git(source,'rev-parse','HEAD');
  const code=item('D06 code',definition([output('api','code')],'implementation',repoId));
  const codeInput=publication(code,{payload:{kind:'code',repoId,head,version:'v1',checkRefs:[],proofRef:'git:producer'}});
  noWrites(()=>core.publishResult(handle,codeInput),/checks_not_passed/);
  const gitProof={observe:request=>{
    if(request.binding.repoId!==repoId||!['code_result','code_in_base'].includes(request.kind))return null;
    try {
      git(source,'cat-file','-e',request.head+'^{commit}');
      if(request.kind==='code_in_base')git(source,'merge-base','--is-ancestor',request.head,request.baseHead);
      return {request:structuredClone(request),verdict:'pass',origin:'host',observedAt:core.now(),expiresAt:null};
    }catch{return null}
  }};
  const codeResult=core.publishResult(handle,codeInput,gitProof); complete(code,gitProof);
  const codeEdge={key:'code',producer:code.ref,producerRevision:1,outputKey:'api',binding:{kind:'code',repoId,version:'v1',baseHead}};
  const missingBase=item('D06 base missing',definition([],'implementation',repoId),[codeEdge]);
  assert.equal(core.inspectDependencies(handle,missingBase.ref,gitProof).edges[0].reason,'base_missing_code');
  const merger=item('D06 merge',definition([output('api','merged')],'integration',repoId),[{...codeEdge,binding:{...codeEdge.binding,baseHead:head}}]);
  noWrites(()=>core.publishResult(handle,publication(merger,{payload:{kind:'merged',repoId,head,target:'main',baseHead:head,
    acceptedResultId:codeResult.id,userRef:'absent:acceptance',receiptRef:'absent:receipt',version:'v1',checkRefs:[]}}),gitProof),/merge_not_succeeded/);
  const readiness=item('D06 readiness',definition([output('api','readiness')],'human_action'));
  noWrites(()=>core.publishResult(handle,publication(readiness,{payload:{kind:'readiness',repoId:null,version:'v1',checkRefs:[],
    resourceId:'backend',configHash:'configuration',consumerScope:'frontend',capabilities:['api:v1'],userRef:'absent:user',probeRef:'absent:probe',observedAt:core.now(),expiresAt:null}})),/readiness_unconfirmed/);
  record('D06',{backendRepoId:backendId,apiResultId:apiResult.id,apiHash:apiResult.payload.artifact.sha256,frontendHeadUnchanged:frontendBefore[0],
    denied:['cross-repo code','missing consumer base','missing merge acceptance/receipt','missing scoped readiness proof'],codeHead:head,consumerBase:baseHead});

  const correction=flow('D07 correction'), first=core.publishResult(handle,correction.publication), replayBefore=snapshot();
  assert.deepEqual(core.publishResult(handle,correction.publication),first); assert.deepEqual(snapshot(),replayBefore);
  noWrites(()=>core.publishResult(handle,{...correction.publication,source:{...correction.publication.source,instructionRef:'conflicting replay'}}),/conflict/);
  const second=core.publishResult(handle,{...correction.publication,commandId:'correct',expectedResultId:first.id});
  assert.deepEqual(core.result(handle,first.id).payload,first.payload); assert.equal(core.result(handle,first.id).successorId,second.id); complete(correction.producer);
  core.resolveDependencies(handle,{ref:correction.consumer.ref,expectedRevision:1});
  const frozen=core.reserveWorkItem(handle,reservation(correction.consumer));
  const rework=core.createWorkItem(handle,{task:correction.producer.task,definition:correction.producer.definition,dependencies:[]});
  const successor=core.publishResult(handle,publication(rework));
  core.invalidateResult(handle,{commandId:'invalidate:old',resultId:second.id,reason:'fixture rework',successorId:successor.id});
  assert.equal(core.workItem(handle,correction.consumer.ref).dependencies[0].resultId,second.id);
  assert.equal(core.inspectDependencies(handle,correction.consumer.ref).ready,false); assert.deepEqual(core.ownership(handle,frozen.ref),frozen);
  noWrites(()=>db.prepare("UPDATE work_item_results SET payload_json='{}' WHERE id=?").run(first.id),/immutable/);
  const p=task('D07 parent'), extra=task('D07 additional'), child=core.createSubtasks(handle,{...split,parent:ref(p.id),expectedParentHash:core.taskContractHash(handle,ref(p.id))}).a;
  const requirements=core.createWorkItem(handle,{task:ref(child.id),definition:{...definition(),sourceTasks:[ref(extra.id)]},dependencies:[]});
  const reqOwner=core.reserveWorkItem(handle,reservation(requirements));
  for(const id of [p.id,extra.id,child.id]) {
    const old=core.mustGetTask(db,id), oldCriterion=core.listCriteria(db,id)[0];
    for(const field of ['title','body']) {
      db.prepare(`UPDATE tasks SET ${field}=? WHERE id=?`).run('changed requirement',id);
      assert.equal(core.inspectDependencies(handle,requirements.ref).inputsCurrent,false);
      db.prepare(`UPDATE tasks SET ${field}=? WHERE id=?`).run(old[field],id);
    }
    db.prepare("UPDATE criteria SET text='changed criterion' WHERE id=?").run(oldCriterion.id);
    assert.equal(core.inspectDependencies(handle,requirements.ref).inputsCurrent,false);
    db.prepare('UPDATE criteria SET text=?,checked_at=1,evidence=?,position=99 WHERE id=?').run(oldCriterion.text,'exit 0',oldCriterion.id);
    db.prepare("UPDATE tasks SET position=99,status='done' WHERE id=?").run(id); core.commentTask(db,id,'nonrequirement',user);
    assert.equal(core.inspectDependencies(handle,requirements.ref).inputsCurrent,true);
  }
  assert.deepEqual(core.ownership(handle,reqOwner.ref),reqOwner);
  record('D07',{resultHistory:[first.id,second.id,successor.id],pinnedResultId:second.id,ownerInputsFrozen:true,
    requirementTasks:[p.id,extra.id,child.id],nonrequirementEditsStale:false,replayResultCount:1});

  const reservationRaces=[];
  for(let round=0;round<20;round++) {
    const work=item('reservation '+round,definition([],'implementation'));
    const outcomes=await runRace(dbPath,[{op:'reserve',input:reservation(work,'a',true)},{op:'reserve',input:reservation(work,'b',true)}]);
    assert.equal(outcomes.filter(o=>o.ok).length,1); assert.match(outcomes.find(o=>!o.ok).error,/owner|fence/);
    assert.equal(db.prepare('SELECT count(*) n FROM work_item_owners WHERE work_item_id=? AND released_at IS NULL').get(work.ref.workItemId).n,1);
    assert.equal(core.workItem(handle,work.ref).fence,1);
    assert.equal(db.prepare("SELECT count(*) n FROM events WHERE action='work_item_reserved' AND json_extract(detail,'$.work_item_id')=?").get(work.ref.workItemId).n,1);
    reservationRaces.push({workItemId:work.ref.workItemId,liveOwners:1,fence:1});
  }
  const independent=[item('independent A',definition([],'implementation')),item('independent B',definition([],'implementation'))];
  assert.deepEqual((await runRace(dbPath,independent.map((w,i)=>({op:'reserve',input:reservation(w,'independent:'+i,true)})))).map(o=>o.ok),[true,true]);
  assert.equal(db.prepare('SELECT count(*) n FROM work_item_owners WHERE work_item_id IN (?,?) AND released_at IS NULL').get(...independent.map(w=>w.ref.workItemId)).n,2);
  const stale=item('D08 stale writer',definition([output()])), oldOwner=core.reserveWorkItem(handle,reservation(stale,'old'));
  const staleInput=publication(stale,{source:{kind:'owned',owner:oldOwner.ref,instructionRef:'publish'}});
  const release=core.beginHandoff(handle,{commandId:'D08 release',task:stale.task,expectedMode:'manual',targetMode:'manual',expectedOwners:[oldOwner.ref]});
  assert.equal((await core.finishHandoff(handle,{handoffId:release.id})).status,'complete');
  const newOwner=core.reserveWorkItem(handle,{...reservation(stale,'new'),expectedFence:1}); assert.equal(newOwner.ref.fence,2);
  noWrites(()=>core.publishResult(handle,staleInput),/fence/);
  record('D08',{reservationProcessRounds:reservationRaces,independentItems:independent.map(w=>w.ref),independentOwners:2,
    stalePublicationWrites:0,oldFence:oldOwner.ref.fence,newFence:newOwner.ref.fence});

  // Historical credential rows are fixtures, not an issueRunAuthority/native preflight bypass.
  const seedCredential=(work,owner,operations=['get_context','submit_report','request_question'],expiresAt=core.now()+3600)=>{
    core.protectTask(handle,work.task.taskId); const token=randomBytes(32).toString('hex'),authorityId=randomBytes(16).toString('hex');
    const grant={projectId,taskId:work.task.taskId,workItemId:work.ref.workItemId,runId:'fixture:'+authorityId,generation:1,operations,
      ownership:owner.ref,repositories:[{repoId,checkoutPath:source,commonDir:core.canonicalCommonDir(source),write:false}],
      native:{readableRoots:[source],scratchDir:join(root,'scratch'),configHash:'persisted-fixture-no-native-proof'}};
    db.prepare('INSERT INTO run_authorities(authority_id,task_id,work_item_id,run_id,generation,expires_at,token_hash,grant_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(authorityId,work.task.taskId,work.ref.workItemId,grant.runId,1,expiresAt,sha(token),JSON.stringify(grant),core.now());
    return {token,authorityId,context:core.openRunContext(db,token),expiresAt};
  };
  mkdirSync(join(root,'scratch'));
  const holds=item('D09 held scope'), heldOwner=core.reserveWorkItem(handle,reservation(holds));
  const sameCard=core.createWorkItem(handle,{task:holds.task,definition:definition(),dependencies:[]});
  const otherOwner=core.reserveWorkItem(handle,reservation(sameCard,'other'));
  const revoked=seedCredential(holds,heldOwner), expiring=seedCredential(sameCard,otherOwner,['get_context'],core.now()+2);
  core.recordLaunchIntent(handle,{owner:heldOwner.ref,intent:{launchId:'pending-launch-no-runtime-id',writerScopeId:'pending-scope'}});
  const held=core.beginHandoff(handle,{commandId:'D09 hold',task:holds.task,expectedMode:'manual',targetMode:'orchestrated',expectedOwners:[heldOwner.ref,otherOwner.ref]});
  const stop=owner=>({observationId:'fixture:stop',owner:owner.ref,launchId:owner.launchIntent.launchId,writerScopeId:owner.launchIntent.writerScopeId,
    observedAt:core.now(),verdict:'stopped',complete:true,writers:[{id:'fixture:writer',state:'gone'}]});
  const heldReasons=[];
  for(const observer of [undefined,async()=>{throw Error('offline')},async o=>({...stop(o),verdict:'unknown'}),async o=>({...stop(o),verdict:'live',writers:[{id:'fixture:writer',state:'alive'}]})]) {
    const outcome=await core.finishHandoff(handle,{handoffId:held.id},observer); assert.equal(outcome.status,'held'); heldReasons.push(outcome.reason);
    assert.equal(core.ownership(handle,heldOwner.ref).releasedAt,null); assert.equal(core.ownership(handle,otherOwner.ref).releasedAt,null);
    assert.equal(core.mustGetTask(db,holds.task.taskId).execution_mode,'manual');
    assert.equal(core.handoff(handle,held.id).receipt,null);
    assert.deepEqual(core.ownership(handle,heldOwner.ref).launchIntent,{launchId:'pending-launch-no-runtime-id',writerScopeId:'pending-scope'});
  }
  core.revokeRunAuthority(handle,revoked.authorityId); await waitUntil(()=>core.now()>=expiring.expiresAt);
  assert.throws(()=>core.readRunContext(revoked.context),/authority/); assert.throws(()=>core.readRunContext(expiring.context),/authority/);
  assert.equal(core.ownership(handle,heldOwner.ref).releasedAt,null); assert.equal(core.ownership(handle,otherOwner.ref).releasedAt,null);
  const idle=item('D09 never started'), idleOwner=core.reserveWorkItem(handle,reservation(idle));
  const idleCredential=seedCredential(idle,idleOwner), transfer=core.beginHandoff(handle,{commandId:'D09 transfer',task:idle.task,
    expectedMode:'manual',targetMode:'orchestrated',expectedOwners:[idleOwner.ref]});
  const transferred=await core.finishHandoff(handle,{handoffId:transfer.id});
  assert.equal(transferred.status,'complete'); assert.equal(transferred.receipt.stops[0].outcome,'never_started');
  assert.deepEqual(transferred.receipt.revokedAuthorityIds,[idleCredential.authorityId]);
  assert.equal(core.mustGetTask(db,idle.task.taskId).execution_mode,'orchestrated');
  const next=core.reserveWorkItem(handle,{...reservation(idle,'next'),expectedFence:1}); assert.equal(next.ref.fence,2);
  record('D09',{heldHandoffId:held.id,heldReasons,retainedOwners:2,revokeAndExpiryReleased:false,
    neverStartedReceipt:transferred.receipt,nextFence:2});

  const treeWork=item('D10 process tree',definition([],'implementation')), treeOwner=core.reserveWorkItem(handle,reservation(treeWork,'tree',true));
  const scope=randomBytes(16).toString('hex'), writes=join(root,'writer.log');
  core.recordLaunchIntent(handle,{owner:treeOwner.ref,intent:{launchId:'fixture:'+scope,writerScopeId:scope}});
  const treeHandoff=core.beginHandoff(handle,{commandId:'D10 tree',task:treeWork.task,expectedMode:'manual',targetMode:'manual',expectedOwners:[treeOwner.ref]});
  assert.equal((await core.finishHandoff(handle,{handoffId:treeHandoff.id})).status,'held');
  const parentProcess=fork(fileURLToPath(new URL('../../../packages/core/test/fixtures/execution_tree.mjs',import.meta.url)),['parent',scope,writes],
    {execPath:process.execPath,detached:true,stdio:['ignore','ignore','pipe','ipc']});
  let childPid, treeReceipt;
  const alive=pid=>{try{process.kill(pid,0);return true}catch(error){if(error.code==='ESRCH')return false;throw error}};
  try {
    let timer;
    const ready=await Promise.race([once(parentProcess,'message'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('fixture ready timeout')),5000)})]).finally(()=>clearTimeout(timer));
    const message=ready[0]; childPid=message.childPid;
    assert.equal(message.scope,scope); assert.equal(message.parentPid,parentProcess.pid); assert.equal(message.pid,childPid);
    await waitUntil(()=>{try{return readFileSync(writes).length>0}catch{return false}});
    const exited=once(parentProcess,'exit'); parentProcess.send('exit-parent'); await exited;
    const size=readFileSync(writes).length; await waitUntil(()=>readFileSync(writes).length>size);
    const observer=async owner=>{
      const writers=[{id:scope+':parent',state:alive(parentProcess.pid)?'alive':'gone'},{id:scope+':child',state:alive(childPid)?'alive':'gone'}];
      return {...stop(owner),observationId:scope+':observed',writers,verdict:writers.some(w=>w.state==='alive')?'live':'stopped'};
    };
    assert.equal((await core.finishHandoff(handle,{handoffId:treeHandoff.id},observer)).reason,'live');
    assert.equal(core.ownership(handle,treeOwner.ref).releasedAt,null);
    process.kill(childPid,'SIGKILL'); await waitUntil(()=>!alive(childPid));
    treeReceipt=await core.finishHandoff(handle,{handoffId:treeHandoff.id},observer); assert.equal(treeReceipt.status,'complete');
    assert.notEqual(core.ownership(handle,treeOwner.ref).releasedAt,null);
  }finally {
    try { if(parentProcess.pid)process.kill(-parentProcess.pid,'SIGKILL'); }catch(error){if(error.code!=='ESRCH')throw error}
    if(childPid)await waitUntil(()=>!alive(childPid));
    if(parentProcess.exitCode===null&&parentProcess.signalCode===null)await once(parentProcess,'exit');
  }
  record('D10',{fixtureScope:scope,parentPid:parentProcess.pid,childPid,orphanContinuedWriting:true,receipt:treeReceipt.receipt,productLaunches:0});

  const authorityWork=item('D11 untrusted report',definition([output('api','contract',['host:required-check'])]));
  const authorityOwner=core.reserveWorkItem(handle,reservation(authorityWork)), credential=seedCredential(authorityWork,authorityOwner);
  const bodyBefore=core.mustGetTask(db,authorityWork.task.taskId), criteriaBefore=core.listCriteria(db,authorityWork.task.taskId);
  const publish=publication(authorityWork,{source:{kind:'owned',owner:authorityOwner.ref,instructionRef:'publish'}});
  for(const fake of [{...handle},{kind:'controller'},{type:'user'},{kind:'run'},credential.context]) {
    noWrites(()=>core.publishResult(fake,publish),/authority/);
    noWrites(()=>core.reserveWorkItem(fake,reservation(authorityWork)),/authority/);
  }
  noWrites(()=>core.moveTask(db,authorityWork.task.taskId,'done',user,'owner approved takeover'),/managed/);
  const resultRowsBefore=db.prepare('SELECT * FROM work_item_results ORDER BY id').all();
  const reportId=core.submitRunReport(credential.context,'{"verified":true,"completed":true,"checks":"pass","exit":0}');
  assert.equal(JSON.parse(db.prepare('SELECT detail FROM events WHERE id=?').get(reportId).detail).untrusted,true);
  assert.deepEqual(core.mustGetTask(db,authorityWork.task.taskId),bodyBefore); assert.deepEqual(core.listCriteria(db,authorityWork.task.taskId),criteriaBefore);
  assert.deepEqual(db.prepare('SELECT * FROM work_item_results ORDER BY id').all(),resultRowsBefore);
  noWrites(()=>core.publishResult(handle,publish),/checks_not_passed/);
  assert.equal(core.workItem(handle,authorityWork.ref).state,'pending');
  const takeover=core.beginHandoff(handle,{commandId:'D11 manual takeover',task:authorityWork.task,expectedMode:'manual',targetMode:'manual',expectedOwners:[authorityOwner.ref]});
  assert.equal((await core.finishHandoff(handle,{handoffId:takeover.id})).status,'complete');
  assert.ok(db.prepare('SELECT 1 FROM managed_task_policy WHERE task_id=?').get(authorityWork.task.taskId));
  noWrites(()=>core.editTask(db,authorityWork.task.taskId,{title:'bypass'},user),/managed/);
  record('D11',{reportId,reportTrusted:false,resultWrites:0,workState:'pending',managedAfterTakeover:true,credentialFixtures:'persisted scoped grant'});

  const cli=fileURLToPath(new URL('../../../packages/cli/dist/index.js',import.meta.url));
  const cliEnv={...process.env,KDD_DB:dbPath,NO_UPDATE_NOTIFIER:'1',KDD_ACTOR:'user'};
  const queued=task('D12 orchestrated'); db.prepare("UPDATE tasks SET execution_mode='orchestrated' WHERE id=?").run(queued.id);
  const explicit=spawnSync(process.execPath,[cli,'claim',String(queued.id),'--json'],{env:cliEnv,cwd:source,encoding:'utf8'});
  assert.notEqual(explicit.status,0); assert.match(JSON.parse(explicit.stdout).error,/orchestrated|controller/);
  const context=spawnSync(process.execPath,[cli,'brief',String(queued.id),'--json'],{env:cliEnv,cwd:source,encoding:'utf8'});
  assert.equal(context.status,0); assert.equal(JSON.parse(context.stdout).next_action.kind,'await_controller');
  assert.deepEqual(core.claimTask(db,queued.id,user),{ok:false,error:'orchestrated task requires controller execution'});
  db.prepare('UPDATE tasks SET blocked=1 WHERE id<>?').run(queued.id);
  const queue=spawnSync(process.execPath,[cli,'claim','--next','--json'],{env:cliEnv,cwd:source,encoding:'utf8'});
  assert.equal(queue.status,0); assert.deepEqual(JSON.parse(queue.stdout),{task:null});
  const legacy=task('D12 legacy queue');
  const claimed=spawnSync(process.execPath,[cli,'claim','--next','--json'],{env:cliEnv,cwd:source,encoding:'utf8'});
  assert.equal(claimed.status,0); assert.equal(JSON.parse(claimed.stdout).id,legacy.id);
  const scopedTools=[];
  for(const operations of [['get_context','submit_report','request_question'],['get_context']]) {
    const work=item('D12 scoped '+operations.length), owner=core.reserveWorkItem(handle,reservation(work));
    const scoped=seedCredential(work,owner,operations), config=join(home,'broker-'+operations.length+'.json');
    writeFileSync(config,JSON.stringify({dbPath,token:scoped.token}),{mode:0o600});
    const client=new Client({name:'dependencies-observation',version:'0'}); clients.push(client);
    await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../../../packages/mcp/dist/run_main.js',import.meta.url)),'--config',config],
      env:{HOME:process.env.HOME,PATH:process.env.PATH,KDD_HOME:home},stderr:'pipe'}));
    const tools=(await client.listTools()).tools.map(t=>t.name).sort(); assert.deepEqual(tools,[...operations].sort());
    assert.notEqual((await client.callTool({name:'get_context',arguments:{}})).isError,true);
    const before=snapshot();
    for(const name of ['publish_result','reserve_work_item','begin_handoff'])assert.equal((await client.callTool({name,arguments:{}})).isError,true);
    if(operations.length===1)assert.equal((await client.callTool({name:'submit_report',arguments:{body:'not granted'}})).isError,true);
    assert.deepEqual(snapshot(),before); scopedTools.push(tools); await client.close();
  }
  const authorityRegression=JSON.parse(execFileSync(process.execPath,[fileURLToPath(new URL('./authority-check.mjs',import.meta.url))],{encoding:'utf8',stdio:'pipe',timeout:30000}));
  const storeRegression=JSON.parse(execFileSync(process.execPath,[fileURLToPath(new URL('./project-store-check.mjs',import.meta.url))],{encoding:'utf8',stdio:'pipe',timeout:30000}));
  assert.equal(authorityRegression.checks.length,7); assert.equal(authorityRegression.refusedChanges,0); assert.equal(authorityRegression.blobPreserved,true);
  assert.equal(storeRegression.checks.length,8); assert.equal(authorityRegression.schema,core.MIGRATIONS.length);
  assert.deepEqual(db.pragma('foreign_key_check'),[]);
  record('D12',{scopedTools,legacyClaimOrchestrated:false,authorityRegression,storeRegression,productLaunches:0});
  assert.deepEqual(evidence.checks.map(c=>c.id),['D01','D02','D03','D04','D05','D06','D07','D08','D09','D10','D11','D12']);
  process.stdout.write(JSON.stringify(evidence,null,2)+'\n');
}finally {
  for(const client of clients.reverse())await client.close();
  for(const db of handles.reverse())if(db.open)db.close();
  process.env=saved; rmSync(root,{recursive:true,force:true});
}
