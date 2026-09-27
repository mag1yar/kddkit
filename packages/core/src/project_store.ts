import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { KddError } from './errors.js';
import type { Actor } from './state.js';
import { MIGRATIONS } from './schema.js';

export type RepositoryAccess = 'context_only' | 'implementation';
export type BindingKind = 'source' | 'managed';
export interface ProjectRecord {
  project_id: string;
  primary_repo_id: string | null;
  legacy_decisions_dir: string | null;
  autonomy_enabled: boolean;
  default_execution_mode: 'manual' | 'orchestrated';
  created_at: number;
}
export interface RepositoryRecord {
  repo_id: string; purpose: string; access: RepositoryAccess;
  remote: string | null; created_at: number;
}
export interface RepositoryBinding {
  common_dir: string; repo_id: string; checkout_path: string;
  kind: BindingKind; created_at: number;
}
export function projectOf(db: Database.Database): ProjectRecord {
  const row = db.prepare('SELECT project_id,primary_repo_id,legacy_decisions_dir,autonomy_enabled,default_execution_mode,created_at FROM project WHERE singleton=1')
    .get() as Omit<ProjectRecord, 'autonomy_enabled'> & { autonomy_enabled: number };
  return { ...row, autonomy_enabled: row.autonomy_enabled === 1 };
}
export function repositoriesOf(db: Database.Database): RepositoryRecord[] {
  return db.prepare('SELECT * FROM repositories ORDER BY repo_id').all() as RepositoryRecord[];
}
export function bindingsOf(db: Database.Database): RepositoryBinding[] {
  return db.prepare('SELECT * FROM repository_bindings ORDER BY common_dir').all() as RepositoryBinding[];
}

