import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import * as core from '../src/index.js';
import { memoryFixture, cleanupFixtures, fixtureHash } from './memory_fixture.js';
import { roleFixture } from './role_fixture.js';
afterEach(cleanupFixtures);

it('upgrades a populated v16 WAL store without rewriting any old rows', () => {
  const f = memoryFixture(), path = join(f.home, 'legacy.db'), raw = new Database(path);
  process.env.KDD_HOME = join(f.root, 'legacy-home');
  let upgraded: Database.Database | undefined, backup: Database.Database | undefined;
  try {
    raw.pragma('foreign_keys=ON'); raw.pragma('journal_mode=WAL'); raw.pragma('wal_autocheckpoint=0');
    for (const sql of core.MIGRATIONS.slice(0, 16)) raw.exec(sql);
    raw.pragma('user_version=16');
    const repoId = 'a'.repeat(32), work = 'b'.repeat(32), consumer = 'c'.repeat(32);
    raw.prepare('INSERT INTO repositories VALUES(?,?,?,?,?)').run(repoId, 'primary', 'implementation', null, 1);
    raw.prepare('UPDATE project SET primary_repo_id=?,legacy_decisions_dir=?').run(repoId, join(f.repo, '.planning', 'decisions'));
    raw.prepare('INSERT INTO repository_bindings VALUES(?,?,?,?,?)').run(core.canonicalCommonDir(f.repo), repoId, f.repo, 'source', 1);
    raw.prepare("INSERT INTO meta VALUES('project_path',?)").run(core.canonicalCommonDir(f.repo));
    raw.prepare("INSERT INTO meta VALUES('project_toplevel',?)").run(f.repo);
    raw.exec(`INSERT INTO tracks VALUES(8,'retained','keep','active',1);
      INSERT INTO tasks(id,title,status,created_at,updated_at,track_id) VALUES(41,'old','new',1,1,8),(42,'child','new',1,1,8);
      UPDATE tasks SET parent_id=41 WHERE id=42;
      INSERT INTO criteria(id,task_id,text,checked_at,created_at,evidence,checked_by) VALUES(9,41,'keep',2,1,'keep','user');
      INSERT INTO comments VALUES(7,41,'user','keep comment',1);
      INSERT INTO events(id,task_id,actor_type,action,detail,created_at) VALUES(6,41,'user','created','{"keep":true}',1);
      INSERT INTO task_links VALUES(42,41,'depends_on');
      INSERT INTO agent_events VALUES(4,41,'old','text',NULL,'keep',1);
      INSERT INTO errors VALUES(2,'old','keep',1);
      INSERT INTO managed_task_policy VALUES(41,1,'old');
      INSERT INTO run_authorities VALUES('old-authority',41,'external-work','old-run',1,1,NULL,'old-hash','{"keep":true}',1);`);
    raw.prepare('INSERT INTO decisions VALUES(?,?,?,?,?,?,?)').run('keep','Keep','old.md','old-hash','2026-01-01',null,'[41]');
    raw.prepare('INSERT INTO search_index VALUES(?,?,?,?)').run('decision','keep','Keep','retainedtoken');
    raw.transaction(() => {
      for (const id of [work, consumer]) {
        raw.prepare('INSERT INTO work_items(id,task_id,current_revision,created_at) VALUES(?,41,1,1)').run(id);
        raw.prepare('INSERT INTO work_item_revisions VALUES(?,1,?,?,?,1)').run(id,
          JSON.stringify({ kind: 'analysis', repoId: null, sourceTasks: [], outputs: [] }), '[]', 'd'.repeat(64));
      }
      raw.prepare("INSERT INTO work_item_results VALUES('old-result','old-command','old-hash',?,1,'api','contract','{}','{}',1,NULL,NULL,NULL)").run(work);
      raw.prepare("INSERT INTO work_item_dependencies VALUES(?,1,'api',?,1,'contract','api','{}','old-result')").run(consumer, work);
      raw.prepare("INSERT INTO execution_handoffs VALUES('old-handoff','old-handoff-command',41,'manual','orchestrated','{}',1,NULL,NULL)").run();
      raw.prepare("INSERT INTO work_item_owners VALUES(?,1,1,'old-owner','manual',0,'[]',NULL,NULL,1,NULL,NULL)").run(work);
    }).immediate();
    raw.transaction(() => {
      raw.prepare('INSERT INTO memory_entries VALUES(?,NULL,NULL,NULL,NULL,1,1)').run('e'.repeat(32));
      raw.prepare("INSERT INTO memory_revisions VALUES(?,1,NULL,'rule','active','Keep','Keep','{}','{}','[]',?,'legacy-rule',?,1)").run('e'.repeat(32),'f'.repeat(64),'f'.repeat(64));
    }).immediate();
    const tables = ['tasks','criteria','comments','events','tracks','task_links','decisions','search_index','agent_events','errors','meta','project','repositories','repository_bindings','managed_task_policy','run_authorities',
      'files','work_items','work_item_revisions','work_item_results','work_item_dependencies','work_item_owners','execution_handoffs','memory_entries','memory_revisions'];
    const snapshot = (db: Database.Database) => tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = snapshot(raw);
    expect(statSync(path + '-wal').size).toBeGreaterThan(0);
    upgraded = core.openDb(path, core.canonicalCommonDir(f.repo), f.repo);
    expect(upgraded.pragma('user_version', { simple: true })).toBe(18);
    expect(snapshot(upgraded)).toEqual(before);
    expect(upgraded.prepare('SELECT count(*) n FROM run_input_snapshots').get()).toEqual({ n: 0 });
    backup = new Database(path + '.v16.bak', { readonly: true });
    expect(backup.pragma('user_version', { simple: true })).toBe(16);
    expect(snapshot(backup)).toEqual(before);
    expect(upgraded.pragma('foreign_key_check')).toEqual([]);
    upgraded.close(); upgraded = core.openDb(path);
    expect(snapshot(upgraded)).toEqual(before);
    expect(upgraded.prepare('SELECT count(*) n FROM memory_revisions').get()).toEqual({ n: 1 });
    upgraded.pragma('user_version=19'); expect(() => core.openDb(path)).toThrow(/newer|version|schema/);
  } finally { backup?.close(); upgraded?.close(); raw.close(); }
});


