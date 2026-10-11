import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  MIGRATIONS, openDb, projectPathOf, projectToplevelOf, setProjectToplevel,
} from '../src/db.js';
import { KddError } from '../src/errors.js';

describe('openDb', () => {
  it('upgrades a populated v17 WAL without changing its rows', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'kdd-role-mig-')), 'board.db');
    const old = new Database(p);
    old.pragma('journal_mode = WAL'); old.pragma('wal_autocheckpoint = 0');
    for (const sql of MIGRATIONS.slice(0, 17)) old.exec(sql);
    old.pragma('user_version = 17');
    old.prepare("INSERT INTO tasks(id,title,status,created_at,updated_at) VALUES(41,'retained','new',1,1)").run();
    old.prepare("INSERT INTO comments(id,task_id,author,body,created_at) VALUES(7,41,'user','retained',1)").run();
    const before = old.prepare('SELECT * FROM comments').all();
    old.close();
    const upgraded = openDb(p);
    expect(upgraded.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(upgraded.prepare('SELECT * FROM comments').all()).toEqual(before);
    upgraded.close();
    const reopened = openDb(p);
    expect(reopened.prepare('SELECT * FROM comments').all()).toEqual(before);
    reopened.close();
  });
  it('creates schema at user_version 1 with all tables', () => {
    const db = openDb(':memory:', 'C:/proj');
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    ).all().map((r: any) => r.name);
    expect(tables).toEqual(expect.arrayContaining(
      ['tasks', 'comments', 'task_links', 'events', 'errors', 'meta']));
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(db.prepare(`SELECT value FROM meta WHERE key='project_path'`).get())
      .toEqual({ value: 'C:/proj' });
  });

  it('is idempotent on reopen (file db)', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const p = join(mkdtempSync(join(tmpdir(), 'kdd-')), 'kdd.db');
    openDb(p, 'x').close();
    const db2 = openDb(p, 'x'); // не падает, версия та же
    expect(db2.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    db2.close();
  });

  it('migration 2 adds decisions, search_index and fts_last_event_id', () => {
    const db = openDb(':memory:', 'x');
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    ).all().map((r: any) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['decisions', 'search_index']));
    expect(db.prepare(`SELECT value FROM meta WHERE key='fts_last_event_id'`).get())
      .toEqual({ value: '0' });
    db.prepare(`INSERT INTO search_index (kind, ref, title, body)
                VALUES ('decision', 's', 'hello world', 'greeting text')`).run();
    const hit = db.prepare(`SELECT ref FROM search_index WHERE search_index MATCH '"hello"'`).get();
    expect(hit).toEqual({ ref: 's' });
  });

  it('migration 3 adds tracks table and tasks.track_id', () => {
    const db = openDb(':memory:', 'x');
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    ).all().map((r: any) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['tracks']));
    const cols = db.prepare(`PRAGMA table_info(tasks)`).all().map((r: any) => r.name);
    expect(cols).toContain('track_id');
  });

  it('migrates an existing v1 database in place', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const Database = (await import('better-sqlite3')).default;
    const p = join(mkdtempSync(join(tmpdir(), 'kdd-')), 'kdd.db');
    // строим v1-базу вручную: только MIGRATIONS[0]
    const raw = new Database(p);
    raw.exec(MIGRATIONS[0]);
    raw.pragma('user_version = 1');
    raw.close();
    const db = openDb(p, 'x');
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(() => db.prepare(`SELECT COUNT(*) FROM decisions`).get()).not.toThrow();
    expect(() => db.prepare(`SELECT COUNT(*) FROM tracks`).get()).not.toThrow();
    db.close();
  });

  it('adds an empty verification snapshot without changing legacy criteria', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'kdd-criteria-mig-')), 'kdd.db');
    const raw = new Database(p);
    for (let i = 0; i < 10; i++) raw.exec(MIGRATIONS[i]);
    raw.pragma(`user_version = ${10}`);
    raw.prepare(
      `INSERT INTO tasks (title, created_at, updated_at) VALUES ('legacy', 1, 1)`,
    ).run();
    raw.prepare(
      `INSERT INTO criteria (task_id, text, checked_at, position, created_at)
       VALUES (1, 'still verified', 7, 0, 1)`,
    ).run();
    raw.close();

    const db = openDb(p);
    expect(db.prepare(
      `SELECT text, checked_at, evidence, checked_by FROM criteria WHERE id = 1`,
    ).get()).toEqual({
      text: 'still verified', checked_at: 7, evidence: null, checked_by: null,
    });
    db.close();
  });

  it('migration 12 preserves decisions with empty source tasks', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'kdd-decision-source-mig-')), 'kdd.db');
    const raw = new Database(p);
    for (let i = 0; i < 11; i++) raw.exec(MIGRATIONS[i]);
    raw.pragma(`user_version = ${11}`);
    raw.prepare(
      `INSERT INTO decisions (slug, title, path, content_hash, created, superseded_by)
       VALUES ('legacy', 'Legacy', '/legacy.md', 'hash', '2026-01-01', NULL)`,
    ).run();
    raw.close();

    const db = openDb(p);
    expect(db.prepare(`SELECT source_tasks FROM decisions WHERE slug = 'legacy'`).get())
      .toEqual({ source_tasks: '[]' });
    db.close();
  });

  it('projectPathOf reads back what openDb wrote, and null when the row is missing', () => {
    const db = openDb(':memory:', 'C:/proj');
    expect(projectPathOf(db)).toBe('C:/proj');
    db.prepare(`DELETE FROM meta WHERE key = 'project_path'`).run();
    expect(projectPathOf(db)).toBeNull();
  });

  // Ключа нет у досок, созданных до его появления, — читатель обязан получить null и
  // уметь откатиться на свою старую догадку, а не сломаться.
  it('projectToplevelOf is null until written, then reads back the last write', () => {
    const db = openDb(':memory:', '/super/.git/modules/sub');
    expect(projectToplevelOf(db)).toBeNull();
    setProjectToplevel(db, '/super/sub');
    expect(projectToplevelOf(db)).toBe('/super/sub');
    setProjectToplevel(db, '/elsewhere/sub'); // репо переехало — перезапись, не второй ряд
    expect(projectToplevelOf(db)).toBe('/elsewhere/sub');
    expect(projectPathOf(db)).toBe('/super/.git/modules/sub'); // project_path не тронут
  });

  it('rejects bad status via CHECK', () => {
    const db = openDb(':memory:', 'x');
    expect(() => db.prepare(
      `INSERT INTO tasks (title, status, created_at, updated_at) VALUES ('t','bogus',0,0)`
    ).run()).toThrow(/CHECK/);
  });
});

