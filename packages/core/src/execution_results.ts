import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { controllerDb, type ControllerHandle } from './controller.js';
import { now } from './db.js';
import { KddError } from './errors.js';
import { appendEvent } from './ops.js';
import { shape, text, integer, strings, dependencyKind, checkRepo, scopedTask, scopedWorkItem, inputsCurrent,
  canonical, digest, newId, checkAuthority, liveOwner, assertNoHandoff, controllerActor,
  type TaskRef, type AuthorityBinding, type OwnershipRef, type WorkItemRef, type WorkItemRecord,
  type DependencyKind, type DependencyBinding, type DependencyInput } from './execution.js';

export type ResultSource =
  | { kind:'manual'; sourceTask:TaskRef; instructionRef:string }
  | { kind:'owned'; owner:OwnershipRef; authority?:AuthorityBinding; instructionRef:string };
interface PayloadBase { repoId:string|null; version:string; checkRefs:readonly string[] }
export type ResultPayload =
  | (PayloadBase & {kind:'contract'; head:string|null; artifact:{path:string;sha256:string}})
  | (PayloadBase & {kind:'code'; repoId:string;head:string;proofRef:string})
  | (PayloadBase & {kind:'merged';repoId:string;head:string;target:string;baseHead:string;acceptedResultId:string;userRef:string;receiptRef:string})
  | (PayloadBase & {kind:'readiness';resourceId:string;configHash:string;consumerScope:string;capabilities:readonly string[];
      userRef:string;probeRef:string;observedAt:number;expiresAt:number|null});
export interface ResultBinding {producer:WorkItemRef;producerRevision:number;inputsHash:string;outputKey:string;
  kind:DependencyKind;version:string;repoId:string|null}
export type EvidenceRequest =
  | {kind:'check';ref:string;binding:ResultBinding;payloadHash:string}
  | {kind:'code_result';ref:string;binding:ResultBinding;head:string}
  | {kind:'code_in_base';ref:string;binding:ResultBinding;head:string;baseHead:string}
  | {kind:'merge_acceptance';ref:string;binding:ResultBinding;acceptedResultId:string}
  | {kind:'merge_receipt';ref:string;binding:ResultBinding;acceptedResultId:string;target:string;baseHead:string;head:string}
  | {kind:'readiness_confirmation';ref:string;binding:ResultBinding;resourceId:string}
  | {kind:'readiness_probe';ref:string;binding:ResultBinding;resourceId:string;configHash:string;consumerScope:string;capabilities:readonly string[]};
export interface EvidenceObservation {request:EvidenceRequest;verdict:'pass'|'fail'|'inconclusive';origin:'host'|'user';observedAt:number;expiresAt:number|null}
export interface ResultObservers {observe?:(request:EvidenceRequest)=>EvidenceObservation|null}
export interface ResultRecord {id:string;commandId:string;binding:ResultBinding;payload:ResultPayload;source:ResultSource;
  inputResults:readonly {edgeKey:string;resultId:string}[];invalidatedAt:number|null;invalidationReason:string|null;successorId:string|null}
export interface PublishResultInput {commandId:string;producer:WorkItemRef;expectedRevision:number;outputKey:string;
  expectedResultId:string|null;payload:ResultPayload;source:ResultSource}
export type DependencyReason = 'missing_output'|'producer_not_completed'|'failed'|'cancelled'|'stale_revision'|'checks_not_passed'|
  'base_missing_code'|'merge_not_succeeded'|'readiness_unconfirmed'|'readiness_unverified'|'readiness_expired'|'scope_mismatch';
export interface DependencyProjection {ref:WorkItemRef;revision:number;inputsCurrent:boolean;ready:boolean;
  edges:readonly ({key:string;producer:WorkItemRef;binding:DependencyBinding} &
    ({satisfied:true;resultId:string;pinned:boolean}|{satisfied:false;reason:DependencyReason;resultId:string|null}))[]}
