import { afterEach, expect, it } from 'vitest';
import * as core from '../src/index.js';
import { cleanupFixtures, fixture } from './execution_fixture.js';
afterEach(cleanupFixtures);
function ownedFlow() {
  const f=fixture(), task=f.task('implementation');
  const item=core.createWorkItem(f.handle,{task:f.ref(task.id),definition:{kind:'implementation',repoId:null,sourceTasks:[],outputs:[]},dependencies:[]});
  const input:core.ReserveWorkItemInput={ref:item.ref,expectedRevision:1,expectedFence:0,expectedMode:'manual',ownerId:'controller:a',write:true};
  return {...f,task,item,input};
}
it('keeps one owner and refuses expired legacy claims before creating a marker',()=>{
  const f=ownedFlow();
  f.db.prepare("UPDATE tasks SET status='in_progress',claimed_by='ai:old',claim_expires=1 WHERE id=?").run(f.task.id);
  expect(()=>core.reserveWorkItem(f.handle,f.input)).toThrow(/legacy.*writer|claim/);
  expect(f.db.prepare('SELECT * FROM managed_task_policy').all()).toEqual([]);
  f.db.prepare("UPDATE tasks SET status='new',claimed_by=NULL,claim_expires=NULL WHERE id=?").run(f.task.id);
  const owner=core.reserveWorkItem(f.handle,f.input);expect(owner.ref.fence).toBe(1);
  expect(()=>core.reserveWorkItem(f.handle,{...f.input,ownerId:'controller:b'})).toThrow(/owner|fence/);
  expect(f.db.prepare('SELECT count(*) n FROM work_item_owners WHERE released_at IS NULL').get()).toEqual({n:1});
});
it('holds a launched owner on missing or throwing observer and rejects never_started JSON',async()=>{
  const f=ownedFlow(),owner=core.reserveWorkItem(f.handle,f.input);
  core.recordLaunchIntent(f.handle,{owner:owner.ref,intent:{launchId:'launch:1',writerScopeId:'writers:1'}});
  const transfer=core.beginHandoff(f.handle,{commandId:'handoff:1',task:f.ref(f.task.id),expectedMode:'manual',targetMode:'orchestrated',expectedOwners:[owner.ref]});
  expect(await core.finishHandoff(f.handle,{handoffId:transfer.id})).toEqual({status:'held',handoffId:transfer.id,reason:'missing_observer'});
  expect((await core.finishHandoff(f.handle,{handoffId:transfer.id},async()=>{throw Error('offline')})).status).toBe('held');
  expect((await core.finishHandoff(f.handle,{handoffId:transfer.id},async()=>({verdict:'never_started'} as unknown as core.StopObservation))).status).toBe('held');
  expect(core.ownership(f.handle,owner.ref).releasedAt).toBeNull();
  expect(core.mustGetTask(f.db,f.task.id).execution_mode).toBe('manual');
});

const stopped=(owner:core.OwnershipRecord):core.StopObservation=>({observationId:'host:stop',owner:owner.ref,
  launchId:owner.launchIntent!.launchId,writerScopeId:owner.launchIntent!.writerScopeId,observedAt:core.now(),verdict:'stopped',complete:true,
  writers:[{id:'writer:1',state:'gone'}]});