// #34: user_version > MIGRATIONS.length означает базу от более новой версии kdd. Раньше цикл
// миграций просто не выполнялся, и код продолжал работать на схеме, которой не знает.
describe('schema version guard', () => {
  const fileDb = (): string => join(mkdtempSync(join(tmpdir(), 'kdd-mig-')), 'kdd.db');

  it('refuses a board from a newer kdd, naming both versions', () => {
    const p = fileDb();
    openDb(p, 'x').close();
    const raw = new Database(p);
    raw.pragma(`user_version = ${MIGRATIONS.length + 3}`);
    raw.close();

    expect(() => openDb(p)).toThrow(KddError);
    expect(() => openDb(p)).toThrow(
      new RegExp(`v${MIGRATIONS.length + 3}.*v${MIGRATIONS.length}`));
  });

  it('backs the board up before migrating it, keeping the pre-migration copy readable', () => {
    const p = fileDb();
    const raw = new Database(p);
    for (let i = 0; i < MIGRATIONS.length - 1; i++) raw.exec(MIGRATIONS[i]);
    raw.prepare(`INSERT INTO tasks (title, created_at, updated_at) VALUES ('keep me', 1, 1)`).run();
    raw.pragma(`user_version = ${MIGRATIONS.length - 1}`);
    raw.close();

    openDb(p).close(); // миграция накатывается заново
    const backup = new Database(`${p}.v${MIGRATIONS.length - 1}.bak`);
    expect(backup.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length - 1);
    expect(backup.prepare(`SELECT title FROM tasks`).get()).toEqual({ title: 'keep me' });
    backup.close();
  });

  it('does not back up a board that needs no migration', () => {
    const p = fileDb();
    openDb(p, 'x').close();
    openDb(p).close(); // второй раз: from === MIGRATIONS.length, копировать нечего
    expect(readdirSync(dirname(p)).filter((f) => f.endsWith('.bak'))).toEqual([]);
  });
});

