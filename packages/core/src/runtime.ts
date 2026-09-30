import type Database from 'better-sqlite3';
import {controllerDb,openController,type ControllerHandle} from './controller.js';
import {now} from './db.js';
import {KddError} from './errors.js';
import {shape,text,integer,digest,newId,canonical,liveOwner,checkAuthority,scopedWorkItem,
  type OwnershipRef,type AuthorityBinding} from './execution.js';
import {recordLaunchIntent} from './execution_ownership.js';
import {readRunInputSnapshotDb} from './run_inputs.js';
import {projectOf} from './project_store.js';
import {redact} from './agent_events.js';

export type RuntimeKind='codex'|'claude';
export type RuntimeState='created'|'running'|'waiting'|'completed'|'failed'|'cancelled';
export type RuntimeReason='unsupported'|'spawn_failed'|'protocol_error'|'provider_error'|'timeout'|'idle_timeout'|
  'cancelled'|'authority_revoked'|'update_required'|'session_unavailable'|'stop_unknown'|'context_overflow';
export interface RuntimeRef{projectId:string;sessionId:string;attemptId:string}
export interface RuntimeLimits{timeoutMs:number;idleTimeoutMs:number;stopGraceMs:number;drainMs:number;
  maxPromptBytes:number;maxEventBytes:number;maxStreamBytes:number;maxStderrBytes:number;maxConcurrentAttempts:number}
export interface RuntimeAttempt{ref:RuntimeRef;owner:OwnershipRef;authority:AuthorityBinding;phase:'start'|'resume';
  state:RuntimeState;providerSessionId:string|null;reason:RuntimeReason|null;writersStopped:boolean;lastSequence:number}
export type RuntimeEventKind='session'|'attempt_start'|'text'|'tool_start'|'tool_finish'|'usage'|'error'|'provider_terminal'|'host_stop'|'attempt_end';
export interface RuntimeEvent{sequence:number;kind:RuntimeEventKind;detail:object}
export interface RuntimeAdmission{commandId:string;owner:OwnershipRef;authority:AuthorityBinding;
  runtime:RuntimeKind;version:string;model:string;effort:string;semanticHash:string;inputHash:string;
  phase:'start'|'resume';sessionId?:string;limits:RuntimeLimits}
