import type Database from 'better-sqlite3';
import {controllerDb,type ControllerHandle} from './controller.js';
import {shape,canonical,digest,contractHash,scopedTask,scopedWorkItem,inputsCurrent,controllerActor,type OwnershipRef} from './execution.js';
import {memoryRecordDb,selectMemory,memoryCommit,type MemoryView,type MemoryRecord} from './memory.js';
import {pinnedInputsCurrent,rowResult} from './execution_results.js';
import {readRunInputSnapshotDb,readRunArtifact,type RunInputRef,type RunInputSnapshot,type RunInputGrant} from './run_inputs.js';
import {projectOf} from './project_store.js';
import {appendEvent} from './ops.js';
import {now} from './db.js';
import {KddError} from './errors.js';
export type RunInputReason='requirements_changed'|'membership_changed'|'work_item_changed'|'ownership_changed'|
  'dependency_changed'|'readiness_expired'|'memory_changed'|'rules_changed'|'repository_changed'|'snapshot_missing';
export interface RunInputChange {
  reason:RunInputReason;taskId?:number;entryId?:string;resultId?:string;repoId?:string;
  previous?:Pick<MemoryRecord,'revision'|'hash'>|null;current?:Pick<MemoryRecord,'revision'|'hash'>|null;
}
export type RunInputStatus={status:'current';authorityId:string;inputHash:string}|
  {status:'update_required';authorityId:string;inputHash:string|null;changeHash:string;changes:RunInputChange[];eventId:number};