it('upgrades v14 without changing any kept row, provenance or search hit and keeps a readable backup', async () => {
  const { rmSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'kdd-v15-preserve-')), path = join(root, 'legacy.db');
  const saved = { ...process.env }; process.env.KDD_HOME = join(root, 'home');
  delete process.env.KDD_DB; delete process.env.KDD_DECISIONS_DIR;
  const raw = new Database(path);
  let upgraded: Database.Database | undefined;
  try {
    raw.pragma('foreign_keys=ON'); raw.pragma('journal_mode=WAL');
    for (const migration of MIGRATIONS.slice(0, 14)) raw.exec(migration);
    raw.pragma('user_version=14');
    raw.exec(`
      INSERT INTO tracks VALUES(3,'track','description','active',1);
      INSERT INTO tasks(id,title,body,status,claimed_by,claim_expires,failed_attempts,track_id,created_at,updated_at)
        VALUES(7,'legacy','body','in_progress','ai:legacy',5,2,3,1,2);
      INSERT INTO tasks(id,title,created_at,updated_at) VALUES(8,'managed',1,2);
      INSERT INTO criteria(id,task_id,text,checked_at,evidence,checked_by,position,created_at)
        VALUES(9,7,'proof',3,'passed','user',1,1);
      INSERT INTO comments VALUES(10,7,'user','kept comment',4);
      INSERT INTO events(id,task_id,actor_type,action,detail,created_at) VALUES
        (11,7,'ai','created','{"manual_provenance":{"client":"codex","session_id":"kept"}}',1);
      INSERT INTO events(id,task_id,actor_type,action,detail,parent_id,type,level,created_at)
        VALUES(12,7,'ai','custom','{"proof":"kept"}',11,'audit','warn',2);
      INSERT INTO task_links VALUES(7,8,'depends');
      INSERT INTO files VALUES(13,7,'hash','txt','file.txt','text/plain',4,'attachment',2);
      INSERT INTO agent_events VALUES(14,7,'legacy','run_start','shell','kept',2);
      INSERT INTO errors VALUES(15,'fixture','kept',2);
      INSERT INTO decisions VALUES('decision','Decision','path','hash','2026-09-28',NULL,'[7]');
      INSERT INTO search_index(kind,ref,title,body) VALUES('decision','decision','Decision','searchable');
      INSERT INTO repositories VALUES('${'a'.repeat(32)}','primary','implementation','remote',1);
      UPDATE project SET primary_repo_id='${'a'.repeat(32)}',default_execution_mode='orchestrated',autonomy_enabled=1;
      INSERT INTO repository_bindings VALUES('/unavailable/.git','${'a'.repeat(32)}','/unavailable','source',1);
      INSERT INTO managed_task_policy VALUES(8,2,'controller');
      INSERT INTO run_authorities VALUES('grant',8,'external-item','run',3,9999999999,NULL,'tokenhash','{"kept":true}',3);
    `);
    const tables = ['tasks','criteria','comments','events','task_links','files','errors','tracks',
      'decisions','search_index','meta','project','repositories','repository_bindings'];
    const before = Object.fromEntries(tables.map(t => [t, raw.prepare(`SELECT * FROM ${t}`).all()]));
    upgraded = openDb(path);
    for (const table of tables) {
      const rows = upgraded.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
      // v20 сняла колонки оркестратора: сравниваем по тем, что остались (parent_id добавлен v15).
      const kept = rows.map(({ parent_id, ...old }) => old);
      const keys = Object.keys(kept[0] ?? {});
      expect(kept).toEqual((before[table] as Record<string, unknown>[])
        .map(row => Object.fromEntries(keys.map(k => [k, row[k]]))));
    }
    expect(upgraded.prepare('SELECT parent_id FROM tasks ORDER BY id').all()).toEqual([
      { parent_id: null }, { parent_id: null }]);
    expect(upgraded.prepare("SELECT ref FROM search_index WHERE search_index MATCH 'searchable'").get()).toEqual({ ref: 'decision' });
    expect(upgraded.pragma('foreign_key_check')).toEqual([]);
    const backup = new Database(`${path}.v14.bak`, { readonly: true });
    try {
      expect(backup.pragma('user_version', { simple: true })).toBe(14);
      for (const table of tables) expect(backup.prepare(`SELECT * FROM ${table}`).all()).toEqual(before[table]);
    } finally { backup.close(); }
    upgraded.close(); upgraded = openDb(path);
    expect(upgraded.prepare('SELECT count(*) n FROM tasks').get()).toEqual({ n: 2 });
  } finally {
    if (upgraded?.open) upgraded.close(); raw.close(); process.env = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

describe('migration v20', () => {
  it('v20 drops orchestrator and tick state, keeps tasks, parents and bindings', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    for (let i = 0; i < 19; i++) { db.exec(MIGRATIONS[i]); db.pragma(`user_version = ${i + 1}`); }
    const repo = 'a'.repeat(32);
    db.prepare(`INSERT INTO repositories VALUES(?, 'primary', 'implementation', NULL, 1)`).run(repo);
    db.prepare(`INSERT INTO repository_bindings VALUES('/src/.git', ?, '/src', 'source', 1)`).run(repo);
    db.prepare(`INSERT INTO repository_bindings VALUES('/wt/.git', ?, '/wt', 'managed', 2)`).run(repo);
    db.prepare(`INSERT INTO tasks (title, status, priority, position, created_at, updated_at) VALUES ('p','new','medium',0,1,1)`).run();
    db.prepare(`INSERT INTO tasks (title, status, priority, position, created_at, updated_at, parent_id) VALUES ('c','new','medium',1,1,1,1)`).run();

    db.transaction(() => { db.exec(MIGRATIONS[19]); db.pragma('user_version = 20'); })();

    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')`).all() as { name: string }[]).map(r => r.name);
    for (const gone of ['agent_events', 'managed_task_policy', 'run_authorities', 'work_items', 'work_item_owners',
      'execution_handoffs', 'memory_entries', 'run_input_snapshots', 'role_profiles', 'runtime_sessions',
      'work_item_retirements', 'idx_memory_import_commands']) expect(names).not.toContain(gone);
    expect(names).toEqual(expect.arrayContaining(['task_parent_insert', 'task_parent_update', 'idx_repository_bindings_repo']));
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(c => c.name);
    expect(cols('tasks')).not.toContain('execution_mode');
    expect(cols('tasks')).not.toContain('failed_attempts');
    expect(cols('repositories')).not.toContain('access');
    expect(cols('project')).not.toContain('autonomy_enabled');
    expect(cols('project')).not.toContain('default_execution_mode');
    expect(cols('repository_bindings')).toEqual(['common_dir', 'repo_id', 'checkout_path', 'created_at']);
    expect(db.prepare('SELECT common_dir FROM repository_bindings ORDER BY created_at').all())
      .toEqual([{ common_dir: '/src/.git' }, { common_dir: '/wt/.git' }]);
    expect((db.prepare('SELECT parent_id FROM tasks WHERE id = 2').get() as { parent_id: number }).parent_id).toBe(1);
    expect(() => db.prepare('UPDATE tasks SET parent_id = 1 WHERE id = 1').run()).toThrow();
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('v20 survives owners released via a handoff and a retirement (FK cycle)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    for (let i = 0; i < 19; i++) db.transaction(() => { db.exec(MIGRATIONS[i]); db.pragma(`user_version = ${i + 1}`); })();
    db.transaction(() => {
      db.exec(`INSERT INTO tasks (title,status,priority,position,created_at,updated_at) VALUES ('t','new','medium',0,1,1)`);
      for (const w of ['w1', 'w2']) {
        db.exec(`INSERT INTO work_items VALUES('${w}',1,1,'pending',2,1)`);
        db.exec(`INSERT INTO work_item_revisions VALUES('${w}',1,'{}','{}','x',1)`);
      }
      db.exec(`INSERT INTO execution_handoffs VALUES('h','c',1,'manual','orchestrated','{}',1,2,'{}')`);
      db.exec(`INSERT INTO work_item_owners VALUES('w1',1,1,'o','manual',1,'{}',NULL,NULL,1,2,'h',NULL)`);
      db.exec(`INSERT INTO work_item_owners VALUES('w2',1,1,'o','manual',1,'{}',NULL,NULL,1,NULL,NULL,NULL)`);
      db.exec(`INSERT INTO work_item_retirements VALUES('r','c2','${'a'.repeat(64)}','w2',1,'{}',1,2,'{}')`);
      db.exec(`UPDATE work_item_owners SET released_at=2, release_retirement_id='r' WHERE work_item_id='w2'`);
    })();

    expect(() => db.transaction(() => { db.exec(MIGRATIONS[19]); db.pragma('user_version = 20'); })()).not.toThrow();

    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map(r => r.name);
    for (const gone of ['work_items', 'work_item_owners', 'execution_handoffs', 'work_item_retirements']) expect(names).not.toContain(gone);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
