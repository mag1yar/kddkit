// Public compiled API observations. Fixture receipts are not human/native attestations.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, writeFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from '../../../packages/core/node_modules/better-sqlite3/lib/index.js';
import { runRace, crashMemoryWrite } from '../../../packages/core/test/fixtures/execution_race.mjs';

const args=process.argv.slice(2);
assert.ok(args.length===0 || args.length===2 && args[0]==='--core' && isAbsolute(args[1]));
const corePath=args[1] ?? fileURLToPath(new URL('../../../packages/core/dist/index.js',import.meta.url));
const core=await import(pathToFileURL(corePath).href);
const required=['writeMemory','importMemory','memoryEntry','memoryHistory','listMemory','memoryRules','recallMemory','readRunMemory','recallRunMemory','runMemoryRules'];
assert.deepEqual(required.filter(name=>typeof core[name]!=='function'),[], 'missing-memory-API (baseline diagnostic; no scenarios/store created)');
const runtimeHash=sha(readFileSync(corePath)), root=realpathSync(mkdtempSync(join(tmpdir(),'kdd-memory-observation-')));
const saved={...process.env}, handles=[], home=join(root,'private');
const evidence={observedAt:new Date().toISOString(),node:process.version,schema:core.MIGRATIONS.length,runtimeHash,checks:[],
  races:{rounds:0,singleWinners:0,duplicateRevisions:0},limitations:[
    'User/host callbacks verify fixed fixture receipts; not a product human acceptance receipt.',
    'M08 consumes fresh real Codex native gates; new reads are core library calls, not new MCP tools.',
    'Recall constructs an O(n) eligible in-memory corpus; no performance claim.',
  ]};