const time = () => Math.floor(Date.now() / 1000);
const id = () => randomBytes(16).toString('hex');
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim();
}
export function canonicalCommonDir(cwd: string): string {
  try { return realpathSync(git(cwd, ['rev-parse','--path-format=absolute','--git-common-dir'])); }
  catch { throw new KddError(`not in a git repository: ${cwd}`); }
}
export function canonicalProjectPath(path: string): string {
  path = resolve(path);
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(resolve(path));
  return parent === resolve(path) ? resolve(path) : join(canonicalProjectPath(parent), path.slice(dirname(path).length + 1));
}
function worktrees(common: string): string[] {
  return git(common, ['--git-dir', common, 'worktree','list','--porcelain'])
    .split(/\r?\n\r?\n/).filter(block => !/^bare$/m.test(block))
    .flatMap(block => block.match(/^worktree (.+)$/m)?.[1] ?? [])
    .filter(path => {
      try { return existsSync(path) && canonicalCommonDir(path) === common &&
        realpathSync(git(path, ['rev-parse','--show-toplevel'])) === realpathSync(path); }
      catch { return false; }
    });
}
interface Locator { common_dir: string; db_path: string; project_id: string; repo_id: string }
function withRegistry<T>(home: string, fn: (db: Database.Database) => T): T {
  mkdirSync(home, { recursive: true });
  const db = new Database(join(home, 'registry.db'));
  try {
    db.pragma('busy_timeout = 5000');
    const version = db.pragma('user_version', { simple: true }) as number;
    if (version > 1) throw new KddError(`registry has unknown schema version ${version}`);
    db.transaction(() => {
      if (db.pragma('user_version', { simple: true }) === 0) {
        db.exec(`CREATE TABLE bindings(common_dir TEXT PRIMARY KEY, db_path TEXT NOT NULL, project_id TEXT NOT NULL, repo_id TEXT NOT NULL); PRAGMA user_version = 1`);
      }
    }).immediate();
    return fn(db);
  } finally { db.close(); }
}
function readonly<T>(path: string, fn: (db: Database.Database, version: number) => T): T {
  if (!existsSync(path)) throw new KddError(`project store is missing: ${path}`);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const version = db.pragma('user_version', { simple: true }) as number;
    if (version < 1 || version > MIGRATIONS.length) throw new KddError(`unknown project schema version ${version}: ${path}`);
    return fn(db, version);
  } finally { db.close(); }
}
function storePaths(home: string): string[] {
  if (!existsSync(home)) return [];
  const paths = readdirSync(home, { withFileTypes: true }).filter(e => e.isDirectory())
    .map(e => join(home, e.name, 'kdd.db')).filter(path => existsSync(path));
  const catalog = join(home,'project-stores');
  if (existsSync(catalog)) for (const name of readdirSync(catalog).filter(n => n.endsWith('.json'))) {
    const record = JSON.parse(readFileSync(join(catalog,name),'utf8')) as { db_path: string; project_id: string };
    if (!/^[0-9a-f]{32}\.json$/.test(name) || record.project_id !== name.slice(0,-5) || typeof record.db_path !== 'string' || resolve(record.db_path) !== record.db_path) throw new KddError('invalid project store catalog');
    readonly(record.db_path,(db,version) => {
      if (version < 13 || projectOf(db).project_id !== record.project_id) throw new KddError('project store catalog identity mismatch');
    });
    paths.push(record.db_path);
  }
  return [...new Set(paths.map(path => resolve(path)))];
}
function catalogStore(db: Database.Database, dbPath: string, home: string): void {
  if (canonicalProjectPath(dirname(dirname(dbPath))) === canonicalProjectPath(home) && dbPath.endsWith('/kdd.db')) return;
  // Explicit external stores need a durable location when the disposable registry is lost.
  const projectId = projectOf(db).project_id;
  const dir = join(home,'project-stores');
  mkdirSync(dir,{recursive:true});
  const path = join(dir,`${projectId}.json`);
  const record = JSON.stringify({ db_path: resolve(dbPath),project_id: projectId });
  if (existsSync(path)) {
    if (readFileSync(path,'utf8') !== record) throw new KddError('project store location conflict');
    return;
  }
  const tmp = `${path}.${process.pid}.tmp`;
  try { writeFileSync(tmp,record,{mode:0o600}); renameSync(tmp,path); }
  finally { rmSync(tmp,{force:true}); }
}
function meta(db: Database.Database, key: string): string | undefined {
  return (db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined)?.value;
}
function discover(common: string, home: string): { dbPath: string; projectPath: string; locator?: Locator } | undefined {
  const matches = storePaths(home).flatMap(path => readonly(path, (db, version) => {
    if (version >= 13) {
      const binding = bindingsOf(db).find(b => b.common_dir === common);
      if (binding) return [{ dbPath: path, projectPath: common, locator: {
        common_dir: common, db_path: resolve(path), project_id: projectOf(db).project_id, repo_id: binding.repo_id,
      } }];
    }
    const source = meta(db, 'project_path');
    try {
      return source && existsSync(source) && canonicalCommonDir(source) === common
        ? [{ dbPath: path, projectPath: source }] : [];
    } catch { return []; }
  }));
  if (matches.length > 1) throw new KddError(`conflicting project stores for ${common}`);
  return matches[0];
}
function validateLocator(row: Locator): void {
  readonly(row.db_path, (db, version) => {
    const binding = version >= 13 ? bindingsOf(db).find(b => b.common_dir === row.common_dir) : undefined;
    if (!binding || binding.repo_id !== row.repo_id || projectOf(db).project_id !== row.project_id) {
      throw new KddError(`stale or mismatched registry binding for ${row.common_dir}; repeat explicit binding/rebind`);
    }
  });
}
function putLocator(registry: Database.Database, row: Locator): void {
  registry.prepare('INSERT INTO bindings(common_dir,db_path,project_id,repo_id) VALUES(@common_dir,@db_path,@project_id,@repo_id) ON CONFLICT(common_dir) DO UPDATE SET db_path=excluded.db_path,project_id=excluded.project_id,repo_id=excluded.repo_id').run(row);
}
export function lookupProjectStore(commonDir: string, home: string): { dbPath: string; projectPath: string } | undefined {
  return withRegistry(home, registry => registry.transaction(() => {
    const row = registry.prepare('SELECT * FROM bindings WHERE common_dir=?').get(commonDir) as Locator | undefined;
    if (row) { validateLocator(row); return { dbPath: row.db_path, projectPath: commonDir }; }
    const found = discover(commonDir, home);
    if (found?.locator) putLocator(registry, found.locator);
    return found ? { dbPath: found.dbPath, projectPath: found.projectPath } : undefined;
  }).immediate());
}
export function initializeProjectStore(db: Database.Database, dbPath: string, home: string,
  projectPath?: string, checkout: string = process.cwd(),
  options: { legacyUpgrade?: boolean; configuredDecisions?: string } = {}): void {
  if (dbPath === ':memory:') return;
  const savedSource = meta(db, 'project_path');
  const source = savedSource ?? projectPath;
  if (!source || !existsSync(source)) return;
  let common: string;
  let paths: string[];
  // Normalize historical checkout metadata, never an arbitrary override caller cwd.
  try {
    common = savedSource && (options.legacyUpgrade || projectOf(db).primary_repo_id)
      ? canonicalCommonDir(savedSource) : realpathSync(source);
    paths = worktrees(common).map(path => realpathSync(path));
  } catch { return; }
  let sourceCaller = false;
  try {
    if (canonicalCommonDir(checkout) === common) {
      sourceCaller = true;
      paths = [realpathSync(git(checkout, ['rev-parse','--show-toplevel'])), ...paths];
    }
  } catch { /* caller may be outside the source repository */ }
  const toplevel = meta(db, 'project_toplevel');
  if (toplevel) {
    try { if (canonicalCommonDir(toplevel) === common) paths.unshift(realpathSync(toplevel)); } catch { /* moved source */ }
  }
  if (!paths.length) return;
  withRegistry(home, registry => registry.transaction(() => {
    catalogStore(db,dbPath,home);
    const found = registry.prepare('SELECT * FROM bindings WHERE common_dir=?').get(common) as Locator | undefined;
    if (found && (found.project_id !== projectOf(db).project_id || resolve(found.db_path) !== resolve(dbPath))) {
      throw new KddError(`registry binding conflict for ${common}`);
    }
    const other = discover(common, home);
    if (other && resolve(other.dbPath) !== resolve(dbPath)) throw new KddError(`project store conflict for ${common}`);
    db.transaction(() => {
      const project = projectOf(db);
      if (project.primary_repo_id) return;
      let decisionsDir = project.legacy_decisions_dir;
      if (!decisionsDir) {
        // Legacy index paths preserve the previous source even if backend triggers upgrade.
        const cachedPaths = (db.prepare('SELECT path FROM decisions').all() as { path: string }[])
          .map(row => resolve(dirname(row.path)));
        const cachedDirs = new Set(cachedPaths.map(canonicalProjectPath));
        // Canonicalize the checkout anchor without following the default directory's symlink.
        const cachedDefault = cachedPaths.some(dir => basename(dir) === 'decisions' &&
          basename(dirname(dir)) === '.planning' && paths.includes(canonicalProjectPath(dirname(dirname(dir)))));
        if (cachedDirs.size === 1 && !cachedDefault) decisionsDir = [...cachedDirs][0];
        if (!decisionsDir && sourceCaller && options.configuredDecisions) decisionsDir = canonicalProjectPath(options.configuredDecisions);
      }
      const repoId = id();
      db.prepare('INSERT INTO repositories VALUES(?,?,?,NULL,?)').run(repoId, 'primary','implementation',time());
      db.prepare('INSERT INTO repository_bindings VALUES(?,?,?,?,?)').run(common,repoId,paths[0],'source',time());
      // A default directory symlink must not grant authority to its foreign target.
      db.prepare('UPDATE project SET primary_repo_id=?,legacy_decisions_dir=? WHERE singleton=1')
        .run(repoId, decisionsDir ?? join(paths[0],'.planning','decisions'));
    }).immediate();
    const binding = bindingsOf(db).find(b => b.common_dir === common);
    if (binding) putLocator(registry, { common_dir: common, db_path: resolve(dbPath), project_id: projectOf(db).project_id, repo_id: binding.repo_id });
  }).immediate());
}
export function listProjectCheckouts(home: string): string[] {
  return [...new Set(storePaths(home).flatMap(path => readonly(path, (db, version) => {
    const bindings = version >= 13 ? bindingsOf(db) : [];
    const commons = version >= 13 ? bindings.map(b => b.common_dir) : [meta(db,'project_path')].filter((p): p is string => !!p);
    const checkoutPaths = bindings.flatMap(b => {
      try { return canonicalCommonDir(b.checkout_path) === b.common_dir ? [realpathSync(b.checkout_path)] : []; }
      catch { return []; }
    });
    return [...checkoutPaths, ...commons.filter(p => existsSync(p)).flatMap(common => worktrees(realpathSync(common)))];
  })))];
}

