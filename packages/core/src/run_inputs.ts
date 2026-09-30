import type Database from 'better-sqlite3';
import type { RunOperation, RunContextSnapshot } from './authority.js';
import type { RoleRef } from './roles.js';
import { roleActiveDb, roleFilesDb, roleRevisionDb } from './roles.js';
import { controllerDb, type ControllerHandle } from './controller.js';
import { digest, shape, integer, type TaskRef, type WorkItemRef, type WorkItemDefinition, type OwnershipRef } from './execution.js';
import type { ResultPayload, ResultBinding } from './execution_results.js';
import type { MemoryRecord, MemoryRepoVersion } from './memory.js';
import { projectOf } from './project_store.js';
import { KddError } from './errors.js';

export interface RunInputGrant {
  projectId: string; taskId: number; workItemId: string; runId: string; generation: number;
  role?: RoleRef;
  operations: readonly RunOperation[];
  repositories: readonly { repoId: string; checkoutPath: string; commonDir: string; write: boolean }[];
  ownership?: OwnershipRef;
  native: { readableRoots: readonly string[]; writableRoot?: string; scratchDir: string; configHash: string; contextWindow?: number };
}
export interface RunInputOptions { maxBytes?: number; query?: string; k?: number }
export interface RunInputRef { projectId: string; authorityId: string }
export interface RequirementInput {
  task: TaskRef; parentId: number | null; hash: string; title: string; body: string | null;
  criteria: { id: number; text: string }[];
}
export type DependencyContextPayload = Exclude<ResultPayload, { kind: 'contract' }> |
  Omit<Extract<ResultPayload, { kind: 'contract' }>, 'artifact'>;
export interface DependencyContextInput {
  edgeKey: string; resultId: string; payloadHash: string; binding: ResultBinding;
  payload: DependencyContextPayload; artifact?: { sha256: string; body: string };
}
interface RunInputBase {
  authorityId: string; inputHash: string; createdAt: number;
  budget: { maxBytes: number; omittedRecords: number };
  requirements: RequirementInput[]; rules: MemoryRecord[]; knowledge: MemoryRecord[];
  workItem: { ref: WorkItemRef; revision: number; inputsHash: string; definition: WorkItemDefinition } | null;
  dependencies: DependencyContextInput[]; repositories: { repoId: string; commit: string; write: boolean }[];
  operations: RunOperation[]; nativeConfigHash: string;
}
export interface RunRolePin extends RoleRef {
  hash: string; manifestHash: string; model: string; effort: string; contextWindow: number;
  skills: { name: string; mode: 'Always' | 'Available'; manifestHash: string }[];
  operations: RunOperation[]; nativeConfigHash: string;
}
export type RunInputSections = (RunInputBase & { schemaVersion: 1; role?: never }) |
  (RunInputBase & { schemaVersion: 2; role: RunRolePin });
