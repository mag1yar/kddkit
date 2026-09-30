import {afterEach,expect,it} from 'vitest';
import * as core from '../src/index.js';
import {fixture,cleanupFixtures} from './execution_fixture.js';
afterEach(cleanupFixtures);
function flow(){
  const f=fixture(),task=f.task('retire'),definition={kind:'analysis' as const,repoId:null,sourceTasks:[],outputs:[]};
  const first=core.createWorkItem(f.handle,{task:f.ref(task.id),definition,dependencies:[]});
  const second=core.createWorkItem(f.handle,{task:f.ref(task.id),definition,dependencies:[]});
  const reserve=(ref:core.WorkItemRef)=>core.reserveWorkItem(f.handle,{ref,expectedRevision:1,expectedFence:0,expectedMode:'manual',ownerId:'host',write:false});
  const owner=reserve(first.ref),sibling=reserve(second.ref);
  const launched=core.recordLaunchIntent(f.handle,{owner:owner.ref,intent:{launchId:'launch',writerScopeId:'scope'}});
  return {...f,task,first,second,owner:launched,sibling};
}
function stopped(owner:core.OwnershipRecord):core.StopObservation{return{observationId:'host',owner:owner.ref,launchId:owner.launchIntent!.launchId,
  writerScopeId:owner.launchIntent!.writerScopeId,observedAt:core.now(),verdict:'stopped',complete:true,writers:[{id:'group',state:'gone'}]}}
it('retires only the stopped owner, preserves siblings and permits a new fence',async()=>{
  const f=flow(),input={commandId:'retire',owner:f.owner.ref};
  const done=await core.retireOwnership(f.handle,input,async owner=>stopped(owner));
  expect(done).toMatchObject({status:'complete',receipt:{owner:f.owner.ref,stop:{outcome:'stopped',launchId:'launch',writerScopeId:'scope'}}});
  expect(core.ownership(f.handle,f.sibling.ref)).toEqual(f.sibling);
  expect(core.mustGetTask(f.db,f.task.id).execution_mode).toBe('manual');
  const events=f.db.prepare('SELECT * FROM events').all();
  expect(await core.retireOwnership(f.handle,input)).toEqual(done);
  expect(f.db.prepare('SELECT * FROM events').all()).toEqual(events);
  expect(core.reserveWorkItem(f.handle,{ref:f.first.ref,expectedRevision:1,expectedFence:1,expectedMode:'manual',ownerId:'next',write:false}).ref.fence).toBe(2);
  await expect(core.retireOwnership(f.handle,{...input,owner:f.sibling.ref})).rejects.toThrow(/conflict/);
});
it('holds launched ownership for every incomplete or mismatched observation',async()=>{
  const f=flow(),input={commandId:'retire',owner:f.owner.ref};
  expect(await core.retireOwnership(f.handle,input)).toMatchObject({status:'held',reason:'missing_observer'});
  expect(()=>core.recordLaunchIntent(f.handle,{owner:f.owner.ref,intent:{launchId:'launch',writerScopeId:'scope'}})).toThrow(/retirement/);
  expect(()=>core.beginHandoff(f.handle,{commandId:'handoff',task:f.ref(f.task.id),expectedMode:'manual',targetMode:'manual',
    expectedOwners:[f.owner.ref,f.sibling.ref]})).toThrow(/retirement/);
  for(const patch of [{verdict:'unknown'},{complete:false},{writers:[]},{writerScopeId:'foreign'},
    {writers:[{id:'child',state:'alive'}]},{observedAt:0}]){
    expect((await core.retireOwnership(f.handle,input,async owner=>({...stopped(owner),...patch} as core.StopObservation))).status).toBe('held');
    expect(core.ownership(f.handle,f.owner.ref).releasedAt).toBeNull();
  }
  expect(await core.retireOwnership(f.handle,input,async()=>{throw Error('offline')})).toMatchObject({status:'held',reason:'observer_error'});
  expect(await core.retireOwnership(f.handle,input,async owner=>stopped(owner))).toMatchObject({status:'complete'});
});
it('rechecks owner snapshot outside the observer transaction and allows safe stop after changed requirements',async()=>{
  const f=flow();core.editTask(f.db,f.task.id,{body:'changed requirements'},{type:'user'});
  const result=await core.retireOwnership(f.handle,{commandId:'stale-stop',owner:f.owner.ref},async owner=>{
    expect(f.db.inTransaction).toBe(false);return stopped(owner);
  });
  expect(result.status).toBe('complete');
  expect(()=>core.reserveWorkItem(f.handle,{ref:f.first.ref,expectedRevision:1,expectedFence:1,expectedMode:'manual',ownerId:'next',write:false})).toThrow(/stale/);
});
it('leaves ownership held if launch binding changes during observation',async()=>{
  const f=flow();const result=await core.retireOwnership(f.handle,{commandId:'changed',owner:f.owner.ref},async owner=>{
    f.db.prepare("UPDATE work_item_owners SET launch_json=json_set(launch_json,'$.writerScopeId','changed') WHERE work_item_id=?").run(f.first.ref.workItemId);
    return stopped(owner);
  });
  expect(result).toMatchObject({status:'held',reason:'snapshot_changed'});expect(core.ownership(f.handle,f.owner.ref).releasedAt).toBeNull();
});
it('retires a never-launched scope without an observer and keeps terminal work states unchanged',async()=>{
  const f=flow();
  for(const state of ['running','completed','failed','cancelled'] as const){
    const item=core.createWorkItem(f.handle,{task:f.ref(f.task.id),definition:f.first.definition,dependencies:[]});
    const owner=core.reserveWorkItem(f.handle,{ref:item.ref,expectedRevision:1,expectedFence:0,expectedMode:'manual',ownerId:'host',write:false});
    f.db.prepare('UPDATE work_items SET state=? WHERE id=?').run(state,item.ref.workItemId);
    expect(await core.retireOwnership(f.handle,{commandId:'retire-'+state,owner:owner.ref})).toMatchObject({status:'complete',receipt:{stop:{outcome:'never_started'}}});
    expect(core.workItem(f.handle,item.ref).state).toBe(state==='running'?'ready':state);
  }
});
