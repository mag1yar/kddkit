import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as core from '../src/index.js';
import { cleanupFixtures, fixture } from './execution_fixture.js';
afterEach(cleanupFixtures);
function contractFlow(checkRefs: readonly string[] = []) {
  const f = fixture(), a = f.task('API'), b = f.task('frontend');
  const definition: core.WorkItemDefinition = { kind: 'architecture', repoId: null,
    sourceTasks: [], outputs: [{ key: 'api', kind: 'contract', required: true, version: 'v1', checkRefs }] };
  const producer = core.createWorkItem(f.handle, { task: f.ref(a.id), definition, dependencies: [] });
  const consumer = core.createWorkItem(f.handle, { task: f.ref(b.id),
    definition: { kind: 'implementation', repoId: null, sourceTasks: [], outputs: [] },
    dependencies: [{ key: 'api', producer: producer.ref, producerRevision: 1, outputKey: 'api',
      binding: { kind: 'contract', repoId: null, version: 'v1' } }] });
  const artifact = join(f.root,'api.json'); writeFileSync(artifact,'{"schema":"v1"}\n');
  const payload: core.ResultPayload = { kind:'contract', repoId:null, head:null, version:'v1',checkRefs,
    artifact:{path:artifact,sha256:createHash('sha256').update(readFileSync(artifact)).digest('hex')} };
  const source: core.ResultSource = {kind:'manual',sourceTask:f.ref(a.id),instructionRef:'owner:publish'};
  const publication: core.PublishResultInput = {commandId:'publish:api',producer:producer.ref,
    expectedRevision:1,outputKey:'api',expectedResultId:null,payload,source};
  return {...f,producer,consumer,artifact,payload,source,publication};
}
it('requires output and work completion before pinning the exact result', () => {
  const f=contractFlow();
  expect(core.inspectDependencies(f.handle,f.consumer.ref).ready).toBe(false);
  const published=core.publishResult(f.handle,f.publication);
  expect(core.inspectDependencies(f.handle,f.consumer.ref).ready).toBe(false);
  core.completeWorkItem(f.handle,{ref:f.producer.ref,expectedRevision:1,source:f.source});
  const ready=core.resolveDependencies(f.handle,{ref:f.consumer.ref,expectedRevision:1});
  expect(ready.ready).toBe(true);
  expect(ready.edges).toEqual([expect.objectContaining({key:'api',resultId:published.id,pinned:true,satisfied:true})]);
  writeFileSync(f.artifact,'changed');
  expect(core.inspectDependencies(f.handle,f.consumer.ref).ready).toBe(false);
  rmSync(f.artifact);
  expect(core.inspectDependencies(f.handle,f.consumer.ref).ready).toBe(false);
});

import { vi } from 'vitest';
afterEach(()=>vi.restoreAllMocks());
const verified: core.ResultObservers = { observe: request => ({ request: structuredClone(request), verdict:'pass',
  origin:request.kind==='merge_acceptance'||request.kind==='readiness_confirmation'?'user':'host',observedAt:core.now(),expiresAt:null }) };