it('releases never-started owners atomically, retains policy, advances fences and preserves child control',async()=>{
  const f=ownedFlow();
  const child=core.createSubtasks(f.handle,{parent:f.ref(f.task.id),expectedParentHash:core.taskContractHash(f.handle,f.ref(f.task.id)),
    source:{kind:'manual',sourceTask:f.ref(f.task.id),instructionRef:'split'},children:[{key:'c',title:'child',criteria:['deliver']}]}).c;
  const childItem=core.createWorkItem(f.handle,{task:f.ref(child.id),definition:f.item.definition,dependencies:[]});
  const childOwner=core.reserveWorkItem(f.handle,{...f.input,ref:childItem.ref,ownerId:'child'});
  const owner=core.reserveWorkItem(f.handle,f.input);
  const input={commandId:'transfer',task:f.ref(f.task.id),expectedMode:'manual' as const,targetMode:'orchestrated' as const,expectedOwners:[owner.ref]};
  const transfer=core.beginHandoff(f.handle,input);
  expect(core.beginHandoff(f.handle,input).id).toBe(transfer.id);
  expect(()=>core.beginHandoff(f.handle,{...input,targetMode:'manual'})).toThrow(/conflict/);
  expect(()=>core.reserveWorkItem(f.handle,{...f.input,expectedFence:1,ownerId:'second'})).toThrow(/handoff/);
  const finished=await core.finishHandoff(f.handle,{handoffId:transfer.id});
  expect(finished).toMatchObject({status:'complete',receipt:{mode:'orchestrated',released:[owner.ref],stops:[{outcome:'never_started'}]}});
  const events=f.db.prepare('SELECT * FROM events').all();
  expect(await core.finishHandoff(f.handle,{handoffId:transfer.id})).toEqual(finished);
  expect(f.db.prepare('SELECT * FROM events').all()).toEqual(events);
  expect(core.mustGetTask(f.db,child.id).execution_mode).toBe('manual');
  expect(core.ownership(f.handle,childOwner.ref).releasedAt).toBeNull();
  expect(()=>core.moveTask(f.db,f.task.id,'done',{type:'user'},'user said so')).toThrow(/managed/);
  const second=core.reserveWorkItem(f.handle,{...f.input,expectedFence:1,expectedMode:'orchestrated',ownerId:'second'});
  expect(second.ref.fence).toBe(2);expect(core.ownership(f.handle,owner.ref).releasedAt).not.toBeNull();
  expect(()=>core.recordLaunchIntent(f.handle,{owner:owner.ref,intent:{launchId:'old',writerScopeId:'old'}})).toThrow(/fence/);
});
it('changes an idle card mode through the same idempotent protocol without a stop observer',async()=>{
  const f=ownedFlow(), input={commandId:'mode',task:f.ref(f.task.id),expectedMode:'manual' as const,targetMode:'orchestrated' as const,expectedOwners:[]};
  const transfer=core.beginHandoff(f.handle,input);
  expect(await core.finishHandoff(f.handle,{handoffId:transfer.id})).toMatchObject({status:'complete',receipt:{released:[],stops:[]}});
  expect(core.mustGetTask(f.db,f.task.id).execution_mode).toBe('orchestrated');
  expect(f.db.prepare('SELECT * FROM managed_task_policy').all()).toEqual([]);
});
it('requires an exact complete owner set and holds every reservation if one writer remains alive',async()=>{
  const f=ownedFlow(), first=core.reserveWorkItem(f.handle,f.input);
  const secondItem=core.createWorkItem(f.handle,{task:f.ref(f.task.id),definition:f.item.definition,dependencies:[]});
  const second=core.reserveWorkItem(f.handle,{...f.input,ref:secondItem.ref,ownerId:'second'});
  const input={commandId:'handoff',task:f.ref(f.task.id),expectedMode:'manual' as const,targetMode:'manual' as const,expectedOwners:[first.ref,second.ref]};
  const before=f.db.prepare('SELECT * FROM events').all();
  expect(()=>core.beginHandoff(f.handle,{...input,expectedOwners:[first.ref]})).toThrow(/snapshot/);
  expect(()=>core.beginHandoff(f.handle,{...input,expectedOwners:[first.ref,{...second.ref,fence:999}]})).toThrow(/snapshot/);
  expect(f.db.prepare('SELECT * FROM events').all()).toEqual(before);
  core.recordLaunchIntent(f.handle,{owner:second.ref,intent:{launchId:'launch',writerScopeId:'scope'}});
  const transfer=core.beginHandoff(f.handle,input);
  const outcome=await core.finishHandoff(f.handle,{handoffId:transfer.id},async owner=>({...stopped(owner),verdict:'live',writers:[{id:'child',state:'alive'}]}));
  expect(outcome).toMatchObject({status:'held',reason:'live'});
  expect(core.ownership(f.handle,first.ref).releasedAt).toBeNull();expect(core.ownership(f.handle,second.ref).releasedAt).toBeNull();
});
it('rejects incomplete, stale and mismatched stop evidence, then accepts a fresh bound observation',async()=>{
  const f=ownedFlow(),owner=core.reserveWorkItem(f.handle,f.input), intent={launchId:'launch',writerScopeId:'scope'};
  const launched=core.recordLaunchIntent(f.handle,{owner:owner.ref,intent});
  const events=f.db.prepare('SELECT * FROM events').all();
  expect(core.recordLaunchIntent(f.handle,{owner:owner.ref,intent})).toEqual(launched);
  expect(f.db.prepare('SELECT * FROM events').all()).toEqual(events);
  expect(()=>core.recordLaunchIntent(f.handle,{owner:owner.ref,intent:{...intent,launchId:'different'}})).toThrow(/already/);
  const transfer=core.beginHandoff(f.handle,{commandId:'stop',task:f.ref(f.task.id),expectedMode:'manual',targetMode:'orchestrated',expectedOwners:[owner.ref]});
  const bad=[{complete:false},{writers:[]},{writers:[{id:'writer',state:'unknown'}]},
    {writers:[{id:'writer',state:'gone'},{id:'writer',state:'gone'}]}, {verdict:'unknown'}, {observedAt:core.now()-5},
    {observedAt:Infinity}, {owner:{...owner.ref,fence:owner.ref.fence+1}}, {writerScopeId:'wrong'}, {launchId:'wrong'}, {verified:true}];
  for(const patch of bad) {
    const outcome=await core.finishHandoff(f.handle,{handoffId:transfer.id},async()=>({...stopped(launched),...patch} as core.StopObservation));
    expect(outcome.status).toBe('held');expect(core.ownership(f.handle,owner.ref).releasedAt).toBeNull();
  }
  expect(await core.finishHandoff(f.handle,{handoffId:transfer.id},async live=>stopped(live))).toMatchObject({status:'complete'});
});
it('refuses invalid expected integers, blocked/archive/backlog states and write=false implementation',()=>{
  const f=ownedFlow(), before=f.db.prepare('SELECT * FROM events').all();
  for(const value of [NaN,Infinity,-1,0.5,Number.MAX_SAFE_INTEGER+1]) {
    expect(()=>core.reserveWorkItem(f.handle,{...f.input,expectedFence:value})).toThrow();
    expect(()=>core.reserveWorkItem(f.handle,{...f.input,expectedRevision:value})).toThrow();
  }
  expect(()=>core.reserveWorkItem(f.handle,{...f.input,write:false})).toThrow(/write/);
  for(const sql of ["UPDATE tasks SET status='backlog'", "UPDATE tasks SET status='review'", "UPDATE tasks SET status='done'",'UPDATE tasks SET blocked=1','UPDATE tasks SET archived_at=1']) {
    f.db.exec(sql);expect(()=>core.reserveWorkItem(f.handle,f.input)).toThrow(/reservable/);
    f.db.exec("UPDATE tasks SET status='new',blocked=0,archived_at=NULL");
  }
  f.db.prepare('UPDATE work_items SET fence=?').run(Number.MAX_SAFE_INTEGER);
  expect(()=>core.reserveWorkItem(f.handle,{...f.input,expectedFence:Number.MAX_SAFE_INTEGER})).toThrow(/overflow/);
  expect(f.db.prepare('SELECT * FROM events').all()).toEqual(before);
  expect(f.db.prepare('SELECT * FROM managed_task_policy').all()).toEqual([]);
});

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
it('fences result writes and keeps completed outputs valid through confirmed stop and credential retirement',async()=>{
  const f=fixture(), task=f.task('contract'), consumerTask=f.task('consumer');
  const item=core.createWorkItem(f.handle,{task:f.ref(task.id),definition:{kind:'architecture',repoId:null,sourceTasks:[],
    outputs:[{key:'api',kind:'contract',required:true,version:'v1',checkRefs:[]}]},dependencies:[]});
  const owner=core.reserveWorkItem(f.handle,{ref:item.ref,expectedRevision:1,expectedFence:0,expectedMode:'manual',ownerId:'host',write:false});
  const artifact=join(f.root,'api');writeFileSync(artifact,'API');
  const source:core.ResultSource={kind:'owned',owner:owner.ref,instructionRef:'publish'};
  const publication:core.PublishResultInput={commandId:'candidate',producer:item.ref,expectedRevision:1,outputKey:'api',expectedResultId:null,source,
    payload:{kind:'contract',repoId:null,head:null,version:'v1',checkRefs:[],artifact:{path:artifact,sha256:createHash('sha256').update('API').digest('hex')}}};
  for(const patch of [{fence:2},{revision:999},{ownerId:'other'},{projectId:'foreign'}]) {
    expect(()=>core.publishResult(f.handle,{...publication,source:{...source,owner:{...owner.ref,...patch}}})).toThrow();
  }
  const result=core.publishResult(f.handle,publication);
  core.completeWorkItem(f.handle,{ref:item.ref,expectedRevision:1,source});
  expect(core.ownership(f.handle,owner.ref).releasedAt).toBeNull();
  const consumer=core.createWorkItem(f.handle,{task:f.ref(consumerTask.id),definition:{kind:'analysis',repoId:null,sourceTasks:[],outputs:[]},
    dependencies:[{key:'api',producer:item.ref,producerRevision:1,outputKey:'api',binding:{kind:'contract',repoId:null,version:'v1'}}]});
  const transfer=core.beginHandoff(f.handle,{commandId:'release',task:f.ref(task.id),expectedMode:'manual',targetMode:'manual',expectedOwners:[owner.ref]});
  await core.finishHandoff(f.handle,{handoffId:transfer.id});
  expect(core.inspectDependencies(f.handle,consumer.ref).ready).toBe(true);
  expect(core.result(f.handle,result.id).source).toEqual(source);
  expect(()=>core.publishResult(f.handle,publication)).toThrow(/fence/);
  expect(()=>core.reserveWorkItem(f.handle,{ref:item.ref,expectedRevision:1,expectedFence:1,expectedMode:'manual',ownerId:'another',write:false})).toThrow(/reservable/);
});
it('retains frozen owner inputs after parent requirements change and permits safe stop',async()=>{
  const f=fixture(), parent=f.task('parent');
  const child=core.createSubtasks(f.handle,{parent:f.ref(parent.id),expectedParentHash:core.taskContractHash(f.handle,f.ref(parent.id)),
    source:{kind:'manual',sourceTask:f.ref(parent.id),instructionRef:'split'},children:[{key:'c',title:'child',criteria:['outcome']}]}).c;
  const item=core.createWorkItem(f.handle,{task:f.ref(child.id),definition:{kind:'implementation',repoId:null,sourceTasks:[],outputs:[]},dependencies:[]});
  const owner=core.reserveWorkItem(f.handle,{ref:item.ref,expectedRevision:1,expectedFence:0,expectedMode:'manual',ownerId:'host',write:true});
  expect(()=>core.reviseWorkItem(f.handle,{ref:item.ref,expectedRevision:1,definition:item.definition,dependencies:[]})).toThrow(/owned/);
  core.editTask(f.db,parent.id,{body:'new requirements'},{type:'user'});
  expect(core.inspectDependencies(f.handle,item.ref).inputsCurrent).toBe(false);
  expect(core.ownership(f.handle,owner.ref)).toEqual(owner);
  expect(()=>core.completeWorkItem(f.handle,{ref:item.ref,expectedRevision:1,source:{kind:'owned',owner:owner.ref,instructionRef:'done'}})).toThrow(/stale/);
  const transfer=core.beginHandoff(f.handle,{commandId:'stop stale',task:f.ref(child.id),expectedMode:'manual',targetMode:'manual',expectedOwners:[owner.ref]});
  expect(await core.finishHandoff(f.handle,{handoffId:transfer.id})).toMatchObject({status:'complete'});
});

