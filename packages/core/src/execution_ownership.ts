import type Database from 'better-sqlite3';
import { controllerDb, type ControllerHandle } from './controller.js';
import { now } from './db.js';
import { KddError } from './errors.js';
import { appendEvent, mustGetTask } from './ops.js';
import { projectOf } from './project_store.js';
import { protectTask, revokeRunAuthority } from './authority.js';
import { shape, text, integer, mode, canonical, newId, scopedTask, scopedWorkItem, inputsCurrent, liveOwner, checkOwnershipRef,
  checkAuthority, assertNoHandoff, controllerActor, type ExecutionMode, type TaskRef, type AuthorityBinding,
  type WorkItemRef, type OwnershipRef, type OwnerRow } from './execution.js';
import { resolveDependencies, type ResultObservers } from './execution_results.js';

export interface LaunchIntent {launchId:string;writerScopeId:string;authority?:AuthorityBinding}
export interface OwnershipRecord {ref:OwnershipRef;mode:ExecutionMode;write:boolean;inputsHash:string;
  inputResults:readonly {edgeKey:string;resultId:string}[];launchIntent:LaunchIntent|null;releasedAt:number|null}
export interface ReserveWorkItemInput {ref:WorkItemRef;expectedRevision:number;expectedFence:number;expectedMode:ExecutionMode;ownerId:string;write:boolean}
export interface HandoffRecord {id:string;commandId:string;task:TaskRef;expectedMode:ExecutionMode;targetMode:ExecutionMode;
  owners:readonly OwnershipRecord[];authorities:readonly AuthorityBinding[];receipt:HandoffReceipt|null}
export interface HandoffReceipt {handoffId:string;task:TaskRef;mode:ExecutionMode;released:readonly OwnershipRef[];revokedAuthorityIds:readonly string[];
  stops:readonly ({owner:OwnershipRef;outcome:'never_started'}|{owner:OwnershipRef;outcome:'stopped';observationId:string;launchId:string;writerScopeId:string})[]}
export interface StopObservation {observationId:string;owner:OwnershipRef;launchId:string;writerScopeId:string;observedAt:number;
  verdict:'stopped'|'live'|'unknown';complete:boolean;writers:readonly {id:string;state:'gone'|'alive'|'unknown'}[]}
export type StopObserver=(owner:OwnershipRecord)=>Promise<StopObservation|null>;
export type HandoffOutcome={status:'complete';receipt:HandoffReceipt}|{status:'held';handoffId:string;
  reason:'missing_observer'|'observer_error'|'unknown'|'live'|'stale_observation'|'snapshot_changed'};
interface HandoffRow {id:string;command_id:string;task_id:number;expected_mode:ExecutionMode;target_mode:ExecutionMode;
  snapshot_json:string;created_at:number;completed_at:number|null;receipt_json:string|null}