it('archives immutable historical inputs under an authentic same-project controller', async () => {
  const f = memoryFixture(), t = f.task('archived'), id = '1'.repeat(32);
  const grant = { projectId:f.projectId, taskId:t.id, workItemId:'external', runId:'archive', generation:1,
    operations:['get_context'], repositories:[], native:{readableRoots:[],scratchDir:'/private/scratch',configHash:'2'.repeat(64)} };
  f.db.prepare('INSERT INTO run_authorities VALUES(?,?,?,?,?, ?,NULL,?,?,?)')
    .run(id,t.id,'external','archive',1,core.now()+100,'3'.repeat(64),JSON.stringify(grant),1);
  const payload = {authorityId:id,inputHash:'0'.repeat(64),createdAt:1,
    response:{projectId:f.projectId,taskId:t.id,workItemId:'external',runId:'archive',generation:1,
      task:{title:'archived',body:'contract',status:'new'},criteria:[],decisions:[],
      inputs:{schemaVersion:1,authorityId:id,inputHash:'0'.repeat(64),createdAt:1,
        budget:{maxBytes:65536,omittedRecords:0},requirements:[],rules:[],knowledge:[],workItem:null,
        dependencies:[],repositories:[],operations:['get_context'],nativeConfigHash:'2'.repeat(64)}},
    validation:{repositories:[],ownership:null,inputResults:[],artifacts:[]}};
  const {digest} = await import('../src/execution.js');
  const hash = digest({...payload,inputHash:undefined,response:{...payload.response,inputs:{...payload.response.inputs,inputHash:undefined}}});
  payload.inputHash=hash;payload.response.inputs.inputHash=hash;
  f.db.prepare('INSERT INTO run_input_snapshots VALUES(?,?,?,?)').run(id,hash,JSON.stringify(payload),1);
  const ref={projectId:f.projectId,authorityId:id};
  expect(core.runInputSnapshot(f.handle,ref)).toEqual(payload);
  expect(() => core.runInputSnapshot({...f.handle},ref)).toThrow();
  expect(() => core.runInputSnapshot(f.handle,{...ref,projectId:'f'.repeat(32)})).toThrow();
  expect(() => f.db.prepare('UPDATE run_input_snapshots SET created_at=2').run()).toThrow(/immutable/);
  expect(() => f.db.prepare('DELETE FROM run_input_snapshots').run()).toThrow(/immutable/);
  f.db.prepare('UPDATE run_authorities SET revoked_at=1').run();
  expect(core.runInputSnapshot(f.handle,ref)).toEqual(payload);
});

