import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import * as core from '../src/index.js';
import { memoryFixture, cleanupFixtures } from './memory_fixture.js';
afterEach(cleanupFixtures);

it('inherits project and root records without exposing siblings or child records to the parent', () => {
  const f = memoryFixture(), parent = f.task('parent'), other = f.task('other');
  const children = core.createSubtasks(f.handle,{ parent:f.ref(parent.id),expectedParentHash:core.taskContractHash(f.handle,f.ref(parent.id)),
    source:{kind:'manual',sourceTask:f.ref(parent.id),instructionRef:'fixture:split'},
    children:[{key:'a',title:'a',criteria:['a']},{key:'b',title:'b',criteria:['b']}] });
  const refs = new Map<number|null,core.MemoryReceipt>();
  for (const taskId of [null,parent.id,children.a.id,children.b.id,other.id]) {
    const input = { ...f.draft('fact','needle scope ' + taskId),scope:{projectId:f.projectId,taskId} };
    refs.set(taskId,core.writeMemory(f.handle,input,f.proof(input,'create','host')));
  }
  for (const [taskId,wanted] of [[null,[null]],[parent.id,[null,parent.id]],[children.a.id,[null,parent.id,children.a.id]]] as const) {
    const view:core.MemoryView = {scope:{projectId:f.projectId,taskId},repositories:[]};
    expect(core.listMemory(f.handle,view).map(r=>r.scope.taskId).sort()).toEqual([...wanted].sort());
    expect(core.recallMemory(f.handle,view,'needle').map(r=>r.scope.taskId).sort()).toEqual([...wanted].sort());
    for (const [id,ref] of refs) {
      if (wanted.some(w=>w===id)) {
        expect(core.memoryEntry(f.handle,view,ref.entryId).hash).toBe(ref.hash);
        expect(core.memoryHistory(f.handle,view,ref.entryId)).toHaveLength(1);
      } else {
        expect(()=>core.memoryEntry(f.handle,view,ref.entryId)).toThrow();
        expect(()=>core.memoryHistory(f.handle,view,ref.entryId)).toThrow();
      }
    }
  }
  const foreign = memoryFixture();
  const collision = foreign.task('same numeric id'); expect(collision.id).toBe(parent.id);
  const view = {scope:{projectId:foreign.projectId,taskId:collision.id},repositories:[]};
  for (const read of [()=>core.listMemory(f.handle,view),()=>core.recallMemory(f.handle,view,'needle'),
    ()=>core.memoryRules(f.handle,view),()=>core.memoryEntry(f.handle,view,refs.get(parent.id)!.entryId),
    ()=>core.memoryHistory(f.handle,view,refs.get(parent.id)!.entryId)]) expect(read).toThrow();
});

it('does not let foreign corpus size or BM25 statistics change permitted hits', () => {
  const f = memoryFixture(), own = f.task('own'), sibling = f.task('sibling');
  const input = {...f.draft('fact','needle authorized'),scope:{projectId:f.projectId,taskId:own.id}};
  core.writeMemory(f.handle,input,f.proof(input,'create','host'));
  const view = {scope:input.scope,repositories:[]};
  const baseline = core.recallMemory(f.handle,view,'needle',{k:1}); expect(baseline).toHaveLength(1);
  for (let n=0;n<200;n++) {
    const other = {...f.draft('fact','needle '.repeat(n+1)),scope:{projectId:f.projectId,taskId:sibling.id}};
    core.writeMemory(f.handle,other,f.proof(other,'create','host'));
  }
  expect(core.recallMemory(f.handle,view,'needle',{k:1})).toEqual(baseline);
  expect(core.recallMemory(f.handle,view,'needle OR * -authorized',{k:1})).toEqual([]);
});

