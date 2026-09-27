import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import * as core from '../src/index.js';

let root: string;
let home: string;
let saved: NodeJS.ProcessEnv;
const handles: Database.Database[] = [];
const user = { type: 'user' } as const;
beforeEach(() => {
  saved = { ...process.env };
  root = mkdtempSync(join(tmpdir(), 'kdd-project-'));
  home = join(root, 'home');
  process.env.KDD_HOME = home;
  delete process.env.KDD_DB;
  delete process.env.KDD_DECISIONS_DIR;
});
afterEach(() => {
  for (const db of handles.splice(0)) if (db.open) db.close();
  process.env = saved;
  rmSync(root, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}
function repo(name: string) {
  const cwd = join(root, name);
  mkdirSync(cwd);
  git(cwd, 'init');
  git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '--allow-empty', '-m', 'seed');
  return cwd;
}
function open(cwd: string) {
  const { dbPath, projectPath } = core.resolveDbPath(cwd);
  const db = core.openDb(dbPath, projectPath, cwd);
  handles.push(db);
  return { db, dbPath };
}

function legacy(cwd: string, decisionsDir: string, override = false) {
  const dbPath = override ? join(root,'override.db') : core.resolveDbPath(cwd).dbPath;
  mkdirSync(join(dbPath,'..'),{recursive:true});
  mkdirSync(decisionsDir,{recursive:true});
  const path = join(decisionsDir,'original.md');
  const text = core.renderDecisionMd({title:'Original',decision:'primarytoken'},'2026-09-27');
  writeFileSync(path,text);
  const raw = new Database(dbPath);
  raw.pragma('journal_mode=WAL');
  for (const sql of core.MIGRATIONS.slice(0,12)) raw.exec(sql);
  raw.pragma('user_version=12');
  raw.prepare('INSERT INTO meta VALUES(?,?)').run('project_path',override ? cwd : core.canonicalCommonDir(cwd));
  raw.prepare('INSERT INTO decisions VALUES(?,?,?,?,?,NULL,?)')
    .run('original','Original',path,core.parseDecisionMd(text).hash,'2026-09-27','[]');
  raw.prepare('INSERT INTO search_index VALUES(?,?,?,?)').run('decision','original','Original','primarytoken');
  raw.close();
  return dbPath;
}

describe('project store review regressions', () => {
  it('does not assign an arbitrary fresh override cwd to a source binding', () => {
    const source=repo('source');
    const db=core.openDb(join(root,'override.db'),source,source);handles.push(db);
    expect(core.projectOf(db).primary_repo_id).toBeNull();
    expect(core.bindingsOf(db)).toEqual([]);
  });
  it.each(['external-decisions','source/custom-decisions'])('preserves configured legacy decisions through foreign first upgrade (%s)', directory => {
    const source = repo('source');
    const external = join(root,directory);
    const dbPath = legacy(source,external);
    const backend = repo('backend');
    process.env.KDD_DECISIONS_DIR=join(backend,'.planning','decisions');
    const db = core.openDb(dbPath,core.canonicalCommonDir(source),backend);handles.push(db);
    expect(core.projectOf(db).legacy_decisions_dir).toBe(realpathSync(external));
    expect(core.canSyncLegacyDecisions(db,process.env.KDD_DECISIONS_DIR)).toBe(false);
    const before = db.prepare('SELECT * FROM decisions').all();
    const fts = db.prepare("SELECT * FROM search_index WHERE kind='decision'").all();
    core.syncIndex(db,join(source,'.planning','decisions'));
    expect(db.prepare('SELECT * FROM decisions').all()).toEqual(before);
    expect(db.prepare("SELECT * FROM search_index WHERE kind='decision'").all()).toEqual(fts);
    expect(core.addDecision(db,external,{title:'Next',decision:'next'}).created).toBe(true);
    process.env.KDD_DECISIONS_DIR=external;
    const reopened=core.openDb(dbPath,core.canonicalCommonDir(source),source);handles.push(reopened);
    expect(core.projectOf(reopened).legacy_decisions_dir).toBe(realpathSync(external));
  });

  it('captures the configured external directory for an empty legacy source only from its source caller', () => {
    const source = repo('source');const external = join(root,'external');
    const dbPath = legacy(source,external);
    const raw = new Database(dbPath);raw.exec('DELETE FROM decisions; DELETE FROM search_index');raw.close();
    process.env.KDD_DECISIONS_DIR=external;
    const db = core.openDb(dbPath,core.canonicalCommonDir(source),source);handles.push(db);
    expect(core.projectOf(db).legacy_decisions_dir).toBe(realpathSync(external));
    expect(core.addDecision(db,external,{title:'Next',decision:'next'}).created).toBe(true);
  });

  it('does not infer external authority from a legacy default directory symlink', () => {
    const source=repo('source');const dir=join(source,'.planning','decisions');
    const dbPath=legacy(source,dir);
    const backend=repo('backend');const foreign=join(backend,'decisions');mkdirSync(foreign);
    writeFileSync(join(foreign,'original.md'),'# Conflict\n\nforeign');
    rmSync(dir,{recursive:true});symlinkSync(foreign,dir);
    const db=core.openDb(dbPath,core.canonicalCommonDir(source),backend);handles.push(db);
    expect(core.canSyncLegacyDecisions(db,dir)).toBe(false);
    expect(core.canSyncLegacyDecisions(db,foreign)).toBe(false);
    expect(core.recall(db,dir,'primarytoken',{kind:'decision'})).toHaveLength(1);
  });

  it('bootstraps legacy override checkout metadata and recovers its locator', () => {
    const source = repo('source');const dir=join(source,'.planning','decisions');
    const dbPath = legacy(source,dir,true);
    process.env.KDD_DB=dbPath;
    const db=core.openDb(dbPath,core.resolveDbPath(source).projectPath,source);handles.push(db);
    expect(core.bindingsOf(db)[0].common_dir).toBe(core.canonicalCommonDir(source));
    expect(core.projectOf(db).primary_repo_id).toBe(core.bindingsOf(db)[0].repo_id);
    expect(core.addDecision(db,dir,{title:'Next',decision:'next'}).created).toBe(true);
    delete process.env.KDD_DB;rmSync(join(home,'registry.db'));
    expect(core.resolveDbPath(source).dbPath).toBe(dbPath);
  });

  it('rejects a nested repository occupying the default decisions directory', () => {
    const source=repo('source');const {db,dbPath}=open(source);
    const dir=join(source,'.planning','decisions');
    const d=core.addDecision(db,dir,{title:'Original',decision:'primarytoken'});
    const before=db.prepare('SELECT * FROM decisions').all();
    const fts=db.prepare("SELECT * FROM search_index WHERE kind='decision'").all();
    git(dir,'init');
    core.addRepository(db,dbPath,home,{cwd:dir,purpose:'backend',access:'context_only'},user);
    writeFileSync(d.path,'# Conflict\n\nforeign');
    expect(core.canSyncLegacyDecisions(db,dir)).toBe(false);
    core.syncIndex(db,dir);
    expect(db.prepare('SELECT * FROM decisions').all()).toEqual(before);
    expect(db.prepare("SELECT * FROM search_index WHERE kind='decision'").all()).toEqual(fts);
    expect(() => core.rebuild(db,dir)).toThrow(/source/);
    expect(() => core.addDecision(db,dir,{title:'foreign',decision:'foreign'})).toThrow(/source/);
  });

  it('uses the migration list as the supported schema authority', () => {
    core.MIGRATIONS.push('SELECT 1;');
    try {
      const source=repo('source');const {db,dbPath}=open(source);
      expect(db.pragma('user_version',{simple:true})).toBe(core.MIGRATIONS.length);
      expect(core.resolveDbPath(source).dbPath).toBe(dbPath);
    } finally { core.MIGRATIONS.pop(); }
  });
});

describe('project store migration', () => {
  it('preserves populated v12 rows and uncheckpointed WAL with a stable identity', () => {
    const path = join(root, 'legacy.db');
    const raw = new Database(path);
    handles.push(raw);
    raw.pragma('journal_mode = WAL');
    raw.pragma('wal_autocheckpoint = 0');
    for (const sql of core.MIGRATIONS.slice(0, 12)) raw.exec(sql);
    raw.pragma('user_version = 12');
    raw.exec(`
      INSERT INTO tracks VALUES (8,'track','desc','active',1);
      INSERT INTO tasks(id,title,status,created_at,updated_at,track_id) VALUES (41,'keep','done',1,2,8),(42,'other','review',1,2,8);
      INSERT INTO criteria(id,task_id,text,checked_at,created_at,evidence,checked_by) VALUES(9,41,'verified',2,1,'proof','ai:test');
      INSERT INTO comments VALUES(7,41,'ai:test','comment',1);
      INSERT INTO events(id,task_id,actor_type,actor_id,action,detail,created_at) VALUES(6,41,'ai','test','created','{"manual_provenance":{"branch":"old"}}',1);
      INSERT INTO task_links VALUES(42,41,'depends_on');
      INSERT INTO files VALUES(3,41,'hash','.txt','evidence.txt','text/plain',4,'proof',1);
      INSERT INTO decisions VALUES('old','Old','/old.md','hash','2026-01-01',NULL,'[41]');
      INSERT INTO search_index VALUES('decision','old','Old','original');
      INSERT INTO agent_events VALUES(4,41,'old-worker','text',NULL,'old stream',1);
      INSERT INTO errors VALUES(2,'old','retained',1);
    `);
    const tables = ['tasks','criteria','comments','events','tracks','task_links','files','decisions','search_index','agent_events','errors','meta'];
    const snapshot = (db: Database.Database) => tables.map(t => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
    const before = snapshot(raw);
    const assets = ['files/evidence.txt','knowledge/old.md','workspaces/dirty.txt'];
    for (const name of assets) {
      const file = join(root, name);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, 'keep');
    }
    const db = core.openDb(path);
    handles.push(db);
    expect(snapshot(db)).toEqual(before);
    expect(db.prepare('PRAGMA table_info(project)').all().map((r: any) => r.name)).toContain('project_id');
    const project = core.projectOf(db);
    expect(project.project_id).toMatch(/^[0-9a-f]{32}$/);
    expect(project.autonomy_enabled).toBe(false);
    expect(project.default_execution_mode).toBe('manual');
    const backup = new Database(`${path}.v12.bak`, { readonly: true });
    handles.push(backup);
    expect(backup.pragma('user_version', { simple: true })).toBe(12);
    expect(snapshot(backup)).toEqual(before);
    db.close();
    const reopened = core.openDb(path);
    handles.push(reopened);
    expect(core.projectOf(reopened).project_id).toBe(project.project_id);
    for (const name of assets) expect(readFileSync(join(root, name), 'utf8')).toBe('keep');
    expect(core.addTask(reopened, { title: 'next' }, user).id).toBe(43);
  });
});

describe('project store lookup', () => {
  it('bootstraps the original source once and resolves symlinks and linked worktrees', () => {
    const source = repo('source');
    const { db, dbPath } = open(source);
    expect(core.bindingsOf(db)).toHaveLength(1);
    expect(core.projectOf(db).primary_repo_id).toBe(core.bindingsOf(db)[0].repo_id);
    const alias = join(root, 'alias');
    symlinkSync(source, alias);
    expect(core.resolveDbPath(alias).dbPath).toBe(dbPath);
    const wt = join(root, 'linked');
    git(source, 'worktree', 'add', '-b', 'linked', wt);
    expect(core.resolveDbPath(wt).dbPath).toBe(dbPath);
    expect(core.listProjectCheckouts(home)).toContain(realpathSync(wt));
    rmSync(join(home, 'registry.db'));
    expect(core.resolveDbPath(alias).dbPath).toBe(dbPath);
    const reopened = core.openDb(dbPath, core.canonicalCommonDir(wt));
    handles.push(reopened);
    expect(core.bindingsOf(reopened)).toHaveLength(1);
  });

  it('resolves separate-git-dir and refuses corrupt or unknown registry schemas', () => {
    const source = join(root, 'separate');
    mkdirSync(source);
    git(source, 'init', '--separate-git-dir', join(root, 'git-data'));
    const { db, dbPath } = open(source);
    expect(core.bindingsOf(db)[0].checkout_path).toBe(realpathSync(source));
    expect(core.resolveDbPath(source).dbPath).toBe(dbPath);
    const registry = new Database(join(home, 'registry.db'));
    registry.pragma('user_version = 99');
    registry.close();
    expect(() => core.resolveDbPath(source)).toThrow(/registry.*version/);
    rmSync(join(home, 'registry.db'));
    writeFileSync(join(home, 'registry.db'), 'broken');
    expect(() => core.resolveDbPath(source)).toThrow();
    process.env.KDD_DB = '/explicit/override.db';
    expect(core.resolveDbPath(source).dbPath).toBe('/explicit/override.db');
  });
});

describe('explicit repository bindings', () => {
  it('recovers bindings of an explicit store outside KDD_HOME after registry loss', () => {
    const source=repo('source');
    const dbPath=join(root,'external','board.db');
    const db=core.openDb(dbPath,core.canonicalCommonDir(source),source);
    handles.push(db);
    const alias=repo('alias');
    core.bindRepository(db,dbPath,home,{cwd:alias,repoId:core.projectOf(db).primary_repo_id!,kind:'managed'},user);
    rmSync(join(home,'registry.db'));
    expect(core.resolveDbPath(alias).dbPath).toBe(dbPath);
  });
  it('allows exactly one owner when two processes bind the same checkout', async () => {
    const a = open(repo('one'));
    const b = open(repo('two'));
    const alias = repo('shared-alias');
    const moduleUrl = new URL('../dist/index.js',import.meta.url).href;
    const script = `import {openDb,bindRepository} from ${JSON.stringify(moduleUrl)};
      const [path,home,cwd,repoId]=process.argv.slice(1);const db=openDb(path);
      try{bindRepository(db,path,home,{cwd,repoId,kind:'managed'},{type:'ai',id:'race'});}
      catch(e){console.error(e.message);process.exitCode=1;}finally{db.close();}`;
    const run = (owner: typeof a) => new Promise<number>(resolve => {
      const child = spawn(process.execPath,['--input-type=module','-e',script,owner.dbPath,home,alias,core.projectOf(owner.db).primary_repo_id!],{stdio:'pipe'});
      child.on('close',code=>resolve(code!));
    });
    expect((await Promise.all([run(a),run(b)])).sort()).toEqual([0,1]);
    const resolved = core.resolveDbPath(alias).dbPath;
    expect([a.dbPath,b.dbPath]).toContain(resolved);
  });

  it('shares an independent clone and worktree, preserves source refs, and recovers a missing locator', () => {
    const source = repo('source');
    const { db, dbPath } = open(source);
    const clone = join(root, 'clone');
    git(root, 'clone','--no-hardlinks',source,clone);
    const wt = join(root,'clone-worktree');
    git(clone,'worktree','add','-b','worker',wt);
    expect(core.resolveDbPath(clone).dbPath).not.toBe(dbPath);
    const before = git(source,'show-ref');
    const repoId = core.projectOf(db).primary_repo_id!;
    expect(() => core.bindRepository(db,dbPath,home,{cwd:clone,repoId,kind:'source'},user)).toThrow(/source.*rebind/);
    core.bindRepository(db,dbPath,home,{ cwd: clone,repoId,kind:'managed' },user);
    expect(core.resolveDbPath(wt).dbPath).toBe(dbPath);
    const task = core.addTask(db,{title:'shared'},user);
    const cloneDb = open(wt).db;
    core.setProjectToplevel(db,source);
    core.setProjectToplevel(cloneDb,wt);
    expect(core.projectToplevelOf(db)).toBe(source);
    core.commentTask(cloneDb,task.id,'clone change',user);
    expect(core.taskDetail(db,task.id).comments[0].body).toBe('clone change');
    const eventsBefore = db.prepare('SELECT COUNT(*) n FROM events').get();
    core.bindRepository(db,dbPath,home,{ cwd: clone,repoId,kind:'managed' },user);
    expect(db.prepare('SELECT COUNT(*) n FROM events').get()).toEqual(eventsBefore);
    expect(git(source,'show-ref')).toBe(before);
    const reg = new Database(join(home,'registry.db'));
    reg.prepare('DELETE FROM bindings WHERE common_dir=?').run(core.canonicalCommonDir(clone));
    reg.close();
    const other = open(repo('other'));
    expect(() => core.bindRepository(other.db,other.dbPath,home,
      {cwd:clone,repoId:core.projectOf(other.db).primary_repo_id!,kind:'managed'},user)).toThrow(/conflict/);
    expect(core.resolveDbPath(clone).dbPath).toBe(dbPath);
    const backend = repo('backend');
    const added = core.addRepository(db,dbPath,home,{cwd:backend,purpose:'backend',access:'context_only'},user);
    expect(added.repository.repo_id).not.toBe(repoId);
    expect(core.resolveDbPath(backend).dbPath).toBe(dbPath);
    expect(core.projectOf(db).primary_repo_id).toBe(repoId);
  });

  it('rejects existing independent boards and rebinds a moved source without changing identity', () => {
    const source = repo('source');
    const { db,dbPath } = open(source);
    const projectId = core.projectOf(db).project_id;
    const oldCommon = core.canonicalCommonDir(source);
    const other = repo('other');
    open(other);
    expect(() => core.addRepository(db,dbPath,home,{cwd:other,purpose:'backend',access:'implementation'},user)).toThrow(/conflict/);
    expect(() => core.bindRepository(db,dbPath,home,{cwd:other,repoId:'bad',kind:'managed'},user)).toThrow();
    const moved = join(root,'moved');
    renameSync(source,moved);
    core.rebindRepository(db,dbPath,home,{fromCommonDir:oldCommon,cwd:moved},user);
    expect(core.resolveDbPath(moved).dbPath).toBe(dbPath);
    expect(core.projectOf(db).project_id).toBe(projectId);
    expect(core.projectPathOf(db)).toBe(core.canonicalCommonDir(moved));
    const count = db.prepare('SELECT COUNT(*) n FROM events').get();
    core.rebindRepository(db,dbPath,home,{fromCommonDir:oldCommon,cwd:moved},user);
    expect(db.prepare('SELECT COUNT(*) n FROM events').get()).toEqual(count);
  });

  it.each(['hashed','external'])('restores an unavailable legacy source after registry loss (%s)', location => {
    const source = repo('old-source');
    const resolved = core.resolveDbPath(source);
    const dbPath = location === 'external' ? join(root,'external','board.db') : resolved.dbPath;
    mkdirSync(join(dbPath,'..'),{recursive:true});
    const raw = new Database(dbPath);
    raw.pragma('journal_mode=WAL');
    for(const sql of core.MIGRATIONS.slice(0,12)) raw.exec(sql);
    raw.pragma('user_version=12');
    raw.prepare("INSERT INTO meta VALUES('project_path',?)").run(resolved.projectPath);
    raw.prepare("INSERT INTO tasks(id,title,created_at,updated_at) VALUES(17,'Retained legacy task',1,1)").run();
    raw.close();
    const moved = join(root,'new-source');
    renameSync(source,moved);
    const db = core.openDb(dbPath);
    handles.push(db);
    const projectId = core.projectOf(db).project_id;
    expect(core.projectOf(db).primary_repo_id).toBeNull();
    expect(() => core.addRepository(db,dbPath,home,{cwd:repo('backend'),purpose:'backend',access:'context_only'},user)).toThrow(/source/);
    core.rebindRepository(db,dbPath,home,{fromCommonDir:resolved.projectPath,cwd:moved},user);
    expect(core.resolveDbPath(moved).dbPath).toBe(dbPath);
    rmSync(join(home,'registry.db'));
    const recovered = open(moved);
    expect(recovered.dbPath).toBe(dbPath);
    expect(core.projectOf(recovered.db).project_id).toBe(projectId);
    expect(recovered.db.prepare('SELECT title FROM tasks WHERE id=17').get()).toEqual({title:'Retained legacy task'});
  });
});

describe('shared legacy decisions', () => {
  it('does not replace a source decision through an individual foreign file symlink', () => {
    const source=repo('source');const {db,dbPath}=open(source);
    const dir=join(source,'.planning','decisions');
    const d=core.addDecision(db,dir,{title:'Original',decision:'primarytoken'});
    const backend=repo('backend');
    core.addRepository(db,dbPath,home,{cwd:backend,purpose:'backend',access:'context_only'},user);
    const file=join(backend,'foreign.md');writeFileSync(file,'# Conflict\n\nforeign');
    rmSync(d.path);symlinkSync(file,d.path);
    expect(core.recall(db,dir,'primarytoken',{kind:'decision'})).toHaveLength(1);
    expect(() => core.rebuild(db,dir)).toThrow(/source/);
    expect(db.prepare('SELECT title FROM decisions WHERE slug=?').get(d.slug)).toEqual({title:'Original'});
    expect(core.decisionDetail(db,dir,d.slug).body).toContain('primarytoken');
    expect(() => core.addDecision(db,dir,{title:'New',decision:'new'})).toThrow(/source/);
  });
  it('retains indexed decisions when the primary source disappears', () => {
    const source=repo('source');
    const {db}=open(source);
    const dir=join(source,'.planning','decisions');
    core.addDecision(db,dir,{title:'retain',decision:'primarytoken'});
    renameSync(source,join(root,'moved-source'));
    expect(core.canSyncLegacyDecisions(db,dir)).toBe(false);
    expect(core.recall(db,dir,'primarytoken',{kind:'decision'})).toHaveLength(1);
  });
  it('preserves complete decision projections for empty or conflicting backend recall while updating task FTS', () => {
    const source=repo('source');
    const {db,dbPath}=open(source);
    const sourceDir=join(source,'.planning','decisions');
    const task=core.addTask(db,{title:'task'},user);
    const decision=core.addDecision(db,sourceDir,{title:'Original',decision:'primarytoken',sourceTasks:[task.id]});
    core.syncIndex(db,sourceDir);
    const before=db.prepare('SELECT * FROM decisions ORDER BY slug').all();
    const fts=db.prepare("SELECT * FROM search_index WHERE kind='decision' ORDER BY ref").all();
    const backend=repo('backend');
    core.addRepository(db,dbPath,home,{cwd:backend,purpose:'backend',access:'context_only'},user);
    const foreign=join(backend,'.planning','decisions');
    const assertRecall=() => {
      expect(core.recall(db,foreign,'primarytoken',{kind:'decision'})).toHaveLength(1);
      expect(db.prepare('SELECT * FROM decisions ORDER BY slug').all()).toEqual(before);
      expect(db.prepare("SELECT * FROM search_index WHERE kind='decision' ORDER BY ref").all()).toEqual(fts);
    };
    assertRecall();
    mkdirSync(foreign,{recursive:true});
    writeFileSync(join(foreign,`${decision.slug}.md`),'---\nsource_tasks: [999]\n---\n# Conflict\n\nforeigntoken');
    assertRecall();
    core.syncIndex(db,foreign);
    core.commentTask(db,task.id,'backendtasktoken',user);
    expect(core.recall(db,foreign,'backendtasktoken',{kind:'task'})[0].ref).toBe(String(task.id));
    expect(() => core.rebuild(db,foreign)).toThrow(/source/);
    expect(() => core.addDecision(db,foreign,{title:'foreign',decision:'foreign'})).toThrow(/source/);
    expect(core.taskBrief(db,foreign,task.id).decisions.items[0].title).toBe('Original');
    expect(db.prepare('SELECT * FROM decisions ORDER BY slug').all()).toEqual(before);
    process.env.KDD_DB=dbPath;
    process.env.KDD_DECISIONS_DIR=foreign;
    expect(core.canSyncLegacyDecisions(db,foreign)).toBe(false);
    writeFileSync(decision.path,readFileSync(decision.path,'utf8').replace('primarytoken','updatedtoken'));
    expect(core.recall(db,sourceDir,'updatedtoken',{kind:'decision'})).toHaveLength(1);
  });

  it('does not let a symlink into backend or a managed primary clone replace source decisions', () => {
    const initialSource=repo('initial-source');
    const initialBackend=repo('initial-backend');
    const initialForeign=join(initialBackend,'decisions');mkdirSync(initialForeign);
    mkdirSync(join(initialSource,'.planning'));
    const initialDir=join(initialSource,'.planning','decisions');symlinkSync(initialForeign,initialDir);
    expect(core.canSyncLegacyDecisions(open(initialSource).db,initialDir)).toBe(false);
    const source=repo('source');
    const {db,dbPath}=open(source);
    const sourceDir=join(source,'.planning','decisions');
    const d=core.addDecision(db,sourceDir,{title:'source',decision:'primarytoken'});
    const backend=repo('backend');
    core.addRepository(db,dbPath,home,{cwd:backend,purpose:'backend',access:'context_only'},user);
    const foreign=join(backend,'decisions');
    mkdirSync(foreign);
    writeFileSync(join(foreign,`${d.slug}.md`),'# Evil\n\nforeign');
    rmSync(sourceDir,{recursive:true});
    symlinkSync(foreign,sourceDir);
    expect(core.canSyncLegacyDecisions(db,sourceDir)).toBe(false);
    expect(core.recall(db,sourceDir,'primarytoken')).toHaveLength(1);
    const clone=join(root,'clone');
    git(root,'clone','--no-hardlinks',source,clone);
    core.bindRepository(db,dbPath,home,{cwd:clone,repoId:core.projectOf(db).primary_repo_id!,kind:'managed'},user);
    expect(core.canSyncLegacyDecisions(db,join(clone,'.planning','decisions'))).toBe(false);
  });
});
