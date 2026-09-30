import {afterEach,expect,it,vi} from 'vitest';
import {writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import * as core from '../src/index.js';
import {cleanupFixtures} from './execution_fixture.js';
import {ownedContextFixture,runInputFixture} from './run_inputs_fixture.js';
const proved=vi.hoisted(()=>new WeakSet<object>());
vi.mock('../src/codex_permissions.js',async importOriginal=>{
  const actual=await importOriginal<typeof import('../src/codex_permissions.js')>();
  return {...actual,assertVerifiedCodexPackage(packet:object){if(!proved.has(packet))throw new core.KddError('unverified native package');}};
});
afterEach(cleanupFixtures);
it('marks a revoked pinned role stale while preserving its historical snapshot', () => {
  const f=runInputFixture(p=>proved.add(p));
  const issued=core.issueRunAuthority(f.handle,f.input),ref={projectId:f.projectId,authorityId:issued.authorityId};
  const context=core.openRunContext(f.db,issued.token),saved=core.runInputSnapshot(f.handle,ref);
  core.revokeRole(f.handle,f.input.role.roleId);
  expect(core.checkRunInputs(f.handle,ref)).toMatchObject({status:'update_required',changes:[{reason:'role_changed'}]});
  expect(()=>core.readRunContext(context)).toThrow();
  expect(core.runInputSnapshot(f.handle,ref)).toEqual(saved);
});
it('keeps an issued run pinned when the role current pointer advances', () => {
  const f=runInputFixture(p=>proved.add(p));
  const issued=core.issueRunAuthority(f.handle,f.input),ref={projectId:f.projectId,authorityId:issued.authorityId};
  const original=core.runInputSnapshot(f.handle,ref);
  core.saveRoleRevision(f.handle,{roleId:f.input.role.roleId,expectedRevision:1,commandId:'next-role',definition:{
    name:'Fixture',prompt:'A later revision.',runtime:'codex',model:'gpt-6-sol',effort:'high',access:'workspace-write',
    operations:['get_context','submit_report','request_question'],skills:[],
  }});
  expect(core.checkRunInputs(f.handle,ref)).toEqual({status:'current',authorityId:issued.authorityId,inputHash:original.inputHash});
  expect(core.runInputSnapshot(f.handle,ref)).toEqual(original);
  expect(core.readRunContext(core.openRunContext(f.db,issued.token)).inputs.schemaVersion).toBe(2);
});
function scenario(){
  const f=ownedContextFixture(p=>proved.add(p));
  const rule=f.draft('rule','context rule'),accepted=core.writeMemory(f.handle,rule,f.proof(rule,'create','user'));
  const fact=f.draft('fact','context fact'),knowledge=core.writeMemory(f.handle,fact,f.proof(fact,'create','host'));
  const issued=core.issueRunAuthority(f.handle,{...f.input,context:{query:'context'}}),ref={projectId:f.projectId,authorityId:issued.authorityId};
  const context=core.openRunContext(f.db,issued.token),frozen=core.runInputSnapshot(f.handle,ref);
  const authority={authorityId:issued.authorityId,workItemId:f.item.ref.workItemId,runId:f.input.runId,generation:1};
  const proposal:core.CreateSubtasksInput={parent:f.ref(f.t.id),expectedParentHash:core.taskContractHash(f.handle,f.ref(f.t.id)),
    source:{kind:'run',sourceTask:f.ref(f.t.id),authority,proposalEventId:core.submitRunReport(context,'split')},
    children:[{key:'child',title:'child',criteria:['deliver']}]};
  return {...f,rule,accepted,fact,knowledge,issued,snapshotRef:ref,context,frozen,authority,proposal};
}
it.each(['new rule','withdrawn rule','selected fact','requirements','artifact','result','source requirements','owner fence'] as const)
('fences every continuation boundary after %s and preserves the immutable archive',async change=>{
  const f=scenario();
  if(change==='new rule'){const d=f.draft('rule','added rule');core.writeMemory(f.handle,d,f.proof(d,'create','user'));}
  if(change==='withdrawn rule'){const d={...f.rule,commandId:'withdraw',entryId:f.accepted.entryId,expectedRevision:1,status:'withdrawn' as const};core.writeMemory(f.handle,d,f.proof(d,'withdraw','user'));}
  if(change==='selected fact'){const d={...f.fact,commandId:'revise',entryId:f.knowledge.entryId,expectedRevision:1,body:'new fact'};core.writeMemory(f.handle,d,f.proof(d,'revise','host'));}
  if(change==='requirements')f.db.prepare('UPDATE tasks SET body=? WHERE id=?').run('changed',f.t.id);
  if(change==='artifact')writeFileSync(f.path,'changed');
  if(change==='result')core.invalidateResult(f.handle,{commandId:'withdraw',resultId:f.published.id,reason:'withdrawn'});
  if(change==='source requirements')core.editTask(f.db,f.producerTask.id,{body:'changed'},{type:'user'});
  if(change==='owner fence')f.db.prepare('UPDATE work_items SET fence=fence+1 WHERE id=?').run(f.item.ref.workItemId);
  expect(()=>core.readRunContext(f.context)).toThrow();
  const before=f.db.prepare('SELECT * FROM events').all();
  for(const call of [()=>core.submitRunReport(f.context,'late'),()=>core.requestRunQuestion(f.context,'late'),
    ()=>core.recordLaunchIntent(f.handle,{owner:f.owner.ref,intent:{launchId:'late',writerScopeId:'late'}}),
    ()=>core.createSubtasks(f.handle,f.proposal),
    ()=>core.completeWorkItem(f.handle,{ref:f.item.ref,expectedRevision:1,source:{kind:'owned',owner:f.owner.ref,instructionRef:'late'}}),
    ()=>core.publishResult(f.handle,{commandId:'late',producer:f.item.ref,expectedRevision:1,outputKey:'missing',expectedResultId:null,
      payload:f.published.payload,source:{kind:'owned',owner:f.owner.ref,instructionRef:'late'}})])expect(call).toThrow();
  expect(f.db.prepare('SELECT * FROM events').all()).toEqual(before);
  const notice=core.checkRunInputs(f.handle,f.snapshotRef);expect(notice.status).toBe('update_required');
  expect(core.checkRunInputs(f.handle,f.snapshotRef)).toEqual(notice);
  expect(core.runInputSnapshot(f.handle,f.snapshotRef)).toEqual(f.frozen);
  expect(core.ownership(f.handle,f.owner.ref).releasedAt).toBeNull();
});
it('detects parent membership and parent contract changes separately',()=>{
  const f=runInputFixture(p=>proved.add(p)),parent=f.task('parent');
  const child=core.createSubtasks(f.handle,{parent:f.ref(parent.id),expectedParentHash:core.taskContractHash(f.handle,f.ref(parent.id)),
    source:{kind:'manual',sourceTask:f.ref(parent.id),instructionRef:'fixture'},children:[{key:'one',title:'child',criteria:['deliver']}] }).one;
  const issued=core.issueRunAuthority(f.handle,{...f.input,taskId:child.id}),ref={projectId:f.projectId,authorityId:issued.authorityId};
  core.editTask(f.db,parent.id,{body:'new parent'},{type:'user'});
  expect(core.checkRunInputs(f.handle,ref)).toMatchObject({status:'update_required',changes:[{reason:'requirements_changed',taskId:parent.id}]});
  f.db.prepare('UPDATE tasks SET parent_id=NULL WHERE id=?').run(child.id);
  expect(core.checkRunInputs(f.handle,ref)).toMatchObject({status:'update_required',changes:expect.arrayContaining([{reason:'membership_changed',taskId:child.id}])});
});
it('keeps status, checkbox progress, comments and unselected knowledge outside input invalidation',()=>{
  const f=scenario(),criterion=core.listCriteria(f.db,f.t.id)[0];
  f.db.prepare("UPDATE tasks SET status='in_progress',position=9 WHERE id=?").run(f.t.id);
  f.db.prepare('UPDATE criteria SET checked_at=1,evidence=? WHERE id=?').run('done',criterion.id);
  f.db.prepare("INSERT INTO comments(task_id,author,body,created_at) VALUES(?,'user','progress',1)").run(f.t.id);
  const fact=f.draft('fact','unselected'),candidate={...f.draft('candidate','context candidate'),source:{kind:'host' as const,ref:'fixture'}};
  core.writeMemory(f.handle,fact,f.proof(fact,'create','host'));core.writeMemory(f.handle,candidate);
  expect(core.checkRunInputs(f.handle,f.snapshotRef)).toEqual({status:'current',authorityId:f.issued.authorityId,inputHash:f.frozen.inputHash});
  expect(core.runInputSnapshot(f.handle,f.snapshotRef)).toEqual(f.frozen);
});
it('keeps a launched stale owner held until a complete stop observation',async()=>{
  const f=scenario();core.recordLaunchIntent(f.handle,{owner:f.owner.ref,intent:{launchId:'launch',writerScopeId:'writers'}});
  const d=f.draft('rule','new rule');core.writeMemory(f.handle,d,f.proof(d,'create','user'));
  core.revokeRunAuthority(f.handle,f.issued.authorityId);
  expect(()=>core.recordLaunchIntent(f.handle,{owner:f.owner.ref,intent:{launchId:'new',writerScopeId:'writers'}})).toThrow();
  const handoff=core.beginHandoff(f.handle,{commandId:'stop',task:f.ref(f.t.id),expectedMode:'manual',targetMode:'manual',expectedOwners:[f.owner.ref]});
  expect(await core.finishHandoff(f.handle,{handoffId:handoff.id})).toMatchObject({status:'held'});
  expect(core.ownership(f.handle,f.owner.ref).releasedAt).toBeNull();
  const stopped=await core.finishHandoff(f.handle,{handoffId:handoff.id},async owner=>({observationId:'fixture-stop',owner:owner.ref,launchId:'launch',
    writerScopeId:'writers',observedAt:core.now(),verdict:'stopped',complete:true,writers:[{id:'process',state:'gone'}]}));
  expect(stopped.status).toBe('complete');expect(core.runInputSnapshot(f.handle,f.snapshotRef)).toEqual(f.frozen);
});
it('deduplicates durable host notices across reopened controllers without leaking source bodies',()=>{
  const f=scenario(),d=f.draft('rule','new policy');core.writeMemory(f.handle,d,f.proof(d,'create','user'));
  expect(()=>core.readRunContext(f.context)).toThrow();
  expect(f.db.prepare("SELECT count(*) n FROM events WHERE action='run_inputs_changed'").get()).toEqual({n:0});
  const first=core.checkRunInputs(f.handle,f.snapshotRef),other=core.openDb(f.dbPath);
  try{expect(core.checkRunInputs(core.openController(other),f.snapshotRef)).toEqual(first);}finally{other.close();}
  const events=f.db.prepare("SELECT detail FROM events WHERE action='run_inputs_changed'").all();
  expect(events).toHaveLength(1);expect(JSON.stringify(events)).not.toContain('new policy');
  expect(()=>core.checkRunInputs({...f.handle},f.snapshotRef)).toThrow();
});
it('identifies distinct added rules and deduplicates only repeated observations',()=>{
  const f=scenario(),ruleA=f.draft('rule','private rule A'),a=core.writeMemory(f.handle,ruleA,f.proof(ruleA,'create','user'));
  const first=core.checkRunInputs(f.handle,f.snapshotRef);
  expect(first).toMatchObject({status:'update_required',changes:[{reason:'rules_changed',entryId:a.entryId,previous:null,current:{revision:1,hash:a.hash}}]});
  const ruleB=f.draft('rule','private rule B'),b=core.writeMemory(f.handle,ruleB,f.proof(ruleB,'create','user'));
  const second=core.checkRunInputs(f.handle,f.snapshotRef);
  expect(second).toMatchObject({status:'update_required',changes:expect.arrayContaining([
    {reason:'rules_changed',entryId:b.entryId,previous:null,current:{revision:1,hash:b.hash}}])});
  if(first.status!=='update_required'||second.status!=='update_required')throw Error('expected changed inputs');
  expect(second.changeHash).not.toBe(first.changeHash);expect(second.eventId).not.toBe(first.eventId);
  expect(core.checkRunInputs(f.handle,f.snapshotRef)).toEqual(second);
  expect(JSON.stringify(f.db.prepare("SELECT detail FROM events WHERE action='run_inputs_changed'").all())).not.toMatch(/private rule [AB]/);
});
it.each(['rule','fact'] as const)('distinguishes successive revisions and removal of a selected %s',kind=>{
  const f=scenario(),original=kind==='rule'?f.rule:f.fact,entry=kind==='rule'?f.accepted:f.knowledge;
  const revised={...original,commandId:'second',entryId:entry.entryId,expectedRevision:1,body:'second revision'};
  const second=core.writeMemory(f.handle,revised,f.proof(revised,'revise',kind==='rule'?'user':'host'));
  const first=core.checkRunInputs(f.handle,f.snapshotRef);
  expect(first).toMatchObject({status:'update_required',changes:expect.arrayContaining([
    {reason:'memory_changed',entryId:entry.entryId,previous:{revision:1,hash:entry.hash},current:{revision:2,hash:second.hash}}])});
  const withdrawn={...revised,commandId:'withdraw',expectedRevision:2,status:'withdrawn' as const};
  const third=core.writeMemory(f.handle,withdrawn,f.proof(withdrawn,'withdraw',kind==='rule'?'user':'host'));
  const next=core.checkRunInputs(f.handle,f.snapshotRef);
  expect(next).toMatchObject({status:'update_required',changes:expect.arrayContaining([
    {reason:'memory_changed',entryId:entry.entryId,previous:{revision:1,hash:entry.hash},current:{revision:3,hash:third.hash}}])});
  if(kind==='rule')expect(next).toMatchObject({changes:expect.arrayContaining([
    {reason:'rules_changed',entryId:entry.entryId,previous:{revision:1,hash:entry.hash},current:null}])});
  if(first.status!=='update_required'||next.status!=='update_required')throw Error('expected changed inputs');
  expect(next.changeHash).not.toBe(first.changeHash);expect(next.eventId).not.toBe(first.eventId);
  expect(core.checkRunInputs(f.handle,f.snapshotRef)).toEqual(next);
});
it('checks missing snapshots even on revoked owned grants when authority is omitted',()=>{
  const f=scenario();core.revokeRunAuthority(f.handle,f.issued.authorityId);
  // Model a retained v16 authority: no fabricated snapshot and owner is still held.
  f.db.exec('DROP TRIGGER run_input_snapshots_immutable_delete');f.db.prepare('DELETE FROM run_input_snapshots').run();
  expect(()=>core.recordLaunchIntent(f.handle,{owner:f.owner.ref,intent:{launchId:'late',writerScopeId:'late'}})).toThrow();
  expect(core.checkRunInputs(f.handle,f.snapshotRef)).toMatchObject({status:'update_required',inputHash:null,changes:[{reason:'snapshot_missing'}]});
  expect(core.ownership(f.handle,f.owner.ref).releasedAt).toBeNull();
});
it('uses saved legacy fields and the pinned input commit while writable HEAD advances',()=>{
  const f=runInputFixture(p=>proved.add(p)),head=f.git('rev-parse','HEAD');
  const fact={...f.draft('fact','context base'),applicability:{repoId:f.repoId,commit:head}};
  const entry=core.writeMemory(f.handle,fact,f.proof(fact,'create','host'));
  const issued=core.issueRunAuthority(f.handle,f.input),context=core.openRunContext(f.db,issued.token),first=core.readRunContext(context);
  f.db.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(f.t.id);
  expect(core.readRunContext(context)).toEqual(first);
  execFileSync('/usr/bin/git',['-c','user.name=Fixture','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','output'],{cwd:f.workspace});
  const newHead=execFileSync('/usr/bin/git',['rev-parse','HEAD'],{cwd:f.workspace,encoding:'utf8'}).trim();
  const newer={...f.draft('fact','context output'),applicability:{repoId:f.repoId,commit:newHead}};
  const newEntry=core.writeMemory(f.handle,newer,f.proof(newer,'create','host'));
  expect(core.readRunMemory(context,{entryId:entry.entryId})[0].body).toBe('context base');
  expect(()=>core.readRunMemory(context,{entryId:newEntry.entryId})).toThrow();
  expect(core.readRunContext(context).inputs.repositories[0].commit).toBe(head);
  const next=core.issueRunAuthority(f.handle,{...f.input,expectedGeneration:1,runId:'next'}),nextContext=core.openRunContext(f.db,next.token);
  expect(core.readRunContext(nextContext).inputs.repositories[0].commit).toBe(newHead);
  expect(core.readRunMemory(nextContext,{entryId:newEntry.entryId})[0].body).toBe('context output');
});