it('keeps command replays immutable and atomically supersedes an output before completion', () => {
  const f=contractFlow(), first=core.publishResult(f.handle,f.publication);
  const events=f.db.prepare('SELECT * FROM events').all();
  expect(core.publishResult(f.handle,f.publication)).toEqual(first);
  expect(f.db.prepare('SELECT * FROM events').all()).toEqual(events);
  expect(()=>core.publishResult(f.handle,{...f.publication,source:{...f.source,instructionRef:'different'}})).toThrow(/conflict/);
  expect(()=>core.publishResult(f.handle,{...f.publication,commandId:'another',expectedResultId:null})).toThrow(/conflict/);
  const second=core.publishResult(f.handle,{...f.publication,commandId:'correct',expectedResultId:first.id});
  expect(core.result(f.handle,first.id)).toMatchObject({payload:first.payload,source:first.source,successorId:second.id,invalidationReason:'superseded'});
  expect(core.publishResult(f.handle,f.publication).id).toBe(first.id);
  core.completeWorkItem(f.handle,{ref:f.producer.ref,expectedRevision:1,source:f.source});
  expect(()=>core.publishResult(f.handle,{...f.publication,commandId:'terminal',expectedResultId:second.id})).toThrow(/terminal/);
  expect(f.db.prepare('SELECT count(*) n FROM work_item_results').get()).toEqual({n:2});
  expect(()=>f.db.exec("UPDATE work_item_results SET payload_json='{}'")).toThrow(/immutable/);
  expect(()=>f.db.exec('DELETE FROM work_item_results')).toThrow(/immutable/);
  expect(()=>f.db.prepare('UPDATE work_item_results SET invalidated_at=NULL WHERE id=?').run(first.id)).toThrow(/final/);
});
it('never substitutes a successor for a pinned result and deduplicates invalidation commands', () => {
  const f=contractFlow(), old=core.publishResult(f.handle,f.publication);
  core.completeWorkItem(f.handle,{ref:f.producer.ref,expectedRevision:1,source:f.source});
  core.resolveDependencies(f.handle,{ref:f.consumer.ref,expectedRevision:1});
  const rework=core.createWorkItem(f.handle,{task:f.producer.task,definition:f.producer.definition,dependencies:[]});
  const successor=core.publishResult(f.handle,{...f.publication,producer:rework.ref,commandId:'rework'});
  const input={commandId:'invalidate',resultId:old.id,reason:'new contract',successorId:successor.id};
  core.invalidateResult(f.handle,input);const events=f.db.prepare('SELECT * FROM events').all();
  core.invalidateResult(f.handle,input);expect(f.db.prepare('SELECT * FROM events').all()).toEqual(events);
  expect(()=>core.invalidateResult(f.handle,{...input,reason:'changed'})).toThrow(/conflict/);
  expect(core.inspectDependencies(f.handle,f.consumer.ref)).toMatchObject({ready:false,edges:[{resultId:old.id,reason:'stale_revision'}]});
  expect(core.workItem(f.handle,f.consumer.ref).dependencies[0].resultId).toBe(old.id);
  expect(()=>f.db.prepare('UPDATE work_item_dependencies SET pinned_result_id=?').run(successor.id)).toThrow(/pinned/);
});
it('refuses missing mandatory outputs and ignores card done, comments, checkbox evidence and exit zero', () => {
  const f=contractFlow();
  const criterion=core.listCriteria(f.db,f.producer.task.taskId)[0];
  core.setCriterionChecked(f.db,f.producer.task.taskId,criterion.id,true,{type:'user'},'exit 0');
  core.commentTask(f.db,f.producer.task.taskId,'ready, checks passed, exit 0',{type:'user'});
  core.moveTask(f.db,f.producer.task.taskId,'done',{type:'user'},'owner requested legacy done');
  expect(core.inspectDependencies(f.handle,f.consumer.ref).ready).toBe(false);
  expect(()=>core.completeWorkItem(f.handle,{ref:f.producer.ref,expectedRevision:1,source:f.source})).toThrow(/missing_output/);
  expect(f.db.prepare('SELECT count(*) n FROM work_item_results').get()).toEqual({n:0});
});
it.each(['failed','cancelled','waiting_input'] as const)('keeps a %s producer closed without releasing or synthesizing results', state=>{
  const f=contractFlow();core.publishResult(f.handle,f.publication);
  if(state==='waiting_input')core.setWorkItemWaiting(f.handle,{ref:f.producer.ref,expectedRevision:1,source:f.source});
  else core.endWorkItem(f.handle,{ref:f.producer.ref,expectedRevision:1,source:f.source,state});
  expect(core.inspectDependencies(f.handle,f.consumer.ref)).toMatchObject({ready:false,edges:[{reason:state==='waiting_input'?'producer_not_completed':state}]});
  if(state!=='waiting_input')expect(()=>core.reviseWorkItem(f.handle,{ref:f.producer.ref,expectedRevision:1,definition:f.producer.definition,dependencies:[]})).toThrow(/terminal/);
});
it('checks mandatory evidence through bound host observations on every read', () => {
  const f=contractFlow(['check:api']);
  const before=f.db.prepare('SELECT * FROM events').all();
  const bad:core.ResultObservers[]=[{}, {observe:()=>null}, {observe:()=>{throw Error('offline')}},
    ...(['fail','inconclusive'] as const).map(verdict=>({observe:(request:core.EvidenceRequest)=>({...verified.observe!(request)!,verdict})})),
    {observe:request=>({...verified.observe!(request)!,origin:'user'})},
    {observe:request=>({...verified.observe!(request)!,observedAt:core.now()+60})},
    {observe:request=>({...verified.observe!(request)!,expiresAt:core.now()})},
    {observe:request=>({...verified.observe!(request)!,request:{...request,binding:{...request.binding,inputsHash:'wrong'}}})}];
  for(const observers of bad)expect(()=>core.publishResult(f.handle,f.publication,observers)).toThrow(/checks_not_passed/);
  expect(f.db.prepare('SELECT * FROM events').all()).toEqual(before);
  expect(()=>core.publishResult(f.handle,{...f.publication,payload:{...f.payload,checkRefs:[]}},verified)).toThrow(/checks_not_passed/);
  core.publishResult(f.handle,f.publication,verified);
  core.completeWorkItem(f.handle,{ref:f.producer.ref,expectedRevision:1,source:f.source},verified);
  expect(core.inspectDependencies(f.handle,f.consumer.ref,verified).ready).toBe(true);
  for(const observers of bad)expect(core.inspectDependencies(f.handle,f.consumer.ref,observers).ready).toBe(false);
});
it('refuses a durable check for another payload before superseding a result', () => {
  const f=contractFlow(['check:api']);
  let checked:core.EvidenceObservation|undefined;
  const recorded:core.ResultObservers={observe:request=>{
    checked??=verified.observe!(request)!;
    return structuredClone(checked);
  }};
  const first=core.publishResult(f.handle,f.publication,recorded);
  const correctedPath=join(f.root,'corrected-api.json');writeFileSync(correctedPath,'{"schema":"corrected"}\n');
  const corrected:core.ResultPayload={...f.payload,kind:'contract',head:null,
    artifact:{path:correctedPath,sha256:createHash('sha256').update(readFileSync(correctedPath)).digest('hex')}};
  const before=f.db.prepare('SELECT * FROM events').all();
  for(const payload of [corrected,{...f.payload,head:'different-source-head'}]) {
    expect(()=>core.publishResult(f.handle,{...f.publication,commandId:'correct',expectedResultId:first.id,payload},recorded)).toThrow(/checks_not_passed/);
  }
  expect(f.db.prepare('SELECT * FROM events').all()).toEqual(before);
  expect(core.result(f.handle,first.id)).toMatchObject({invalidatedAt:null,successorId:null});
  expect(f.db.prepare('SELECT count(*) n FROM work_item_results').get()).toEqual({n:1});
  let rechecked:core.EvidenceObservation|undefined;
  const current:core.ResultObservers={observe:request=>{
    rechecked??=verified.observe!(request)!;
    return structuredClone(rechecked);
  }};
  const second=core.publishResult(f.handle,{...f.publication,commandId:'correct',expectedResultId:first.id,payload:corrected},current);
  core.completeWorkItem(f.handle,{ref:f.producer.ref,expectedRevision:1,source:f.source},current);
  expect(core.resolveDependencies(f.handle,{ref:f.consumer.ref,expectedRevision:1},recorded)).toMatchObject({ready:false,edges:[{reason:'checks_not_passed'}]});
  expect(core.resolveDependencies(f.handle,{ref:f.consumer.ref,expectedRevision:1},current)).toMatchObject({ready:true,edges:[{resultId:second.id,pinned:true}]});
});
it('propagates real parent and additional source requirements, while checkbox and order changes stay outside inputs', () => {
  const f=fixture(), parent=f.task('parent'), extra=f.task('additional');
  const child=core.createSubtasks(f.handle,{parent:f.ref(parent.id),expectedParentHash:core.taskContractHash(f.handle,f.ref(parent.id)),
    source:{kind:'manual',sourceTask:f.ref(parent.id),instructionRef:'split'},children:[{key:'c',title:'child',criteria:['deliver']}]}).c;
  const item=core.createWorkItem(f.handle,{task:f.ref(child.id),definition:{kind:'analysis',repoId:null,sourceTasks:[f.ref(extra.id)],outputs:[]},dependencies:[]});
  expect(item.inputs.map(i=>i.task.taskId)).toEqual([parent.id,extra.id,child.id]);
  const source:core.ResultSource={kind:'manual',sourceTask:f.ref(child.id),instructionRef:'complete'};
  for(const sql of ["UPDATE tasks SET title='changed' WHERE id=?","UPDATE tasks SET body='changed' WHERE id=?"]) {
    const old=core.mustGetTask(f.db,parent.id);f.db.prepare(sql).run(parent.id);
    expect(core.inspectDependencies(f.handle,item.ref).inputsCurrent).toBe(false);
    expect(()=>core.completeWorkItem(f.handle,{ref:item.ref,expectedRevision:1,source})).toThrow(/stale/);
    f.db.prepare('UPDATE tasks SET title=?,body=? WHERE id=?').run(old.title,old.body,parent.id);
  }
  const criterion=core.listCriteria(f.db,parent.id)[0];
  f.db.prepare("UPDATE criteria SET text='changed' WHERE id=?").run(criterion.id);
  expect(core.inspectDependencies(f.handle,item.ref).inputsCurrent).toBe(false);
  f.db.prepare('UPDATE criteria SET text=?,checked_at=7,evidence=?,position=100 WHERE id=?').run(criterion.text,'proof',criterion.id);
  core.commentTask(f.db,parent.id,'irrelevant comment',{type:'user'});
  f.db.prepare("UPDATE tasks SET position=100,status='done' WHERE id=?").run(parent.id);
  expect(core.inspectDependencies(f.handle,item.ref).inputsCurrent).toBe(true);
  core.editTask(f.db,extra.id,{body:'new additional requirement'},{type:'user'});
  expect(core.inspectDependencies(f.handle,item.ref).inputsCurrent).toBe(false);
});
it('evaluates a diamond DAG without mistaking shared upstream results for a cycle', () => {
  const f=contractFlow();core.publishResult(f.handle,f.publication);
  core.completeWorkItem(f.handle,{ref:f.producer.ref,expectedRevision:1,source:f.source});
  const branches=[0,1].map(i=>{
    const task=f.task('branch '+i), item=core.createWorkItem(f.handle,{task:f.ref(task.id),definition:f.producer.definition,
      dependencies:f.consumer.dependencies});
    const source:core.ResultSource={kind:'manual',sourceTask:f.ref(task.id),instructionRef:'publish'};
    core.publishResult(f.handle,{...f.publication,commandId:'branch:'+i,producer:item.ref,source});
    core.completeWorkItem(f.handle,{ref:item.ref,expectedRevision:1,source});return item;
  });
  const sink=core.createWorkItem(f.handle,{task:f.consumer.task,definition:f.consumer.definition,
    dependencies:branches.map((producer,i)=>({...f.consumer.dependencies[0],key:'branch:'+i,producer:producer.ref}))});
  expect(core.resolveDependencies(f.handle,{ref:sink.ref,expectedRevision:1}).edges.map(e=>e.satisfied)).toEqual([true,true]);
});