function audit(db: Database.Database, actor: Actor, action: string, detail: unknown): void {
  db.prepare('INSERT INTO events(task_id,actor_type,actor_id,action,detail,created_at) VALUES(NULL,?,?,?,?,?)')
    .run(actor.type, actor.type === 'ai' ? actor.id ?? null : null, action, JSON.stringify(detail), time());
}
function assertAvailable(registry: Database.Database, common: string, home: string,
  dbPath: string, projectId: string, repoId?: string): void {
  const row = registry.prepare('SELECT * FROM bindings WHERE common_dir=?').get(common) as Locator | undefined;
  if (row && (row.project_id !== projectId || resolve(row.db_path) !== resolve(dbPath) || (repoId && row.repo_id !== repoId))) {
    throw new KddError(`repository binding conflict for ${common}`);
  }
  const found = discover(common, home);
  if (found && (resolve(found.dbPath) !== resolve(dbPath) || (repoId && found.locator && found.locator.repo_id !== repoId))) {
    throw new KddError(`project store conflict for ${common}`);
  }
}
function checkoutBinding(cwd: string, repoId: string, kind: BindingKind): RepositoryBinding {
  return { common_dir: canonicalCommonDir(cwd), repo_id: repoId,
    checkout_path: realpathSync(git(cwd,['rev-parse','--show-toplevel'])), kind, created_at: time() };
}
function insertBinding(db: Database.Database, binding: RepositoryBinding): void {
  db.prepare('INSERT INTO repository_bindings VALUES(@common_dir,@repo_id,@checkout_path,@kind,@created_at)').run(binding);
}
function locateBinding(registry: Database.Database, db: Database.Database, dbPath: string, binding: RepositoryBinding): void {
  putLocator(registry, { common_dir: binding.common_dir, db_path: resolve(dbPath),
    project_id: projectOf(db).project_id, repo_id: binding.repo_id });
}
export function bindRepository(db: Database.Database, dbPath: string, home: string,
  input: { cwd: string; repoId: string; kind: BindingKind }, actor: Actor): RepositoryBinding {
  if (!/^[0-9a-f]{32}$/.test(input.repoId) || !repositoriesOf(db).some(r => r.repo_id === input.repoId)) throw new KddError('unknown repository id');
  if (!['source','managed'].includes(input.kind)) throw new KddError('invalid binding kind');
  const binding = checkoutBinding(input.cwd,input.repoId,input.kind);
  return withRegistry(home, registry => registry.transaction(() => {
    assertAvailable(registry,binding.common_dir,home,dbPath,projectOf(db).project_id,input.repoId);
    const existing = bindingsOf(db).find(b => b.common_dir === binding.common_dir);
    if (existing && (existing.repo_id !== input.repoId || existing.kind !== input.kind)) throw new KddError('repository binding conflict');
    if (input.kind === 'source' && bindingsOf(db).some(b => b.repo_id === input.repoId && b.kind === 'source' && b.common_dir !== binding.common_dir)) {
      throw new KddError('repository already has a source; use rebind to move it');
    }
    const result = existing ?? db.transaction(() => {
      insertBinding(db,binding);
      audit(db,actor,'repository_bound',binding);
      return binding;
    }).immediate();
    locateBinding(registry,db,dbPath,result);
    return result;
  }).immediate());
}
export function addRepository(db: Database.Database, dbPath: string, home: string,
  input: { cwd: string; purpose: string; access: RepositoryAccess }, actor: Actor):
  { repository: RepositoryRecord; binding: RepositoryBinding } {
  if (!input.purpose?.trim()) throw new KddError('repository purpose must not be empty');
  if (!['context_only','implementation'].includes(input.access)) throw new KddError('invalid repository access');
  if (!projectOf(db).primary_repo_id) throw new KddError('restore the primary source before adding a repository');
  const binding = checkoutBinding(input.cwd,id(),'source');
  return withRegistry(home, registry => registry.transaction(() => {
    assertAvailable(registry,binding.common_dir,home,dbPath,projectOf(db).project_id);
    const existing = bindingsOf(db).find(b => b.common_dir === binding.common_dir);
    const repository = existing ? repositoriesOf(db).find(r => r.repo_id === existing.repo_id)! : {
      repo_id: binding.repo_id, purpose: input.purpose.trim(), access: input.access, remote: null, created_at: time(),
    };
    if (existing && (repository.purpose !== input.purpose.trim() || repository.access !== input.access)) throw new KddError('repository binding conflict');
    if (!existing) db.transaction(() => {
      db.prepare('INSERT INTO repositories VALUES(@repo_id,@purpose,@access,@remote,@created_at)').run(repository);
      insertBinding(db,binding);
      audit(db,actor,'repository_added',{ repository,binding });
    }).immediate();
    locateBinding(registry,db,dbPath,existing ?? binding);
    return { repository, binding: existing ?? binding };
  }).immediate());
}
export function rebindRepository(db: Database.Database, dbPath: string, home: string,
  input: { fromCommonDir: string; cwd: string }, actor: Actor): RepositoryBinding {
  const oldPath = canonicalProjectPath(input.fromCommonDir);
  const newCommon = canonicalCommonDir(input.cwd);
  return withRegistry(home, registry => registry.transaction(() => {
    const project = projectOf(db);
    let previous = bindingsOf(db).find(b => b.common_dir === oldPath);
    const existing = bindingsOf(db).find(b => b.common_dir === newCommon);
    const history = db.prepare("SELECT detail FROM events WHERE action='repository_rebound' AND json_valid(detail) ORDER BY id DESC").all() as { detail: string }[];
    const repeated = !previous && existing && history.some(e => {
      const change = JSON.parse(e.detail);
      return change.from_common_dir === oldPath && change.binding.common_dir === newCommon && change.binding.repo_id === existing.repo_id;
    });
    if (!previous && !repeated && (project.primary_repo_id || canonicalProjectPath(meta(db,'project_path') ?? '') !== oldPath)) throw new KddError('unknown original source binding');
    const oldRow = registry.prepare('SELECT * FROM bindings WHERE common_dir=?').get(oldPath) as Locator | undefined;
    if (oldRow && (oldRow.project_id !== project.project_id || resolve(oldRow.db_path) !== resolve(dbPath))) throw new KddError('repository binding conflict');
    const repoId = previous?.repo_id ?? existing?.repo_id ?? id();
    assertAvailable(registry,newCommon,home,dbPath,project.project_id,repoId);
    if (existing && !repeated && previous?.common_dir !== existing.common_dir) throw new KddError('repository binding conflict');
    const binding = repeated ? existing! : checkoutBinding(input.cwd,repoId,previous?.kind ?? 'source');
    catalogStore(db,dbPath,home);
    if (!repeated && oldPath !== newCommon) db.transaction(() => {
      if (!previous) {
        db.prepare('INSERT INTO repositories VALUES(?,?,?,NULL,?)').run(repoId,'primary','implementation',time());
        db.prepare('UPDATE project SET primary_repo_id=? WHERE singleton=1').run(repoId);
      } else db.prepare('DELETE FROM repository_bindings WHERE common_dir=?').run(oldPath);
      insertBinding(db,binding);
      if ((previous?.kind === 'source' && project.primary_repo_id === repoId) || !project.primary_repo_id) {
        const oldDefault = previous ? join(previous.checkout_path,'.planning','decisions') : null;
        if (!project.legacy_decisions_dir || project.legacy_decisions_dir === oldDefault) {
          db.prepare('UPDATE project SET legacy_decisions_dir=? WHERE singleton=1').run(join(binding.checkout_path,'.planning','decisions'));
        }
        db.prepare("INSERT INTO meta(key,value) VALUES('project_path',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(newCommon);
        if (meta(db,'project_toplevel')) db.prepare("UPDATE meta SET value=? WHERE key='project_toplevel'").run(binding.checkout_path);
      }
      audit(db,actor,'repository_rebound',{ from_common_dir: oldPath,binding });
    }).immediate();
    if (oldPath !== newCommon) registry.prepare('DELETE FROM bindings WHERE common_dir=?').run(oldPath);
    locateBinding(registry,db,dbPath,binding);
    return binding;
  }).immediate());
}

export function canSyncLegacyDecisions(db: Database.Database, decisionsDir: string): boolean {
  const project = projectOf(db);
  if (!project.primary_repo_id && db.memory) return true;
  const bindings = bindingsOf(db);
  const source = bindings.find(b => b.repo_id === project.primary_repo_id && b.kind === 'source');
  if (project.primary_repo_id && (!source || !existsSync(source.common_dir))) return false;
  const path = canonicalProjectPath(decisionsDir);
  if (project.legacy_decisions_dir && (!source || resolve(project.legacy_decisions_dir) !== join(source.checkout_path,'.planning','decisions'))) {
    return path === resolve(project.legacy_decisions_dir);
  }
  if (!project.primary_repo_id) return false;
  let ancestor = path;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  try {
    const common = canonicalCommonDir(ancestor);
    return bindings.some(b => b.repo_id === project.primary_repo_id && b.kind === 'source' && b.common_dir === common);
  } catch { return false; }
}
export function assertLegacyDecisionSource(db: Database.Database, decisionsDir: string): void {
  if (!canSyncLegacyDecisions(db,decisionsDir)) throw new KddError('legacy decisions require the primary project source; foreign repositories may read the shared index');
}
