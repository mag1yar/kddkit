// Public compiled APIs, genuine process-local native packages, isolated Git/SQLite only.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync,spawnSync,fork} from 'node:child_process';
import {mkdtempSync,mkdirSync,realpathSync,readFileSync,writeFileSync,rmSync,statSync,linkSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import Database from '../../../packages/core/node_modules/better-sqlite3/lib/index.js';
import {Client} from '../../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StdioClientTransport} from '../../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
const args=process.argv.slice(2),entry=fileURLToPath(import.meta.url);
const flags=new Map();for(let i=0;i<args.length;i+=2){assert.ok(['--core','--race-child','--native-full','--native-context','--dependencies','--memory'].includes(args[i]));assert.ok(isAbsolute(args[i+1]));assert.ok(!flags.has(args[i]));flags.set(args[i],args[i+1]);}
const corePath=flags.get('--core')??fileURLToPath(new URL('../../../packages/core/dist/index.js',import.meta.url));
const core=await import(pathToFileURL(corePath).href);
assert.deepEqual(['runInputSnapshot','checkRunInputs'].filter(name=>typeof core[name]!=='function'),[],'missing-run-input-API; baseline RED before creating any store');
const sha=value=>createHash('sha256').update(value).digest('hex');
const order=v=>Array.isArray(v)?v.map(order):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,order(v[k])])):v;
const canonical=v=>JSON.stringify(order(v)),git=(cwd,...argv)=>execFileSync('/usr/bin/git',argv,{cwd,encoding:'utf8',stdio:'pipe'}).trim();
if(flags.has('--race-child')){
  const f=JSON.parse(readFileSync(flags.get('--race-child'),'utf8'));
  process.env.KDD_HOME=f.home;delete process.env.KDD_DB;delete process.env.KDD_DECISIONS_DIR;
  const db=core.openDb(f.dbPath),controller=core.openController(db);
  try{
    const packet=await core.preflightCodex(f.native);
    process.send({ready:true,version:packet.version,configHash:packet.configHash,observations:packet.results.length});
    process.on('message',command=>{
      if(command.kind==='close'){db.close();process.exit(0);}
      try{
        if(command.kind==='crash')db.exec('BEGIN IMMEDIATE');
        const supplied=command.input??f.input;
        const issued=core.issueRunAuthority(controller,{...supplied,runId:`${command.kind}-${command.round}-${f.lane}`,
          expectedGeneration:command.expectedGeneration,native:packet,...(command.observationsPath?{contextObservers:{observe:request=>{
            const receipts=JSON.parse(readFileSync(command.observationsPath,'utf8')),receipt=receipts.find(r=>canonical(r.request)===canonical(request));
            return receipt?{...receipt,observedAt:core.now()}:null;
          }}}:{})});
        if(command.kind==='crash'){process.send({pending:true});return;}
        // Private bootstrap stays on disk; tokens and native packets never cross IPC.
        if(command.configPath)writeFileSync(command.configPath,JSON.stringify({dbPath:f.dbPath,token:issued.token}),{mode:0o600});
        process.send({ok:true,authorityId:issued.authorityId,generation:issued.generation});
      }catch(error){if(db.inTransaction)db.exec('ROLLBACK');process.send({ok:false,error:String(error.message).slice(0,256)});}
    });
  }catch(error){process.stderr.write(String(error.stack)+'\n');db.close();process.exit(1);}
}else{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'kdd-context-observation-'))),home=join(root,'private'),saved={...process.env};
  const handles=[],children=[],clients=[],runtimeHash=sha(readFileSync(corePath));
  const evidence={observedAt:new Date().toISOString(),node:process.version,schema:core.MIGRATIONS.length,runtimeHash,checks:[],
    races:{rounds:0,singleWinners:0,duplicates:0},limitations:['Fixed host/user fixture receipts are not product acceptance.','Bytes are not model tokens; prompt capacity and runtime delivery belong to later tasks.','Native proof uses pinned Codex 0.157.0; process-local packets never cross IPC.']};
  const record=(id,observations)=>{evidence.checks.push({id,passed:true,observations});process.stderr.write(`${id} passed\n`);};
  const track=db=>{handles.push(db);return db;};
  const makeRepo=name=>{const path=join(root,name);mkdirSync(path);git(path,'init','-q');git(path,'-c','user.name=Fixture','-c','user.email=test@example.invalid','commit','--allow-empty','-qm',name);return path;};
  const message=(child,timeout=30000)=>new Promise((done,fail)=>{
    let timer;const clean=()=>{clearTimeout(timer);child.off('message',received);child.off('exit',exited);child.off('error',failed);};
    const received=value=>{clean();done(value);},exited=(code,signal)=>{clean();fail(Error(`native issuer exited ${code}/${signal}`));},failed=error=>{clean();fail(error);};
    child.once('message',received);child.once('exit',exited);child.once('error',failed);timer=setTimeout(()=>{clean();fail(Error('native issuer timeout; incomplete proof'));},timeout);
  });
  try{
    process.env.KDD_HOME=home;delete process.env.KDD_DB;delete process.env.KDD_DECISIONS_DIR;mkdirSync(home);
    const source=makeRepo('source'),backend=makeRepo('backend'),common=core.canonicalCommonDir(source),user={type:'user'};
    const backendControl=join(backend,'controller');mkdirSync(backendControl);
    const historicalSource=makeRepo('historical'),historicalCommon=core.canonicalCommonDir(historicalSource);
    const oldPath=join(home,'v16.db'),raw=track(new Database(oldPath));raw.pragma('journal_mode=WAL');raw.pragma('wal_autocheckpoint=0');
    for(const sql of core.MIGRATIONS.slice(0,16))raw.exec(sql);raw.pragma('user_version=16');
    const repo='a'.repeat(32),memory='b'.repeat(32),oldWork='c'.repeat(32);
    raw.prepare('INSERT INTO repositories VALUES(?,?,?,?,?)').run(repo,'primary','implementation',null,1);
    raw.prepare('UPDATE project SET primary_repo_id=?,legacy_decisions_dir=?').run(repo,join(historicalSource,'.planning/decisions'));
    raw.prepare('INSERT INTO repository_bindings VALUES(?,?,?,?,?)').run(historicalCommon,repo,historicalSource,'source',1);
    raw.prepare("INSERT INTO meta VALUES('project_path',?)").run(historicalCommon);raw.prepare("INSERT INTO meta VALUES('project_toplevel',?)").run(historicalSource);
    raw.exec(`INSERT INTO tasks(id,title,status,created_at,updated_at) VALUES(41,'retained','new',1,1);
      INSERT INTO criteria(id,task_id,text,created_at) VALUES(9,41,'retained',1);
      INSERT INTO comments VALUES(7,41,'user','retain comment',1);
      INSERT INTO events(id,task_id,actor_type,action,detail,created_at) VALUES(6,41,'user','created','{"keep":true}',1);
      INSERT INTO managed_task_policy VALUES(41,1,'legacy');
      INSERT INTO run_authorities VALUES('old-authority',41,'external','old',1,1,NULL,'old-hash','{"retained":true}',1);
      INSERT INTO search_index VALUES('decision','retained','Retained','retain token');
      INSERT INTO decisions VALUES('retained','Retained','old.md','old-hash','2026-01-01',NULL,'[41]');`);
    raw.transaction(()=>{
      raw.prepare('INSERT INTO memory_entries VALUES(?,NULL,NULL,NULL,NULL,1,1)').run(memory);
      raw.prepare("INSERT INTO memory_revisions VALUES(?,1,NULL,'rule','active','Keep','Keep','{}','{}','[]',?,'legacy-rule',?,1)").run(memory,'d'.repeat(64),'d'.repeat(64));
      raw.prepare('INSERT INTO work_items(id,task_id,current_revision,created_at) VALUES(?,41,1,1)').run(oldWork);
      raw.prepare('INSERT INTO work_item_revisions VALUES(?,1,?,?,?,1)').run(oldWork,'{"kind":"analysis","repoId":null,"sourceTasks":[],"outputs":[]}','[]','e'.repeat(64));
      raw.prepare("INSERT INTO work_item_results VALUES('old-result','old-command','old-hash',?,1,'api','contract','{}','{}',1,NULL,NULL,NULL)").run(oldWork);
      raw.prepare("INSERT INTO work_item_owners VALUES(?,1,1,'old-owner','manual',0,'[]',NULL,NULL,1,NULL,NULL)").run(oldWork);
    }).immediate();
    const tables=raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'search_index_%' ORDER BY name").all().map(r=>r.name);
    const historical=db=>tables.map(t=>db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()),before=historical(raw),walBytes=statSync(oldPath+'-wal').size;
    assert.ok(walBytes>0);const upgraded=track(core.openDb(oldPath,historicalCommon,historicalSource));assert.equal(upgraded.pragma('user_version',{simple:true}),17);assert.deepEqual(historical(upgraded),before);
    const backup=track(new Database(oldPath+'.v16.bak',{readonly:true}));assert.equal(backup.pragma('user_version',{simple:true}),16);assert.deepEqual(historical(backup),before);
    assert.deepEqual(upgraded.prepare('SELECT * FROM run_input_snapshots').all(),[]);assert.deepEqual(upgraded.pragma('foreign_key_check'),[]);
    assert.deepEqual(historical(track(core.openDb(oldPath))),before);
    const oldBinary=spawnSync(process.execPath,['--input-type=module','-e','const core=await import(process.argv[1]);core.openDb(process.argv[2]);',
      pathToFileURL(resolve('.superpowers/sdd/2026-09-29-run-context/baseline/packages/core/dist/index.js')).href,oldPath],{encoding:'utf8',timeout:10000});
    assert.notEqual(oldBinary.status,0);assert.match(oldBinary.stderr,/schema v17.*only knows v16/);record('C01',{tables:tables.length,walBytes,backupVersion:16,newVersion:17,oldBinaryExit:oldBinary.status});
    const dbPath=join(home,'board.db'),db=track(core.openDb(dbPath,common,source)),handle=core.openController(db),projectId=core.projectOf(db).project_id,repoId=core.projectOf(db).primary_repo_id;
    const backendId=core.addRepository(db,dbPath,home,{cwd:backend,purpose:'backend',access:'context_only'},user).repository.repo_id;
    const ref=taskId=>({projectId,taskId}),task=title=>core.addTask(db,{title,body:'requirements',criteria:['outcome']},user);
    const repositories=[{repoId,checkoutPath:source,write:false},{repoId:backendId,checkoutPath:backend,write:false}],nativeExecutable=process.env.KDD_CODEX_EXECUTABLE??resolve('.superpowers/sdd/2026-09-28-subtasks-dependencies/codex-0.157.0/bin/codex');
    assert.equal(sha(readFileSync(nativeExecutable)),'ad0be20d04e2ba6146ecdb51d7f8b7b0fe15420a15dc9b0057518d858f1f3714');
    const raceTask=task('generation races'),baseInput={taskId:raceTask.id,workItemId:'external-race',runId:'race',expectedGeneration:0,
      expiresAt:core.now()+7200,operations:['get_context','submit_report','request_question'],repositories};
    const ready=await Promise.all([0,1].map(async lane=>{
      const controlDir=lane===0?backendControl:join(home,'lane-'+lane),scratchDir=join(root,'scratch-'+lane),fixturePath=join(home,`lane-${lane}.json`);
      mkdirSync(controlDir,{recursive:true});mkdirSync(scratchDir);
      writeFileSync(fixturePath,JSON.stringify({lane,home,dbPath,input:baseInput,native:{executable:nativeExecutable,model:'fixture-codex',cwd:source,
        readableRoots:[source,backend],scratchDir,controlDir,protectedPaths:[home,backendControl]}}),{mode:0o600});
      const child=fork(entry,['--race-child',fixturePath],{execPath:process.execPath,stdio:['ignore','ignore','pipe','ipc']});
      children.push(child);child.stderr.on('data',data=>process.stderr.write(`lane${lane}: ${data}`));child.closed=new Promise(done=>child.once('close',(code,signal)=>done({code,signal})));
      const proof=await message(child,1200000);process.stderr.write(`lane${lane} genuine preflight complete\n`);assert.equal(proof.ready,true);assert.equal(proof.version,'codex-cli 0.157.0');assert.ok(proof.observations>0);return proof;
    }));evidence.nativeIssuers=ready;
    const allRows=()=>['managed_task_policy','run_authorities','run_input_snapshots','events'].map(t=>db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
    let sequence=0;
    const issue=async(input,expectedGeneration=0,observationsPath)=>{
      const configPath=join(home,`broker-${++sequence}.json`),reply=message(children[0]);children[0].send({kind:'issue',round:sequence,input,expectedGeneration,configPath,observationsPath});
      const result=await reply;return {...result,configPath};
    };
    const success=async(input,observationsPath)=>{const issued=await issue({...baseInput,...input},0,observationsPath);assert.equal(issued.ok,true,issued.error);const token=JSON.parse(readFileSync(issued.configPath,'utf8')).token;
      const snapshotRef={projectId,authorityId:issued.authorityId};return {...issued,token,context:core.openRunContext(db,token),snapshotRef,snapshot:core.runInputSnapshot(handle,snapshotRef)};};
    const failure=async(input,pattern)=>{const before=allRows(),reply=await issue({...baseInput,...input},input.expectedGeneration??0);assert.equal(reply.ok,false);assert.match(reply.error,pattern);assert.deepEqual(allRows(),before);return reply.error;};
    const draft=(kind,body,taskId=null)=>({commandId:randomUUID(),entryId:null,expectedRevision:0,scope:{projectId,taskId},applicability:{repoId:null,commit:null},
      kind,status:'active',title:body.length>100?'context':body,body,source:{kind:kind==='fact'?'host':'user',ref:'fixture:explicit'},author:{type:'user',id:null}});
    const publishMemory=(input,operation='create')=>{const {scope,applicability,kind,status,title,body,source,author}=input;
      const payloadHash=sha(canonical({scope,applicability,kind,status,title,body,source,author}));
      const origins=kind==='fact'?['host']:kind==='candidate'&&source.kind==='host'?[]:['user'];
      const receipts=origins.map(origin=>({request:{operation,entryId:input.entryId,expectedRevision:input.expectedRevision,origin,scope,applicability,payloadHash,source},origin,verdict:'pass',observedAt:core.now(),expiresAt:null}));
      const path=join(home,randomUUID()+'.receipt.json');writeFileSync(path,JSON.stringify(receipts),{mode:0o600});
      return core.writeMemory(handle,input,{observe:request=>JSON.parse(readFileSync(path,'utf8')).find(r=>canonical(r.request)===canonical(request))??null});};
    const parent=task('parent'),childrenTasks=core.createSubtasks(handle,{parent:ref(parent.id),expectedParentHash:core.taskContractHash(handle,ref(parent.id)),
      source:{kind:'manual',sourceTask:ref(parent.id),instructionRef:'fixture'},children:[{key:'own',title:'context child',criteria:['own outcome']},{key:'sibling',title:'sibling',criteria:['sibling outcome']}]});
    for(const [taskId,body] of [[null,'project rule'],[parent.id,'parent rule'],[childrenTasks.own.id,'own rule'],[childrenTasks.sibling.id,'sibling private policy']])publishMemory(draft('rule',body,taskId));
    const selected=draft('fact','context knowledge',childrenTasks.own.id),selectedEntry=publishMemory(selected);
    const childInput={taskId:childrenTasks.own.id,workItemId:'child-context',context:{query:'context',k:1}},child=await success(childInput);
    assert.deepEqual(child.snapshot.response.inputs.requirements.map(r=>r.task.taskId),[parent.id,childrenTasks.own.id]);
    assert.deepEqual(child.snapshot.response.inputs.rules.map(r=>r.body).sort(),['own rule','parent rule','project rule']);
    assert.equal(JSON.stringify(child.snapshot.response).includes('sibling private policy'),false);assert.deepEqual(child.snapshot.response.inputs.knowledge.map(r=>r.body),['context knowledge']);
    record('C02',{parent:parent.id,child:childrenTasks.own.id,requirements:2,rules:3,siblingExcluded:true});
    const overflow=task('mandatory overflow');
    for(let i=0;i<4;i++)publishMemory(draft('rule','😀"\\\n'.repeat(1200),overflow.id));
    await failure({taskId:overflow.id,workItemId:'overflow'},/budget|limit/);
    const beforeRotation=allRows();await failure({...childInput,expectedGeneration:1,context:{maxBytes:1}},/budget|limit/);assert.deepEqual(allRows(),beforeRotation);
    record('C03',{mandatoryOverflowRefused:true,rejectedRotationWrites:0,kOneRules:child.snapshot.response.inputs.rules.length});
    const checks=async fixture=>{
      const payload=core.readRunContext(fixture.context);assert.deepEqual(payload,fixture.snapshot.response);
      const path=fixture.configPath,client=new Client({name:'context-observation',version:'0'});clients.push(client);
      await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('packages/mcp/dist/run_main.js'),'--config',path],env:{HOME:process.env.HOME,PATH:process.env.PATH},stderr:'pipe'}));
      const response=await client.callTool({name:'get_context',arguments:{}});assert.notEqual(response.isError,true);assert.deepEqual(JSON.parse(response.content[0].text),payload);
      assert.deepEqual(await client.callTool({name:'get_context',arguments:{}}),response);await client.close();
      const reopened=track(core.openDb(dbPath));assert.deepEqual(core.readRunContext(core.openRunContext(reopened,fixture.token)),payload);
      return {inputHash:payload.inputs.inputHash,wireBytes:Buffer.byteLength(JSON.stringify(response)),stdio:true,reopen:true};
    };
    record('C06',await checks(child));
    const saved=core.runInputSnapshot(handle,child.snapshotRef);
    db.prepare("UPDATE tasks SET status='in_progress',position=9 WHERE id=?").run(childrenTasks.own.id);
    db.prepare('UPDATE criteria SET checked_at=1,evidence=? WHERE task_id=?').run('progress',childrenTasks.own.id);
    db.prepare("INSERT INTO comments(task_id,author,body,created_at) VALUES(?,'user','progress',1)").run(childrenTasks.own.id);
    publishMemory({...draft('candidate','context proposal',childrenTasks.own.id),source:{kind:'host',ref:'fixture'}});
    publishMemory(draft('fact','unselected reference',childrenTasks.own.id));
    assert.equal(core.checkRunInputs(handle,child.snapshotRef).status,'current');assert.deepEqual(core.readRunContext(child.context),saved.response);
    record('C08',{noImplicitRebuild:true,progressExcluded:true,unselectedKnowledgeExcluded:true});
    const addedRule=publishMemory(draft('rule','new mandatory rule',parent.id));
    assert.throws(()=>core.readRunContext(child.context));const notice=core.checkRunInputs(handle,child.snapshotRef);
    assert.equal(notice.status,'update_required');assert.deepEqual(notice.changes.find(c=>c.entryId===addedRule.entryId),
      {reason:'rules_changed',entryId:addedRule.entryId,previous:null,current:{revision:1,hash:addedRule.hash}});
    assert.deepEqual(core.checkRunInputs(handle,child.snapshotRef),notice);
    const replay=track(core.openDb(dbPath));assert.deepEqual(core.checkRunInputs(core.openController(replay),child.snapshotRef),notice);
    const secondRule=publishMemory(draft('rule','another mandatory rule',parent.id)),secondNotice=core.checkRunInputs(handle,child.snapshotRef);
    assert.deepEqual(secondNotice.changes.find(c=>c.entryId===secondRule.entryId),
      {reason:'rules_changed',entryId:secondRule.entryId,previous:null,current:{revision:1,hash:secondRule.hash}});
    assert.notEqual(secondNotice.changeHash,notice.changeHash);assert.notEqual(secondNotice.eventId,notice.eventId);
    assert.deepEqual(core.checkRunInputs(handle,child.snapshotRef),secondNotice);
    assert.deepEqual(core.runInputSnapshot(handle,child.snapshotRef),saved);
    const updated={...selected,commandId:randomUUID(),entryId:selectedEntry.entryId,expectedRevision:1,body:'changed knowledge'};publishMemory(updated,'revise');
    const knowledgeNotice=core.checkRunInputs(handle,child.snapshotRef);assert.ok(knowledgeNotice.changes.some(c=>c.entryId===selectedEntry.entryId));
    db.prepare('UPDATE tasks SET body=? WHERE id=?').run('changed parent',parent.id);assert.ok(core.checkRunInputs(handle,child.snapshotRef).changes.some(c=>c.taskId===parent.id));
    record('C07',{noticeId:notice.eventId,secondNoticeId:secondNotice.eventId,deduplicated:true,exactRevisionRefs:true,
      distinctChangesNotCollapsed:true,selectedRevisionDetected:true,addedRuleDetected:true,archiveImmutable:true});
    const definition=(kind,repoId,outputs=[])=>({kind,repoId,sourceTasks:[],outputs}),output=kind=>({key:'api',kind,required:true,version:'v1',checkRefs:[]});
    const manual=item=>({kind:'manual',sourceTask:item.task,instructionRef:'fixture'});
    const fixedObserver=requests=>({observe:incoming=>{const r=requests.find(r=>canonical(r.request)===canonical(incoming));return r?{...r,observedAt:core.now()}:null;}});
    const flow=(kind,lifetime=3600,artifactOverride=null)=>{
      const producerTask=task('producer '+kind),consumerTask=task('consumer '+kind),producer=core.createWorkItem(handle,{task:ref(producerTask.id),definition:definition(kind==='readiness'?'human_action':'architecture',backendId,[output(kind)]),dependencies:[]});
      const path=artifactOverride?.path??join(root,randomUUID()+'.json'),body=artifactOverride?.body??'{"api":"backend-v1"}\n';if(!artifactOverride?.existing)writeFileSync(path,body);
      const payload=kind==='contract'?{kind,repoId:backendId,head:null,version:'v1',checkRefs:[],artifact:{path,sha256:sha(body)}}:
        {kind,repoId:backendId,version:'v1',checkRefs:[],resourceId:'backend-fixture',configHash:'f'.repeat(64),consumerScope:'frontend',capabilities:['http'],userRef:'fixture:confirmation',probeRef:'fixture:probe',observedAt:core.now(),expiresAt:core.now()+lifetime};
      const binding={producer:producer.ref,producerRevision:1,inputsHash:producer.inputsHash,outputKey:'api',kind,version:'v1',repoId:backendId};
      const receipts=kind==='readiness'?[{request:{kind:'readiness_confirmation',ref:payload.userRef,binding,resourceId:payload.resourceId},origin:'user',verdict:'pass',expiresAt:null},
        {request:{kind:'readiness_probe',ref:payload.probeRef,binding,resourceId:payload.resourceId,configHash:payload.configHash,consumerScope:payload.consumerScope,capabilities:payload.capabilities},origin:'host',verdict:'pass',expiresAt:null}]:[];
      const proof=fixedObserver(receipts),publicationBefore=[allRows(),db.prepare('SELECT * FROM work_item_results ORDER BY rowid').all()];
      let published;
      try{published=core.publishResult(handle,{commandId:randomUUID(),producer:producer.ref,expectedRevision:1,outputKey:'api',expectedResultId:null,payload,source:manual(producer)},proof);}
      catch(error){
        if(!artifactOverride?.expectPublicationRefusal)throw error;
        assert.match(error.message,/result verification failed: stale_revision/);
        assert.deepEqual([allRows(),db.prepare('SELECT * FROM work_item_results ORDER BY rowid').all()],publicationBefore);
        return {publicationRefused:true,error:error.message};
      }
      core.completeWorkItem(handle,{ref:producer.ref,expectedRevision:1,source:manual(producer)},proof);
      const dependencyBinding=kind==='contract'?{kind,repoId:backendId,version:'v1'}:{kind,repoId:backendId,version:'v1',resourceId:payload.resourceId,configHash:payload.configHash,consumerScope:payload.consumerScope,capabilities:payload.capabilities};
      const consumer=core.createWorkItem(handle,{task:ref(consumerTask.id),definition:definition('analysis',repoId),dependencies:[{key:'api',producer:producer.ref,producerRevision:1,outputKey:'api',binding:dependencyBinding}]});
      const owner=core.reserveWorkItem(handle,{ref:consumer.ref,expectedRevision:1,expectedFence:0,expectedMode:'manual',ownerId:'fixture',write:false},proof);
      const observationsPath=join(home,randomUUID()+'.result-receipts.json');writeFileSync(observationsPath,JSON.stringify(receipts),{mode:0o600});
      return {producer,consumer,producerTask,consumerTask,owner,published,payload,path,body,observationsPath,input:{taskId:consumerTask.id,workItemId:consumer.ref.workItemId,ownership:owner.ref}};
    };
    const api=flow('contract'),apiContext=await success(api.input),copied=apiContext.snapshot.response.inputs.dependencies[0];
    assert.equal(copied.artifact.body,api.body);assert.equal(copied.artifact.sha256,sha(api.body));assert.equal(copied.resultId,api.published.id);
    assert.equal(JSON.stringify(apiContext.snapshot.response).includes(api.path),false);assert.equal(copied.binding.repoId,backendId);
    const readiness=flow('readiness'),readyContext=await success(readiness.input,readiness.observationsPath);
    assert.deepEqual(readyContext.snapshot.response.inputs.dependencies[0].payload,readiness.payload);
    const head=git(source,'rev-parse','HEAD'),codeTask=task('code producer');
    const code=core.createWorkItem(handle,{task:ref(codeTask.id),definition:definition('architecture',repoId,[output('code')]),dependencies:[]});
    const codeBinding={producer:code.ref,producerRevision:1,inputsHash:code.inputsHash,outputKey:'api',kind:'code',version:'v1',repoId};
    const codePayload={kind:'code',repoId,version:'v1',checkRefs:[],head,proofRef:'fixture:actual-base'};
    const codeReceipt={request:{kind:'code_result',ref:codePayload.proofRef,binding:codeBinding,head},origin:'host',verdict:'pass',expiresAt:null};
    const codeProof=fixedObserver([codeReceipt]);assert.equal(git(source,'--no-replace-objects','cat-file','-t',head),'commit');
    const codeResult=core.publishResult(handle,{commandId:randomUUID(),producer:code.ref,expectedRevision:1,outputKey:'api',expectedResultId:null,payload:codePayload,source:manual(code)},codeProof);
    core.completeWorkItem(handle,{ref:code.ref,expectedRevision:1,source:manual(code)},codeProof);
    git(source,'branch','context-accepted',head);
    const mergeTask=task('merge producer'),merge=core.createWorkItem(handle,{task:ref(mergeTask.id),definition:definition('integration',repoId,[output('merged')]),dependencies:[]});
    const mergedPayload={kind:'merged',repoId,version:'v1',checkRefs:[],head,target:'context-accepted',baseHead:head,acceptedResultId:codeResult.id,userRef:'fixture:user-acceptance',receiptRef:'fixture:merge-receipt'};
    const mergeBinding={producer:merge.ref,producerRevision:1,inputsHash:merge.inputsHash,outputKey:'api',kind:'merged',version:'v1',repoId};
    const commonReceipt={binding:mergeBinding,acceptedResultId:codeResult.id};
    const receipts=[codeReceipt,{request:{kind:'code_in_base',ref:codePayload.proofRef,binding:codeBinding,head,baseHead:head},origin:'host',verdict:'pass',expiresAt:null},
      {request:{kind:'merge_acceptance',ref:mergedPayload.userRef,...commonReceipt},origin:'user',verdict:'pass',expiresAt:null},
      {request:{kind:'merge_receipt',ref:mergedPayload.receiptRef,...commonReceipt,target:mergedPayload.target,baseHead:head,head},origin:'host',verdict:'pass',expiresAt:null}];
    assert.equal(git(source,'merge-base','--is-ancestor',head,head),'');assert.equal(git(source,'rev-parse','context-accepted'),head);
    const gitProof=fixedObserver(receipts),mergedResult=core.publishResult(handle,{commandId:randomUUID(),producer:merge.ref,expectedRevision:1,outputKey:'api',expectedResultId:null,payload:mergedPayload,source:manual(merge)},gitProof);
    core.completeWorkItem(handle,{ref:merge.ref,expectedRevision:1,source:manual(merge)},gitProof);
    const gitTask=task('git inputs'),gitConsumer=core.createWorkItem(handle,{task:ref(gitTask.id),definition:definition('analysis',repoId),dependencies:[
      {key:'code',producer:code.ref,producerRevision:1,outputKey:'api',binding:{kind:'code',repoId,version:'v1',baseHead:head}},
      {key:'merged',producer:merge.ref,producerRevision:1,outputKey:'api',binding:{kind:'merged',repoId,version:'v1',baseHead:head,target:mergedPayload.target}}]});
    const gitOwner=core.reserveWorkItem(handle,{ref:gitConsumer.ref,expectedRevision:1,expectedFence:0,expectedMode:'manual',ownerId:'fixture',write:false},gitProof);
    const gitReceiptPath=join(home,'git-input-receipts.json');writeFileSync(gitReceiptPath,JSON.stringify(receipts),{mode:0o600});
    const gitContext=await success({taskId:gitTask.id,workItemId:gitConsumer.ref.workItemId,ownership:gitOwner.ref},gitReceiptPath);
    assert.deepEqual(gitContext.snapshot.response.inputs.dependencies.map(d=>d.resultId),[codeResult.id,mergedResult.id]);
    assert.deepEqual(gitContext.snapshot.response.inputs.dependencies.map(d=>d.payload.head),[head,head]);
    record('C04',{contract:{resultId:api.published.id,sha256:sha(api.body),bodyBytes:Buffer.byteLength(api.body),crossRepo:true},readiness:{resultId:readiness.published.id,expiresAt:readiness.payload.expiresAt},codeResultId:codeResult.id,mergedResultId:mergedResult.id,backendCodeMerged:false});
    writeFileSync(api.path,'changed artifact');assert.throws(()=>core.readRunContext(apiContext.context));assert.equal(core.checkRunInputs(handle,apiContext.snapshotRef).status,'update_required');
    await failure({...api.input,expectedGeneration:1},/inputs|stale/);assert.equal(core.runInputSnapshot(handle,apiContext.snapshotRef).response.inputs.dependencies[0].artifact.body,api.body);
    const expiry=flow('readiness',2),expiryContext=await success(expiry.input,expiry.observationsPath);
    while(core.now()<expiry.payload.expiresAt)await new Promise(done=>setTimeout(done,100));
    assert.throws(()=>core.readRunContext(expiryContext.context));
    assert.ok(core.checkRunInputs(handle,expiryContext.snapshotRef).changes.some(c=>c.reason==='readiness_expired'));
    const expired=flow('readiness');db.prepare('UPDATE tasks SET body=? WHERE id=?').run('stale producer',expired.producerTask.id);
    await failure(expired.input,/stale|inputs/);
    record('C05',{artifactMutationRefused:true,producerInputInvalidationRefused:true,readinessExpiryRefused:true,oldBytesPreserved:true});
    const guard=flow('contract'),guardContext=await success(guard.input),binding={authorityId:guardContext.authorityId,workItemId:guard.consumer.ref.workItemId,
      runId:guardContext.snapshot.response.runId,generation:guardContext.generation};
    const report=core.submitRunReport(guardContext.context,'split');
    const proposal={parent:guard.consumer.task,expectedParentHash:core.taskContractHash(handle,guard.consumer.task),source:{kind:'run',sourceTask:guard.consumer.task,authority:binding,proposalEventId:report},children:[{key:'child',title:'child',criteria:['deliver']}]};
    core.recordLaunchIntent(handle,{owner:guard.owner.ref,intent:{launchId:'live',writerScopeId:'writers'}});
    publishMemory(draft('rule','changed guard',guard.consumerTask.id));const preGuard=allRows();
    for(const call of [()=>core.submitRunReport(guardContext.context,'late'),()=>core.requestRunQuestion(guardContext.context,'late'),()=>core.createSubtasks(handle,proposal),
      ()=>core.recordLaunchIntent(handle,{owner:guard.owner.ref,intent:{launchId:'late',writerScopeId:'late'}}),
      ()=>core.completeWorkItem(handle,{ref:guard.consumer.ref,expectedRevision:1,source:{kind:'owned',owner:guard.owner.ref,instructionRef:'late'}}),
      ()=>core.publishResult(handle,{commandId:'late',producer:guard.consumer.ref,expectedRevision:1,outputKey:'api',expectedResultId:null,payload:guard.payload,source:{kind:'owned',owner:guard.owner.ref,instructionRef:'late'}})])assert.throws(call,/authority|inputs|stale/);
    assert.deepEqual(allRows(),preGuard);core.revokeRunAuthority(handle,guardContext.authorityId);
    assert.throws(()=>core.recordLaunchIntent(handle,{owner:guard.owner.ref,intent:{launchId:'late',writerScopeId:'late'}}),/inputs/);
    const transfer=core.beginHandoff(handle,{commandId:'stop-context',task:guard.consumer.task,expectedMode:'manual',targetMode:'manual',expectedOwners:[guard.owner.ref]});
    assert.equal((await core.finishHandoff(handle,{handoffId:transfer.id})).status,'held');assert.equal(core.ownership(handle,guard.owner.ref).releasedAt,null);
    assert.equal((await core.finishHandoff(handle,{handoffId:transfer.id},async owner=>({observationId:'fixture-stop',owner:owner.ref,launchId:'live',writerScopeId:'writers',observedAt:core.now(),verdict:'stopped',complete:true,writers:[{id:'fixture-process',state:'gone'}]}))).status,'complete');
    record('C09',{continuationBoundariesRefused:6,omittedAuthorityRefused:true,revokedOwnerStillFenced:true,unknownStopHeld:true,completeStopAllowed:true});
    const independent=task('independent context'),indInput={taskId:independent.id,workItemId:'independent'},ind=await success(indInput);
    for(const fake of [{kind:'run'},{...ind.context},JSON.parse(JSON.stringify(ind.context))])assert.throws(()=>core.readRunContext(fake));
    assert.throws(()=>core.runInputSnapshot({...handle},ind.snapshotRef));assert.throws(()=>core.runInputSnapshot(handle,{...ind.snapshotRef,projectId:'f'.repeat(32)}));
    assert.throws(()=>db.prepare('UPDATE run_input_snapshots SET created_at=0').run(),/immutable/);assert.throws(()=>db.prepare('DELETE FROM run_input_snapshots').run(),/immutable/);
    const rotated=await issue({...baseInput,...indInput},1);assert.equal(rotated.ok,true);assert.throws(()=>core.readRunContext(ind.context));assert.deepEqual(core.runInputSnapshot(handle,ind.snapshotRef),ind.snapshot);
    const limited=await success({taskId:task('context only').id,workItemId:'context-only',operations:['get_context']});
    assert.deepEqual(core.runOperations(limited.context),['get_context']);assert.throws(()=>core.submitRunReport(limited.context,'not granted'));
    record('C10',{forgedContextsRefused:3,foreignProjectRefused:true,triggersImmutable:true,rotationGeneration:rotated.generation,getContextOnly:true});
    const budgetTask=task('byte budget'),body='😀"\\\n'.repeat(250),rule=draft('rule',body,budgetTask.id);publishMemory(rule);
    publishMemory(draft('fact','context '+'optional '.repeat(600),budgetTask.id));
    const byteInput={taskId:budgetTask.id,workItemId:'byte-budget',context:{query:'context'}},full=await success(byteInput);
    const mandatory=structuredClone(full.snapshot.response);mandatory.inputs.knowledge=[];mandatory.inputs.budget.omittedRecords=1;
    let cap=10000;for(let i=0;i<3;i++){mandatory.inputs.budget.maxBytes=cap;cap=Buffer.byteLength(JSON.stringify({content:[{type:'text',text:JSON.stringify(mandatory)}]}))+200;}
    const smaller=await issue({...baseInput,...byteInput,context:{query:'context',maxBytes:cap}},1);assert.equal(smaller.ok,true,smaller.error);
    const bounded=core.runInputSnapshot(handle,{projectId,authorityId:smaller.authorityId});assert.equal(bounded.response.inputs.knowledge.length,0);assert.equal(bounded.response.inputs.budget.omittedRecords,1);
    assert.ok(bounded.response.inputs.rules.some(r=>r.body===body));const wireBytes=Buffer.byteLength(JSON.stringify({content:[{type:'text',text:JSON.stringify(bounded.response)}]}));assert.ok(wireBytes<=cap);
    const secretTask=task('known secret');db.prepare('UPDATE tasks SET body=? WHERE id=?').run('sk-proj-'+'x'.repeat(40),secretTask.id);
    await failure({taskId:secretTask.id,workItemId:'secret'},/private/);
    const aliasOriginal=join(root,'alias-original');writeFileSync(aliasOriginal,'safe');
    const symlink=join(root,'artifact-symlink'),hardlink=join(root,'artifact-hardlink');symlinkSync(aliasOriginal,symlink);linkSync(aliasOriginal,hardlink);
    const unsafeArtifacts=[{path:symlink,body:'safe',existing:true},{path:hardlink,body:'safe',existing:true},
      {path:join(root,'invalid-utf8'),body:Buffer.from([255])},{path:join(root,'secret-artifact'),body:'sk-proj-'+'x'.repeat(40)},
      {path:join(root,'.npmrc'),body:'private config'},{path:join(home,'native-config.json'),body:'private config'},
      {path:join(backendControl,'bootstrap.json'),body:JSON.stringify({dbPath,token:'b'.repeat(64)})},
      {path:dbPath,body:readFileSync(dbPath),existing:true,expectPublicationRefusal:true}];
    let publicationRefusals=0;
    for(const artifact of unsafeArtifacts){const unsafe=flow('contract',3600,artifact);if(unsafe.publicationRefused){publicationRefusals++;continue;}await failure(unsafe.input,/artifact|inputs|verified|denied/);}
    const files=core.filesDir(dbPath);mkdirSync(files);const file=flow('contract',3600,{path:join(files,'api.txt'),body:'published API'});
    assert.equal((await success(file.input)).snapshot.response.inputs.dependencies[0].artifact.body,'published API');
    record('C11',{wireBytes,limit:cap,unicodeMandatoryComplete:true,optionalWholeOmission:true,secretRefusedWrites:0,unsafeArtifactsRefused:unsafeArtifacts.length,publicationRefusals,grantRefusals:unsafeArtifacts.length-publicationRefusals,protectedCheckoutBootstrapRefused:true,canonicalFilesDirAllowed:true,privatePathAbsent:!JSON.stringify(apiContext.snapshot.response).includes(api.path)});
    const inputCommit=git(source,'rev-parse','HEAD'),versionTask=task('version facts'),fact=draft('fact','context base',versionTask.id);
    fact.applicability={repoId,commit:inputCommit};const factEntry=publishMemory(fact),versionInput={taskId:versionTask.id,workItemId:'version-facts'},version=await success(versionInput);
    git(source,'-c','user.name=Fixture','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','output');const outputCommit=git(source,'rev-parse','HEAD');
    const freshFact=draft('fact','context output',versionTask.id);freshFact.applicability={repoId,commit:outputCommit};const freshEntry=publishMemory(freshFact);
    assert.equal(core.readRunMemory(version.context,{entryId:factEntry.entryId})[0].body,'context base');assert.throws(()=>core.readRunMemory(version.context,{entryId:freshEntry.entryId}));
    assert.equal(core.readRunContext(version.context).inputs.repositories.find(r=>r.repoId===repoId).commit,inputCommit);
    const nextVersion=await issue({...baseInput,...versionInput},1);assert.equal(nextVersion.ok,true);assert.equal(core.runInputSnapshot(handle,{projectId,authorityId:nextVersion.authorityId}).response.inputs.repositories.find(r=>r.repoId===repoId).commit,outputCommit);
    record('C12',{inputCommit,outputCommit,noImplicitFactSubstitution:true,newGenerationPinned:true});
    const counts=()=>['run_authorities','run_input_snapshots'].map(t=>db.prepare(`SELECT count(*) n FROM ${t} WHERE ${t==='run_authorities'?'work_item_id=?':'authority_id IN (SELECT authority_id FROM run_authorities WHERE work_item_id=?)'}`).get(baseInput.workItemId).n);
    let history=[];
    for(let round=0;round<20;round++){
      const receiptsBefore=db.prepare("SELECT count(*) n FROM events WHERE task_id=? AND action IN ('authority_issued','run_inputs_snapshot')").get(raceTask.id).n;
      const replies=children.map(child=>message(child));children.forEach(child=>child.send({kind:'issue',round,expectedGeneration:round}));
      const results=await Promise.all(replies);assert.equal(results.filter(r=>r.ok).length,1);assert.match(results.find(r=>!r.ok).error,/generation/);
      const current=db.prepare('SELECT * FROM run_input_snapshots WHERE authority_id IN (SELECT authority_id FROM run_authorities WHERE work_item_id=?) ORDER BY rowid').all(baseInput.workItemId);
      assert.deepEqual(current.slice(0,history.length),history);history=current;
      assert.deepEqual(counts(),[round+1,round+1]);assert.equal(db.prepare("SELECT count(*) n FROM events WHERE task_id=? AND action IN ('authority_issued','run_inputs_snapshot')").get(raceTask.id).n,receiptsBefore+2);
      assert.equal(db.prepare('SELECT count(*) n FROM run_authorities WHERE work_item_id=? AND revoked_at IS NULL').get(baseInput.workItemId).n,1);
      evidence.races.rounds++;evidence.races.singleWinners++;
    }
    const crashBefore=allRows(),pending=message(children[0]);children[0].send({kind:'crash',round:20,expectedGeneration:20});assert.equal((await pending).pending,true);
    children[0].kill('SIGKILL');const killed=await children[0].closed;assert.equal(killed.signal,'SIGKILL');assert.deepEqual(allRows(),crashBefore);
    const afterCrash=track(core.openDb(dbPath));assert.deepEqual(afterCrash.prepare('SELECT * FROM run_input_snapshots ORDER BY rowid').all(),db.prepare('SELECT * FROM run_input_snapshots ORDER BY rowid').all());
    evidence.races.crash=killed;record('C13',{...evidence.races,oneGrantSnapshotEventReceiptPerWinner:true,oldSnapshotsUnchanged:true,rollback:true});
    // Companion producers may still be running. An incomplete/mismatched result cannot pass.
    const waitJson=async path=>{const deadline=Date.now()+1200000;while(true){try{return JSON.parse(readFileSync(path,'utf8'));}catch(error){if(Date.now()>deadline)throw Error(`missing completed producer: ${path}`);await new Promise(done=>setTimeout(done,250));}}};
    const evidenceDir=resolve('.superpowers/sdd/2026-09-29-run-context');
    const dependency=await waitJson(flags.get('--dependencies')??join(evidenceDir,'dependencies.json')),memoryEvidence=await waitJson(flags.get('--memory')??join(evidenceDir,'memory.json'));
    assert.equal(dependency.runtimeHash,runtimeHash);assert.equal(memoryEvidence.runtimeHash,runtimeHash);assert.equal(dependency.checks.length,12);assert.equal(memoryEvidence.checks.length,14);
    assert.ok(dependency.checks.every(c=>c.outcome==='pass'));assert.ok(memoryEvidence.checks.every(c=>c.passed));
    record('C14',{dependencies:12,memory:14,legacyStore:dependency.checks.find(c=>c.id==='D12').storeRegression.checks.length,oldRowsPreserved:true});
    const natives=await Promise.all(['full','context'].map(name=>waitJson(flags.get('--native-'+name)??join(evidenceDir,'native-'+name+'.json'))));
    for(const native of natives){
      assert.equal(native.version,'codex-cli 0.157.0');assert.equal(native.final.applicable,true);assert.deepEqual(native.final.failures,[]);
      assert.equal(native.final.scriptHash,runtimeHash);assert.equal(native.final.guardHash,runtimeHash);assert.equal(native.final.executed,native.final.attempted);
      assert.ok(native.final.observations.every(o=>o.executed&&o.unchangedProtectedBytes&&!o.timedOut));
      for(const o of native.final.observations)assert.ok(o.protectedHashes.every(h=>h.before===h.after));
      assert.equal(native.contextChecks[1].nativeReads,2);assert.ok(native.initialResults.length>0);assert.ok(native.results.every(r=>r.executed&&r.unchangedProtectedBytes));
    }
    assert.deepEqual(natives.map(n=>n.final.operations),[['get_context','submit_report','request_question'],['get_context']]);
    record('C15',{matrices:natives.map(n=>({operations:n.final.operations,initial:n.initialResults.length,bound:n.results.length,final:n.final.executed,inputHashes:n.contextChecks.map(c=>c.inputHash),nativeContextReads:n.contextChecks[1].nativeReads})),failures:0});
    evidence.runtimeHashes=JSON.parse(readFileSync(join(evidenceDir,'runtime-hashes.json'),'utf8'));
    for(const [path,hash] of Object.entries(evidence.runtimeHashes))assert.equal(sha(readFileSync(path)),hash);
    evidence.checks.sort((a,b)=>a.id.localeCompare(b.id));assert.deepEqual(evidence.checks.map(c=>c.id),Array.from({length:15},(_,i)=>'C'+String(i+1).padStart(2,'0')));
    assert.deepEqual(db.pragma('foreign_key_check'),[]);
  }finally{
    for(const client of clients)await client.close();
    for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');evidence.commandExits={migrationBaseline:evidence.checks.find(c=>c.id==='C01')?.observations.oldBinaryExit??null,issuers:await Promise.all(children.map(c=>c.closed))};
    for(const db of handles.reverse())if(db.open)db.close();process.env=saved;rmSync(root,{recursive:true,force:true});
  }
  process.stdout.write(JSON.stringify(evidence,null,2)+'\n');
}