it('binds repository facts to their exact commit even across ancestry and matching repo hashes', () => {
  const f = memoryFixture(), repoId = core.projectOf(f.db).primary_repo_id!, firstCommit=f.git('rev-parse','HEAD');
  const input = {...f.draft('fact','needle version'),applicability:{repoId,commit:firstCommit}};
  const ref = core.writeMemory(f.handle,input,f.proof(input,'create','host'));
  const at = (commit:string):core.MemoryView => ({scope:f.scope,repositories:[{repoId,checkoutPath:f.repo,commit}]});
  f.git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','next');
  const next = f.git('rev-parse','HEAD');
  expect(core.listMemory(f.handle,at(firstCommit)).map(r=>r.entryId)).toEqual([ref.entryId]);
  expect(core.listMemory(f.handle,at(next))).toEqual([]);
  expect(()=>core.memoryEntry(f.handle,at(next),ref.entryId,1)).toThrow();
  const backend = join(f.root,'backend'); execFileSync('/usr/bin/git',['clone','--no-local',f.repo,backend],{stdio:'pipe'});
  const attached = core.addRepository(f.db,f.dbPath,f.home,{cwd:backend,purpose:'backend',access:'context_only'},{type:'user'}).repository;
  const backendView = {scope:f.scope,repositories:[{repoId:attached.repo_id,checkoutPath:backend,commit:firstCommit}]};
  expect(core.listMemory(f.handle,backendView)).toEqual([]);
  for (const version of [{repoId,checkoutPath:backend,commit:firstCommit},{repoId,checkoutPath:f.repo,commit:'main'},
    {repoId:'f'.repeat(32),checkoutPath:f.repo,commit:firstCommit}]) expect(()=>core.listMemory(f.handle,{scope:f.scope,repositories:[version]})).toThrow();
  const alias = join(f.root,'alias'); symlinkSync(f.repo,alias);
  expect(()=>core.listMemory(f.handle,{scope:f.scope,repositories:[{repoId,checkoutPath:alias,commit:firstCommit}]})).toThrow();
  f.git('checkout','--detach',firstCommit);
  expect(core.listMemory(f.handle,at(firstCommit))).toHaveLength(1);
});

it('excludes candidates and withdrawn knowledge by default while explicit reads preserve history', () => {
  const f = memoryFixture(), input=f.draft('candidate','needle proposal');
  const first=core.writeMemory(f.handle,input,f.proof(input,'create','user'));
  expect(core.listMemory(f.handle,f.view)).toEqual([]); expect(core.recallMemory(f.handle,f.view,'needle')).toEqual([]);
  expect(core.recallMemory(f.handle,f.view,'needle',{candidates:true})[0].kind).toBe('candidate');
  const accepted={...input,commandId:'accepted',entryId:first.entryId,expectedRevision:1,kind:'decision' as const};
  core.writeMemory(f.handle,accepted,f.proof(accepted,'accept','user'));
  const withdrawn={...accepted,commandId:'withdrawn',expectedRevision:2,status:'withdrawn' as const};
  core.writeMemory(f.handle,withdrawn,f.proof(withdrawn,'withdraw','user'));
  expect(core.listMemory(f.handle,f.view)).toEqual([]);
  expect(core.listMemory(f.handle,f.view,{withdrawn:true})).toHaveLength(1);
  expect(core.memoryEntry(f.handle,f.view,first.entryId).status).toBe('withdrawn');
  expect(core.memoryEntry(f.handle,f.view,first.entryId,1)).toMatchObject({kind:'candidate',body:'needle proposal',effectiveStatus:'superseded'});
  expect(core.memoryHistory(f.handle,f.view,first.entryId).map(r=>[r.revision,r.effectiveStatus])).toEqual([[1,'superseded'],[2,'superseded'],[3,'withdrawn']]);
});

it('returns every applicable active rule without a keyword or narrowest-scope winner', () => {
  const f=memoryFixture(), task=f.task('rules');
  const view={scope:{projectId:f.projectId,taskId:task.id},repositories:[]};
  for (let n=0;n<12;n++) {
    const input={...f.draft('rule',n===0?'Use REST':'Use RPC '+n),scope:{projectId:f.projectId,taskId:n%2?task.id:null}};
    core.writeMemory(f.handle,input,f.proof(input,'create','user'));
  }
  expect(core.recallMemory(f.handle,view,'unrelated',{k:1})).toEqual([]);
  const rules=core.memoryRules(f.handle,view); expect(rules).toHaveLength(12);
  expect(rules.some(r=>r.body==='Use REST')).toBe(true); expect(rules.some(r=>r.body==='Use RPC 1')).toBe(true);
  const before=f.rows(); core.memoryRules(f.handle,view); core.recallMemory(f.handle,view,'RPC',{k:1}); expect(f.rows()).toEqual(before);
});

it('rejects a null public revision rather than silently selecting the current record', () => {
  const f=memoryFixture(), input=f.draft('fact','known');
  const entry=core.writeMemory(f.handle,input,f.proof(input,'create','host'));
  expect(core.memoryEntry(f.handle,f.view,entry.entryId,1).hash).toBe(entry.hash);
  expect(()=>core.memoryEntry(f.handle,f.view,entry.entryId,null as never)).toThrow();
});

it.each([{k:0},{k:51},{k:1.5},{k:null},{candidates:'yes'},{withdrawn:null},{unknown:true}])('rejects malformed recall options %j', options => {
  const f=memoryFixture(); expect(core.recallMemory(f.handle,f.view,'needle')).toEqual([]);
  expect(()=>core.recallMemory(f.handle,f.view,'needle',options as core.MemoryRecallOptions)).toThrow();
});
