import { describe, it, expect } from 'vitest';
import {
  MIGRATIONS, openDb, projectPathOf, projectToplevelOf, setProjectToplevel,
} from '../src/db.js';

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