import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
it('holds ownership while a real orphaned fixture writer is alive, then releases after the full tree stops',async()=>{
  const f=ownedFlow(),owner=core.reserveWorkItem(f.handle,f.input),scope=randomBytes(16).toString('hex'),artifact=join(f.root,'writes');
  const intent={launchId:'fixture:'+scope,writerScopeId:scope};
  core.recordLaunchIntent(f.handle,{owner:owner.ref,intent});
  const transfer=core.beginHandoff(f.handle,{commandId:'tree',task:f.ref(f.task.id),expectedMode:'manual',targetMode:'manual',expectedOwners:[owner.ref]});
  const parent=fork(fileURLToPath(new URL('./fixtures/execution_tree.mjs',import.meta.url)),['parent',scope,artifact],
    {execPath:process.execPath,detached:true,stdio:['ignore','ignore','pipe','ipc']});
  let childPid:number|undefined;
  const alive=(pid:number)=>{try{process.kill(pid,0);return true}catch{return false}};
  const pause=()=>new Promise<void>(resolve=>setTimeout(resolve,25));
  const waitUntil=async(condition:()=>boolean)=>{const end=Date.now()+5000;while(!condition()){if(Date.now()>end)throw Error('fixture lifecycle timeout');await pause()}};
  try {
    const message=(await Promise.race([once(parent,'message'),new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('fixture ready timeout')),5000))]))[0] as {scope:string;parentPid:number;childPid:number;pid:number};
    expect(message.scope).toBe(scope);expect(message.parentPid).toBe(parent.pid);expect(message.pid).toBe(message.childPid);childPid=message.childPid;
    await waitUntil(()=>{try{return readFileSync(artifact,'utf8').length>0}catch{return false}});
    const exited=once(parent,'exit');parent.send('exit-parent');await exited;
    const size=readFileSync(artifact).length;await waitUntil(()=>readFileSync(artifact).length>size);
    const observer:core.StopObserver=async record=>{
      const writers=[{id:scope+':parent',state:alive(parent.pid!)?'alive' as const:'gone' as const},
        {id:scope+':child',state:alive(childPid!)?'alive' as const:'gone' as const}];
      return {...stopped(record),observationId:scope+':observed',writers,verdict:writers.some(w=>w.state==='alive')?'live':'stopped'};
    };
    expect(await core.finishHandoff(f.handle,{handoffId:transfer.id},observer)).toMatchObject({status:'held',reason:'live'});
    expect(()=>core.reserveWorkItem(f.handle,{...f.input,expectedFence:1,ownerId:'second'})).toThrow(/handoff/);
    process.kill(childPid,'SIGKILL');await waitUntil(()=>!alive(childPid!));
    expect(await core.finishHandoff(f.handle,{handoffId:transfer.id},observer)).toMatchObject({status:'complete'});
    expect(core.ownership(f.handle,owner.ref).releasedAt).not.toBeNull();
  }finally {
    try{if(parent.pid)process.kill(-parent.pid,'SIGKILL')}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error}
    if(childPid)await waitUntil(()=>!alive(childPid!));
    if(parent.exitCode===null&&parent.signalCode===null)await once(parent,'exit');
  }
},15000);