interface ResultRow {id:string;command_id:string;command_hash:string;producer_id:string;producer_revision:number;
  output_key:string;kind:DependencyKind;payload_json:string;source_json:string;invalidated_at:number|null;invalidation_reason:string|null;successor_id:string|null}
interface SourceMetadata {source:ResultSource;binding:ResultBinding;inputResults:{edgeKey:string;resultId:string}[];fence:number}
const terminal = (item:WorkItemRecord) => ['completed','failed','cancelled'].includes(item.state);
export function rowResult(db:Database.Database,id:string):ResultRecord {
  text(id); const row=db.prepare('SELECT * FROM work_item_results WHERE id=?').get(id) as ResultRow|undefined;
  if (!row) throw new KddError('result not found');
  const metadata=JSON.parse(row.source_json) as SourceMetadata;
  return {id:row.id,commandId:row.command_id,binding:metadata.binding,payload:JSON.parse(row.payload_json),source:metadata.source,
    inputResults:metadata.inputResults,invalidatedAt:row.invalidated_at,invalidationReason:row.invalidation_reason,successorId:row.successor_id};
}
export function result(handle:ControllerHandle,resultId:string):ResultRecord {return rowResult(controllerDb(handle),resultId)}
function checkPayload(db:Database.Database,payload:ResultPayload):void {
  dependencyKind(payload?.kind);
  const fields={contract:['head','artifact'],code:['head','proofRef'],merged:['head','target','baseHead','acceptedResultId','userRef','receiptRef'],
    readiness:['resourceId','configHash','consumerScope','capabilities','userRef','probeRef','observedAt','expiresAt']}[payload.kind];
  shape(payload,['kind','repoId','version','checkRefs',...fields]);checkRepo(db,payload.repoId);text(payload.version);strings(payload.checkRefs);
  if (payload.kind==='contract') {
    if (payload.head!==null) text(payload.head);
    shape(payload.artifact,['path','sha256']);text(payload.artifact.path);
    if (!isAbsolute(payload.artifact.path)|| !/^[a-f0-9]{64}$/.test(payload.artifact.sha256)) throw new KddError('invalid artifact');
  } else if (payload.kind==='code'||payload.kind==='merged') {
    if (payload.repoId===null) throw new KddError('result requires repository');text(payload.head);
    if (payload.kind==='code') text(payload.proofRef);
    else {text(payload.target);text(payload.baseHead);text(payload.acceptedResultId);text(payload.userRef);text(payload.receiptRef)}
  } else {
    text(payload.resourceId);text(payload.configHash);text(payload.consumerScope);strings(payload.capabilities);text(payload.userRef);text(payload.probeRef);
    if (!Number.isFinite(payload.observedAt)||payload.observedAt<0||payload.observedAt>now()
      ||(payload.expiresAt!==null&&(!Number.isFinite(payload.expiresAt)||payload.expiresAt<=payload.observedAt))) throw new KddError('invalid readiness time');
  }
}
export function checkResultSource(db:Database.Database,item:WorkItemRecord,source:ResultSource):void {
  shape(source,source?.kind==='manual'?['kind','sourceTask','instructionRef']:['kind','owner','instructionRef'],source?.kind==='owned'?['authority']:[]);
  text(source.instructionRef);assertNoHandoff(db,item.task.taskId);
  if (source.kind==='manual') {
    scopedTask(db,source.sourceTask);
    if (source.sourceTask.taskId!==item.task.taskId) throw new KddError('result source task mismatch');
    if (db.prepare('SELECT 1 FROM work_item_owners WHERE work_item_id=? AND released_at IS NULL').get(item.ref.workItemId)) throw new KddError('owned work requires ownership fence');
  } else if(source.kind==='owned') {
    const owner=liveOwner(db,source.owner);
    if(owner.work_item_id!==item.ref.workItemId || owner.revision!==item.revision) throw new KddError('source ownership mismatch');
    if(source.authority!==undefined) {
      checkAuthority(db,item.task,source.authority);
      if(source.authority.workItemId!==item.ref.workItemId) throw new KddError('source authority mismatch');
      const grant=JSON.parse((db.prepare('SELECT grant_json FROM run_authorities WHERE authority_id=?').get(source.authority.authorityId) as {grant_json:string}).grant_json);
      if(canonical(grant.ownership)!==canonical(source.owner)) throw new KddError('source authority ownership mismatch');
    }
  } else throw new KddError('invalid result source');
}
function pass(observers:ResultObservers,request:EvidenceRequest,fresh=false):boolean {
  try {
    const expected=canonical(request), time=now(), observed=observers.observe?.(request);
    if(!observed) return false;
    shape(observed,['request','verdict','origin','observedAt','expiresAt']);
    const origin=request.kind==='merge_acceptance'||request.kind==='readiness_confirmation'?'user':'host';
    return canonical(observed.request)===expected && observed.verdict==='pass' && observed.origin===origin
      && Number.isFinite(observed.observedAt) && observed.observedAt>=0 && observed.observedAt<=now()
      && (!fresh||observed.observedAt>=time)
      && (observed.expiresAt===null || Number.isFinite(observed.expiresAt)&&observed.expiresAt>now()&&observed.expiresAt>observed.observedAt);
  } catch {return false}
}
function validateResult(db:Database.Database,record:ResultRecord,required:DependencyBinding|null,observers:ResultObservers,path:Set<string>,candidate=false,currentOnly=false):DependencyReason|null {
  const key=record.id;
  if(path.has(key)) return 'stale_revision';path.add(key);
  try {
    const item=scopedWorkItem(db,record.binding.producer), payload=record.payload, binding=record.binding;
    if(record.invalidatedAt!==null || item.revision!==binding.producerRevision || item.inputsHash!==binding.inputsHash || !inputsCurrent(db,item)) return 'stale_revision';
    if(item.state==='failed'||item.state==='cancelled') return item.state;
    const output=item.definition.outputs.find(o=>o.key===binding.outputKey);
    if(!output||output.kind!==binding.kind||output.version!==binding.version||item.definition.repoId!==binding.repoId
      ||payload.kind!==binding.kind||payload.repoId!==binding.repoId||payload.version!==binding.version) return 'scope_mismatch';
    if(required&&(required.kind!==payload.kind||required.repoId!==payload.repoId||required.version!==payload.version)) return 'scope_mismatch';
    checkPayload(db,payload);
    if(!candidate) {
      const row=db.prepare('SELECT source_json FROM work_item_results WHERE id=?').get(record.id) as {source_json:string}|undefined;
      if(!row) return 'stale_revision';
      const meta=JSON.parse(row.source_json) as SourceMetadata;
      if(meta.fence!==item.fence) return 'stale_revision';
      if(record.source.kind==='owned') {
        const owner=db.prepare('SELECT inputs_json FROM work_item_owners WHERE work_item_id=? AND fence=? AND revision=? AND owner_id=?')
          .get(item.ref.workItemId,record.source.owner.fence,record.source.owner.revision,record.source.owner.ownerId) as {inputs_json:string}|undefined;
        if(!owner||record.source.owner.fence!==item.fence||JSON.parse(owner.inputs_json).inputsHash!==item.inputsHash) return 'stale_revision';
      }
    }
    for(const dep of item.dependencies) {
      const pin=record.inputResults.find(p=>p.edgeKey===dep.key);
      if(!pin||dep.resultId!==pin.resultId) return 'stale_revision';
      const reason=validateEdge(db,dep,observers,path,pin.resultId,currentOnly).reason;
      if(reason) return reason;
    }
    if(record.inputResults.length!==item.dependencies.length) return 'stale_revision';
    if(output.checkRefs.some(ref=>!payload.checkRefs.includes(ref))) return 'checks_not_passed';
    const payloadHash=digest(payload);
    if(!currentOnly)for(const ref of payload.checkRefs) if(!pass(observers,{kind:'check',ref,binding,payloadHash})) return 'checks_not_passed';
    switch(payload.kind) {
      case 'contract': {
        if(!statSync(payload.artifact.path).isFile() || createHash('sha256').update(readFileSync(payload.artifact.path)).digest('hex')!==payload.artifact.sha256) return 'stale_revision';
        return null;
      }
      case 'code':
        if(currentOnly)return null;
        if(!pass(observers,{kind:'code_result',ref:payload.proofRef,binding,head:payload.head})) return 'checks_not_passed';
        return required?.kind==='code'&&!pass(observers,{kind:'code_in_base',ref:payload.proofRef,binding,head:payload.head,baseHead:required.baseHead})?'base_missing_code':null;
      case 'merged': {
        const accepted=rowResult(db,payload.acceptedResultId), producer=scopedWorkItem(db,accepted.binding.producer);
        if(accepted.payload.kind!=='code'||accepted.payload.repoId!==payload.repoId||accepted.payload.head!==payload.head
          ||producer.state!=='completed'||validateResult(db,accepted,null,observers,path,false,currentOnly)) return 'merge_not_succeeded';
        if(required?.kind==='merged'&&(required.target!==payload.target||required.baseHead!==payload.baseHead)) return 'scope_mismatch';
        const common={binding,acceptedResultId:payload.acceptedResultId};
        return currentOnly||pass(observers,{kind:'merge_acceptance',ref:payload.userRef,...common})
          &&pass(observers,{kind:'merge_receipt',ref:payload.receiptRef,...common,target:payload.target,baseHead:payload.baseHead,head:payload.head})?null:'merge_not_succeeded';
      }
      case 'readiness': {
        if(payload.expiresAt!==null&&payload.expiresAt<=now()) return 'readiness_expired';
        if(required?.kind==='readiness'&&(required.resourceId!==payload.resourceId||required.configHash!==payload.configHash
          ||required.consumerScope!==payload.consumerScope||canonical([...required.capabilities].sort())!==canonical([...payload.capabilities].sort()))) return 'scope_mismatch';
        if(currentOnly)return null;
        if(!pass(observers,{kind:'readiness_confirmation',ref:payload.userRef,binding,resourceId:payload.resourceId})) return 'readiness_unconfirmed';
        return pass(observers,{kind:'readiness_probe',ref:payload.probeRef,binding,resourceId:payload.resourceId,configHash:payload.configHash,
          consumerScope:payload.consumerScope,capabilities:payload.capabilities},true)?null:'readiness_unverified';
      }
    }
  } catch {return 'stale_revision'} finally {path.delete(key)}
}
function validateEdge(db:Database.Database,dep:DependencyInput,observers:ResultObservers,path:Set<string>,explicitId?:string,currentOnly=false):{resultId:string|null;reason:DependencyReason|null} {
  const producer=scopedWorkItem(db,dep.producer);
  const id=explicitId??dep.resultId??(db.prepare('SELECT id FROM work_item_results WHERE producer_id=? AND producer_revision=? AND output_key=? AND invalidated_at IS NULL')
    .get(dep.producer.workItemId,dep.producerRevision,dep.outputKey) as {id:string}|undefined)?.id??null;
  if(producer.state==='failed'||producer.state==='cancelled') return {resultId:id,reason:producer.state};
  if(producer.revision!==dep.producerRevision||!inputsCurrent(db,producer)) return {resultId:id,reason:'stale_revision'};
  if(producer.state!=='completed') return {resultId:id,reason:'producer_not_completed'};
  if(!id) return {resultId:null,reason:'missing_output'};
  const record=rowResult(db,id);
  if(record.binding.producer.workItemId!==dep.producer.workItemId||record.binding.producerRevision!==dep.producerRevision||record.binding.outputKey!==dep.outputKey) return {resultId:id,reason:'scope_mismatch'};
  return {resultId:id,reason:validateResult(db,record,dep.binding,observers,path,false,currentOnly)};
}
// Internal ownership guard for already verified pins; fresh host observations still gate readiness/publication.
export function pinnedInputsCurrent(db:Database.Database,item:WorkItemRecord,pins:readonly {edgeKey:string;resultId:string}[]):boolean {
  try {
    return Array.isArray(pins)&&pins.length===item.dependencies.length&&item.dependencies.every(dep=>{
      const pin=pins.find(p=>p.edgeKey===dep.key);
      return !!pin&&typeof pin.resultId==='string'&&dep.resultId===pin.resultId&&!validateEdge(db,dep,{},new Set(),pin.resultId,true).reason;
    });
  }catch{return false}
}
export function dependencyProjection(db:Database.Database,item:WorkItemRecord,observers:ResultObservers={}):DependencyProjection {
  const current=inputsCurrent(db,item);
  const edges:DependencyProjection['edges']=item.dependencies.map(dep=>{
    const {resultId,reason}=validateEdge(db,dep,observers,new Set());
    const base={key:dep.key,producer:dep.producer,binding:dep.binding};
    return reason||resultId===null?{...base,satisfied:false as const,reason:reason??'missing_output',resultId}
      :{...base,satisfied:true as const,resultId,pinned:dep.resultId!==undefined};
  });
  return {ref:item.ref,revision:item.revision,inputsCurrent:current,ready:current&&edges.every(e=>e.satisfied),edges};
}
function pin(db:Database.Database,item:WorkItemRecord,projection:DependencyProjection):DependencyProjection {
  if(!projection.ready) return projection;
  let changed=false;
  for(const edge of projection.edges) if(edge.satisfied&&!edge.pinned) {
    db.prepare('UPDATE work_item_dependencies SET pinned_result_id=? WHERE consumer_id=? AND consumer_revision=? AND edge_key=? AND pinned_result_id IS NULL')
      .run(edge.resultId,item.ref.workItemId,item.revision,edge.key);changed=true;
  }
  if(changed) appendEvent(db,item.task.taskId,controllerActor,'dependencies_resolved',{work_item_id:item.ref.workItemId,revision:item.revision,
    results:projection.edges.map(e=>({key:e.key,resultId:e.resultId}))});
  return {...projection,edges:projection.edges.map(e=>e.satisfied?{...e,pinned:true}:e)};
}
export function inspectDependencies(handle:ControllerHandle,ref:WorkItemRef,observers:ResultObservers={}):DependencyProjection {
  const db=controllerDb(handle); return db.transaction(()=>dependencyProjection(db,scopedWorkItem(db,ref),observers))();
}
export function resolveDependencies(handle:ControllerHandle,input:{ref:WorkItemRef;expectedRevision:number},observers:ResultObservers={}):DependencyProjection {
  const db=controllerDb(handle);
  return db.transaction(()=>{
    shape(input,['ref','expectedRevision']);integer(input.expectedRevision);
    const item=scopedWorkItem(db,input.ref);assertNoHandoff(db,item.task.taskId);
    if(item.revision!==input.expectedRevision) throw new KddError('revision conflict');
    return pin(db,item,dependencyProjection(db,item,observers));
  }).immediate();
}
export function publishResult(handle:ControllerHandle,input:PublishResultInput,observers:ResultObservers={}):ResultRecord {
  const db=controllerDb(handle);
  return db.transaction(()=>{
    shape(input,['commandId','producer','expectedRevision','outputKey','expectedResultId','payload','source']);
    text(input.commandId);integer(input.expectedRevision);text(input.outputKey);
    if(input.expectedResultId!==null) text(input.expectedResultId);checkPayload(db,input.payload);
    const hash=digest(input),existing=db.prepare('SELECT id,command_hash FROM work_item_results WHERE command_id=?').get(input.commandId) as {id:string;command_hash:string}|undefined;
    if(existing&&existing.command_hash!==hash) throw new KddError('publication command conflict');
    const item=scopedWorkItem(db,input.producer);checkResultSource(db,item,input.source);
    if(existing) return rowResult(db,existing.id);
    if(item.revision!==input.expectedRevision||!inputsCurrent(db,item)) throw new KddError('stale revision or inputs');
    if(terminal(item)) throw new KddError('terminal work requires new work item');
    const output=item.definition.outputs.find(o=>o.key===input.outputKey);
    if(!output) throw new KddError('undeclared output');
    const deps=pin(db,item,dependencyProjection(db,item,observers));
    if(!deps.ready) throw new KddError('input dependencies not verified');
    const inputResults=deps.edges.map(e=>({edgeKey:e.key,resultId:e.resultId!}));
    const binding:ResultBinding={producer:item.ref,producerRevision:item.revision,inputsHash:item.inputsHash,outputKey:input.outputKey,
      kind:output.kind,version:output.version,repoId:item.definition.repoId};
    const candidate:ResultRecord={id:newId(),commandId:'candidate',binding,payload:input.payload,source:input.source,inputResults,
      invalidatedAt:null,invalidationReason:null,successorId:null};
    const reason=validateResult(db,candidate,null,observers,new Set(),true);
    if(reason) throw new KddError(`result verification failed: ${reason}`);
    const current=db.prepare('SELECT id FROM work_item_results WHERE producer_id=? AND producer_revision=? AND output_key=? AND invalidated_at IS NULL')
      .get(item.ref.workItemId,item.revision,input.outputKey) as {id:string}|undefined;
    if((current?.id??null)!==input.expectedResultId) throw new KddError('output result conflict');
    if(current) db.prepare('UPDATE work_item_results SET invalidated_at=?,invalidation_reason=?,successor_id=? WHERE id=?')
      .run(now(),'superseded',candidate.id,current.id);
    db.prepare('INSERT INTO work_item_results(id,command_id,command_hash,producer_id,producer_revision,output_key,kind,payload_json,source_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(candidate.id,input.commandId,hash,item.ref.workItemId,item.revision,input.outputKey,input.payload.kind,canonical(input.payload),
        canonical({source:input.source,binding,inputResults,fence:item.fence}),now());
    appendEvent(db,item.task.taskId,controllerActor,'result_published',{result_id:candidate.id,commandId:input.commandId,binding,supersedes:current?.id??null});
    return rowResult(db,candidate.id);
  }).immediate();
}
export function invalidateResult(handle:ControllerHandle,input:{commandId:string;resultId:string;reason:string;successorId?:string}):ResultRecord {
  const db=controllerDb(handle);
  return db.transaction(()=>{
    shape(input,['commandId','resultId','reason'],['successorId']);text(input.commandId);text(input.resultId);text(input.reason);
    const old=rowResult(db,input.resultId);
    const replay=db.prepare("SELECT detail FROM events WHERE action='result_invalidated' AND json_valid(detail) AND json_extract(detail,'$.commandId')=?")
      .get(input.commandId) as {detail:string}|undefined;
    if(replay) {
      if(canonical(JSON.parse(replay.detail))!==canonical(input)) throw new KddError('invalidation command conflict');return old;
    }
    assertNoHandoff(db,scopedWorkItem(db,old.binding.producer).task.taskId);
    if(old.invalidatedAt!==null) throw new KddError('result already invalidated');
    if(input.successorId!==undefined) {
      text(input.successorId);const successor=rowResult(db,input.successorId);
      if(successor.id===old.id||successor.binding.kind!==old.binding.kind||successor.binding.repoId!==old.binding.repoId||successor.invalidatedAt!==null) throw new KddError('incompatible successor');
    }
    db.prepare('UPDATE work_item_results SET invalidated_at=?,invalidation_reason=?,successor_id=? WHERE id=?')
      .run(now(),input.reason,input.successorId??null,old.id);
    appendEvent(db,scopedWorkItem(db,old.binding.producer).task.taskId,controllerActor,'result_invalidated',input);
    return rowResult(db,old.id);
  }).immediate();
}
export function completeWorkItem(handle:ControllerHandle,input:{ref:WorkItemRef;expectedRevision:number;source:ResultSource},observers:ResultObservers={}):WorkItemRecord {
  const db=controllerDb(handle);
  return db.transaction(()=>{
    shape(input,['ref','expectedRevision','source']);integer(input.expectedRevision);
    const item=scopedWorkItem(db,input.ref);checkResultSource(db,item,input.source);
    if(item.revision!==input.expectedRevision||!inputsCurrent(db,item)) throw new KddError('stale revision or inputs');
    if(item.state==='failed'||item.state==='cancelled') throw new KddError('terminal work requires new work item');
    if(!pin(db,item,dependencyProjection(db,item,observers)).ready) throw new KddError('dependencies not verified');
    for(const output of item.definition.outputs.filter(o=>o.required)) {
      const row=db.prepare('SELECT id FROM work_item_results WHERE producer_id=? AND producer_revision=? AND output_key=? AND invalidated_at IS NULL')
        .get(item.ref.workItemId,item.revision,output.key) as {id:string}|undefined;
      const reason=row?validateResult(db,rowResult(db,row.id),null,observers,new Set()):'missing_output';
      if(reason) throw new KddError(`mandatory output not verified: ${reason}`);
    }
    if(item.state!=='completed') {
      db.prepare("UPDATE work_items SET state='completed' WHERE id=?").run(item.ref.workItemId);
      appendEvent(db,item.task.taskId,controllerActor,'work_item_completed',{work_item_id:item.ref.workItemId,revision:item.revision});
    }
    return scopedWorkItem(db,item.ref);
  }).immediate();
}
export function setWorkItemWaiting(handle:ControllerHandle,input:{ref:WorkItemRef;expectedRevision:number;source:ResultSource}):WorkItemRecord {
  return setState(handle,input,'waiting_input');
}
export function endWorkItem(handle:ControllerHandle,input:{ref:WorkItemRef;expectedRevision:number;source:ResultSource;state:'failed'|'cancelled'}):WorkItemRecord {
  const db=controllerDb(handle);shape(input,['ref','expectedRevision','source','state']);
  if(input.state!=='failed'&&input.state!=='cancelled') throw new KddError('invalid end state');
  return setStateWithDb(db,{ref:input.ref,expectedRevision:input.expectedRevision,source:input.source},input.state);
}
function setState(handle:ControllerHandle,input:{ref:WorkItemRef;expectedRevision:number;source:ResultSource},state:'waiting_input'):WorkItemRecord {
  return setStateWithDb(controllerDb(handle),input,state);
}
function setStateWithDb(db:Database.Database,input:{ref:WorkItemRef;expectedRevision:number;source:ResultSource},state:'waiting_input'|'failed'|'cancelled'):WorkItemRecord {
  return db.transaction(()=>{
    shape(input,['ref','expectedRevision','source']);integer(input.expectedRevision);
    const item=scopedWorkItem(db,input.ref);checkResultSource(db,item,input.source);
    if(item.revision!==input.expectedRevision||!inputsCurrent(db,item)) throw new KddError('stale revision or inputs');
    if(terminal(item)||state==='waiting_input'&&!['pending','ready'].includes(item.state)) throw new KddError('invalid state transition');
    if(db.prepare('SELECT 1 FROM work_item_owners WHERE work_item_id=? AND released_at IS NULL AND launch_id IS NOT NULL').get(item.ref.workItemId)) throw new KddError('launched owner must stop');
    db.prepare('UPDATE work_items SET state=? WHERE id=?').run(state,item.ref.workItemId);
    appendEvent(db,item.task.taskId,controllerActor,'work_item_state',{work_item_id:item.ref.workItemId,revision:item.revision,state});
    return scopedWorkItem(db,item.ref);
  }).immediate();
}
