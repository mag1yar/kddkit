import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, linkSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as core from '../src/index.js';
import * as authority from '../src/authority.js';

// Native execution has its own real-tool gate. These DB tests isolate issuance/fencing.
const proved = vi.hoisted(() => new WeakSet<object>());
vi.mock('../src/codex_permissions.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/codex_permissions.js')>();
  return { ...actual, assertVerifiedCodexPackage(packet: object) {
    if (!proved.has(packet)) throw new core.KddError('unverified native package');
  } };
});
let root: string, home: string, source: string, workspace: string, backend: string, dbPath: string;
let db: Database.Database;
let saved: NodeJS.ProcessEnv;
const connections: Database.Database[] = [];
const user = { type: 'user' } as const;
const git = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
beforeEach(() => {
  saved = { ...process.env };
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kdd-authority-'))); home = join(root, 'home');
  process.env.KDD_HOME = home; delete process.env.KDD_DB; delete process.env.KDD_DECISIONS_DIR;
  source = join(root, 'source'); workspace = join(root, 'workspace'); backend = join(root, 'backend'); mkdirSync(join(root, 'scratch'));
  for (const path of [source, backend]) {
    mkdirSync(path); git(path, 'init', '-q');
    git(path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture');
  }
  git(root, 'clone', '--no-hardlinks', '-q', source, workspace);
  const resolved = core.resolveDbPath(source); dbPath = resolved.dbPath;
  db = core.openDb(dbPath, resolved.projectPath, source); connections.push(db);
  core.bindRepository(db, dbPath, home, { cwd: workspace, repoId: core.projectOf(db).primary_repo_id!, kind: 'managed' }, user);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const connection of connections.splice(0)) if (connection.open) connection.close();
  process.env = saved; rmSync(root, { recursive: true, force: true });
});
function native(cwd = workspace, writable = true, readableRoots = [cwd]): core.VerifiedCodexPackage {
  const packet = Object.freeze({ executable: '/fixture/codex', version: 'codex-cli 0.157.0', cwd,
    controlDir: home, readableRoots: Object.freeze(readableRoots), writableRoot: writable ? cwd : undefined,
    scratchDir: join(root, 'scratch'), protectedPaths: Object.freeze([home]), argv: Object.freeze([]),
    env: Object.freeze({}), configHash: 'a'.repeat(64), results: Object.freeze([]) });
  proved.add(packet); return packet;
}
function issueInput(taskId: number) {
  return { taskId, workItemId: 'w1', runId: 'r1', expectedGeneration: 0, expiresAt: core.now() + 60,
    operations: ['get_context', 'submit_report', 'request_question'] as const,
    repositories: [{ repoId: core.projectOf(db).primary_repo_id!, checkoutPath: workspace, write: true }], native: native() };
}
it('protects a task only through an authentic connection-bound handle, without a legacy claim', () => {
  const task = core.addTask(db, { title: 'protected' }, user);
  const handle = authority.openController(db);
  const before = core.mustGetTask(db, task.id);
  for (const fake of [{ kind: 'controller' }, { ...handle }, JSON.parse(JSON.stringify(handle))]) {
    expect(() => authority.protectTask(fake as authority.ControllerHandle, task.id)).toThrow(/authority/);
  }
  authority.protectTask(handle, task.id);
  expect(core.mustGetTask(db, task.id)).toEqual(before);
  expect(() => authority.assertLegacyTaskMutation(db, [task.id])).toThrow(/managed/);
  authority.protectTask(handle, task.id);
  expect(db.prepare('SELECT COUNT(*) n FROM managed_task_policy').get()).toEqual({ n: 1 });
  const claimed = core.addTask(db, { title: 'old writer', criteria: ['ready'] }, user);
  db.prepare("UPDATE tasks SET status='in_progress',claimed_by='legacy' WHERE id=?").run(claimed.id);
  expect(() => authority.protectTask(handle, claimed.id)).toThrow(/claimed|writer/);
  expect(() => authority.issueRunAuthority(handle, issueInput(claimed.id))).toThrow(/claimed|writer/);
});
it('fences two connections, revokes the previous credential and retains the managed marker', () => {
  const task = core.addTask(db, { title: 'scoped' }, user);
  const handle = authority.openController(db), input = issueInput(task.id);
  const second = core.openDb(dbPath, core.canonicalCommonDir(source), source); connections.push(second);
  const other = authority.openController(second);
  const first = authority.issueRunAuthority(handle, input);
  expect(first.token).toMatch(/^[0-9a-f]{64}$/);
  const context = authority.openRunContext(second, first.token);
  expect(JSON.stringify(context)).not.toContain(first.token);
  expect(() => authority.issueRunAuthority(other, input)).toThrow(/generation|fence/);
  const next = authority.issueRunAuthority(other, { ...input, runId: 'r2', expectedGeneration: 1 });
  expect(next.generation).toBe(2);
  expect(() => authority.openRunContext(db, first.token)).toThrow(/authority/);
  authority.openRunContext(db, next.token);
  authority.revokeRunAuthority(handle, next.authorityId);
  expect(() => authority.openRunContext(second, next.token)).toThrow(/authority/);
  expect(() => authority.assertLegacyTaskMutation(db, [task.id])).toThrow(/managed/);
  const audit = JSON.stringify(db.prepare('SELECT detail FROM events').all());
  const hash = (db.prepare('SELECT token_hash FROM run_authorities WHERE authority_id=?').get(first.authorityId) as { token_hash: string }).token_hash;
  expect(audit).not.toContain(first.token); expect(audit).not.toContain(hash);
  expect(core.mustGetTask(db, task.id).status).toBe('new');
});
it('rejects expired/foreign credentials and malformed grants atomically', () => {
  const task = core.addTask(db, { title: 'scoped' }, user), handle = authority.openController(db), input = issueInput(task.id);
  const before = db.prepare('SELECT * FROM events').all();
  const invalid = [
    { ...input, operations: ['update_task'] }, { ...input, operations: ['get_context', 'get_context'] },
    { ...input, workItemId: '' }, { ...input, expiresAt: Infinity }, { ...input, expiresAt: core.now() },
    { ...input, expectedGeneration: 0.5 }, { ...input, native: { ...input.native } },
  ];
  for (const candidate of invalid) expect(() => authority.issueRunAuthority(handle, candidate as authority.IssueRunInput)).toThrow();
  expect(db.prepare('SELECT * FROM events').all()).toEqual(before);
  expect(db.prepare('SELECT COUNT(*) n FROM run_authorities').get()).toEqual({ n: 0 });
  expect(db.prepare('SELECT COUNT(*) n FROM managed_task_policy').get()).toEqual({ n: 0 });
  const issued = authority.issueRunAuthority(handle, input);
  const foreign = core.openDb(':memory:'); connections.push(foreign);
  expect(() => authority.openRunContext(foreign, issued.token)).toThrow(/authority/);
  vi.spyOn(Date, 'now').mockReturnValue((input.expiresAt + 1) * 1000);
  expect(() => authority.openRunContext(db, issued.token)).toThrow(/authority/);
});
it('permits context-only reads but refuses source/sibling writes and unmatched native roots', () => {
  const task = core.addTask(db, { title: 'scoped' }, user), handle = authority.openController(db), input = issueInput(task.id);
  const added = core.addRepository(db, dbPath, home, { cwd: backend, purpose: 'backend', access: 'context_only' }, user);
  const readonly = { ...input, repositories: [{ repoId: added.repository.repo_id, checkoutPath: backend, write: false }], native: native(backend, false) };
  authority.issueRunAuthority(handle, readonly);
  expect(() => authority.issueRunAuthority(handle, { ...readonly, expectedGeneration: 1,
    repositories: [{ ...readonly.repositories[0], write: true }], native: native(backend) })).toThrow(/scope|repository|write/);
  expect(() => authority.issueRunAuthority(handle, { ...input, expectedGeneration: 1,
    repositories: [{ ...input.repositories[0], checkoutPath: source }], native: native(source) })).toThrow(/scope|repository|write/);
  expect(() => authority.issueRunAuthority(handle, { ...input, expectedGeneration: 1, native: native(backend) })).toThrow(/scope|repository/);
});
it('rechecks every run operation and keeps reports/questions as attributed untrusted events', () => {
  const task = core.addTask(db, { title: 'own', body: 'context', criteria: ['proof'] }, user);
  const other = core.addTask(db, { title: 'foreign' }, user);
  core.linkTasks(db, task.id, other.id, 'depends', user);
  db.prepare("INSERT INTO decisions(slug,title,path,content_hash,source_tasks) VALUES('own','Stored','never-read','hash',?)").run(JSON.stringify([task.id]));
  const backendRepo = core.addRepository(db, dbPath, home, { cwd: backend, purpose: 'backend', access: 'context_only' }, user).repository.repo_id;
  const input = { ...issueInput(task.id), native: native(workspace, true, [workspace, backend]),
    repositories: [...issueInput(task.id).repositories, { repoId: backendRepo, checkoutPath: backend, write: false }] };
  const controller = authority.openController(db);
  const issued = authority.issueRunAuthority(controller, input), context = authority.openRunContext(db, issued.token);
  const before = ['tasks', 'criteria', 'comments', 'decisions'].map(table => db.prepare(`SELECT * FROM ${table}`).all());
  const snapshot = authority.readRunContext(context);
  expect(snapshot).toMatchObject({ taskId: task.id, runId: 'r1', generation: 1, task: { title: 'own', body: 'context' }, decisions: [{ slug: 'own', title: 'Stored' }] });
  expect(JSON.stringify(snapshot)).not.toContain('foreign'); expect(JSON.stringify(snapshot)).not.toContain('never-read');
  const decisionsDir = join(backend, '.planning', 'decisions'); mkdirSync(decisionsDir, { recursive: true });
  expect(authority.readRunContext(context)).toEqual(snapshot);
  writeFileSync(join(decisionsDir, 'own.md'), '# Conflicting backend decision');
  expect(authority.readRunContext(context)).toEqual(snapshot);
  const hash = (db.prepare('SELECT token_hash FROM run_authorities WHERE authority_id=?').get(issued.authorityId) as { token_hash: string }).token_hash;
  const reportId = authority.submitRunReport(context, `result ${issued.token} ${hash}`);
  const questionId = authority.requestRunQuestion(context, 'which env?');
  const event = db.prepare('SELECT * FROM events WHERE id=?').get(reportId) as { actor_type: string; actor_id: string; action: string; detail: string };
  expect(event).toMatchObject({ actor_type: 'ai', actor_id: 'r1', action: 'run_report' });
  expect(JSON.parse(event.detail)).toMatchObject({ work_item_id: 'w1', run_id: 'r1', generation: 1, untrusted: true });
  expect(event.detail).not.toContain(issued.token); expect(event.detail).not.toContain(hash);
  expect(db.prepare('SELECT action FROM events WHERE id=?').get(questionId)).toEqual({ action: 'run_question' });
  for (const body of ['', ' '.repeat(4), 'x'.repeat(core.CAPS.agentFieldChars + 1)]) expect(() => authority.submitRunReport(context, body)).toThrow();
  for (const fake of [{ kind: 'run' }, { ...context }]) expect(() => authority.readRunContext(fake as authority.RunContext)).toThrow(/authority/);
  expect(['tasks', 'criteria', 'comments', 'decisions'].map(table => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
  const next = authority.issueRunAuthority(controller, { ...input, expectedGeneration: 1, runId: 'r2', operations: ['get_context'] });
  for (const call of [() => authority.runOperations(context), () => authority.readRunContext(context), () => authority.submitRunReport(context, 'late')]) expect(call).toThrow(/authority/);
  const readOnly = authority.openRunContext(db, next.token);
  expect(authority.runOperations(readOnly)).toEqual(['get_context']);
  expect(() => authority.requestRunQuestion(readOnly, 'hidden')).toThrow(/authority/);
  vi.spyOn(Date, 'now').mockReturnValue((input.expiresAt + 1) * 1000);
  expect(() => authority.readRunContext(readOnly)).toThrow(/authority/);
  vi.restoreAllMocks();
  authority.revokeRunAuthority(controller, next.authorityId);
  expect(() => authority.readRunContext(readOnly)).toThrow(/authority/);
});
it('preserves all v13 rows and a WAL-aware backup, without implicitly managing legacy tasks', () => {
  const path = join(root, 'v13.db'), raw = new Database(path);
  raw.pragma('journal_mode=WAL');
  for (const migration of core.MIGRATIONS.slice(0, 13)) raw.exec(migration);
  raw.pragma('user_version=13');
  raw.exec("INSERT INTO tasks(id,title,created_at,updated_at) VALUES(77,'preserved',1,1); INSERT INTO criteria(id,task_id,text,created_at) VALUES(78,77,'criterion',1); INSERT INTO comments(id,task_id,author,body,created_at) VALUES(79,77,'user','comment',1); INSERT INTO events(id,task_id,actor_type,action,created_at) VALUES(80,77,'user','created',1); INSERT INTO decisions(slug,title,path,content_hash,source_tasks) VALUES('d','Decision','fixture','hash','[77]'); INSERT INTO search_index(kind,ref,title,body) VALUES('decision','d','Decision','body');");
  const tables = ['tasks', 'criteria', 'comments', 'events', 'decisions', 'search_index', 'project'];
  const before = Object.fromEntries(tables.map(table => [table, raw.prepare(`SELECT * FROM ${table}`).all()]));
  const upgraded = core.openDb(path); connections.push(upgraded);
  expect(upgraded.pragma('user_version', { simple: true })).toBe(14);
  for (const table of tables) expect(upgraded.prepare(`SELECT * FROM ${table}`).all()).toEqual(before[table]);
  expect(upgraded.prepare('SELECT COUNT(*) n FROM managed_task_policy').get()).toEqual({ n: 0 });
  expect(upgraded.prepare('SELECT COUNT(*) n FROM run_authorities').get()).toEqual({ n: 0 });
  const backup = new Database(`${path}.v13.bak`, { readonly: true });
  expect(backup.pragma('user_version', { simple: true })).toBe(13);
  for (const table of tables) expect(backup.prepare(`SELECT * FROM ${table}`).all()).toEqual(before[table]);
  backup.close(); raw.close();
});
it('refuses stores visible through repo/Git reads or hardlinked private DB files', () => {
  const task = core.addTask(db, { title: 'scoped' }, user), input = issueInput(task.id);
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    linkSync(path, join(backend, 'db-alias'));
    expect(() => authority.issueRunAuthority(authority.openController(db), input)).toThrow(/alias/);
    rmSync(join(backend, 'db-alias'));
  }
  const aliasPath = join(root, 'board-alias.db'); symlinkSync(dbPath, aliasPath);
  const aliased = new Database(aliasPath); connections.push(aliased);
  expect(() => authority.issueRunAuthority(authority.openController(aliased), input)).toThrow(/alias/);
  const issued = authority.issueRunAuthority(authority.openController(db), input);
  const before = db.prepare('SELECT * FROM events').all(), scratch = join(root, 'scratch');
  rmSync(scratch, { recursive: true }); symlinkSync(dirname(dbPath), scratch);
  expect(() => authority.openRunContext(db, issued.token)).toThrow(/authority/);
  expect(db.prepare('SELECT * FROM events').all()).toEqual(before);
  rmSync(scratch); mkdirSync(scratch);
  authority.openRunContext(db, issued.token);
  linkSync(dbPath, join(backend, 'db-alias'));
  expect(() => authority.openRunContext(db, issued.token)).toThrow(/authority/);
  rmSync(join(backend, 'db-alias'));
  const embedded = core.openDb(join(workspace, 'unsafe.db')); connections.push(embedded);
  for (const repo of core.repositoriesOf(db)) embedded.prepare('INSERT INTO repositories VALUES(@repo_id,@purpose,@access,@remote,@created_at)').run(repo);
  for (const binding of core.bindingsOf(db)) embedded.prepare('INSERT INTO repository_bindings VALUES(@common_dir,@repo_id,@checkout_path,@kind,@created_at)').run(binding);
  const own = core.addTask(embedded, { title: 'embedded store' }, user);
  expect(() => authority.issueRunAuthority(authority.openController(embedded), { ...input, taskId: own.id })).toThrow(/store|scope/);
  expect(embedded.prepare('SELECT COUNT(*) n FROM run_authorities').get()).toEqual({ n: 0 });
});

it('refuses a persisted grant without its scratch scope on every later operation', () => {
  const task = core.addTask(db, { title: 'scope freshness' }, user);
  const issued = authority.issueRunAuthority(authority.openController(db), issueInput(task.id));
  const context = authority.openRunContext(db, issued.token);
  db.prepare("UPDATE run_authorities SET grant_json=json_remove(grant_json,'$.native.scratchDir') WHERE authority_id=?").run(issued.authorityId);
  const before = db.prepare('SELECT * FROM events').all();
  expect(() => authority.openRunContext(db, issued.token)).toThrow(/authority/);
  expect(() => authority.readRunContext(context)).toThrow(/authority/);
  expect(() => authority.submitRunReport(context, 'late')).toThrow(/authority/);
  expect(db.prepare('SELECT * FROM events').all()).toEqual(before);
});