interface Snapshot {owners:OwnershipRecord[];authorities:AuthorityBinding[]}
function ownerRecord(db:Database.Database,row:OwnerRow):OwnershipRecord {
  const item=scopedWorkItem(db,{projectId:(JSON.parse(row.inputs_json) as {projectId:string}).projectId,workItemId:row.work_item_id},row.revision);
  const inputs=JSON.parse(row.inputs_json) as {inputsHash:string;inputResults:{edgeKey:string;resultId:string}[]};
  return {ref:{...item.ref,revision:row.revision,ownerId:row.owner_id,fence:row.fence},mode:row.mode,write:row.write_access===1,
    inputsHash:inputs.inputsHash,inputResults:inputs.inputResults,launchIntent:row.launch_json===null?null:JSON.parse(row.launch_json),releasedAt:row.released_at};
}
export function ownership(handle:ControllerHandle,ref:OwnershipRef):OwnershipRecord {
  const db=controllerDb(handle);checkOwnershipRef(db,ref);
  const row=db.prepare('SELECT * FROM work_item_owners WHERE work_item_id=? AND fence=? AND revision=? AND owner_id=?')
    .get(ref.workItemId,ref.fence,ref.revision,ref.ownerId) as OwnerRow|undefined;
  if(!row)throw new KddError('ownership not found');return ownerRecord(db,row);
}
export function reserveWorkItem(handle:ControllerHandle,input:ReserveWorkItemInput,observers:ResultObservers={}):OwnershipRecord {
  const db=controllerDb(handle);
  return db.transaction(()=>{
    shape(input,['ref','expectedRevision','expectedFence','expectedMode','ownerId','write']);
    integer(input.expectedRevision);integer(input.expectedFence,0);mode(input.expectedMode);text(input.ownerId);
    if(typeof input.write!=='boolean')throw new KddError('invalid write access');
    const item=scopedWorkItem(db,input.ref),task=mustGetTask(db,item.task.taskId);assertNoHandoff(db,task.id);
    if(item.revision!==input.expectedRevision||!inputsCurrent(db,item))throw new KddError('stale revision or inputs');
    if(item.fence!==input.expectedFence||item.fence===Number.MAX_SAFE_INTEGER)throw new KddError('ownership fence conflict or overflow');
    if(task.execution_mode!==input.expectedMode)throw new KddError('execution mode changed');
    if(task.blocked||task.archived_at!==null||!['new','in_progress'].includes(task.status)||!['pending','ready'].includes(item.state))throw new KddError('work item not reservable');
    if(!input.write&&['implementation','integration'].includes(item.definition.kind))throw new KddError('write ownership required');
    if(db.prepare('SELECT 1 FROM work_item_owners WHERE work_item_id=? AND released_at IS NULL').get(item.ref.workItemId))throw new KddError('work item already owned');
    if(input.write)protectTask(handle,task.id);
    const deps=resolveDependencies(handle,{ref:item.ref,expectedRevision:item.revision},observers);
    if(!deps.ready)throw new KddError('dependencies not verified');
    const fence=item.fence+1;
    if(!db.prepare('UPDATE work_items SET fence=? WHERE id=? AND fence=? AND current_revision=?')
      .run(fence,item.ref.workItemId,input.expectedFence,input.expectedRevision).changes)throw new KddError('ownership fence changed');
    db.prepare('INSERT INTO work_item_owners(work_item_id,fence,revision,owner_id,mode,write_access,inputs_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(item.ref.workItemId,fence,item.revision,input.ownerId,input.expectedMode,Number(input.write),canonical({projectId:item.ref.projectId,
        inputsHash:item.inputsHash,inputResults:deps.edges.map(e=>({edgeKey:e.key,resultId:e.resultId}))}),now());
    appendEvent(db,task.id,controllerActor,'work_item_reserved',{work_item_id:item.ref.workItemId,revision:item.revision,fence,owner_id:input.ownerId});
    return ownership(handle,{...item.ref,revision:item.revision,fence,ownerId:input.ownerId});
  }).immediate();
}
export function recordLaunchIntent(handle:ControllerHandle,input:{owner:OwnershipRef;intent:LaunchIntent}):OwnershipRecord {
  const db=controllerDb(handle);
  return db.transaction(()=>{
    shape(input,['owner','intent']);const owner=liveOwner(db,input.owner),item=scopedWorkItem(db,{projectId:input.owner.projectId,workItemId:input.owner.workItemId});
    assertNoHandoff(db,item.task.taskId);shape(input.intent,['launchId','writerScopeId'],['authority']);text(input.intent.launchId);text(input.intent.writerScopeId);
    if(input.intent.authority!==undefined) {
      checkAuthority(db,item.task,input.intent.authority);
      const grant=JSON.parse((db.prepare('SELECT grant_json FROM run_authorities WHERE authority_id=?').get(input.intent.authority.authorityId) as {grant_json:string}).grant_json);
      if(input.intent.authority.workItemId!==item.ref.workItemId||canonical(grant.ownership)!==canonical(input.owner))throw new KddError('launch authority ownership mismatch');
    }
    if(owner.launch_json!==null) {
      if(canonical(JSON.parse(owner.launch_json))!==canonical(input.intent))throw new KddError('launch intent already recorded');
      return ownership(handle,input.owner);
    }
    db.prepare('UPDATE work_item_owners SET launch_id=?,launch_json=? WHERE work_item_id=? AND fence=? AND released_at IS NULL AND launch_id IS NULL')
      .run(input.intent.launchId,canonical(input.intent),owner.work_item_id,owner.fence);
    appendEvent(db,item.task.taskId,controllerActor,'work_item_launch_intent',{owner:input.owner,intent:input.intent});
    return ownership(handle,input.owner);
  }).immediate();
}
function snapshot(db:Database.Database,task:TaskRef):Snapshot {
  const rows=db.prepare('SELECT o.* FROM work_item_owners o JOIN work_items w ON w.id=o.work_item_id WHERE w.task_id=? AND o.released_at IS NULL ORDER BY o.work_item_id,o.fence')
    .all(task.taskId) as OwnerRow[];
  const authorities=(db.prepare(`SELECT a.authority_id,a.work_item_id,a.run_id,a.generation FROM run_authorities a
    LEFT JOIN work_items w ON w.id=a.work_item_id WHERE a.task_id=? OR w.task_id=? ORDER BY a.authority_id`)
    .all(task.taskId,task.taskId) as {authority_id:string;work_item_id:string;run_id:string;generation:number}[]).map(a=>({authorityId:a.authority_id,
      workItemId:a.work_item_id,runId:a.run_id,generation:a.generation}));
  return {owners:rows.map(row=>ownerRecord(db,row)),authorities};
}
function authorityTracked(db:Database.Database,record:HandoffRecord,authority:AuthorityBinding):boolean {
  try {
    const row=db.prepare('SELECT task_id,grant_json FROM run_authorities WHERE authority_id=? AND work_item_id=? AND run_id=? AND generation=?')
      .get(authority.authorityId,authority.workItemId,authority.runId,authority.generation) as {task_id:number;grant_json:string}|undefined;
    if(!row||row.task_id!==record.task.taskId)return false;
    const grant=JSON.parse(row.grant_json);
    if(grant.projectId!==record.task.projectId||grant.taskId!==row.task_id||grant.workItemId!==authority.workItemId
      ||grant.runId!==authority.runId||grant.generation!==authority.generation||!grant.ownership)return false;
    checkOwnershipRef(db,grant.ownership);
    const ref=grant.ownership as OwnershipRef;
    if(ref.workItemId!==authority.workItemId)return false;
    if(record.owners.some(owner=>canonical(owner.ref)===canonical(ref)))return true;
    // Revocation alone is not stop evidence; only an already completed handoff retires a prior owner.
    return !!db.prepare(`SELECT 1 FROM work_item_owners o JOIN work_items w ON w.id=o.work_item_id
      JOIN execution_handoffs h ON h.id=o.release_handoff_id AND h.task_id=w.task_id
      WHERE w.task_id=? AND o.work_item_id=? AND o.fence=? AND o.revision=? AND o.owner_id=?
        AND o.released_at IS NOT NULL AND h.completed_at IS NOT NULL`)
      .get(record.task.taskId,ref.workItemId,ref.fence,ref.revision,ref.ownerId);
  }catch{return false}
}
function readHandoff(db:Database.Database,id:string):HandoffRow {
  text(id);const row=db.prepare('SELECT * FROM execution_handoffs WHERE id=?').get(id) as HandoffRow|undefined;
  if(!row)throw new KddError('handoff not found');return row;
}
function handoffRecord(db:Database.Database,row:HandoffRow):HandoffRecord {
  const snap=JSON.parse(row.snapshot_json) as Snapshot;
  const projectId=projectOf(db).project_id;
  return {id:row.id,commandId:row.command_id,task:{projectId,taskId:row.task_id},expectedMode:row.expected_mode,targetMode:row.target_mode,
    owners:snap.owners,authorities:snap.authorities,receipt:row.receipt_json===null?null:JSON.parse(row.receipt_json)};
}
export function handoff(handle:ControllerHandle,handoffId:string):HandoffRecord {
  const db=controllerDb(handle);return handoffRecord(db,readHandoff(db,handoffId));
}
export function beginHandoff(handle:ControllerHandle,input:{commandId:string;task:TaskRef;expectedMode:ExecutionMode;targetMode:ExecutionMode;expectedOwners:readonly OwnershipRef[]}):HandoffRecord {
  const db=controllerDb(handle);
  return db.transaction(()=>{
    shape(input,['commandId','task','expectedMode','targetMode','expectedOwners']);text(input.commandId);mode(input.expectedMode);mode(input.targetMode);
    const task=scopedTask(db,input.task);
    if(!Array.isArray(input.expectedOwners))throw new KddError('invalid owner set');
    input.expectedOwners.forEach(ref=>checkOwnershipRef(db,ref));
    const expected=[...input.expectedOwners].sort((a,b)=>a.workItemId.localeCompare(b.workItemId)||a.fence-b.fence);
    const replay=db.prepare('SELECT id FROM execution_handoffs WHERE command_id=?').get(input.commandId) as {id:string}|undefined;
    if(replay) {
      const prior=handoffRecord(db,readHandoff(db,replay.id));
      if(canonical(prior.task)!==canonical(input.task)||prior.expectedMode!==input.expectedMode||prior.targetMode!==input.targetMode
        ||canonical(prior.owners.map(o=>o.ref))!==canonical(expected))throw new KddError('handoff command conflict');return prior;
    }
    assertNoHandoff(db,task.id);
    if(task.execution_mode!==input.expectedMode)throw new KddError('execution mode changed');
    if(task.claimed_by!==null)throw new KddError('legacy writer must stop before handoff');
    const snap=snapshot(db,input.task);
    if(canonical(snap.owners.map(o=>o.ref))!==canonical(expected))throw new KddError('handoff owner snapshot mismatch');
    const id=newId();
    db.prepare('INSERT INTO execution_handoffs(id,command_id,task_id,expected_mode,target_mode,snapshot_json,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(id,input.commandId,task.id,input.expectedMode,input.targetMode,canonical({...snap,projectId:input.task.projectId}),now());
    appendEvent(db,task.id,controllerActor,'execution_handoff_intent',{handoff_id:id,expected_mode:input.expectedMode,target_mode:input.targetMode,owners:expected});
    return handoffRecord(db,readHandoff(db,id));
  }).immediate();
}
function stopReason(owner:OwnershipRecord,observation:StopObservation|null,startedAt:number):'unknown'|'live'|'stale_observation'|null {
  try {
    if(!observation)return 'unknown';
    shape(observation,['observationId','owner','launchId','writerScopeId','observedAt','verdict','complete','writers']);text(observation.observationId);
    if(canonical(observation.owner)!==canonical(owner.ref)||observation.launchId!==owner.launchIntent!.launchId
      ||observation.writerScopeId!==owner.launchIntent!.writerScopeId||!Number.isFinite(observation.observedAt)
      ||observation.observedAt<startedAt||observation.observedAt>now())return 'stale_observation';
    if(typeof observation.complete!=='boolean'||!Array.isArray(observation.writers)||!observation.writers.length)return 'unknown';
    const ids=new Set<string>();
    for(const writer of observation.writers) {
      shape(writer,['id','state']);text(writer.id);if(ids.has(writer.id))return 'unknown';ids.add(writer.id);
      if(!['gone','alive','unknown'].includes(writer.state))return 'unknown';
    }
    if(observation.verdict==='live'||observation.writers.some(w=>w.state==='alive'))return 'live';
    if(observation.verdict!=='stopped'||!observation.complete||observation.writers.some(w=>w.state!=='gone'))return 'unknown';
    return null;
  }catch{return 'stale_observation'}
}
export async function finishHandoff(handle:ControllerHandle,input:{handoffId:string},observer?:StopObserver):Promise<HandoffOutcome> {
  const db=controllerDb(handle);shape(input,['handoffId']);const record=handoffRecord(db,readHandoff(db,input.handoffId));
  if(record.receipt)return {status:'complete',receipt:record.receipt};
  const held=(reason:Extract<HandoffOutcome,{status:'held'}>['reason']):HandoffOutcome=>{
    return db.transaction(():HandoffOutcome=>{
      const current=handoffRecord(db,readHandoff(db,record.id));
      if(current.receipt)return {status:'complete',receipt:current.receipt};
      appendEvent(db,record.task.taskId,controllerActor,'execution_handoff_held',{handoff_id:record.id,reason});
      return {status:'held',handoffId:record.id,reason};
    }).immediate();
  };
  if(record.authorities.some(authority=>!authorityTracked(db,record,authority)))return held('unknown');
  const stops:HandoffReceipt['stops'][number][]=[];
  for(const owner of record.owners) {
    if(owner.launchIntent===null){stops.push({owner:owner.ref,outcome:'never_started'});continue}
    if(typeof observer!=='function')return held('missing_observer');
    let observation:StopObservation|null;const startedAt=now();
    try{observation=await observer(structuredClone(owner))}catch{return held('observer_error')}
    const reason=stopReason(owner,observation,startedAt);if(reason)return held(reason);
    stops.push({owner:owner.ref,outcome:'stopped',observationId:observation!.observationId,launchId:owner.launchIntent.launchId,writerScopeId:owner.launchIntent.writerScopeId});
  }
  controllerDb(handle);
  return db.transaction(()=>{
    const current=handoffRecord(db,readHandoff(db,record.id));if(current.receipt)return {status:'complete' as const,receipt:current.receipt};
    const task=scopedTask(db,record.task),snap=snapshot(db,record.task);
    if(task.execution_mode!==record.expectedMode||task.claimed_by!==null||canonical(snap.owners)!==canonical(record.owners)
      ||canonical(snap.authorities)!==canonical(record.authorities)
      ||record.owners.some(owner=>{
        const item=scopedWorkItem(db,{projectId:owner.ref.projectId,workItemId:owner.ref.workItemId});
        return item.revision!==owner.ref.revision||item.fence!==owner.ref.fence;
      }))return held('snapshot_changed');
    if(record.authorities.some(authority=>!authorityTracked(db,record,authority)))return held('unknown');
    for(const owner of record.owners)db.prepare('UPDATE work_item_owners SET released_at=?,release_handoff_id=? WHERE work_item_id=? AND fence=? AND released_at IS NULL')
      .run(now(),record.id,owner.ref.workItemId,owner.ref.fence);
    const revokedAuthorityIds:string[]=[];
    for(const authority of record.authorities) {
      if(db.prepare('SELECT 1 FROM run_authorities WHERE authority_id=? AND revoked_at IS NULL').get(authority.authorityId)) {
        revokeRunAuthority(handle,authority.authorityId);revokedAuthorityIds.push(authority.authorityId);
      }
    }
    db.prepare('UPDATE tasks SET execution_mode=?,updated_at=? WHERE id=?').run(record.targetMode,now(),task.id);
    const receipt:HandoffReceipt={handoffId:record.id,task:record.task,mode:record.targetMode,released:record.owners.map(o=>o.ref),revokedAuthorityIds,stops};
    db.prepare('UPDATE execution_handoffs SET completed_at=?,receipt_json=? WHERE id=? AND completed_at IS NULL').run(now(),canonical(receipt),record.id);
    appendEvent(db,task.id,controllerActor,'execution_handoff_completed',receipt);return {status:'complete' as const,receipt};
  }).immediate();
}
