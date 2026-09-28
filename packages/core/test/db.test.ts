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

it('upgrades v14 without changing any old row, grant, provenance or search hit and keeps a readable backup', async () => {
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
    const tables = ['tasks','criteria','comments','events','task_links','files','agent_events','errors','tracks',
      'decisions','search_index','meta','project','repositories','repository_bindings','managed_task_policy','run_authorities'];
    const before = Object.fromEntries(tables.map(t => [t, raw.prepare(`SELECT * FROM ${t}`).all()]));
    upgraded = openDb(path);
    for (const table of tables) {
      const rows = upgraded.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
      expect(table === 'tasks' ? rows.map(({ parent_id,execution_mode,...old }) => old) : rows).toEqual(before[table]);
    }
    expect(upgraded.prepare('SELECT parent_id,execution_mode FROM tasks ORDER BY id').all()).toEqual([
      { parent_id: null, execution_mode: 'manual' }, { parent_id: null, execution_mode: 'manual' }]);
    expect(upgraded.prepare("SELECT ref FROM search_index WHERE search_index MATCH 'searchable'").get()).toEqual({ ref: 'decision' });
    expect(upgraded.pragma('foreign_key_check')).toEqual([]);
    for (const table of ['work_items','work_item_results','work_item_owners','execution_handoffs']) {
      expect(upgraded.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    const backup = new Database(`${path}.v14.bak`, { readonly: true });
    try {
      expect(backup.pragma('user_version', { simple: true })).toBe(14);
      for (const table of tables) expect(backup.prepare(`SELECT * FROM ${table}`).all()).toEqual(before[table]);
    } finally { backup.close(); }
    upgraded.close(); upgraded = openDb(path);
    expect(upgraded.prepare('SELECT count(*) n FROM tasks').get()).toEqual({ n: 2 });
    expect(upgraded.prepare('SELECT count(*) n FROM managed_task_policy').get()).toEqual({ n: 1 });
  } finally {
    if (upgraded?.open) upgraded.close(); raw.close(); process.env = saved;
    rmSync(root, { recursive: true, force: true });
  }
});