it('rejects a stale publication and mandatory output after a new fence, even when its command is named candidate',async()=>{
  const f=fixture(),task=f.task('output'),item=core.createWorkItem(f.handle,{task:f.ref(task.id),definition:{kind:'analysis',repoId:null,sourceTasks:[],
    outputs:[{key:'api',kind:'contract',required:true,version:'v1',checkRefs:[]}]},dependencies:[]});
  const input:core.ReserveWorkItemInput={ref:item.ref,expectedRevision:1,expectedFence:0,expectedMode:'manual',ownerId:'first',write:false};
  const first=core.reserveWorkItem(f.handle,input),artifact=join(f.root,'artifact');writeFileSync(artifact,'API');
  const publication:core.PublishResultInput={commandId:'candidate',producer:item.ref,expectedRevision:1,outputKey:'api',expectedResultId:null,
    source:{kind:'owned',owner:first.ref,instructionRef:'publish'},payload:{kind:'contract',repoId:null,head:null,version:'v1',checkRefs:[],artifact:{path:artifact,sha256:createHash('sha256').update('API').digest('hex')}}};
  core.publishResult(f.handle,publication);
  const transfer=core.beginHandoff(f.handle,{commandId:'release',task:f.ref(task.id),expectedMode:'manual',targetMode:'manual',expectedOwners:[first.ref]});
  await core.finishHandoff(f.handle,{handoffId:transfer.id});
  const second=core.reserveWorkItem(f.handle,{...input,expectedFence:1,ownerId:'second'});
  const events=f.db.prepare('SELECT * FROM events').all();
  expect(()=>core.publishResult(f.handle,publication)).toThrow(/fence/);
  expect(()=>core.completeWorkItem(f.handle,{ref:item.ref,expectedRevision:1,source:{kind:'owned',owner:second.ref,instructionRef:'complete'}})).toThrow(/stale_revision/);
  expect(f.db.prepare('SELECT * FROM events').all()).toEqual(events);
});
it('runs the stop observer outside SQL and rechecks the snapshot before releasing',async()=>{
  const f=ownedFlow(),owner=core.reserveWorkItem(f.handle,f.input);
  core.recordLaunchIntent(f.handle,{owner:owner.ref,intent:{launchId:'launch',writerScopeId:'scope'}});
  const transfer=core.beginHandoff(f.handle,{commandId:'observe',task:f.ref(f.task.id),expectedMode:'manual',targetMode:'manual',expectedOwners:[owner.ref]});
  const outcome=await core.finishHandoff(f.handle,{handoffId:transfer.id},async record=>{
    const other=core.openDb(f.dbPath);
    try {other.transaction(()=>other.prepare("INSERT INTO meta(key,value) VALUES('stop-observer','outside transaction')").run()).immediate()}
    finally{other.close()}
    f.db.prepare("UPDATE work_item_owners SET launch_json=json_set(launch_json,'$.writerScopeId','changed') WHERE work_item_id=?").run(owner.ref.workItemId);
    return stopped(record);
  });
  expect(outcome).toMatchObject({status:'held',reason:'snapshot_changed'});
  expect(core.ownership(f.handle,owner.ref).releasedAt).toBeNull();
});
