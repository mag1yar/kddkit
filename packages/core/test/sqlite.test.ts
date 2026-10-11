import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/db.js';

const file = (): string => join(mkdtempSync(join(tmpdir(), 'kdd-sqlite-')), 'k.db');
const count = (db: Db): number => (db.prepare('SELECT COUNT(*) c FROM t').get() as { c: number }).c;

describe('Db', () => {
  it('transaction commits and returns the value; throw rolls back and rethrows', () => {
    const db = new Db(':memory:');
    db.exec('CREATE TABLE t(x)');
    expect(db.transaction(() => { db.exec('INSERT INTO t VALUES (1)'); return 42; })()).toBe(42);
    expect(() => db.transaction(() => { db.exec('INSERT INTO t VALUES (2)'); throw new Error('boom'); })())
      .toThrow('boom');
    expect(count(db)).toBe(1);
    expect(db.isTransaction).toBe(false);
  });

  it('immediate returns the value', () => {
    const db = new Db(':memory:');
    expect(db.transaction(() => 7).immediate()).toBe(7);
  });

  it('nested failure rolls back only the savepoint; outer commits', () => {
    const db = new Db(':memory:');
    db.exec('CREATE TABLE t(x)');
    db.transaction(() => {
      db.exec('INSERT INTO t VALUES (1)');
      try {
        db.transaction(() => { db.exec('INSERT INTO t VALUES (2)'); throw new Error('inner'); }).immediate();
      } catch { /* expected */ }
      db.exec('INSERT INTO t VALUES (3)');
    }).immediate();
    expect((db.prepare('SELECT x FROM t ORDER BY x').all() as { x: number }[]).map((r) => r.x)).toEqual([1, 3]);
  });

  it('refuses a promise-returning function and rolls back', () => {
    const db = new Db(':memory:');
    db.exec('CREATE TABLE t(x)');
    expect(() => db.transaction(() => { db.exec('INSERT INTO t VALUES (1)'); return Promise.resolve(); })())
      .toThrow(TypeError);
    expect(count(db)).toBe(0);
  });

  it('pragma: simple gives the value, otherwise rows', () => {
    const db = new Db(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(0);
    db.pragma('user_version = 3');
    expect(db.pragma('user_version', { simple: true })).toBe(3);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('prepare tolerates extra named keys', () => {
    const db = new Db(':memory:');
    expect(db.prepare('SELECT 1 AS one').all({ status: null })).toEqual([{ one: 1 }]);
  });

  // better-sqlite3 bound undefined as NULL; node:sqlite throws — callers must pass `?? null`.
  it('binding undefined throws', () => {
    const db = new Db(':memory:');
    expect(() => db.prepare('SELECT ?').get(undefined)).toThrow();
  });

  it('name and memory', () => {
    const mem = new Db(':memory:');
    expect(mem.memory).toBe(true);
    expect(mem.name).toBe(':memory:');
    const p = file();
    const disk = new Db(p);
    expect(disk.memory).toBe(false);
    expect(realpathSync(disk.name)).toBe(realpathSync(p));
  });

  it('close is idempotent', () => {
    const db = new Db(':memory:');
    db.close();
    expect(() => db.close()).not.toThrow();
  });

  it('readOnly connection rejects writes', () => {
    const p = file();
    const w = new Db(p);
    w.exec('CREATE TABLE t(x)');
    w.close();
    const r = new Db(p, { readOnly: true });
    expect(() => r.exec('INSERT INTO t VALUES (1)')).toThrow(/readonly/i);
    r.close();
  });

  it('waits for a busy writer up to its timeout instead of failing at once', () => {
    const p = file();
    const a = new Db(p);
    a.exec('PRAGMA journal_mode = WAL; CREATE TABLE t(x)');
    a.exec('BEGIN IMMEDIATE');
    const b = new Db(p, { timeout: 200 });
    const started = Date.now();
    expect(() => b.transaction(() => b.exec('INSERT INTO t VALUES (1)')).immediate()).toThrow(/locked|busy/i);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    a.exec('ROLLBACK');
    a.close(); b.close();
  });

  it('default busy timeout is 5000', () => {
    expect(new Db(':memory:').pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it('swallows only the SQLite ExperimentalWarning', async () => {
    const seen: string[] = [];
    const listener = (w: Error): void => { seen.push(w.message); };
    // Node's default printer would dump the unfiltered warnings to stderr — detach it for the test.
    const saved = process.listeners('warning');
    process.removeAllListeners('warning');
    process.on('warning', listener);
    try {
      process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
      process.emitWarning('something else is experimental', 'ExperimentalWarning');
      process.emitWarning('plain warning');
      await new Promise((r) => setTimeout(r, 20)); // emitWarning delivers on nextTick
    } finally {
      process.off('warning', listener);
      for (const l of saved) process.on('warning', l);
    }
    expect(seen).toEqual(['something else is experimental', 'plain warning']);
  });
});