const denied=(reason:string)=>new KddError(`runtime denied: ${reason}`);
const limitKeys=['timeoutMs','idleTimeoutMs','stopGraceMs','drainMs','maxPromptBytes','maxEventBytes','maxStreamBytes','maxStderrBytes','maxConcurrentAttempts'] as const;
export function validateRuntimeLimits(limits:RuntimeLimits):void{
  shape(limits,limitKeys);
  for(const key of limitKeys){integer(limits[key]);if(limits[key]>2147483647)throw denied('limit exceeds host capacity')}
  for(const key of ['maxPromptBytes','maxEventBytes','maxStreamBytes','maxStderrBytes'] as const)
    if(limits[key]>64*1024*1024)throw denied('byte limit exceeds host capacity');
  if(limits.maxEventBytes>limits.maxStreamBytes)throw denied('event limit exceeds stream limit');
}
function hash(value:string):void{if(typeof value!=='string'||!/^[0-9a-f]{64}$/.test(value))throw denied('invalid hash')}
export function readRuntimeAttemptDb(db:Database.Database,ref:RuntimeRef):RuntimeAttempt{
  shape(ref,['projectId','sessionId','attemptId']);
  if(ref.projectId!==projectOf(db).project_id)throw denied('foreign project');
  text(ref.sessionId);text(ref.attemptId);
  const row=db.prepare(`SELECT a.*,s.project_id,s.provider_session_id FROM runtime_attempts a
    JOIN runtime_sessions s ON s.id=a.session_id WHERE a.id=? AND s.id=? AND s.project_id=?`)
    .get(ref.attemptId,ref.sessionId,ref.projectId) as {work_item_id:string;revision:number;owner_id:string;fence:number;
      authority_id:string;run_id:string;generation:number;phase:'start'|'resume';state:RuntimeState;reason:RuntimeReason|null;
      writers_stopped:number;provider_session_id:string|null}|undefined;
  if(!row)throw denied('attempt not found');
  return {ref:{...ref},owner:{projectId:ref.projectId,workItemId:row.work_item_id,revision:row.revision,ownerId:row.owner_id,fence:row.fence},
    authority:{authorityId:row.authority_id,workItemId:row.work_item_id,runId:row.run_id,generation:row.generation},
    phase:row.phase,state:row.state,reason:row.reason,providerSessionId:row.provider_session_id,writersStopped:row.writers_stopped===1,
    lastSequence:(db.prepare('SELECT COALESCE(MAX(sequence),0) n FROM runtime_events WHERE attempt_id=?').get(ref.attemptId) as {n:number}).n};
}
export function runtimeAttempt(handle:ControllerHandle,ref:RuntimeRef):RuntimeAttempt{
  const db=controllerDb(handle);return db.transaction(()=>readRuntimeAttemptDb(db,ref))();
}
/** Internal host admission, never a native launch permit. Replays cannot spawn. */
export function admitRuntimeDb(db:Database.Database,input:RuntimeAdmission):RuntimeAttempt{
  if(!db.inTransaction)throw denied('admission requires transaction');
  shape(input,['commandId','owner','authority','runtime','version','model','effort','semanticHash','inputHash','phase','limits'],['sessionId']);
  text(input.commandId);if(input.commandId.length>256)throw denied('command too long');
  validateRuntimeLimits(input.limits);hash(input.semanticHash);hash(input.inputHash);
  for(const value of [input.version,input.model,input.effort]){text(value);if(value.length>256)throw denied('identity too long')}
  if(!['codex','claude'].includes(input.runtime)||!['start','resume'].includes(input.phase)
    ||(input.phase==='resume')!==(input.sessionId!==undefined)||redact(canonical(input))!==canonical(input))throw denied('invalid admission');
  const projectId=projectOf(db).project_id,commandHash=digest(input);
  const replay=db.prepare('SELECT id,session_id,command_hash FROM runtime_attempts WHERE command_id=?').get(input.commandId) as
    {id:string;session_id:string;command_hash:string}|undefined;
  if(replay){if(replay.command_hash!==commandHash)throw denied('command conflict');
    return readRuntimeAttemptDb(db,{projectId,sessionId:replay.session_id,attemptId:replay.id})}
  liveOwner(db,input.owner);
  const item=scopedWorkItem(db,{projectId:input.owner.projectId,workItemId:input.owner.workItemId});
  checkAuthority(db,item.task,input.authority);
  const snapshot=readRunInputSnapshotDb(db,input.authority.authorityId);
  if(snapshot.inputHash!==input.inputHash||canonical(snapshot.validation.ownership)!==canonical(input.owner)
    ||input.authority.workItemId!==input.owner.workItemId)throw denied('input binding mismatch');
  const active=(db.prepare('SELECT count(*) n FROM runtime_attempts WHERE ended_at IS NULL').get() as {n:number}).n;
  if(active>=input.limits.maxConcurrentAttempts)throw denied('active attempt capacity');
  let sessionId=input.sessionId;
  if(sessionId!==undefined){
    text(sessionId);
    const session=db.prepare('SELECT * FROM runtime_sessions WHERE id=?').get(sessionId) as
      {project_id:string;task_id:number;work_item_id:string;runtime:string;version:string;model:string;effort:string;semantic_hash:string;provider_session_id:string|null}|undefined;
    if(!session||session.project_id!==projectId||session.task_id!==item.task.taskId||session.work_item_id!==item.ref.workItemId
      ||session.runtime!==input.runtime||session.version!==input.version||session.model!==input.model||session.effort!==input.effort
      ||session.semantic_hash!==input.semanticHash||session.provider_session_id===null)throw denied('session unavailable or incompatible');
  }else{
    sessionId=newId();db.prepare(`INSERT INTO runtime_sessions(id,project_id,task_id,work_item_id,runtime,version,model,effort,semantic_hash,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(sessionId,projectId,item.task.taskId,item.ref.workItemId,input.runtime,input.version,input.model,input.effort,input.semanticHash,now());
  }
  const id=newId(),scope=newId();
  db.prepare(`INSERT INTO runtime_attempts(id,session_id,command_id,command_hash,work_item_id,fence,revision,owner_id,authority_id,run_id,
    generation,input_hash,phase,limits_json,writer_scope_id,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'created',?)`)
    .run(id,sessionId,input.commandId,commandHash,input.owner.workItemId,input.owner.fence,input.owner.revision,input.owner.ownerId,
      input.authority.authorityId,input.authority.runId,input.authority.generation,input.inputHash,input.phase,canonical(input.limits),scope,now());
  recordLaunchIntent(openController(db),{owner:input.owner,intent:{launchId:id,writerScopeId:scope,authority:input.authority}});
  return readRuntimeAttemptDb(db,{projectId,sessionId,attemptId:id});
}
/** Host supplies exact credentials privately; the list is never persisted. */
export function redactRuntimeDetail(detail:object,secrets:readonly string[]=[],maxBytes=64*1024*1024):string{
  integer(maxBytes);if(maxBytes>64*1024*1024)throw denied('byte limit exceeds host capacity');
  if(!Array.isArray(secrets)||secrets.length>16||secrets.some(s=>typeof s!=='string'||s.length<16||s.length>4096))
    throw denied('invalid credential redaction');
  let safe=JSON.stringify(detail,(_key,value)=>typeof value==='string'?redact(value):value);
  if(typeof safe!=='string')throw denied('invalid event detail');
  for(const secret of secrets)safe=safe.split(JSON.stringify(secret).slice(1,-1)).join('[redacted]');
  if(Buffer.byteLength(safe)>maxBytes)throw denied('event limit exceeded');
  return safe;
}
export function appendRuntimeEventDb(db:Database.Database,ref:RuntimeRef,kind:RuntimeEventKind,detail:object,secrets:readonly string[]=[]):RuntimeEvent{
  if(!db.inTransaction)throw denied('journal requires transaction');
  const attempt=readRuntimeAttemptDb(db,ref);
  const limits=JSON.parse((db.prepare('SELECT limits_json FROM runtime_attempts WHERE id=?').get(ref.attemptId) as {limits_json:string}).limits_json) as RuntimeLimits;
  const raw=JSON.stringify(detail);
  if(typeof raw!=='string'||Buffer.byteLength(raw)>limits.maxEventBytes)throw denied('event limit exceeded');
  const safe=redactRuntimeDetail(detail,secrets,limits.maxEventBytes),sequence=attempt.lastSequence+1;integer(sequence);
  db.prepare('INSERT INTO runtime_events VALUES(?,?,?,?,?)').run(ref.attemptId,sequence,kind,safe,now());
  return {sequence,kind,detail:JSON.parse(safe)};
}
export function runtimeEvents(handle:ControllerHandle,input:{ref:RuntimeRef;afterSequence:number;limit:number}):RuntimeEvent[]{
  const db=controllerDb(handle);shape(input,['ref','afterSequence','limit']);integer(input.afterSequence,0);integer(input.limit);
  if(input.limit>1000)throw denied('journal page limit');
  return db.transaction(()=>{
    readRuntimeAttemptDb(db,input.ref);
    return (db.prepare('SELECT sequence,kind,detail_json FROM runtime_events WHERE attempt_id=? AND sequence>? ORDER BY sequence LIMIT ?')
      .all(input.ref.attemptId,input.afterSequence,input.limit) as {sequence:number;kind:RuntimeEventKind;detail_json:string}[])
      .map(row=>({sequence:row.sequence,kind:row.kind,detail:JSON.parse(row.detail_json)}));
  })();
}
