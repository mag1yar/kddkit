import { afterEach, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as core from '../src/index.js';
import { memoryFixture, cleanupFixtures } from './memory_fixture.js';
afterEach(cleanupFixtures);

function document(path='notes.md',bytes=Buffer.from('# API\n\nPinned schema\n')) {
  const f=memoryFixture(); mkdirSync(dirname(join(f.repo,path)),{recursive:true});
  writeFileSync(join(f.repo,path),bytes); f.git('--literal-pathspecs','add','--',path);
  f.git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','document');
  const input:core.MemoryImportInput={commandId:randomUUID(),scope:f.scope,applicability:{repoId:null,commit:null},
    repoId:core.projectOf(f.db).primary_repo_id!,checkoutPath:f.repo,commit:f.git('rev-parse','HEAD'),path,
    sha256:createHash('sha256').update(bytes).digest('hex'),author:{type:'user',id:null}};
  return {...f,input,bytes};
}
it('imports only the selected blob with exact provenance and reserves duplicate command ids',()=>{
  const f=document(), first=core.importMemory(f.handle,f.input), alias={...f.input,commandId:'alias'};
  const record=core.memoryEntry(f.handle,f.view,first.entryId);
  expect(record).toMatchObject({kind:'candidate',status:'active',title:'API',body:f.bytes.toString(),
    source:{kind:'git',repoId:f.input.repoId,commit:f.input.commit,path:'notes.md',sha256:f.input.sha256,documentStatus:null}});
  expect(core.listMemory(f.handle,f.view)).toEqual([]);
  expect(core.importMemory(f.handle,alias)).toMatchObject({entryId:first.entryId,revision:1,created:false});
  const before=f.rows(); core.importMemory(f.handle,alias); core.importMemory(f.handle,f.input); expect(f.rows()).toEqual(before);
  expect(()=>core.importMemory(f.handle,{...alias,kind:'rule'})).toThrow();
  const conflict={...f.draft('candidate','different command payload'),commandId:'alias'};
  expect(()=>core.writeMemory(f.handle,conflict,f.proof(conflict,'create','user'))).toThrow(/command/);
  expect(f.rows()).toEqual(before);
  expect(f.db.prepare('SELECT count(*) n FROM memory_revisions').get()).toEqual({n:1});
});
it('does not echo a private value passed as an invalid import repository id',()=>{
  const f=document(),secret='sk-proj-'+'x'.repeat(40),before=f.rows();let error:Error|undefined;
  try{core.importMemory(f.handle,{...f.input,repoId:secret});}catch(e){error=e as Error;}
  expect(error).toBeDefined();expect(error!.message).not.toContain(secret);expect(f.rows()).toEqual(before);
});
it.each(['import','git-write','host-ref','user-ref'] as const)('rejects credential file paths through %s without memory or audit writes',method=>{
  const f=document();core.importMemory(f.handle,f.input);
  const files=['.npmrc','.git-credentials','.netrc','frontend/.npmrc','backend/.git-credentials','backend/.netrc'];
  const bytes=Buffer.from('machine example.invalid login fixture password fixturepassword\n');
  for(const path of files){mkdirSync(dirname(join(f.repo,path)),{recursive:true});writeFileSync(join(f.repo,path),bytes);}
  f.git('--literal-pathspecs','add','-f','--',...files);
  f.git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','private fixtures');
  const commit=f.git('rev-parse','HEAD'),sha256=createHash('sha256').update(bytes).digest('hex'),before=f.rows();
  for(const path of files){
    const input={...f.input,commandId:randomUUID(),commit,path,sha256};
    const draft:core.MemoryWriteInput={...f.draft('candidate',bytes.toString()),source:method==='git-write'
      ? {kind:'git',repoId:input.repoId,commit,path,sha256,documentStatus:null}
      : {kind:method==='host-ref'?'host':'user',ref:join(f.repo,path)}};
    expect(()=>method==='import'?core.importMemory(f.handle,input)
      :core.writeMemory(f.handle,draft,method==='user-ref'?f.proof(draft,'create','user'):undefined)).toThrow(/private/);
    expect(f.rows()).toEqual(before);
  }
});
it('imports documentation about credentials without treating its path as a private file',()=>{
  const f=document('docs/npmrc-guide.md'),receipt=core.importMemory(f.handle,f.input);
  expect(core.memoryEntry(f.handle,f.view,receipt.entryId).body).toBe(f.bytes.toString());
});
it('deduplicates through two connections and rolls back an import when its audit insert fails',()=>{
  const f=document(), other=core.openDb(f.dbPath),handle=core.openController(other);
  try {
    const first=core.importMemory(f.handle,f.input);
    expect(core.importMemory(handle,{...f.input,commandId:'connection-2'})).toMatchObject({entryId:first.entryId,created:false});
    expect(other.prepare('SELECT count(*) n FROM memory_entries').get()).toEqual({n:1});
    const before=f.rows(), changed={...f.input,commandId:'rollback',scope:{projectId:f.projectId,taskId:f.task('new import scope').id}};
    f.db.exec("CREATE TRIGGER refuse_memory_audit BEFORE INSERT ON events WHEN NEW.action='memory_revision' BEGIN SELECT RAISE(ABORT,'fixture audit refusal'); END");
    expect(()=>core.importMemory(handle,changed)).toThrow(/audit refusal/);
    expect(f.rows()).toEqual(before);
    f.db.exec('DROP TRIGGER refuse_memory_audit');
    expect(core.importMemory(handle,changed).created).toBe(true);
    expect(other.prepare('SELECT count(*) n FROM memory_entries').get()).toEqual({n:2});
  } finally {other.close();}
});
it('never restores an imported candidate after explicit withdrawal or legacy branch/backend recall',()=>{
  const f=document('.planning/decisions/local.md'), first=core.importMemory(f.handle,f.input);
  const record=core.memoryEntry(f.handle,f.view,first.entryId);
  const withdrawn:core.MemoryWriteInput={commandId:'withdraw',entryId:first.entryId,expectedRevision:1,
    scope:record.scope,applicability:record.applicability,kind:record.kind,status:'withdrawn',title:record.title,body:record.body,
    source:record.source,author:record.author};
  core.writeMemory(f.handle,withdrawn);
  const before=f.rows();
  f.git('rm','--',f.input.path);f.git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','branch B');
  const primaryDir=join(f.repo,'.planning','decisions'); core.recall(f.db,primaryDir,'API');core.rebuild(f.db,primaryDir);
  const backend=join(f.root,'backend');mkdirSync(backend);execFileSync('/usr/bin/git',['init'],{cwd:backend,stdio:'pipe'});
  core.addRepository(f.db,f.dbPath,f.home,{cwd:backend,purpose:'backend',access:'context_only'},{type:'user'});
  const backendDir=join(backend,'.planning','decisions');core.recall(f.db,backendDir,'API');
  mkdirSync(backendDir,{recursive:true});writeFileSync(join(backendDir,'local.md'),'# Conflicting\n\nreplace API\n');
  core.recall(f.db,backendDir,'replace');expect(()=>core.rebuild(f.db,backendDir)).toThrow();
  expect(f.rows()).toEqual(before);
  expect(core.importMemory(f.handle,f.input)).toMatchObject({entryId:first.entryId,currentRevision:2,effectiveStatus:'superseded',created:false});
  expect(core.memoryEntry(f.handle,f.view,first.entryId).status).toBe('withdrawn');expect(f.rows()).toEqual(before);
});
it('keeps changed commit and explicitly different scope as separate imports',()=>{
  const f=document(), first=core.importMemory(f.handle,f.input), task=f.task('other scope');
  const scoped=core.importMemory(f.handle,{...f.input,commandId:'other',scope:{projectId:f.projectId,taskId:task.id}});
  expect(scoped.entryId).not.toBe(first.entryId);
  f.git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','version');
  const versioned=core.importMemory(f.handle,{...f.input,commandId:'version',commit:f.git('rev-parse','HEAD')});
  expect(versioned.entryId).not.toBe(first.entryId);expect(f.db.prepare('SELECT count(*) n FROM memory_entries').get()).toEqual({n:3});
});
it('reads the literal pinned commit and blob rather than local Git replace refs',()=>{
  const f=document(),original=f.input.commit;
  writeFileSync(join(f.repo,f.input.path),'# Replacement\n\nWrong version\n');f.git('add','--',f.input.path);
  f.git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','replacement');
  const replacement=f.git('rev-parse','HEAD');f.git('replace',original,replacement);
  const refs=f.git('for-each-ref'),before=f.rows();
  const wrong={...f.input,commandId:'replacement-bytes',sha256:createHash('sha256').update('# Replacement\n\nWrong version\n').digest('hex')};
  expect(()=>core.importMemory(f.handle,wrong)).toThrow(/hash/);expect(f.rows()).toEqual(before);
  const imported=core.importMemory(f.handle,f.input);
  expect(core.memoryEntry(f.handle,f.view,imported.entryId)).toMatchObject({body:f.bytes.toString(),source:{commit:original,sha256:f.input.sha256}});
  expect(f.git('for-each-ref')).toBe(refs);
  f.git('replace','-d',original);
  const originalBlob=f.git('--no-replace-objects','rev-parse',`${original}:${f.input.path}`);
  const replacementBlob=f.git('rev-parse',`${replacement}:${f.input.path}`);
  f.git('replace',originalBlob,replacementBlob);
  const blobRefs=f.git('for-each-ref');
  expect(()=>core.importMemory(f.handle,wrong)).toThrow(/hash/);
  expect(core.importMemory(f.handle,f.input).created).toBe(false);expect(f.git('for-each-ref')).toBe(blobRefs);
});
it('confirms a versioned Git fact only with host evidence bound to the actual bytes',()=>{
  const f=document(), input={...f.input,kind:'fact' as const,applicability:{repoId:f.input.repoId,commit:f.input.commit}};
  expect(()=>core.importMemory(f.handle,input)).toThrow();
  const draft:core.MemoryWriteInput={...f.draft('fact',f.bytes.toString()),commandId:input.commandId,title:'API',
    applicability:input.applicability,source:{kind:'git',repoId:input.repoId,commit:input.commit,path:input.path,sha256:input.sha256,documentStatus:null}};
  const result=core.importMemory(f.handle,input,f.proof(draft,'import','host'));
  const view={scope:f.scope,repositories:[{repoId:input.repoId,checkoutPath:f.repo,commit:input.commit}]};
  expect(core.recallMemory(f.handle,view,'Pinned')[0].hash).toBe(result.hash);
  const bad={...draft,commandId:'wrong-version',applicability:{repoId:null,commit:null}};
  expect(()=>core.writeMemory(f.handle,bad,f.proof(bad,'create','host'))).toThrow();
});
it('does not silently revive a superseded legacy policy but permits explicit candidate acceptance',()=>{
  const bytes=Buffer.from('---\nstatus: superseded\nsuperseded_by: newer\n---\n# Old policy\n\nUse RPC\n');
  const f=document('.planning/decisions/old.md',bytes), first=core.importMemory(f.handle,f.input);
  expect(core.memoryEntry(f.handle,f.view,first.entryId).source).toMatchObject({documentStatus:'superseded'});
  expect(()=>core.importMemory(f.handle,{...f.input,commandId:'silent',kind:'rule'})).toThrow();
  const old=core.memoryEntry(f.handle,f.view,first.entryId), accepted:core.MemoryWriteInput={...f.draft('rule',old.body),
    commandId:'explicit',entryId:first.entryId,expectedRevision:1,title:old.title,source:old.source};
  core.writeMemory(f.handle,accepted,f.proof(accepted,'accept','user'));
  expect(core.memoryRules(f.handle,f.view)).toHaveLength(1);
});
it.each([
  ['---\nstatus:\n---\n# Unknown\n','unknown'],
  ['---\nstatus: superseded\n---','superseded'],
  ['---\nstatus: active\nstatus: superseded\n---\n# Last status\n','superseded'],
] as const)('preserves explicit inactive/empty legacy metadata %j',(raw,status)=>{
  const f=document('.planning/decisions/status.md',Buffer.from(raw)),first=core.importMemory(f.handle,f.input);
  expect(core.memoryEntry(f.handle,f.view,first.entryId).source).toMatchObject({documentStatus:status});
  const before=f.rows();expect(()=>core.importMemory(f.handle,{...f.input,commandId:'active',kind:'rule'})).toThrow(/inactive legacy/);
  expect(f.rows()).toEqual(before);
});
it.each(['../notes.md','/notes.md','notes\\file.md','notes\0.md','notes//file.md',':(glob)*'])('rejects malformed or interpreted selection %s',path=>{
  const f=document();core.importMemory(f.handle,f.input);const before=f.rows();
  expect(()=>core.importMemory(f.handle,{...f.input,commandId:'invalid',path})).toThrow();expect(f.rows()).toEqual(before);
});
it.each(['utf8','nul','overflow','secret','credentials','private-config','symlink','gitlink','hash','missing','foreign','kind-null','status-null'])(
  'rejects %s document before changing revisions/events',kind=>{
    const f=document(), normal=core.importMemory(f.handle,f.input), before=f.rows(); expect(normal.revision).toBe(1);
    let input={...f.input,commandId:'bad'},path='bad.md',bytes=Buffer.from('# Bad\n');
    if (kind==='utf8') bytes=Buffer.from([0xff]);
    if (kind==='nul') bytes=Buffer.from('# binary\0');
    if (kind==='overflow') bytes=Buffer.from('x'.repeat(core.CAPS.bodyChars+1));
    if (kind==='secret') bytes=Buffer.from('sk-proj-'+'x'.repeat(40));
    if (kind==='credentials') path='.env';
    if (kind==='private-config') path='.claude/settings.local.json';
    if (['utf8','nul','overflow','secret','credentials','private-config','symlink','gitlink'].includes(kind)) {
      mkdirSync(dirname(join(f.repo,path)),{recursive:true});
      if (kind==='symlink') symlinkSync('/private/secret',join(f.repo,path));else writeFileSync(join(f.repo,path),bytes);
      if (kind==='gitlink') {f.git('update-index','--add','--cacheinfo',`160000,${f.input.commit},${path}`);}
      else f.git('--literal-pathspecs','add','-f','--',path);
      f.git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','bad document');
      input={...input,path,commit:f.git('rev-parse','HEAD'),sha256:createHash('sha256').update(bytes).digest('hex')};
    }
    if (kind==='hash') input.sha256='0'.repeat(64);
    if (kind==='missing') input.commit='1'.repeat(40);
    if (kind==='foreign') {const clone=join(f.root,'foreign');execFileSync('/usr/bin/git',['clone',f.repo,clone],{stdio:'pipe'});input.checkoutPath=clone;}
    if (kind==='kind-null') input.kind=null as never;
    if (kind==='status-null') input.status=null as never;
    expect(()=>core.importMemory(f.handle,input)).toThrow();expect(f.rows()).toEqual(before);
  });
it('imports spaces and Unicode literal paths and a managed-only commit without touching source refs',()=>{
  const f=document('docs/\u0441\u0445\u0435\u043c\u0430 *.md'), sourceHead=f.git('rev-parse','HEAD');
  expect(core.importMemory(f.handle,f.input).revision).toBe(1);
  const clone=join(f.root,'managed');execFileSync('/usr/bin/git',['clone','--no-local',f.repo,clone],{stdio:'pipe'});
  core.bindRepository(f.db,f.dbPath,f.home,{cwd:clone,repoId:f.input.repoId,kind:'managed'},{type:'user'});
  const bytes=Buffer.from('# Managed document\n\nnew result\n');writeFileSync(join(clone,'managed.md'),bytes);
  const git=(...args:string[])=>execFileSync('/usr/bin/git',args,{cwd:clone,encoding:'utf8',stdio:'pipe'}).trim();
  git('add','managed.md');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','managed');
  const imported=core.importMemory(f.handle,{...f.input,commandId:'managed',checkoutPath:clone,commit:git('rev-parse','HEAD'),
    path:'managed.md',sha256:createHash('sha256').update(bytes).digest('hex')});
  expect(core.memoryEntry(f.handle,f.view,imported.entryId).body).toBe(bytes.toString());
  expect(f.git('rev-parse','HEAD')).toBe(sourceHead);expect(readFileSync(join(clone,'managed.md'))).toEqual(bytes);
});
it('preserves a UTF-8 BOM in the saved body while parsing its title correctly',()=>{
  const f=document('bom.md',Buffer.from('\uFEFF# API\n\nPinned schema\n'));
  const imported=core.importMemory(f.handle,f.input), record=core.memoryEntry(f.handle,f.view,imported.entryId);
  expect(record.body).toBe(f.bytes.toString());expect(record.title).toBe('API');
});