export interface RunInputValidation {
  repositories: MemoryRepoVersion[]; ownership: OwnershipRef | null;
  inputResults: { edgeKey: string; resultId: string }[];
  artifacts: { resultId: string; path: string; sha256: string }[];
}
export interface RunInputSnapshot {
  authorityId: string; inputHash: string; createdAt: number;
  response: RunContextSnapshot & { inputs: RunInputSections }; validation: RunInputValidation;
}
const denied = () => new KddError('run input snapshot denied');
function rolePinDb(db: Database.Database, grant: RunInputGrant): RunRolePin {
  if (!grant.role || !Number.isSafeInteger(grant.native.contextWindow) || grant.native.contextWindow! < 1) throw denied();
  const { definition, receipt } = roleRevisionDb(db, grant.role), files = roleFilesDb(db, grant.role);
  return { ...receipt, model: definition.model, effort: definition.effort, contextWindow: grant.native.contextWindow!,
    skills: definition.skills.map(skill => ({ name: skill.name, mode: skill.mode,
      manifestHash: digest(files.filter(file => file.skill === skill.name)
        .map(file => ({ path: file.path, sha256: file.sha256, mime: file.mime, size: file.bytes.length }))) })),
    operations: [...grant.operations], nativeConfigHash: grant.native.configHash };
}
export function runInputHash(snapshot: RunInputSnapshot): string {
  return digest({ ...snapshot, inputHash: undefined, response: { ...snapshot.response,
    inputs: { ...snapshot.response.inputs, inputHash: undefined } } });
}
export function readRunInputSnapshotDb(db: Database.Database, authorityId: string): RunInputSnapshot {
  if (!db.inTransaction || typeof authorityId !== 'string' || !/^[0-9a-f]{32}$/.test(authorityId)) throw denied();
  try {
    const row = db.prepare('SELECT * FROM run_input_snapshots WHERE authority_id=?').get(authorityId) as
      { input_hash: string; payload_json: string; created_at: number } | undefined;
    const authority = db.prepare('SELECT * FROM run_authorities WHERE authority_id=?').get(authorityId) as
      { task_id: number; work_item_id: string; run_id: string; generation: number; grant_json: string } | undefined;
    if (!row || !authority) throw denied();
    const snapshot = JSON.parse(row.payload_json) as RunInputSnapshot, grant = JSON.parse(authority.grant_json) as RunInputGrant;
    shape(snapshot, ['authorityId','inputHash','createdAt','response','validation']);
    const {response:r,validation:v} = snapshot, inputs = r.inputs;
    shape(v,['repositories','ownership','inputResults','artifacts']);
    const baseKeys = ['schemaVersion','authorityId','inputHash','createdAt','budget','requirements','rules','knowledge',
      'workItem','dependencies','repositories','operations','nativeConfigHash'];
    if (inputs.schemaVersion === 2) shape(inputs, [...baseKeys, 'role']);
    else if (inputs.schemaVersion === 1) shape(inputs, baseKeys);
    else throw denied();
    integer(snapshot.createdAt,0);
    if (snapshot.authorityId !== authorityId || inputs.authorityId !== authorityId
      || row.created_at !== snapshot.createdAt || inputs.createdAt !== snapshot.createdAt
      || snapshot.inputHash !== row.input_hash || inputs.inputHash !== row.input_hash || runInputHash(snapshot) !== row.input_hash
      || r.projectId !== projectOf(db).project_id || grant.projectId !== r.projectId
      || r.taskId !== authority.task_id || grant.taskId !== r.taskId || r.workItemId !== authority.work_item_id
      || grant.workItemId !== r.workItemId || r.runId !== authority.run_id || grant.runId !== r.runId
      || r.generation !== authority.generation || grant.generation !== r.generation
      || digest(inputs.operations) !== digest(grant.operations) || inputs.nativeConfigHash !== grant.native.configHash
      || ![inputs.requirements,inputs.rules,inputs.knowledge,inputs.dependencies,inputs.repositories,
        v.repositories,v.inputResults,v.artifacts].every(Array.isArray)) throw denied();
    if (inputs.schemaVersion === 2) {
      if (!grant.role || digest(grant.role) !== digest({ roleId: inputs.role.roleId, revision: inputs.role.revision })
        || digest(inputs.role) !== digest(rolePinDb(db, grant))) throw denied();
    } else if (grant.role) throw denied();
    return snapshot;
  } catch { throw denied(); }
}
export function persistRunInputSnapshotDb(db: Database.Database, snapshot: RunInputSnapshot): void {
  if (!db.inTransaction) throw denied();
  db.prepare('INSERT INTO run_input_snapshots VALUES(?,?,?,?)')
    .run(snapshot.authorityId,snapshot.inputHash,JSON.stringify(snapshot),snapshot.createdAt);
  readRunInputSnapshotDb(db,snapshot.authorityId);
}
export function runInputSnapshot(handle: ControllerHandle, ref: RunInputRef): RunInputSnapshot {
  const db = controllerDb(handle);
  return db.transaction(() => {
    shape(ref,['projectId','authorityId']);
    if (ref.projectId !== projectOf(db).project_id) throw denied();
    return readRunInputSnapshotDb(db,ref.authorityId);
  })();
}

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants, openSync, closeSync, fstatSync, lstatSync, realpathSync, readFileSync, existsSync } from 'node:fs';
import { isAbsolute, dirname, resolve, relative } from 'node:path';
import { contractHash, scopedTask, scopedWorkItem, inputsCurrent, checkOwnershipRef, canonical } from './execution.js';
import { rowResult, pinnedInputsCurrent, dependencyProjection, type ResultObservers } from './execution_results.js';
import { selectMemory, memoryRecordDb, memoryCheckout, memoryCommit, memoryPrivatePath, type MemoryView } from './memory.js';
import { queryMemoryDb } from './memory_query.js';
import { canonicalCommonDir } from './project_store.js';
import { CAPS } from './caps.js';
import { sanitizeQuery } from './recall.js';
import { redact } from './agent_events.js';
import { now } from './db.js';
import { listCriteria } from './criteria.js';
import { filesDir } from './files.js';
import { inside } from './codex_permissions.js';