function sha(bytes){return createHash('sha256').update(bytes).digest('hex');}
function order(v){return Array.isArray(v)?v.map(order):v && typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,order(v[k])])):v;}
const canonical=v=>JSON.stringify(order(v));
const git=(cwd,...argv)=>execFileSync('/usr/bin/git',argv,{cwd,encoding:'utf8',stdio:'pipe'}).trim();
const track=db=>{handles.push(db);return db;};
const repo=name=>{const path=join(root,name);mkdirSync(path);git(path,'init','-q');
  git(path,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm',name);return path;};
const record=(id,observations)=>{evidence.checks.push({id,passed:true,observations});process.stderr.write(`${id} passed\n`);};
try {
  process.env.KDD_HOME=home;delete process.env.KDD_DB;delete process.env.KDD_DECISIONS_DIR;mkdirSync(home);
  const source=repo('source'),backend=repo('backend'),sourceCommon=core.canonicalCommonDir(source);
  const historicalSource=repo('historical'),oldCommon=core.canonicalCommonDir(historicalSource);
  const oldPath=join(home,'v15.db'),raw=track(new Database(oldPath));
  raw.pragma('foreign_keys=ON');raw.pragma('journal_mode=WAL');raw.pragma('wal_autocheckpoint=0');
  for(const sql of core.MIGRATIONS.slice(0,15))raw.exec(sql);raw.pragma('user_version=15');
  const oldRepo='a'.repeat(32),work='b'.repeat(32),consumer='c'.repeat(32);
  raw.prepare('INSERT INTO repositories VALUES(?,?,?,?,?)').run(oldRepo,'primary','implementation',null,1);
  raw.prepare('UPDATE project SET primary_repo_id=?,legacy_decisions_dir=?').run(oldRepo,join(historicalSource,'.planning','decisions'));
  raw.prepare('INSERT INTO repository_bindings VALUES(?,?,?,?,?)').run(oldCommon,oldRepo,historicalSource,'source',1);
  raw.prepare("INSERT INTO meta VALUES('project_path',?)").run(oldCommon);raw.prepare("INSERT INTO meta VALUES('project_toplevel',?)").run(historicalSource);
  raw.exec(`INSERT INTO tracks VALUES(8,'retained','keep','active',1);
    INSERT INTO tasks(id,title,status,created_at,updated_at,track_id) VALUES(41,'old','new',1,1,8),(42,'child','new',1,1,8);
    UPDATE tasks SET parent_id=41 WHERE id=42;
    INSERT INTO criteria(id,task_id,text,checked_at,created_at,evidence,checked_by) VALUES(9,41,'keep',2,1,'keep','user');
    INSERT INTO comments VALUES(7,41,'user','keep comment',1);
    INSERT INTO events(id,task_id,actor_type,action,detail,created_at) VALUES(6,41,'user','created','{"keep":true}',1);
    INSERT INTO task_links VALUES(42,41,'depends_on');
    INSERT INTO agent_events VALUES(4,41,'old','text',NULL,'keep',1);INSERT INTO errors VALUES(2,'old','keep',1);
    INSERT INTO managed_task_policy VALUES(41,1,'old');
    INSERT INTO run_authorities VALUES('old-authority',41,'external-work','old-run',1,1,NULL,'old-hash','{"historical":true}',1);`);
  raw.prepare('INSERT INTO decisions VALUES(?,?,?,?,?,?,?)').run('keep','Keep','old.md','old-hash','2026-01-01',null,'[41]');
  raw.prepare('INSERT INTO search_index VALUES(?,?,?,?)').run('decision','keep','Keep','retainedtoken');
  const blob='retained attachment';mkdirSync(core.filesDir(oldPath));writeFileSync(join(core.filesDir(oldPath),sha(blob)+'.txt'),blob);
  raw.prepare("INSERT INTO files(task_id,sha256,ext,original_name,size_bytes,created_at) VALUES(41,?,'txt','old.txt',?,1)").run(sha(blob),Buffer.byteLength(blob));
  raw.transaction(()=>{
    for(const id of [work,consumer]){
      raw.prepare('INSERT INTO work_items(id,task_id,current_revision,created_at) VALUES(?,41,1,1)').run(id);
      raw.prepare('INSERT INTO work_item_revisions VALUES(?,1,?,?,?,1)').run(id,JSON.stringify({kind:'analysis',repoId:null,sourceTasks:[],outputs:[]}),'[]','d'.repeat(64));
    }
    raw.prepare("INSERT INTO work_item_results VALUES('old-result','old-command','old-hash',?,1,'api','contract','{}','{}',1,NULL,NULL,NULL)").run(work);
    raw.prepare("INSERT INTO work_item_dependencies VALUES(?,1,'api',?,1,'contract','api','{}','old-result')").run(consumer,work);
    raw.prepare("INSERT INTO execution_handoffs VALUES('old-handoff','old-handoff-command',41,'manual','orchestrated','{}',1,NULL,NULL)").run();
    raw.prepare("INSERT INTO work_item_owners VALUES(?,1,1,'old-owner','manual',0,'[]',NULL,NULL,1,NULL,NULL)").run(work);
  }).immediate();
  const oldTables=['tasks','criteria','comments','events','tracks','task_links','decisions','search_index','agent_events','errors','meta','project','repositories','repository_bindings','managed_task_policy','run_authorities','files','work_items','work_item_revisions','work_item_results','work_item_dependencies','work_item_owners','execution_handoffs'];
  const historical=db=>oldTables.map(t=>db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()),before=historical(raw);
  const walBytes=statSync(oldPath+'-wal').size;assert.ok(walBytes>0);
  const upgraded=track(core.openDb(oldPath,oldCommon,historicalSource));assert.deepEqual(historical(upgraded),before);
  const backup=track(new Database(oldPath+'.v15.bak',{readonly:true}));assert.equal(backup.pragma('user_version',{simple:true}),15);assert.deepEqual(historical(backup),before);
  const reopened=track(core.openDb(oldPath));assert.deepEqual(historical(reopened),before);
  assert.deepEqual(reopened.prepare('SELECT * FROM memory_entries').all(),[]);assert.deepEqual(reopened.prepare('SELECT * FROM memory_revisions').all(),[]);
  const baseline=resolve('.superpowers/sdd/2026-09-29-scoped-memory/baseline/packages/core/dist/index.js');
  const oldBinary=spawnSync(process.execPath,['--input-type=module','-e',
    "const core=await import(process.argv[1]);core.openDb(process.argv[2]);",pathToFileURL(baseline).href,oldPath],{encoding:'utf8',timeout:10000});
  assert.notEqual(oldBinary.status,0);assert.match(oldBinary.stderr,/has schema v17, this kdd only knows v15/);
  assert.equal(readFileSync(join(core.filesDir(oldPath),sha(blob)+'.txt'),'utf8'),blob);
  record('M01',{oldTables:oldTables.length,walBytes,backupVersion:15,newVersion:reopened.pragma('user_version',{simple:true}),oldBinaryExit:oldBinary.status,emptyMemory:true});

  const dbPath=join(home,'board.db'),db=track(core.openDb(dbPath,sourceCommon,source)),handle=core.openController(db);
  const projectId=core.projectOf(db).project_id,repoId=core.projectOf(db).primary_repo_id,user={type:'user'};
  const task=title=>core.addTask(db,{title,criteria:['ready']},user),scope=taskId=>({projectId,taskId}),view=taskId=>({scope:scope(taskId),repositories:[]});
  const parent=task('parent'),other=task('other'),ref={projectId,taskId:parent.id};
  const children=core.createSubtasks(handle,{parent:ref,expectedParentHash:core.taskContractHash(handle,ref),source:{kind:'manual',sourceTask:ref,instructionRef:'fixture:owner'},
    children:[{key:'a',title:'child A',criteria:['A']},{key:'b',title:'child B',criteria:['B']}]});
  const draft=(kind,title,taskId=null)=>({commandId:randomUUID(),entryId:null,expectedRevision:0,scope:scope(taskId),
    applicability:{repoId:null,commit:null},kind,status:'active',title,body:title,
    source:{kind:kind==='rule'||kind==='decision'?'user':'host',ref:'fixture:explicit observation'},author:{type:'user',id:null}});
  const draftHash=input=>{const {scope,applicability,kind,status,title,body,source,author}=input;return sha(canonical({scope,applicability,kind,status,title,body,source,author}));};
  const proof=(input,operation,origins)=>{
    const receipts=origins.map(origin=>({request:{operation,entryId:input.entryId,expectedRevision:input.expectedRevision,origin,
      scope:input.scope,applicability:input.applicability,payloadHash:draftHash(input),source:input.source},origin,verdict:'pass',observedAt:core.now(),expiresAt:null}));
    const path=join(home,randomUUID()+'.receipt.json');writeFileSync(path,JSON.stringify(receipts),{mode:0o600});
    return {observe:request=>JSON.parse(readFileSync(path,'utf8')).find(r=>canonical(r.request)===canonical(request))??null};
  };
  const publish=input=>core.writeMemory(handle,input,proof(input,'create',input.kind==='candidate'?[]:input.kind==='fact'?['host']:['user']));
  const rows=()=>['memory_entries','memory_revisions','events'].map(t=>db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
  const noWrite=(action,pattern)=>{const before=rows();assert.throws(action,pattern);assert.deepEqual(rows(),before);};
  const entries=[null,parent.id,children.a.id,children.b.id,other.id].map((id,i)=>publish(draft('rule',['project','parent','child A','child B','other'][i],id)));
  const expected=[['project'],['project','parent'],['project','parent','child A']];
  for(const [i,id] of [null,parent.id,children.a.id].entries()) {
    for(const read of [core.listMemory,core.memoryRules])assert.deepEqual(read(handle,view(id)).map(r=>r.title).sort(),expected[i].sort());
    for(const [j,entry] of entries.entries()){
      const allowed=expected[i].includes(['project','parent','child A','child B','other'][j]);
      for(const read of [core.memoryEntry,core.memoryHistory])if(allowed)read(handle,view(id),entry.entryId);else assert.throws(()=>read(handle,view(id),entry.entryId),/unavailable/);
    }
  }
  const foreignSource=repo('foreign'),foreign=track(core.openDb(join(home,'foreign.db'),core.canonicalCommonDir(foreignSource),foreignSource));
  const collision=core.addTask(foreign,{title:'collision'},user);assert.equal(collision.id,parent.id);
  noWrite(()=>core.listMemory(handle,{scope:{projectId:core.projectOf(foreign).project_id,taskId:collision.id},repositories:[]}),/foreign/);
  record('M02',{views:expected,foreignNumericCollision:collision.id,byIdAndHistoryDenied:true});

  const hit=publish(draft('fact','needle memory permitted',children.a.id)),queryView=view(children.a.id);
  const supplemental=publish({...draft('fact','needle supplemental',children.a.id),body:'needle '+'context '.repeat(150)});
  const ownHits=core.recallMemory(handle,queryView,'needle',{k:1});assert.ok([hit.entryId,supplemental.entryId].includes(ownHits[0].ref.entryId));
  const ordered=core.recallMemory(handle,queryView,'needle',{k:2});assert.equal(ordered.length,2);
  for(let i=0;i<200;i++)publish(draft('fact','needle '.repeat(10)+i,children.b.id));
  assert.deepEqual(core.recallMemory(handle,queryView,'needle',{k:1}),ownHits);
  assert.deepEqual(core.recallMemory(handle,queryView,'needle',{k:2}),ordered);
  record('M03',{foreignHits:200,k:1,eligibleHit:ownHits[0].ref.entryId,unchangedHitAndSnippet:true,
    rankedPermittedHits:ordered.map(h=>h.ref.entryId),unchangedOrderAcrossCorpusStatistics:true});

  const a=git(source,'rev-parse','HEAD'),fact={...draft('fact','Exact code version'),applicability:{repoId,commit:a}};
  const versioned=publish(fact),repoView=commit=>({scope:scope(null),repositories:[{repoId,checkoutPath:source,commit}]});
  assert.equal(core.memoryEntry(handle,repoView(a),versioned.entryId).hash,versioned.hash);
  git(source,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','branch B');const b=git(source,'rev-parse','HEAD');
  assert.equal(git(source,'merge-base','--is-ancestor',a,b),'');assert.throws(()=>core.memoryEntry(handle,repoView(b),versioned.entryId),/unavailable/);
  const backendId=core.addRepository(db,dbPath,home,{cwd:backend,purpose:'backend',access:'context_only'},user).repository.repo_id;
  assert.throws(()=>core.memoryEntry(handle,{scope:scope(null),repositories:[{repoId:backendId,checkoutPath:backend,commit:git(backend,'rev-parse','HEAD')}]},versioned.entryId),/unavailable/);
  const clone=join(root,'clone');git(root,'clone','--no-hardlinks','-q',source,clone);
  for(const bad of [{...repoView(a),repositories:[{repoId,checkoutPath:clone,commit:a}]},repoView('main'),repoView('0'.repeat(40)),
    {scope:scope(null),repositories:[{repoId:'f'.repeat(32),checkoutPath:source,commit:a}]}])noWrite(()=>core.listMemory(handle,bad));
  record('M04',{repoId,a,b,ancestorDoesNotBroaden:true,foreignBindingDenied:true});

  const candidate=draft('candidate','proposal'),first=publish(candidate),firstRow=db.prepare('SELECT * FROM memory_revisions WHERE entry_id=?').get(first.entryId);
  const accepted={...candidate,commandId:'accepted',entryId:first.entryId,expectedRevision:1,kind:'rule'};
  noWrite(()=>core.writeMemory(handle,accepted));core.writeMemory(handle,accepted,proof(accepted,'accept',['user']));
  const edit={...accepted,commandId:'edited',expectedRevision:2,body:'corrected'};core.writeMemory(handle,edit,proof(edit,'revise',['user']));
  const withdrawn={...edit,commandId:'withdrawn',expectedRevision:3,status:'withdrawn'};core.writeMemory(handle,withdrawn,proof(withdrawn,'withdraw',['user']));
  assert.deepEqual(db.prepare('SELECT * FROM memory_revisions WHERE entry_id=? AND revision=1').get(first.entryId),firstRow);
  for(const sql of ['DELETE FROM memory_revisions WHERE entry_id=?',"UPDATE memory_revisions SET body='erase' WHERE entry_id=?"])
    noWrite(()=>db.prepare(sql).run(first.entryId),/immutable/);
  assert.deepEqual(core.memoryHistory(handle,view(null),first.entryId).map(r=>r.predecessor),[null,1,2,3]);
  record('M05',{entryId:first.entryId,revisions:4,originalHash:first.hash,originalBytesAndProofPreserved:true});

  for(let round=0;round<20;round++) {
    const input=draft('candidate','race '+round),initial=publish(input);
    const replies=await runRace(dbPath,['left','right'].map(side=>({op:'memory',input:{...input,commandId:`race-${round}-${side}`,entryId:initial.entryId,expectedRevision:1,body:side}})));
    const winners=replies.filter(r=>r.ok).length;assert.equal(winners,1);assert.match(replies.find(r=>!r.ok).error,/stale memory revision/);
    const count=db.prepare('SELECT count(*) n FROM memory_revisions WHERE entry_id=?').get(initial.entryId).n;assert.equal(count,2);
    evidence.races.rounds++;evidence.races.singleWinners+=winners;evidence.races.duplicateRevisions+=count-2;
    const before=rows();assert.equal(core.writeMemory(handle,input).created,false);assert.deepEqual(rows(),before);
    noWrite(()=>core.writeMemory(handle,{...input,body:'changed'}),/command/);
  }
  const crashDraft=draft('candidate','crash'),crashEntry=publish(crashDraft),preCrash=rows();
  await crashMemoryWrite(dbPath,{...crashDraft,commandId:'crash-pending',entryId:crashEntry.entryId,expectedRevision:1,body:'uncommitted'});
  assert.deepEqual(rows(),preCrash);
  db.exec("CREATE TRIGGER memory_audit_failure BEFORE INSERT ON events WHEN NEW.action='memory_revision' BEGIN SELECT RAISE(ABORT,'fixture audit refusal'); END");
  noWrite(()=>publish(draft('candidate','audit failure')),/audit refusal/);db.exec('DROP TRIGGER memory_audit_failure');
  record('M06',{...evidence.races,crash:'pending write then SIGKILL',rollback:true,commandReplay:true});

  const rule=draft('rule','Evidence only'),valid=proof(rule,'create',['user']);
  const negatives=['missing','fail','inconclusive','hash','origin','scope','operation','expiry','future','throw'];
  for(const mode of negatives)noWrite(()=>core.writeMemory(handle,rule,{observe:request=>{
    if(mode==='throw')throw Error('private callback payload');if(mode==='missing')return null;
    const r=structuredClone(valid.observe(request));
    if(mode==='fail'||mode==='inconclusive')r.verdict=mode;
    if(mode==='hash')r.request.payloadHash='0'.repeat(64);if(mode==='origin')r.origin='host';
    if(mode==='scope')r.request.scope.taskId=children.b.id;if(mode==='operation')r.request.operation='revise';
    if(mode==='expiry')r.expiresAt=core.now()-1;if(mode==='future')r.observedAt=core.now()+60;return r;
  }}),/not verified/);
  noWrite(()=>core.writeMemory(handle,{...rule,reason:'user approved'}),/shape/);
  core.writeMemory(handle,rule,valid);const userFact={...draft('fact','Host and user'),source:{kind:'user',ref:'fixture:answer'}};
  noWrite(()=>core.writeMemory(handle,userFact,proof(userFact,'create',['user'])),/not verified/);
  core.writeMemory(handle,userFact,proof(userFact,'create',['user','host']));
  const mutable=draft('rule','Immutable verified payload'),fixed=proof(mutable,'create',['user']);
  const capturedHash=draftHash(mutable),captured=core.writeMemory(handle,mutable,{observe:request=>{
    const receipt=fixed.observe(request);mutable.body='unconfirmed';mutable.scope.taskId=children.b.id;return receipt;
  }});
  const stored=core.memoryEntry(handle,view(null),captured.entryId);assert.equal(stored.hash,capturedHash);
  assert.equal(stored.body,'Immutable verified payload');assert.equal(stored.scope.taskId,null);
  assert.equal(stored.evidence[0].request.payloadHash,stored.hash);
  record('M07',{negativeEvidence:negatives,actorAndReasonNotAuthority:true,fixtureReceipts:true,dualOrigins:['user','host'],mutableCallerCannotChangeVerifiedPayload:true});

  const path='.planning/decisions/selected.md',bytes=Buffer.from('\ufeff---\r\nstatus: active\r\n---\r\n# Selected\r\n\r\nPinned API\r\n');
  mkdirSync(dirname(join(source,path)),{recursive:true});writeFileSync(join(source,path),bytes);symlinkSync('selected.md',join(source,'.planning/decisions/link.md'));
  const credentialDocs=['.npmrc','.git-credentials','.netrc'].map(path=>[path,Buffer.from('machine example.invalid login fixture password fixturepassword\n')]);
  const badDocs=[['invalid.md',Buffer.from([0xff])],['nul.md',Buffer.from('a\0b')],['big.md',Buffer.from('x'.repeat(core.CAPS.bodyChars+1))],['secret.md',Buffer.from('sk-proj-'+'x'.repeat(40))],['.env',Buffer.from('private')],...credentialDocs];
  const statusDocs=[['.planning/decisions/empty.md','---\nstatus:\n---\n# Empty\n','unknown'],
    ['.planning/decisions/eof.md','---\nstatus: superseded\n---','superseded']];
  for(const [name,data] of badDocs)writeFileSync(join(source,name),data);
  for(const [name,data] of statusDocs)writeFileSync(join(source,name),data);
  git(source,'add','-f','--','.planning/decisions',...badDocs.map(d=>d[0]));git(source,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','selected documents');
  const commit=git(source,'rev-parse','HEAD'),selected={commandId:'selected',scope:scope(null),applicability:{repoId:null,commit:null},
    repoId,checkoutPath:source,commit,path,sha256:sha(bytes),author:{type:'user',id:null}};
  const sourceState=()=>({refs:git(source,'for-each-ref'),status:git(source,'status','--porcelain'),tracked:git(source,'ls-files','--stage'),selected:sha(readFileSync(join(source,path)))});
  const preImport=sourceState(),imported=core.importMemory(handle,selected),current=core.memoryEntry(handle,view(null),imported.entryId);
  assert.equal(current.body,bytes.toString());assert.equal(current.source.sha256,sha(bytes));assert.equal(current.source.commit,commit);
  assert.equal(core.importMemory(handle,{...selected,commandId:'selected-alias'}).entryId,imported.entryId);
  const stable=rows();core.importMemory(handle,{...selected,commandId:'selected-alias'});assert.deepEqual(rows(),stable);assert.deepEqual(sourceState(),preImport);
  let refused=0;
  for(const overrides of [{path:'../selected.md'},{path:'/etc/passwd'},{path:'x\\y'},{path:'x\0y'},{path:'.planning/decisions/link.md'},
    {sha256:'0'.repeat(64)},{commit:'0'.repeat(40)},{checkoutPath:clone},...badDocs.map(([path,data])=>({path,sha256:sha(data)}))]){
    noWrite(()=>core.importMemory(handle,{...selected,commandId:randomUUID(),...overrides}));refused++;
  }
  for(const [path,body,documentStatus] of statusDocs){
    const input={...selected,commandId:randomUUID(),path,sha256:sha(body)},receipt=core.importMemory(handle,input);
    assert.equal(core.memoryEntry(handle,view(null),receipt.entryId).source.documentStatus,documentStatus);
    noWrite(()=>core.importMemory(handle,{...input,commandId:randomUUID(),kind:'rule'}),/inactive legacy/);
  }
  const scopedImport=core.importMemory(handle,{...selected,commandId:'other-scope',scope:scope(children.a.id)});assert.notEqual(scopedImport.entryId,imported.entryId);
  git(source,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','new version');
  const newer=core.importMemory(handle,{...selected,commandId:'new-version',commit:git(source,'rev-parse','HEAD')});assert.notEqual(newer.entryId,imported.entryId);
  const replacementBytes='# Replacement\n\nWrong version\n';writeFileSync(join(source,path),replacementBytes);
  git(source,'add','--',path);git(source,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','replacement version');
  const replacement=git(source,'rev-parse','HEAD');git(source,'replace',commit,replacement);
  const wrong={...selected,commandId:'replaced-bytes',sha256:sha(replacementBytes)},replaceRefs=git(source,'for-each-ref');
  noWrite(()=>core.importMemory(handle,wrong),/hash/);assert.equal(core.importMemory(handle,selected).created,false);
  assert.equal(git(source,'for-each-ref'),replaceRefs);git(source,'replace','-d',commit);
  const originalBlob=git(source,'--no-replace-objects','rev-parse',`${commit}:${path}`),replacementBlob=git(source,'rev-parse',`${replacement}:${path}`);
  git(source,'replace',originalBlob,replacementBlob);const blobRefs=git(source,'for-each-ref');
  noWrite(()=>core.importMemory(handle,wrong),/hash/);assert.equal(core.importMemory(handle,selected).created,false);
  assert.equal(git(source,'for-each-ref'),blobRefs);git(source,'replace','-d',originalBlob);
  record('M09',{entryId:imported.entryId,commit,blobHash:sha(bytes),rawBOMAndCRLFPreserved:true,refusedInputs:refused,
    deduplicated:true,separateScopeAndVersion:true,commitAndBlobReplaceIgnored:true,inactiveStatuses:statusDocs.map(d=>d[2])});

  const preLegacy=rows();git(source,'rm','--',path,'.planning/decisions/link.md');git(source,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','branch removes source');
  const primaryDir=join(source,'.planning/decisions');core.recall(db,primaryDir,'Selected');core.rebuild(db,primaryDir);
  const backendDir=join(backend,'.planning/decisions');core.recall(db,backendDir,'Selected');
  mkdirSync(backendDir,{recursive:true});writeFileSync(join(backendDir,'selected.md'),'# Conflicting backend\n\nreplace API');
  core.recall(db,backendDir,'replace');assert.throws(()=>core.rebuild(db,backendDir));
  assert.deepEqual(rows(),preLegacy);assert.equal(core.importMemory(handle,selected).created,false);assert.deepEqual(rows(),preLegacy);
  record('M10',{importedRowsPreserved:true,legacyBranches:['primary removed document','backend empty','backend conflicting'],sourceMissingReplay:true});

  assert.equal(core.listMemory(handle,view(null)).some(r=>r.entryId===first.entryId||r.kind==='candidate'),false);
  const history=core.memoryHistory(handle,view(null),first.entryId);assert.deepEqual(history.map(r=>r.effectiveStatus),['superseded','superseded','superseded','withdrawn']);
  assert.equal(core.listMemory(handle,view(null),{candidates:true}).some(r=>r.entryId===imported.entryId),true);
  const beforeReplay=rows();core.writeMemory(handle,candidate);assert.deepEqual(rows(),beforeReplay);
  noWrite(()=>core.writeMemory(handle,{...candidate,commandId:'demote',entryId:entries[0].entryId,expectedRevision:1}),/kind/);
  record('M11',{defaultCandidatesExcluded:true,withdrawnExcluded:true,history:history.map(r=>({revision:r.revision,effectiveStatus:r.effectiveStatus})),replayDoesNotRevive:true});

  const mandatory=core.memoryRules(handle,view(children.a.id));assert.ok(mandatory.length>=3);
  assert.ok(['project','parent','child A'].every(title=>mandatory.some(r=>r.title===title)));
  assert.equal(core.recallMemory(handle,view(children.a.id),'needle',{k:1}).length,1);
  assert.deepEqual(core.memoryRules(handle,view(children.a.id)),mandatory);
  record('M12',{activeRules:mandatory.length,inheritedRules:['project','parent','child A'],independentOfTopK:true,noNarrowerOverride:true});

  const privatePayload='sk-proj-'+'x'.repeat(40),preBounds=rows(),refs=git(source,'for-each-ref'),status=git(source,'status','--porcelain');
  for(const input of [{...draft('candidate','safe'),body:privatePayload},{...draft('candidate','safe'),body:'x'.repeat(core.CAPS.bodyChars+1)},
    {...draft('candidate','safe'),source:{kind:'host',ref:'.codex/credential.json'}},
    {...draft('candidate','safe'),body:new Function(`return '${privatePayload}'`)},
    {...draft('candidate','safe'),applicability:{repoId:privatePayload,commit:null}},
    {...draft('candidate','safe'),body:String.fromCharCode(0xd800)},{...draft('candidate','safe'),title:String.fromCharCode(0xdc00)}]) {
    let error;try{core.writeMemory(handle,input);}catch(e){error=e;}assert.ok(error);assert.equal(error.message.includes(privatePayload),false);
  }
  for(const [path,bytes] of credentialDocs)noWrite(()=>core.writeMemory(handle,{...draft('candidate','credential fixture'),body:bytes.toString(),
    source:{kind:'git',repoId,commit,path,sha256:sha(bytes),documentStatus:null}}),/private/);
  assert.deepEqual(rows(),preBounds);assert.equal(JSON.stringify(db.prepare("SELECT detail FROM events WHERE action LIKE 'memory_%'").all()).includes(privatePayload),false);
  assert.equal(git(source,'for-each-ref'),refs);assert.equal(git(source,'status','--porcelain'),status);
  assert.equal(git(source,'ls-files').split('\n').some(p=>p.startsWith('.kdd')||p.startsWith('.codex')||p.startsWith('.planning/runs')),false);
  record('M13',{bodyCap:core.CAPS.bodyChars,secretAndPrivateRefDenied:true,credentialFilesDenied:credentialDocs.length,noTruncation:true,noNewRefsOrExports:true,malformedObjectErrorsDoNotEchoPayload:true,malformedUnicodeDeniedBeforeHashPersistence:true});

  const persisted=core.memoryEntry(handle,view(null),imported.entryId);assert.equal(persisted.hash,draftHash(persisted));
  assert.equal(persisted.source.commit,commit);assert.deepEqual(persisted.scope,scope(null));
  const authorityRegression=JSON.parse(execFileSync(process.execPath,[fileURLToPath(new URL('./authority-check.mjs',import.meta.url))],{encoding:'utf8',stdio:'pipe',timeout:30000}));
  assert.equal(authorityRegression.checks.length,7);assert.equal(authorityRegression.schema,core.MIGRATIONS.length);
  assert.deepEqual(db.pragma('foreign_key_check'),[]);assert.equal('assertRunMemorySource' in core,false);
  record('M14',{publicFunctions:required,actualRevision:persisted.revision,hash:persisted.hash,transportRegression:authorityRegression.checks.length,newTools:0});
  // Recorded only after fresh production preflight; absence/stale hashes fail this scenario.
  const natives=['full','context'].map(name=>JSON.parse(readFileSync(resolve(`.superpowers/sdd/2026-09-29-run-context/native-${name}.json`),'utf8')));
  for(const native of natives){
    assert.equal(native.final.applicable,true);assert.deepEqual(native.final.failures,[]);
    assert.equal(native.final.scriptHash,runtimeHash);assert.equal(native.final.guardHash,runtimeHash);
    assert.equal(native.final.executed,native.final.attempted);
    assert.ok(native.final.observations.every(o=>o.executed && o.unchangedProtectedBytes));
    for(const check of ['memory-own-scope','memory-sibling-refused','memory-current-inputs-refused','memory-live-revoke-refused'])assert.ok(native.checks.includes(check));
  }
  assert.deepEqual(natives.map(n=>n.final.operations),[['get_context','submit_report','request_question'],['get_context']]);
  record('M08',{genuineNativeCredentials:true,matrices:natives.map(n=>({operations:n.final.operations,
    verifiedPackageResults:n.results.length,attempted:n.final.attempted,executed:n.final.executed,
    failures:n.final.failures.length,protectedObservations:n.final.observations.length,
    checks:n.checks.filter(c=>c.startsWith('memory-'))}))});

  evidence.checks.sort((a,b)=>a.id.localeCompare(b.id));
  assert.deepEqual(evidence.checks.map(c=>c.id),Array.from({length:14},(_,i)=>'M'+String(i+1).padStart(2,'0')));
  assert.equal(sha(readFileSync(corePath)),runtimeHash);process.stdout.write(JSON.stringify(evidence,null,2)+'\n');
}finally{for(const db of handles.reverse())if(db.open)db.close();process.env=saved;rmSync(root,{recursive:true,force:true});}
