import Database from 'better-sqlite3';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import * as core from '../src/index.js';
import * as runtime from '../src/runtime.js';
import {ownedContextFixture} from './run_inputs_fixture.js';
import {cleanupFixtures} from './execution_fixture.js';

const proved=vi.hoisted(()=>new WeakSet<object>());
vi.mock('../src/codex_permissions.js',async importOriginal=>{
  const actual=await importOriginal<typeof import('../src/codex_permissions.js')>();
  return {...actual,assertVerifiedCodexPackage(packet:object){
    if(!proved.has(packet))throw new core.KddError('unverified native package');
  }};
});
afterEach(()=>{cleanupFixtures();vi.restoreAllMocks()});
const limits={timeoutMs:10000,idleTimeoutMs:5000,stopGraceMs:100,drainMs:100,
  maxPromptBytes:65536,maxEventBytes:65536,maxStreamBytes:1048576,maxStderrBytes:65536,maxConcurrentAttempts:1};

it('preserves populated v18 WAL and exact historical input/role bytes',()=>{
  const root=mkdtempSync(join(tmpdir(),'kdd-runtime-upgrade-')),path=join(root,'board.db');
  const old=new Database(path);let upgraded:Database.Database|undefined;
  try{
    old.pragma('journal_mode=WAL');old.pragma('wal_autocheckpoint=0');old.pragma('foreign_keys=ON');
    for(const sql of core.MIGRATIONS.slice(0,18))old.exec(sql);
    old.pragma('user_version=18');
    old.exec(`INSERT INTO tasks(id,title,created_at,updated_at) VALUES(41,'retained',1,1);
      INSERT INTO files VALUES(7,41,'hash','txt','kept.txt','text/plain',4,'retained',1);
      INSERT INTO run_authorities VALUES('old',41,'external','run',1,9999999999,NULL,'hash','{}',1);
      INSERT INTO run_input_snapshots VALUES('old','${'a'.repeat(64)}','{"historical":true}',1);
      INSERT INTO role_profiles VALUES('role','project','Retained',1,NULL);
      INSERT INTO role_revisions VALUES('role',1,'{}','${'b'.repeat(64)}','${'c'.repeat(64)}',1,'old','${'d'.repeat(64)}');
      INSERT INTO role_skill_files VALUES('role',1,'guide','SKILL.md','${'e'.repeat(64)}','text/markdown',X'00FF');`);
    old.transaction(()=>old.exec(`
      INSERT INTO work_items(id,task_id,current_revision,state,fence,created_at) VALUES('item',41,1,'pending',2,1);
      INSERT INTO work_item_revisions VALUES('item',1,'{}','{}','hash',1);
      INSERT INTO execution_handoffs VALUES('handoff','handoff-command',41,'manual','manual','{}',1,2,'{}');
      INSERT INTO work_item_owners VALUES('item',1,1,'old','manual',1,'{}',NULL,NULL,1,2,'handoff');
      INSERT INTO work_item_owners VALUES('item',2,1,'active','manual',1,'{}','launch','{"launchId":"launch","writerScopeId":"writers"}',3,NULL,NULL);
    `))();
    const ownersBefore=old.prepare('SELECT * FROM work_item_owners ORDER BY fence').all();
    const tables=['tasks','files','run_authorities','run_input_snapshots','role_profiles','role_revisions','role_skill_files'];
    const before=Object.fromEntries(tables.map(t=>[t,old.prepare(`SELECT * FROM ${t}`).all()]));
    upgraded=core.openDb(path);
    expect(upgraded.pragma('user_version',{simple:true})).toBe(19);
    for(const table of tables)expect(upgraded.prepare(`SELECT * FROM ${table}`).all()).toEqual(before[table]);
    for(const table of ['runtime_sessions','runtime_attempts','runtime_events','work_item_retirements'])
      expect(upgraded.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual({n:0});
    expect(upgraded.pragma('foreign_key_check')).toEqual([]);
    expect((upgraded.prepare('SELECT * FROM work_item_owners ORDER BY fence').all() as Record<string,unknown>[])
      .map(({release_retirement_id,...owner})=>owner)).toEqual(ownersBefore);
    expect(upgraded.prepare('SELECT fence FROM work_item_owners WHERE released_at IS NULL').all()).toEqual([{fence:2}]);
    const backup=new Database(`${path}.v18.bak`,{readonly:true});
    try{expect(backup.pragma('user_version',{simple:true})).toBe(18);
      for(const table of tables)expect(backup.prepare(`SELECT * FROM ${table}`).all()).toEqual(before[table]);
    }finally{backup.close()}
    upgraded.close();upgraded=core.openDb(path);
    expect(upgraded.prepare('SELECT * FROM run_input_snapshots').all()).toEqual(before.run_input_snapshots);
  }finally{upgraded?.close();old.close();rmSync(root,{recursive:true,force:true})}
});

function admitted(){
  const f=ownedContextFixture(p=>proved.add(p));
  const issued=core.issueRunAuthority(f.handle,f.input);
  writeFileSync(f.input.native.brokerConfigPath!,JSON.stringify({token:issued.token}));
  const input={commandId:'start:1',owner:f.owner.ref,
    authority:{authorityId:issued.authorityId,workItemId:f.item.ref.workItemId,runId:f.input.runId,generation:issued.generation},
    runtime:'codex' as const,version:'codex-cli 0.159.0',model:'gpt-6-sol',effort:'high',
    semanticHash:'f'.repeat(64),inputHash:core.runInputSnapshot(f.handle,{projectId:f.projectId,authorityId:issued.authorityId}).inputHash,
    phase:'start' as const,limits};
  return {...f,issued,input,issueInput:f.input};
}

it('admits one durable intent and returns exact replay after reopen',()=>{
  const f=admitted(),admit=()=>f.db.transaction(()=>runtime.admitRuntimeDb(f.db,f.input)).immediate();
  const first=admit();expect(first.state).toBe('created');expect(first.providerSessionId).toBeNull();
  expect(core.ownership(f.handle,f.owner.ref).launchIntent).toMatchObject({launchId:first.ref.attemptId,authority:f.input.authority});
  expect(admit()).toEqual(first);
  const other=core.openDb(f.dbPath),handle=core.openController(other);
  try{
    expect(other.transaction(()=>runtime.admitRuntimeDb(other,f.input)).immediate()).toEqual(first);
    expect(core.runtimeAttempt(handle,first.ref)).toEqual(first);
    expect(()=>other.transaction(()=>runtime.admitRuntimeDb(other,{...f.input,model:'different'})).immediate()).toThrow(/conflict/);
    expect(()=>other.transaction(()=>runtime.admitRuntimeDb(other,{...f.input,commandId:'other'})).immediate()).toThrow(/active|launch/);
    expect(other.prepare('SELECT count(*) n FROM runtime_attempts').get()).toEqual({n:1});
  }finally{other.close()}
  expect(()=>core.runtimeAttempt(f.handle,{...first.ref,projectId:'foreign'})).toThrow();
  expect(()=>core.runtimeAttempt(f.handle,{...first.ref,sessionId:'0'.repeat(32)})).toThrow();
});

it('rejects admission outside a transaction, invalid limits and wrong input/authority bindings without writes',()=>{
  const f=admitted();
  expect(()=>runtime.admitRuntimeDb(f.db,f.input)).toThrow(/transaction/);
  for(const patch of [{limits:{...limits,timeoutMs:Infinity}},{limits:{...limits,maxConcurrentAttempts:0}},
    {limits:{...limits,maxStreamBytes:64*1024*1024+1}},
    {limits:{...limits,hardCostUsd:1}},{inputHash:'0'.repeat(64)},
    {authority:{...f.input.authority,generation:999}}]){
    expect(()=>f.db.transaction(()=>runtime.admitRuntimeDb(f.db,{...f.input,...patch})).immediate()).toThrow();
  }
  expect(f.db.prepare('SELECT count(*) n FROM runtime_attempts').get()).toEqual({n:0});
  expect(core.ownership(f.handle,f.owner.ref).launchIntent).toBeNull();
});

it('journals redacted events in sequence and keeps rows append-only',()=>{
  const f=admitted(),attempt=f.db.transaction(()=>runtime.admitRuntimeDb(f.db,f.input)).immediate();
  const token='sk-'+ 'S'.repeat(30);
  f.db.transaction(()=>{
    runtime.appendRuntimeEventDb(f.db,attempt.ref,'text',{text:`secret ${token} ${f.issued.token}`},[f.issued.token]);
    runtime.appendRuntimeEventDb(f.db,attempt.ref,'error',{reason:'provider_error'});
    runtime.appendRuntimeEventDb(f.db,attempt.ref,'text',{text:'SERVICE_TOKEN=abc12345abc12345\n'});
  }).immediate();
  const events=core.runtimeEvents(f.handle,{ref:attempt.ref,afterSequence:0,limit:100});
  expect(events.map(e=>e.sequence)).toEqual([1,2,3]);
  expect(JSON.stringify(events)).not.toContain(token);
  expect(JSON.stringify(events)).not.toContain(f.issued.token);
  expect(events[0].detail).toEqual({text:'secret [redacted] [redacted]'});
  expect(events[2].detail).toEqual({text:'SERVICE_TOKEN=[redacted]\n'});
  expect(core.runtimeEvents(f.handle,{ref:attempt.ref,afterSequence:1,limit:1})).toEqual([events[1]]);
  expect(()=>f.db.prepare('UPDATE runtime_events SET kind=?').run('error')).toThrow(/immutable/);
  expect(()=>f.db.prepare('DELETE FROM runtime_events').run()).toThrow(/immutable/);
  expect(()=>f.db.transaction(()=>runtime.appendRuntimeEventDb(f.db,attempt.ref,'text',{text:'x'.repeat(65537)})).immediate()).toThrow(/limit|oversize/);
});

it('rejects redaction expansion past the event limit without inserting a row',()=>{
  const f=admitted();f.input.limits={...limits,maxEventBytes:33};
  const attempt=f.db.transaction(()=>runtime.admitRuntimeDb(f.db,f.input)).immediate();
  expect(()=>f.db.transaction(()=>runtime.appendRuntimeEventDb(f.db,attempt.ref,'text',{text:'SERVICE_TOKEN=abcdefgh'})).immediate()).toThrow(/limit/);
  expect(core.runtimeEvents(f.handle,{ref:attempt.ref,afterSequence:0,limit:100})).toEqual([]);
});

it('revokes only the retired grant and recognises the scoped receipt in a later task handoff',async()=>{
  const f=admitted(),attempt=f.db.transaction(()=>runtime.admitRuntimeDb(f.db,f.input)).immediate();
  const item=core.createWorkItem(f.handle,{task:f.ref(f.t.id),definition:f.item.definition,dependencies:[]});
  const sibling=core.reserveWorkItem(f.handle,{ref:item.ref,expectedRevision:1,expectedFence:0,expectedMode:'manual',ownerId:'sibling',write:true});
  const second=core.issueRunAuthority(f.handle,{...f.issueInput,workItemId:item.ref.workItemId,ownership:sibling.ref,runId:'sibling-run',expectedGeneration:0});
  const result=await core.retireOwnership(f.handle,{commandId:'stop',owner:f.owner.ref},async owner=>({observationId:'stop-proof',owner:owner.ref,
    launchId:owner.launchIntent!.launchId,writerScopeId:owner.launchIntent!.writerScopeId,observedAt:core.now(),verdict:'stopped',complete:true,
    writers:[{id:'process-group',state:'gone'}]}));
  expect(result).toMatchObject({status:'complete',receipt:{revokedAuthorityIds:[f.issued.authorityId]}});
  expect(f.db.prepare('SELECT revoked_at FROM run_authorities WHERE authority_id=?').get(second.authorityId)).toEqual({revoked_at:null});
  expect(core.ownership(f.handle,sibling.ref).releasedAt).toBeNull();
  expect(()=>core.readRunContext(core.openRunContext(f.db,f.issued.token))).toThrow(/denied/);
  const transfer=core.beginHandoff(f.handle,{commandId:'transfer-after-retire',task:f.ref(f.t.id),expectedMode:'manual',targetMode:'manual',expectedOwners:[sibling.ref]});
  expect(await core.finishHandoff(f.handle,{handoffId:transfer.id})).toMatchObject({status:'complete'});
  expect(core.runtimeAttempt(f.handle,attempt.ref).state).toBe('created');
});