export function runContextWireBytes(response: RunContextSnapshot): number {
  return Buffer.byteLength(JSON.stringify({content:[{type:'text',text:JSON.stringify(response)}]}),'utf8');
}
function safeContext(value: unknown): void {
  const encoded=JSON.stringify(value);
  if (redact(encoded)!==encoded || Buffer.from(encoded).toString('utf8')!==encoded) throw new KddError('private or malformed run input');
}
export function readRunArtifact(db: Database.Database, path: string, hash: string, maxBytes: number,
  privateRoots: readonly string[], checkouts: readonly string[]): string {
  try {
    if (!isAbsolute(path) || resolve(path)!==path || realpathSync(path)!==path || !/^[0-9a-f]{64}$/.test(hash)) throw denied();
    for(let ancestor=path;;ancestor=dirname(ancestor)) {
      if(lstatSync(ancestor).isSymbolicLink()) throw denied();
      if(dirname(ancestor)===ancestor)break;
    }
    const fileRoot=filesDir(db.name), stored=existsSync(fileRoot)&&realpathSync(fileRoot)===fileRoot&&inside(fileRoot,path);
    if(memoryPrivatePath(stored?relative(fileRoot,path):path)
      || privateRoots.some(root=>inside(root,path)
        &&!(stored&&root!==fileRoot&&inside(root,fileRoot))
        &&!checkouts.some(checkout=>root!==checkout&&inside(root,checkout)&&inside(checkout,path)&&!memoryPrivatePath(relative(checkout,path))))) throw denied();
    const before=lstatSync(path);
    if(!before.isFile()||before.nlink!==1||before.size>maxBytes) throw denied();
    for(const privatePath of [db.name,db.name+'-wal',db.name+'-shm']) {
      if(path===privatePath)throw denied();
      if(existsSync(privatePath)) {const s=lstatSync(privatePath);if(s.dev===before.dev&&s.ino===before.ino)throw denied();}
    }
    const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try {
      const file=fstatSync(fd);
      if(file.dev!==before.dev||file.ino!==before.ino||!file.isFile()||file.nlink!==1||file.size>maxBytes)throw denied();
      const bytes=readFileSync(fd),after=fstatSync(fd),current=lstatSync(path);
      if(bytes.length!==file.size||after.dev!==file.dev||after.ino!==file.ino||after.nlink!==1
        ||after.size!==file.size||after.mtimeMs!==file.mtimeMs||after.ctimeMs!==file.ctimeMs
        ||current.dev!==file.dev||current.ino!==file.ino||current.isSymbolicLink()
        ||createHash('sha256').update(bytes).digest('hex')!==hash)throw denied();
      const body=new TextDecoder('utf-8',{fatal:true}).decode(bytes);safeContext(body);return body;
    }finally{closeSync(fd);}
  }catch{throw new KddError('unsafe or changed run input artifact');}
}
export function runInputRequirements(db: Database.Database, grant: RunInputGrant): RequirementInput[] {
  const task=scopedTask(db,{projectId:grant.projectId,taskId:grant.taskId});
  const ids=[...(task.parent_id===null?[]:[task.parent_id]),task.id];
  if(db.prepare('SELECT 1 FROM work_items WHERE id=?').get(grant.workItemId)) {
    const item=scopedWorkItem(db,{projectId:grant.projectId,workItemId:grant.workItemId});
    for(const input of item.inputs)if(!ids.includes(input.task.taskId))ids.push(input.task.taskId);
  }
  return ids.map(taskId=>{
    const ref={projectId:grant.projectId,taskId},t=scopedTask(db,ref);
    return {task:ref,parentId:t.parent_id,hash:contractHash(db,ref),title:t.title,body:t.body,
      criteria:db.prepare('SELECT id,text FROM criteria WHERE task_id=? ORDER BY id').all(taskId) as RequirementInput['criteria']};
  });
}
export function buildRunInputSnapshot(db: Database.Database, original: RunInputGrant, authorityId: string,
  options: RunInputOptions = {}, observers: ResultObservers = {}, privateRoots: readonly string[] = []): RunInputSnapshot {
  if(!db.inTransaction || !/^[0-9a-f]{32}$/.test(authorityId))throw denied();
  const grant=structuredClone(original);shape(options,[],['maxBytes','query','k']);
  if (!grant.role || !roleActiveDb(db, grant.role.roleId)) throw denied();
  const role = rolePinDb(db, grant);
  const maxBytes=options.maxBytes??CAPS.agentDetailBytes;integer(maxBytes);
  if(maxBytes>CAPS.agentDetailBytes)throw new KddError('run input budget exceeds limit');
  if(options.k!==undefined){integer(options.k);if(options.k>CAPS.recallKMax)throw denied();}
  const task=scopedTask(db,{projectId:grant.projectId,taskId:grant.taskId});
  const repositories=grant.repositories.map(repo=>{
    const checkoutPath=memoryCheckout(db,repo.repoId,repo.checkoutPath);
    if(canonicalCommonDir(checkoutPath)!==repo.commonDir)throw denied();
    const commit=execFileSync('/usr/bin/git',['--no-replace-objects','rev-parse','--verify','HEAD^{commit}'],
      {cwd:checkoutPath,encoding:'utf8',stdio:'pipe',maxBuffer:4096}).trim();
    memoryCommit(db,repo.repoId,commit,checkoutPath);return {repoId:repo.repoId,checkoutPath,commit};
  });
  const view:MemoryView={scope:{projectId:grant.projectId,taskId:grant.taskId},repositories};
  const requirements=runInputRequirements(db,grant),eligible=selectMemory(db,view),rules=eligible.filter(r=>r.kind==='rule');
  const modeled=!!db.prepare('SELECT 1 FROM work_items WHERE id=?').get(grant.workItemId);
  const item=modeled?scopedWorkItem(db,{projectId:grant.projectId,workItemId:grant.workItemId}):null;
  let inputResults:RunInputValidation['inputResults']=[];
  if(item){
    if(!grant.ownership)throw new KddError('modeled work requires ownership');checkOwnershipRef(db,grant.ownership);
    const o=db.prepare('SELECT * FROM work_item_owners WHERE work_item_id=? AND fence=? AND owner_id=? AND revision=? AND released_at IS NULL')
      .get(item.ref.workItemId,grant.ownership.fence,grant.ownership.ownerId,grant.ownership.revision) as
      {inputs_json:string;write_access:number}|undefined;
    if(!o||item.task.taskId!==task.id||item.revision!==grant.ownership.revision||item.fence!==grant.ownership.fence||!inputsCurrent(db,item))throw denied();
    const pins=JSON.parse(o.inputs_json) as {projectId:string;inputsHash:string;inputResults:RunInputValidation['inputResults']};
    if(pins.projectId!==grant.projectId||pins.inputsHash!==item.inputsHash||!pinnedInputsCurrent(db,item,pins.inputResults))throw denied();
    if(grant.repositories.some(r=>r.write&&(!o.write_access||item.definition.repoId!==r.repoId)))throw denied();
    inputResults=pins.inputResults;
    for(const dep of item.dependencies)if(dep.binding.kind==='code'||dep.binding.kind==='merged'){
      const binding=dep.binding;
      if(!repositories.some(r=>r.repoId===binding.repoId&&r.commit===binding.baseHead))throw new KddError('dependency base differs from run input');
    }
    if(!dependencyProjection(db,item,observers).ready)throw new KddError('run input dependencies not verified');
  }else if(grant.ownership)throw denied();
  const artifacts:RunInputValidation['artifacts']=[];
  const dependencies=inputResults.map(pin=>{
    const record=rowResult(db,pin.resultId),payload=record.payload;
    if(payload.kind==='contract'){
      const body=readRunArtifact(db,payload.artifact.path,payload.artifact.sha256,maxBytes,privateRoots,repositories.map(r=>r.checkoutPath));
      artifacts.push({resultId:record.id,...payload.artifact});
      return {edgeKey:pin.edgeKey,resultId:record.id,payloadHash:digest(payload),binding:record.binding,
        payload:{kind:payload.kind,repoId:payload.repoId,version:payload.version,checkRefs:[...payload.checkRefs],head:payload.head},
        artifact:{sha256:payload.artifact.sha256,body}};
    }
    return {edgeKey:pin.edgeKey,resultId:record.id,payloadHash:digest(payload),binding:record.binding,payload};
  });
  const query=options.query??task.title;
  if(typeof query!=='string'||query.length>CAPS.bodyChars)throw denied();safeContext(query);
  let match='';try{match=sanitizeQuery(query);}catch(error){if(!(error instanceof KddError)||error.message!=='empty query')throw error;}
  const hits=match?queryMemoryDb(db,view,query,{k:options.k},['fact','decision']):[];
  const optional=hits.filter(h=>h.kind==='fact'||h.kind==='decision').map(h=>memoryRecordDb(db,h.ref.entryId,h.ref.revision));
  const createdAt=now(),snapshot:RunInputSnapshot={authorityId,inputHash:'0'.repeat(64),createdAt,
    response:{projectId:grant.projectId,taskId:grant.taskId,workItemId:grant.workItemId,runId:grant.runId,generation:grant.generation,
      task:{title:task.title,body:task.body,status:task.status},
      criteria:listCriteria(db,task.id).map(c=>({id:c.id,text:c.text,checked:c.checked_at!==null})),
      decisions:db.prepare(`SELECT d.slug,d.title FROM decisions d,json_each(d.source_tasks) s WHERE CAST(s.value AS INTEGER)=? ORDER BY d.slug`)
        .all(task.id) as {slug:string;title:string}[],
      inputs:{schemaVersion:2,role,authorityId,inputHash:'0'.repeat(64),createdAt,budget:{maxBytes,omittedRecords:optional.length},
        requirements,rules,knowledge:[],workItem:item?{ref:item.ref,revision:item.revision,inputsHash:item.inputsHash,definition:item.definition}:null,
        dependencies,repositories:repositories.map((r,i)=>({repoId:r.repoId,commit:r.commit,write:grant.repositories[i].write})),
        operations:[...grant.operations],nativeConfigHash:grant.native.configHash}},
    validation:{repositories,ownership:grant.ownership??null,inputResults,artifacts}};
  safeContext(snapshot.response);
  const finalize=()=>{snapshot.inputHash=runInputHash(snapshot);snapshot.response.inputs.inputHash=snapshot.inputHash;return runContextWireBytes(snapshot.response);};
  let requiredBytes=finalize();if(requiredBytes>maxBytes)throw new KddError(`run input budget exceeded: requiredBytes=${requiredBytes} limit=${maxBytes}`);
  for(const record of optional){
    safeContext(record);snapshot.response.inputs.knowledge.push(record);snapshot.response.inputs.budget.omittedRecords--;
    if(finalize()>maxBytes){snapshot.response.inputs.knowledge.pop();snapshot.response.inputs.budget.omittedRecords++;finalize();}
  }
  // Recheck sources after host observers; callbacks cannot silently change the captured input set.
  if(canonical(requirements)!==canonical(runInputRequirements(db,grant))
    ||digest(rules)!==digest(selectMemory(db,view).filter(r=>r.kind==='rule'))
    ||item&&(!inputsCurrent(db,item)||!pinnedInputsCurrent(db,scopedWorkItem(db,item.ref),inputResults)))throw new KddError('run inputs changed during assembly');
  for(const repo of repositories){
    const head=execFileSync('/usr/bin/git',['--no-replace-objects','rev-parse','--verify','HEAD^{commit}'],{cwd:repo.checkoutPath,encoding:'utf8',stdio:'pipe'}).trim();
    if(head!==repo.commit)throw new KddError('run repository changed during assembly');
  }
  return snapshot;
}
