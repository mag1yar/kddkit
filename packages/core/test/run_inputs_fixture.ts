import {execFileSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import * as core from '../src/index.js';
import {memoryFixture} from './memory_fixture.js';
import type {RunInputGrant} from '../src/run_inputs.js';
export function runInputFixture(registerNative: (packet: core.VerifiedCodexPackage) => void = () => {}) {
  const f=memoryFixture(),workspace=join(f.root,'workspace'),scratch=join(f.root,'scratch');
  execFileSync('/usr/bin/git',['clone','--no-hardlinks','-q',f.repo,workspace]);mkdirSync(scratch);
  const repoId=core.projectOf(f.db).primary_repo_id!;
  core.bindRepository(f.db,f.dbPath,f.home,{cwd:workspace,repoId,kind:'managed'},{type:'user'});
  // Unit-native attestation shim only; genuine native evidence is a separate gate.
  const native=Object.freeze({executable:'/fixture/codex',version:'codex-cli 0.157.0',cwd:workspace,controlDir:f.home,
    readableRoots:Object.freeze([workspace]),writableRoot:workspace,scratchDir:scratch,protectedPaths:Object.freeze([f.home]),
    argv:Object.freeze([]),env:Object.freeze({}),configHash:'a'.repeat(64),results:Object.freeze([])});
  registerNative(native);
  const t=f.task('context'),input:core.IssueRunInput={taskId:t.id,workItemId:'context-fixture',runId:'context-run',expectedGeneration:0,
    expiresAt:core.now()+3600,operations:['get_context','submit_report','request_question'],repositories:[{repoId,checkoutPath:workspace,write:true}],native};
  const grant:RunInputGrant={projectId:f.projectId,taskId:t.id,workItemId:input.workItemId,runId:input.runId,generation:1,
    operations:input.operations,repositories:[{repoId,checkoutPath:workspace,commonDir:core.canonicalCommonDir(workspace),write:true}],
    native:{readableRoots:[workspace],writableRoot:workspace,scratchDir:scratch,configHash:native.configHash}};
  return {...f,workspace,scratch,repoId,input,grant,t};
}

import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {canonical,digest} from '../src/execution.js';
export function ownedContextFixture(registerNative: (packet:core.VerifiedCodexPackage)=>void, checked=false){
  const f=runInputFixture(registerNative),producerTask=f.task('API source');
  const producer=core.createWorkItem(f.handle,{task:f.ref(producerTask.id),definition:{kind:'architecture',repoId:null,sourceTasks:[],
    outputs:[{key:'api',kind:'contract',required:true,version:'v1',checkRefs:checked?['fixture-check']:[]}]},dependencies:[]});
  const path=join(f.root,'api.json'),body='{"api":"v1"}\n';writeFileSync(path,body);
  const payload:core.ResultPayload={kind:'contract',repoId:null,head:null,version:'v1',checkRefs:checked?['fixture-check']:[],
    artifact:{path,sha256:createHash('sha256').update(body).digest('hex')}};
  const request:core.EvidenceRequest={kind:'check',ref:'fixture-check',binding:{producer:producer.ref,producerRevision:1,inputsHash:producer.inputsHash,
    outputKey:'api',kind:'contract',version:'v1',repoId:null},payloadHash:digest(payload)};
  const proof:core.ResultObservers={observe:incoming=>canonical(incoming)===canonical(request)?{request,verdict:'pass',origin:'host',observedAt:core.now(),expiresAt:null}:null};
  const source:core.ResultSource={kind:'manual',sourceTask:producer.task,instructionRef:'fixture'};
  const published=core.publishResult(f.handle,{commandId:'fixture-api',producer:producer.ref,expectedRevision:1,outputKey:'api',expectedResultId:null,payload,source},proof);
  core.completeWorkItem(f.handle,{ref:producer.ref,expectedRevision:1,source},proof);
  const item=core.createWorkItem(f.handle,{task:f.ref(f.t.id),definition:{kind:'analysis',repoId:f.repoId,sourceTasks:[],outputs:[]},
    dependencies:[{key:'api',producer:producer.ref,producerRevision:1,outputKey:'api',binding:{kind:'contract',repoId:null,version:'v1'}}]});
  const owner=core.reserveWorkItem(f.handle,{ref:item.ref,expectedRevision:1,expectedFence:0,expectedMode:'manual',ownerId:'BA',write:true},proof);
  const input:core.IssueRunInput={...f.input,workItemId:item.ref.workItemId,ownership:owner.ref,contextObservers:proof};
  return {...f,producer,producerTask,published,item,owner,input,path,body,resultProof:proof};
}