it('separates producer code verification from consumer base inclusion and requires merge acceptance and receipt', () => {
  const f=fixture(), repoId=core.projectOf(f.db).primary_repo_id!, head=f.git('rev-parse','HEAD');
  const a=f.task('code'), b=f.task('consumer'), c=f.task('merge');
  const definition:core.WorkItemDefinition={kind:'implementation',repoId,sourceTasks:[],
    outputs:[{key:'code',kind:'code',required:true,version:'v1',checkRefs:[]}]};
  const producer=core.createWorkItem(f.handle,{task:f.ref(a.id),definition,dependencies:[]});
  const payload:core.ResultPayload={kind:'code',repoId,head,version:'v1',checkRefs:[],proofRef:'host:code-proof'};
  const source:core.ResultSource={kind:'manual',sourceTask:f.ref(a.id),instructionRef:'publish'};
  const publication:core.PublishResultInput={commandId:'code',producer:producer.ref,expectedRevision:1,outputKey:'code',expectedResultId:null,payload,source};
  expect(()=>core.publishResult(f.handle,publication)).toThrow(/checks_not_passed/);
  const requests:core.EvidenceRequest[]=[];
  const codeOnly:core.ResultObservers={observe:request=>{requests.push(structuredClone(request));return request.kind==='code_in_base'?null:verified.observe!(request)}};
  const code=core.publishResult(f.handle,publication,codeOnly);
  core.completeWorkItem(f.handle,{ref:producer.ref,expectedRevision:1,source},codeOnly);
  expect(requests.every(r=>r.kind==='code_result')).toBe(true);
  const dep:core.DependencyInput={key:'code',producer:producer.ref,producerRevision:1,outputKey:'code',
    binding:{kind:'code',repoId,version:'v1',baseHead:'consumer-base'}};
  const consumer=core.createWorkItem(f.handle,{task:f.ref(b.id),definition:{...definition,outputs:[]},dependencies:[dep]});
  expect(core.inspectDependencies(f.handle,consumer.ref,codeOnly)).toMatchObject({ready:false,edges:[{reason:'base_missing_code'}]});
  expect(core.resolveDependencies(f.handle,{ref:consumer.ref,expectedRevision:1},verified).ready).toBe(true);
  expect(requests).toContainEqual(expect.objectContaining({kind:'code_in_base',head,baseHead:'consumer-base',binding:expect.objectContaining({repoId})}));
  const merger=core.createWorkItem(f.handle,{task:f.ref(c.id),definition:{kind:'integration',repoId,sourceTasks:[],
    outputs:[{key:'merge',kind:'merged',required:true,version:'v1',checkRefs:[]}]},dependencies:[dep]});
  const mergeSource:core.ResultSource={kind:'manual',sourceTask:f.ref(c.id),instructionRef:'merge'};
  const merged:core.PublishResultInput={commandId:'merge',producer:merger.ref,expectedRevision:1,outputKey:'merge',expectedResultId:null,source:mergeSource,
    payload:{kind:'merged',repoId,head,target:'main',baseHead:'consumer-base',acceptedResultId:code.id,userRef:'owner:accepted',receiptRef:'host:receipt',version:'v1',checkRefs:[]}};
  const noReceipt:core.ResultObservers={observe:request=>request.kind==='merge_receipt'?null:verified.observe!(request)};
  expect(()=>core.publishResult(f.handle,merged,noReceipt)).toThrow(/merge_not_succeeded/);
  const noAcceptance:core.ResultObservers={observe:request=>request.kind==='merge_acceptance'?{...verified.observe!(request)!,origin:'host'}:verified.observe!(request)};
  expect(()=>core.publishResult(f.handle,merged,noAcceptance)).toThrow(/merge_not_succeeded/);
  core.publishResult(f.handle,merged,verified);
  core.completeWorkItem(f.handle,{ref:merger.ref,expectedRevision:1,source:mergeSource},verified);
  const mergedConsumer=core.createWorkItem(f.handle,{task:f.ref(b.id),definition:{...definition,outputs:[]},dependencies:[{
    key:'merge',producer:merger.ref,producerRevision:1,outputKey:'merge',binding:{kind:'merged',repoId,version:'v1',target:'main',baseHead:'consumer-base'}}]});
  expect(core.inspectDependencies(f.handle,mergedConsumer.ref,verified).ready).toBe(true);
  expect(core.inspectDependencies(f.handle,mergedConsumer.ref,noReceipt).ready).toBe(false);
  for(const item of [consumer,mergedConsumer]) {
    const owner=core.reserveWorkItem(f.handle,{ref:item.ref,expectedRevision:1,expectedFence:0,expectedMode:'manual',ownerId:'host',write:true},verified);
    expect(core.recordLaunchIntent(f.handle,{owner:owner.ref,intent:{launchId:item.ref.workItemId,writerScopeId:'verified-inputs'}}).launchIntent).not.toBeNull();
  }
});
it('requires user confirmation and a newly observed scoped readiness probe even without an expiry', () => {
  const f=fixture(), a=f.task('env'), b=f.task('frontend'), task=f.ref(a.id);
  const producer=core.createWorkItem(f.handle,{task,definition:{kind:'human_action',repoId:null,sourceTasks:[],
    outputs:[{key:'env',kind:'readiness',required:true,version:'v1',checkRefs:[]}]},dependencies:[]});
  const source:core.ResultSource={kind:'manual',sourceTask:task,instructionRef:'env prepared'};
  const payload:core.ResultPayload={kind:'readiness',repoId:null,version:'v1',checkRefs:[],resourceId:'backend-env',configHash:'configuration',
    consumerScope:'frontend-workspace',capabilities:['api:v1'],userRef:'owner:env-ready',probeRef:'host:frontend-probe',observedAt:core.now(),expiresAt:null};
  const publication:core.PublishResultInput={commandId:'env',producer:producer.ref,expectedRevision:1,outputKey:'env',expectedResultId:null,payload,source};
  expect(()=>core.publishResult(f.handle,publication)).toThrow(/readiness_unconfirmed/);
  const requests:core.EvidenceRequest[]=[];
  const scoped:core.ResultObservers={observe:request=>{requests.push(structuredClone(request));return verified.observe!(request)}};
  core.publishResult(f.handle,publication,scoped);core.completeWorkItem(f.handle,{ref:producer.ref,expectedRevision:1,source},scoped);
  const binding:core.DependencyBinding={kind:'readiness',repoId:null,version:'v1',resourceId:'backend-env',configHash:'configuration',consumerScope:'frontend-workspace',capabilities:['api:v1']};
  const consumer=core.createWorkItem(f.handle,{task:f.ref(b.id),definition:{kind:'analysis',repoId:null,sourceTasks:[],outputs:[]},
    dependencies:[{key:'env',producer:producer.ref,producerRevision:1,outputKey:'env',binding}]});
  requests.length=0;
  expect(core.inspectDependencies(f.handle,consumer.ref,scoped).ready).toBe(true);
  expect(core.inspectDependencies(f.handle,consumer.ref,scoped).ready).toBe(true);
  expect(requests.filter(r=>r.kind==='readiness_probe')).toEqual([
    expect.objectContaining({consumerScope:'frontend-workspace',capabilities:['api:v1']}),
    expect.objectContaining({consumerScope:'frontend-workspace',capabilities:['api:v1']})]);
  const staleProbe:core.ResultObservers={observe:request=>({...verified.observe!(request)!,observedAt:request.kind==='readiness_probe'?core.now()-5:core.now()})};
  expect(core.inspectDependencies(f.handle,consumer.ref,staleProbe)).toMatchObject({ready:false,edges:[{reason:'readiness_unverified'}]});
  const wrongScope:core.ResultObservers={observe:request=>request.kind==='readiness_probe'?{...verified.observe!(request)!,request:{...request,consumerScope:'backend-workspace'}}:verified.observe!(request)};
  expect(core.inspectDependencies(f.handle,consumer.ref,wrongScope).ready).toBe(false);
  const mismatched=core.createWorkItem(f.handle,{task:f.ref(b.id),definition:consumer.definition,
    dependencies:[{...consumer.dependencies[0],binding:{...binding,consumerScope:'other-workspace'}}]});
  expect(core.inspectDependencies(f.handle,mismatched.ref,scoped)).toMatchObject({ready:false,edges:[{reason:'scope_mismatch'}]});
  expect(core.inspectDependencies(f.handle,consumer.ref).ready).toBe(false);
  const expiry=core.now()+5;
  const expiring=core.createWorkItem(f.handle,{task,definition:producer.definition,dependencies:[]});
  core.publishResult(f.handle,{...publication,producer:expiring.ref,commandId:'expiring',payload:{...payload,expiresAt:expiry}},scoped);
  core.completeWorkItem(f.handle,{ref:expiring.ref,expectedRevision:1,source},scoped);
  const expiresConsumer=core.createWorkItem(f.handle,{task:f.ref(b.id),definition:consumer.definition,
    dependencies:[{...consumer.dependencies[0],producer:expiring.ref}]});
  const owner=core.reserveWorkItem(f.handle,{ref:expiresConsumer.ref,expectedRevision:1,expectedFence:0,expectedMode:'manual',ownerId:'host',write:false},scoped);
  const intent={launchId:'env-launch',writerScopeId:'env-scope'};
  expect(core.recordLaunchIntent(f.handle,{owner:owner.ref,intent}).launchIntent).toEqual(intent);
  vi.spyOn(Date,'now').mockReturnValue(expiry*1000);
  expect(core.inspectDependencies(f.handle,expiresConsumer.ref,scoped)).toMatchObject({ready:false,edges:[{reason:'readiness_expired'}]});
  const before=f.db.prepare('SELECT * FROM events').all();
  expect(()=>core.recordLaunchIntent(f.handle,{owner:owner.ref,intent})).toThrow(/stale|inputs/);
  expect(f.db.prepare('SELECT * FROM events').all()).toEqual(before);
});