import {runInputFixture} from './run_inputs_fixture.js';
import * as inputs from '../src/run_inputs.js';
import {writeFileSync,linkSync,symlinkSync,mkdirSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
it('assembles complete inherited rules and contracts before the optional shortlist', () => {
  const f=runInputFixture(),parent=f.task('parent'),other=f.task('source');
  const children=core.createSubtasks(f.handle,{parent:f.ref(parent.id),expectedParentHash:core.taskContractHash(f.handle,f.ref(parent.id)),
    source:{kind:'manual',sourceTask:f.ref(parent.id),instructionRef:'fixture'},children:[
      {key:'own',title:'own',criteria:['own criterion']},{key:'sibling',title:'sibling',criteria:['sibling criterion']}]});
  for(const [taskId,body] of [[null,'project'],[parent.id,'parent'],[children.own.id,'own'],[children.sibling.id,'sibling private text'],[other.id,'foreign rule']] as const){
    const draft={...f.draft('rule',body),scope:{projectId:f.projectId,taskId}};
    core.writeMemory(f.handle,draft,f.proof(draft,'create','user'));
  }
  const fact=f.draft('fact','own optional fact');core.writeMemory(f.handle,fact,f.proof(fact,'create',['host','user']));
  const candidate=f.draft('candidate','own hidden candidate');core.writeMemory(f.handle,candidate,f.proof(candidate,'create','user'));
  const snapshot=f.db.transaction(()=>inputs.buildRunInputSnapshot(f.db,{...f.grant,taskId:children.own.id},'4'.repeat(32),{query:'own',k:1}))();
  expect(snapshot.response.inputs.requirements.map(r=>r.task.taskId)).toEqual([parent.id,children.own.id]);
  expect(snapshot.response.inputs.rules.map(r=>r.body).sort()).toEqual(['own','parent','project']);
  expect(JSON.stringify(snapshot.response)).not.toContain('sibling private text');
  expect(JSON.stringify(snapshot.response)).not.toContain('foreign rule');
  expect(JSON.stringify(snapshot.response)).not.toContain('candidate');
  expect(snapshot.response.inputs.knowledge.map(r=>r.body)).toEqual(['own optional fact']);
});
it('measures the escaped UTF8 envelope and never truncates mandatory text',()=>{
  const f=runInputFixture(),body='😀"\\\n'.repeat(120),rule=f.draft('rule',body);
  core.writeMemory(f.handle,rule,f.proof(rule,'create','user'));
  const build=(maxBytes=65536)=>f.db.transaction(()=>inputs.buildRunInputSnapshot(f.db,f.grant,'5'.repeat(32),{query:'',maxBytes}))();
  const s=build(9999),bytes=Buffer.byteLength(JSON.stringify({content:[{type:'text',text:JSON.stringify(s.response)}]}));
  expect(build(bytes).response.inputs.rules[0].body).toBe(body);
  expect(()=>build(bytes-1)).toThrow(/budget|limit/);
  expect(()=>build(65537)).toThrow();expect(()=>build(0)).toThrow();
});
it('copies only published contract bytes and keeps the artifact path private',()=>{
  const f=runInputFixture(),producer=core.createWorkItem(f.handle,{task:f.ref(f.t.id),definition:{kind:'architecture',repoId:null,sourceTasks:[],
    outputs:[{key:'api',kind:'contract',required:true,version:'v1',checkRefs:[]}]},dependencies:[]});
  const path=join(f.root,'api.json'),body='{"api":"v1"}\n';writeFileSync(path,body);
  const source={kind:'manual' as const,sourceTask:f.ref(f.t.id),instructionRef:'fixture'};
  const result=core.publishResult(f.handle,{commandId:'api',producer:producer.ref,expectedRevision:1,outputKey:'api',expectedResultId:null,source,
    payload:{kind:'contract',repoId:null,version:'v1',head:null,checkRefs:[],artifact:{path,sha256:createHash('sha256').update(body).digest('hex')}}});
  core.completeWorkItem(f.handle,{ref:producer.ref,expectedRevision:1,source});
  const consumer=core.createWorkItem(f.handle,{task:f.ref(f.t.id),definition:{kind:'analysis',repoId:null,sourceTasks:[],outputs:[]},
    dependencies:[{key:'api',producer:producer.ref,producerRevision:1,outputKey:'api',binding:{kind:'contract',repoId:null,version:'v1'}}]});
  const owner=core.reserveWorkItem(f.handle,{ref:consumer.ref,expectedRevision:1,expectedFence:0,expectedMode:'manual',ownerId:'fixture',write:false});
  const grant={...f.grant,workItemId:consumer.ref.workItemId,ownership:owner.ref,repositories:f.grant.repositories.map(r=>({...r,write:false}))};
  const s=f.db.transaction(()=>inputs.buildRunInputSnapshot(f.db,grant,'6'.repeat(32)))();
  expect(s.response.inputs.dependencies[0]).toMatchObject({resultId:result.id,artifact:{body,sha256:result.payload.kind==='contract'?result.payload.artifact.sha256:''}});
  expect(JSON.stringify(s.response)).not.toContain(path);
  writeFileSync(path,'changed');expect(()=>f.db.transaction(()=>inputs.buildRunInputSnapshot(f.db,grant,'7'.repeat(32)))()).toThrow();
});
it.each(['symlink','hardlink','utf8','secret','config','db','private-root'])('rejects unsafe published artifact bytes: %s',kind=>{
  expect(inputs.readRunArtifact).toBeTypeOf('function');
  const f=runInputFixture(),path=join(f.root,'document'),original=join(f.root,'original');writeFileSync(original,'safe');
  let target=path;
  if(kind==='symlink')symlinkSync(original,path);else if(kind==='hardlink')linkSync(original,path);
  else if(kind==='db')target=f.dbPath;else if(kind==='config'){target=join(f.root,'.npmrc');writeFileSync(target,'safe');}
  else if(kind==='private-root'){target=join(f.home,'config.json');writeFileSync(target,'safe');}
  else writeFileSync(target,kind==='utf8'?Buffer.from([255]):kind==='secret'?'token=ghp_123456789012345678901234567890123456':'safe');
  const hash=createHash('sha256').update(readFileSync(target)).digest('hex');
  expect(()=>inputs.readRunArtifact(f.db,target,hash,65536,[f.home],[])).toThrow();
});
it('omits optional records whole while preserving mandatory requirements at the measured limit',()=>{
  const f=runInputFixture(),fact={...f.draft('fact','context '+'optional '.repeat(600)),title:'context'};
  core.writeMemory(f.handle,fact,f.proof(fact,'create','host'));
  const build=(maxBytes:number)=>f.db.transaction(()=>inputs.buildRunInputSnapshot(f.db,f.grant,'8'.repeat(32),{maxBytes,query:'context'}))();
  const full=build(65536),small=build(2500);
  expect(full.response.inputs.knowledge).toHaveLength(1);
  expect(small.response.inputs.knowledge).toHaveLength(0);
  expect(small.response.inputs.budget.omittedRecords).toBe(1);
  expect(small.response.inputs.requirements[0].body).toBe('contract');
  expect(inputs.runContextWireBytes(small.response)).toBeLessThanOrEqual(2500);
});
it('allows a published document in the canonical private store files directory',()=>{
  const f=runInputFixture(),root=core.filesDir(f.dbPath);mkdirSync(root);
  const path=join(root,'api.txt');writeFileSync(path,'safe API');
  const hash=createHash('sha256').update('safe API').digest('hex');
  expect(inputs.readRunArtifact(f.db,path,hash,100,[f.home],[])).toBe('safe API');
});
it('keeps protected subtrees private inside an otherwise allowed checkout or files directory',()=>{
  const f=runInputFixture(),fileRoot=core.filesDir(f.dbPath);mkdirSync(fileRoot);
  for(const protectedRoot of [join(f.workspace,'controller'),f.workspace,join(fileRoot,'controller'),fileRoot]){
    mkdirSync(protectedRoot,{recursive:true});
    const path=join(protectedRoot,'bootstrap.json'),body=JSON.stringify({dbPath:f.dbPath,token:'b'.repeat(64)});
    writeFileSync(path,body);
    const hash=createHash('sha256').update(body).digest('hex');
    expect(()=>inputs.readRunArtifact(f.db,path,hash,65536,[f.root,protectedRoot],[f.workspace])).toThrow(/unsafe/);
  }
  const docs=join(f.workspace,'docs');mkdirSync(docs);
  const path=join(docs,'api.json'),body='{"api":"v1"}';writeFileSync(path,body);
  expect(inputs.readRunArtifact(f.db,path,createHash('sha256').update(body).digest('hex'),100,[f.root],[f.workspace])).toBe(body);
});

import {vi} from 'vitest';
// Only the expensive native attestation is isolated here; Git, SQLite and guards are real.
const proved=vi.hoisted(()=>new WeakSet<object>());
vi.mock('../src/codex_permissions.js',async importOriginal=>{
  const actual=await importOriginal<typeof import('../src/codex_permissions.js')>();
  return {...actual,assertVerifiedCodexPackage(packet:object){if(!proved.has(packet))throw new core.KddError('unverified native package');}};
});
it('rejects mandatory overflow before any grant, marker, snapshot or successful event',()=>{
  const f=runInputFixture(p=>proved.add(p));
  const rows=()=>['managed_task_policy','run_authorities','run_input_snapshots','events'].map(t=>f.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
  const before=rows();expect(()=>core.issueRunAuthority(f.handle,{...f.input,context:{maxBytes:1}})).toThrow(/budget|limit/);
  expect(rows()).toEqual(before);
  const first=core.issueRunAuthority(f.handle,f.input),prior=rows();
  expect(()=>core.issueRunAuthority(f.handle,{...f.input,expectedGeneration:1,context:{maxBytes:1}})).toThrow(/budget|limit/);
  expect(rows()).toEqual(prior);
  expect(core.openRunContext(f.db,first.token)).toEqual({kind:'run'});
});
it('atomically creates one immutable snapshot per generation without storing credentials',()=>{
  const f=runInputFixture(p=>proved.add(p)),first=core.issueRunAuthority(f.handle,f.input);
  const snapshot=core.runInputSnapshot(f.handle,{projectId:f.projectId,authorityId:first.authorityId});
  expect(snapshot.response.inputs.workItem).toBeNull();expect(snapshot.validation.ownership).toBeNull();
  const next=core.issueRunAuthority(f.handle,{...f.input,expectedGeneration:1,runId:'next'});
  expect(core.runInputSnapshot(f.handle,{projectId:f.projectId,authorityId:first.authorityId})).toEqual(snapshot);
  expect(core.runInputSnapshot(f.handle,{projectId:f.projectId,authorityId:next.authorityId}).response.generation).toBe(2);
  expect(()=>core.openRunContext(f.db,first.token)).toThrow();
  const archive=JSON.stringify(f.db.prepare('SELECT * FROM run_input_snapshots').all());
  expect(archive).not.toContain(first.token);expect(archive).not.toContain(f.scratch);
  expect(f.db.prepare('SELECT count(*) n FROM run_input_snapshots').get()).toEqual({n:2});
  expect(f.db.prepare("SELECT count(*) n FROM events WHERE action='run_inputs_snapshot'").get()).toEqual({n:2});
  expect(()=>core.issueRunAuthority(f.handle,{...f.input,expectedGeneration:2,snapshot:{}} as never)).toThrow();
});
import {ownedContextFixture} from './run_inputs_fixture.js';
it('refuses a published private bootstrap in a readable checkout before issuing authority',()=>{
  const f=runInputFixture(()=>{}),controlDir=join(f.workspace,'controller');mkdirSync(controlDir);
  const path=join(controlDir,'bootstrap.json'),body=JSON.stringify({dbPath:f.dbPath,token:'b'.repeat(64)});writeFileSync(path,body);
  const producer=core.createWorkItem(f.handle,{task:f.ref(f.t.id),definition:{kind:'architecture',repoId:null,sourceTasks:[],
    outputs:[{key:'api',kind:'contract',required:true,version:'v1',checkRefs:[]}]},dependencies:[]});
  const source={kind:'manual' as const,sourceTask:f.ref(f.t.id),instructionRef:'fixture'};
  core.publishResult(f.handle,{commandId:'bootstrap',producer:producer.ref,expectedRevision:1,outputKey:'api',expectedResultId:null,source,
    payload:{kind:'contract',repoId:null,head:null,version:'v1',checkRefs:[],artifact:{path,sha256:createHash('sha256').update(body).digest('hex')}}});
  core.completeWorkItem(f.handle,{ref:producer.ref,expectedRevision:1,source});
  const consumer=core.createWorkItem(f.handle,{task:f.ref(f.t.id),definition:{kind:'analysis',repoId:null,sourceTasks:[],outputs:[]},
    dependencies:[{key:'api',producer:producer.ref,producerRevision:1,outputKey:'api',binding:{kind:'contract',repoId:null,version:'v1'}}]});
  const owner=core.reserveWorkItem(f.handle,{ref:consumer.ref,expectedRevision:1,expectedFence:0,expectedMode:'manual',ownerId:'reader',write:false});
  const native={...f.input.native,controlDir,writableRoot:undefined,protectedPaths:[f.home,controlDir]};proved.add(native);
  const input={...f.input,native,role:roleFixture(f.handle,'read'),workItemId:consumer.ref.workItemId,ownership:owner.ref,repositories:f.input.repositories.map(r=>({...r,write:false}))};
  const rows=()=>['managed_task_policy','run_authorities','run_input_snapshots','events'].map(t=>f.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
  const before=rows();expect(()=>core.issueRunAuthority(f.handle,input)).toThrow(/unsafe/);expect(rows()).toEqual(before);
});
it('isolates caller mutation during observations and rolls back changes to captured requirements',()=>{
  const f=ownedContextFixture(p=>proved.add(p),true),supplied={...f.input,operations:[...f.input.operations]};
  supplied.contextObservers={observe:request=>{supplied.runId='injected';supplied.operations.length=0;return f.resultProof.observe!(request);}};
  const issued=core.issueRunAuthority(f.handle,supplied);
  expect(core.runInputSnapshot(f.handle,{projectId:f.projectId,authorityId:issued.authorityId}).response.runId).toBe('context-run');
  const before=f.db.prepare('SELECT * FROM run_authorities').all();
  const changed={...f.input,expectedGeneration:1,contextObservers:{observe:(request:core.EvidenceRequest)=>{
    f.db.prepare('UPDATE tasks SET body=? WHERE id=?').run('callback change',f.t.id);return f.resultProof.observe!(request);}}};
  expect(()=>core.issueRunAuthority(f.handle,changed)).toThrow(/inputs.*changed/);
  expect(f.db.prepare('SELECT * FROM run_authorities').all()).toEqual(before);
  expect(core.mustGetTask(f.db,f.t.id).body).toBe('contract');
});
it('refuses a retained legacy authority without fabricating a snapshot',()=>{
  const f=runInputFixture(p=>proved.add(p)),id='c'.repeat(32),token='d'.repeat(64);
  core.protectTask(f.handle,f.t.id);
  f.db.prepare('INSERT INTO run_authorities VALUES(?,?,?,?,?, ?,NULL,?,?,?)').run(id,f.t.id,f.input.workItemId,f.input.runId,1,
    core.now()+3600,createHash('sha256').update(token).digest('hex'),JSON.stringify(f.grant),core.now());
  expect(()=>core.openRunContext(f.db,token)).toThrow();
  expect(f.db.prepare('SELECT count(*) n FROM run_input_snapshots').get()).toEqual({n:0});
});
