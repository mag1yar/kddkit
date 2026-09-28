import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../../../packages/core/dist/index.js';

const Database = createRequire(new URL('../../../packages/core/package.json',import.meta.url))('better-sqlite3');
const cli = fileURLToPath(new URL('../../../packages/cli/dist/index.js',import.meta.url));
const root = mkdtempSync(join(tmpdir(),'kdd-store-observation-'));
const saved = {...process.env};
const home = join(root,'home');
const handles = [];
const checks = [];
const user = {type:'user'};
const git = (cwd,...args) => execFileSync('git',args,{cwd,encoding:'utf8',stdio:'pipe'}).trim();
const run = (cwd,...args) => JSON.parse(execFileSync(process.execPath,[cli,...args],{
  cwd,env:{...process.env,NO_UPDATE_NOTIFIER:'1'},encoding:'utf8',stdio:'pipe',
}));
function repo(name) {
  const cwd=join(root,name);mkdirSync(cwd);git(cwd,'init');
  git(cwd,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','seed');
  return cwd;
}
function check(name,fn) { fn();checks.push(name); }
function track(db) { handles.push(db);return db; }
const tables=['tasks','criteria','comments','events','tracks','task_links','files','decisions','search_index','agent_events','errors','meta'];
const snapshot = db => tables.map(t=>db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map(row => {
  if (t !== 'tasks') return row;
  const { parent_id, execution_mode, ...historical } = row;
  return historical; // v15 defaults are asserted separately in dependencies-check.mjs.
}));
const decisionSnapshot = db => [db.prepare('SELECT * FROM decisions ORDER BY slug').all(),
  db.prepare("SELECT * FROM search_index WHERE kind='decision' ORDER BY ref").all()];
try {
  process.env.KDD_HOME=home;delete process.env.KDD_DB;delete process.env.KDD_DECISIONS_DIR;
  const source=repo('source');
  const resolved=core.resolveDbPath(source);
  mkdirSync(dirname(resolved.dbPath),{recursive:true});
  const raw=track(new Database(resolved.dbPath));
  raw.pragma('journal_mode=WAL');raw.pragma('wal_autocheckpoint=0');
  for(const sql of core.MIGRATIONS.slice(0,12)) raw.exec(sql);
  raw.pragma('user_version=12');
  raw.prepare("INSERT INTO meta VALUES('project_path',?)").run(resolved.projectPath);
  raw.exec(`INSERT INTO tracks VALUES(8,'track','retained','active',1);
    INSERT INTO tasks(id,title,status,created_at,updated_at,track_id) VALUES(41,'shared task','new',1,1,8),(42,'other','done',1,1,8);
    INSERT INTO criteria(id,task_id,text,checked_at,created_at,evidence,checked_by) VALUES(9,41,'proof',2,1,'retained','ai:test');
    INSERT INTO comments VALUES(7,41,'ai:test','retained comment',1);
    INSERT INTO events(id,task_id,actor_type,action,detail,created_at) VALUES(6,41,'user','created','{"manual_provenance":{"branch":"old"}}',1);
    INSERT INTO task_links VALUES(42,41,'depends_on');
    INSERT INTO agent_events VALUES(4,41,'old-worker','text',NULL,'retained',1);
    INSERT INTO errors VALUES(2,'old','retained',1);`);
  const dir=join(source,'.planning','decisions');mkdirSync(dir,{recursive:true});
  const slug='retained-decision';const path=join(dir,`${slug}.md`);
  const text=core.renderDecisionMd({title:'Original',decision:'primarytoken',sourceTasks:[41]},'2026-01-01');
  writeFileSync(path,text);const parsed=core.parseDecisionMd(text);
  raw.prepare('INSERT INTO decisions VALUES(?,?,?,?,?,NULL,?)').run(slug,'Original',path,parsed.hash,'2026-01-01','[41]');
  raw.prepare('INSERT INTO search_index VALUES(?,?,?,?)').run('decision',slug,'Original',parsed.indexBody);
  const artifact=join(root,'evidence.txt');writeFileSync(artifact,'retained evidence');
  // Seed the historical v12 fixture directly: current task writers require the current schema.
  const sha=createHash('sha256').update(readFileSync(artifact)).digest('hex');
  mkdirSync(core.filesDir(resolved.dbPath),{recursive:true});
  writeFileSync(join(core.filesDir(resolved.dbPath),`${sha}.txt`),readFileSync(artifact));
  const fileInsert=raw.prepare("INSERT INTO files(task_id,sha256,ext,original_name,mime_type,size_bytes,created_at) VALUES(41,?,'txt','evidence.txt','text/plain',17,1)").run(sha);
  const attached=raw.prepare('SELECT * FROM files WHERE id=?').get(fileInsert.lastInsertRowid);
  core.appendEvent(raw,41,user,'file_attached',{id:attached.id,name:'evidence.txt'});
  const attachedPath=core.filePath(resolved.dbPath,attached);
  const workspace=join(home,'retained-workspace','dirty.txt');mkdirSync(dirname(workspace),{recursive:true});writeFileSync(workspace,'dirty retained');
  const before=snapshot(raw);
  const sourceState=()=>[git(source,'status','--porcelain=v1','--untracked-files=all'),git(source,'show-ref'),readFileSync(join(source,'.git','config'),'utf8')];
  const originalSource=sourceState();
  const db=track(core.openDb(resolved.dbPath,resolved.projectPath,source));
  check('v12 migration preserves 12 tables, WAL backup and files',()=> {
    assert.deepEqual(snapshot(db),before);
    const backup=track(new Database(`${resolved.dbPath}.v12.bak`,{readonly:true}));
    assert.equal(backup.pragma('user_version',{simple:true}),12);assert.deepEqual(snapshot(backup),before);
    assert.equal(readFileSync(attachedPath,'utf8'),'retained evidence');assert.equal(readFileSync(workspace,'utf8'),'dirty retained');
  });
  const project=core.projectOf(db);
  check('identity survives reopen with manual defaults',()=> {
    assert.match(project.project_id,/^[0-9a-f]{32}$/);assert.equal(project.autonomy_enabled,false);assert.equal(project.default_execution_mode,'manual');
    const reopened=track(core.openDb(resolved.dbPath));assert.equal(core.projectOf(reopened).project_id,project.project_id);
  });
  const clone=join(root,'clone');git(root,'clone','--no-hardlinks',source,clone);
  run(source,'project','bind',clone,'--repo',project.primary_repo_id,'--kind','managed','--json');
  const wt=join(root,'worktree');git(clone,'worktree','add','-b','worker',wt);
  check('built CLI shares clone/worktree identity and task writes',()=> {
    assert.equal(run(wt,'project','show','--json').project.project_id,project.project_id);
    run(wt,'comment','41','worktree mutation','--json');assert.equal(run(source,'show','41','--json').comments.at(-1).body,'worktree mutation');
    assert.equal(existsSync(join(clone,'.git','objects','info','alternates')),false);
  });
  const backend=repo('backend');run(source,'project','add-repo',backend,'--purpose','backend','--access','context_only','--json');
  const decisions=decisionSnapshot(db);
  check('backend recall with missing decisions preserves both projections',()=> {
    assert.equal(run(backend,'recall','primarytoken','--kind','decision','--json').length,1);
    assert.deepEqual(decisionSnapshot(db),decisions);
  });
  const foreign=join(backend,'.planning','decisions');mkdirSync(foreign,{recursive:true});
  writeFileSync(join(foreign,`${slug}.md`),'---\nsource_tasks: [999]\n---\n# Conflict\n\nforeign');
  check('backend recall with conflicting slug preserves both projections',()=> {
    assert.equal(run(backend,'recall','primarytoken','--kind','decision','--json').length,1);
    assert.deepEqual(decisionSnapshot(db),decisions);
    assert.throws(()=>core.rebuild(db,foreign),/source/);
  });
  check('missing registry restores all bound checkouts without a new board',()=> {
    rmSync(join(home,'registry.db'));
    for(const cwd of [source,wt,backend]) assert.equal(core.resolveDbPath(cwd).dbPath,resolved.dbPath);
  });
  check('source Git state and retained artifacts are unchanged',()=> {
    assert.deepEqual(sourceState(),originalSource);
    assert.equal(readFileSync(attachedPath,'utf8'),'retained evidence');assert.equal(readFileSync(workspace,'utf8'),'dirty retained');
  });
  const raceSource=repo('race-source');const race=core.resolveDbPath(raceSource);
  mkdirSync(dirname(race.dbPath),{recursive:true});const seed=track(new Database(race.dbPath));
  seed.pragma('journal_mode=WAL');
  for(const sql of core.MIGRATIONS.slice(0,12)) seed.exec(sql);seed.pragma('user_version=12');
  seed.prepare("INSERT INTO meta VALUES('project_path',?)").run(race.projectPath);seed.close();
  const moduleUrl=new URL('../../../packages/core/dist/index.js',import.meta.url).href;
  const code=`import{openDb,projectOf}from ${JSON.stringify(moduleUrl)};const db=openDb(process.argv[1]);console.log(projectOf(db).project_id);db.close();`;
  const child=()=>new Promise((resolve,reject)=> {
    const p=spawn(process.execPath,['--input-type=module','-e',code,race.dbPath],{stdio:'pipe'});let out='',err='';
    p.stdout.on('data',chunk=>out+=chunk);p.stderr.on('data',chunk=>err+=chunk);p.on('error',reject);
    p.on('close',status=>status===0?resolve(out.trim()):reject(new Error(err)));
  });
  const ids=await Promise.all([child(),child()]);
  check('two concurrent upgrades produce one identity',()=>assert.equal(ids[0],ids[1]));
  process.stdout.write(JSON.stringify({ schema: db.pragma('user_version', { simple: true }),
    projectId: project.project_id, checks, retainedEvidence: true, decisionsPreserved: true }, null, 2) + '\n');
} finally {
  for(const db of handles.reverse()) if(db.open) db.close();
  process.env=saved;rmSync(root,{recursive:true,force:true});
}