export function runInputChangesDb(db:Database.Database,snapshot:RunInputSnapshot):RunInputChange[]{
  if(!db.inTransaction)throw new KddError('run input check requires transaction');
  const {response,validation}=snapshot,inputs=response.inputs,changes:RunInputChange[]=[];
  const memoryRef=(record:MemoryRecord)=>({revision:record.revision,hash:record.hash});
  for(const required of inputs.requirements){
    try{
      const current=scopedTask(db,required.task);
      if(current.parent_id!==required.parentId)changes.push({reason:'membership_changed',taskId:required.task.taskId});
      if(contractHash(db,required.task)!==required.hash)changes.push({reason:'requirements_changed',taskId:required.task.taskId});
    }catch{changes.push({reason:'requirements_changed',taskId:required.task.taskId});}
  }
  let reposCurrent=true;
  for(const repo of validation.repositories){
    try{memoryCommit(db,repo.repoId,repo.commit,repo.checkoutPath);}
    catch{reposCurrent=false;changes.push({reason:'repository_changed',repoId:repo.repoId});}
  }
  if(inputs.workItem){
    try{
      const saved=inputs.workItem,item=scopedWorkItem(db,saved.ref);
      if(item.task.taskId!==response.taskId||item.revision!==saved.revision||item.inputsHash!==saved.inputsHash||!inputsCurrent(db,item)
        ||canonical(item.definition)!==canonical(saved.definition))changes.push({reason:'work_item_changed'});
      const o=validation.ownership;
      const row=o?db.prepare('SELECT * FROM work_item_owners WHERE work_item_id=? AND fence=? AND owner_id=? AND revision=? AND released_at IS NULL')
        .get(o.workItemId,o.fence,o.ownerId,o.revision) as {inputs_json:string}|undefined:undefined;
      if(!o||!row||item.fence!==o.fence||item.revision!==o.revision||JSON.parse(row.inputs_json).inputsHash!==saved.inputsHash
        ||canonical(JSON.parse(row.inputs_json).inputResults)!==canonical(validation.inputResults))changes.push({reason:'ownership_changed'});
      if(!pinnedInputsCurrent(db,item,validation.inputResults))changes.push({reason:'dependency_changed'});
    }catch{changes.push({reason:'work_item_changed'});}
  }
  for(const dependency of inputs.dependencies){
    try{
      const r=rowResult(db,dependency.resultId);
      if(r.invalidatedAt!==null||digest(r.payload)!==dependency.payloadHash||canonical(r.binding)!==canonical(dependency.binding))
        changes.push({reason:'dependency_changed',resultId:r.id});
      if(r.payload.kind==='readiness'&&r.payload.expiresAt!==null&&r.payload.expiresAt<=now())changes.push({reason:'readiness_expired',resultId:r.id});
    }catch{changes.push({reason:'dependency_changed',resultId:dependency.resultId});}
  }
  for(const artifact of validation.artifacts){
    try{readRunArtifact(db,artifact.path,artifact.sha256,inputs.budget.maxBytes,[],validation.repositories.map(r=>r.checkoutPath));}
    catch{changes.push({reason:'dependency_changed',resultId:artifact.resultId});}
  }
  for(const memory of [...inputs.rules,...inputs.knowledge]){
    try{const current=memoryRecordDb(db,memory.entryId);
      if(current.revision!==memory.revision||current.hash!==memory.hash||current.status!=='active')
        changes.push({reason:'memory_changed',entryId:memory.entryId,previous:memoryRef(memory),current:memoryRef(current)});}
    catch{changes.push({reason:'memory_changed',entryId:memory.entryId,previous:memoryRef(memory),current:null});}
  }
  if(reposCurrent){
    try{
      const view:MemoryView={scope:{projectId:response.projectId,taskId:response.taskId},repositories:validation.repositories};
      const saved=new Map(inputs.rules.map(r=>[r.entryId,memoryRef(r)]));
      const current=new Map(selectMemory(db,view).filter(r=>r.kind==='rule').map(r=>[r.entryId,memoryRef(r)]));
      for(const entryId of new Set([...saved.keys(),...current.keys()])){
        const previous=saved.get(entryId)??null,next=current.get(entryId)??null;
        if(canonical(previous)!==canonical(next))changes.push({reason:'rules_changed',entryId,previous,current:next});
      }
    }catch{changes.push({reason:'rules_changed'});}
  }
  return [...new Map(changes.map(c=>[canonical(c),c])).values()].sort((a,b)=>canonical(a).localeCompare(canonical(b)));
}
export function assertRunInputsCurrentDb(db:Database.Database,authorityId:string):void{
  const snapshot=readRunInputSnapshotDb(db,authorityId);
  if(runInputChangesDb(db,snapshot).length)throw new KddError('run inputs stale; explicit update required');
}
export function assertOwnedRunInputsCurrentDb(db:Database.Database,owner:OwnershipRef):void{
  const rows=db.prepare('SELECT authority_id,grant_json FROM run_authorities WHERE work_item_id=? ORDER BY generation DESC')
    .all(owner.workItemId) as {authority_id:string;grant_json:string}[];
  for(const row of rows){
    let grant:RunInputGrant;
    try{grant=JSON.parse(row.grant_json);}catch{throw new KddError('owned run inputs denied');}
    if(!grant.ownership)throw new KddError('owned run inputs missing');
    if(canonical(grant.ownership)===canonical(owner)){assertRunInputsCurrentDb(db,row.authority_id);return;}
  }
}
export function checkRunInputs(handle:ControllerHandle,ref:RunInputRef):RunInputStatus{
  const db=controllerDb(handle);
  return db.transaction(():RunInputStatus=>{
    shape(ref,['projectId','authorityId']);
    if(ref.projectId!==projectOf(db).project_id||typeof ref.authorityId!=='string'||!/^[0-9a-f]{32}$/.test(ref.authorityId))throw new KddError('run input reference denied');
    const row=db.prepare('SELECT task_id,grant_json FROM run_authorities WHERE authority_id=?').get(ref.authorityId) as {task_id:number;grant_json:string}|undefined;
    if(!row||JSON.parse(row.grant_json).projectId!==ref.projectId)throw new KddError('run input reference denied');
    let inputHash:string|null=null,changes:RunInputChange[];
    try{const snapshot=readRunInputSnapshotDb(db,ref.authorityId);inputHash=snapshot.inputHash;changes=runInputChangesDb(db,snapshot);}
    catch{changes=[{reason:'snapshot_missing'}];}
    if(!changes.length)return {status:'current',authorityId:ref.authorityId,inputHash:inputHash!};
    const changeHash=digest(changes);
    const existing=db.prepare(`SELECT id FROM events WHERE action='run_inputs_changed' AND task_id=?
      AND json_extract(detail,'$.authorityId')=? AND json_extract(detail,'$.inputHash') IS ? AND json_extract(detail,'$.changeHash')=? ORDER BY id LIMIT 1`)
      .get(row.task_id,ref.authorityId,inputHash,changeHash) as {id:number}|undefined;
    const eventId=existing?.id??appendEvent(db,row.task_id,controllerActor,'run_inputs_changed',{authorityId:ref.authorityId,inputHash,changeHash,changes});
    return {status:'update_required',authorityId:ref.authorityId,inputHash,changeHash,changes,eventId};
  }).immediate();
}
