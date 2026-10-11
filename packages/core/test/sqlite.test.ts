import { describe, it, expect } from 'vitest';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { Db, checkpointWal } from '../src/db.js';

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

  // A misspelt key must fail loudly, not bind the intended one as NULL.
  it('prepare rejects unknown named keys', () => {
    const db = new Db(':memory:');
    expect(() => db.prepare('SELECT @status AS s').all({ status: 1, stauts: 2 })).toThrow(/unknown named parameter/i);
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
    expect(disk.name).toBe(p);
  });

  // Attachments live next to db.name: through a symlinked KDD_DB they must follow the link, not its target.
  it('name is the path as given (symlink kept) and stays readable after close', () => {
    const target = file();
    new Db(target).close();
    const link = join(dirname(target), 'link.db');
    symlinkSync(target, link);
    const db = new Db(link);
    expect(db.name).toBe(link);
    db.close();
    expect(db.name).toBe(link);
    expect(db.memory).toBe(false);
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

  it('checkpointWal restores the connection\'s own busy timeout', () => {
    const db = new Db(file(), { timeout: 1234 });
    db.exec('PRAGMA journal_mode = WAL; CREATE TABLE t(x)');
    checkpointWal(db);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(1234);
    db.close();
  });

  // A fresh process: the import-time load must print nothing, and the filter must be gone a tick
  // later — a library consumer's own SQLite warning (emitted by hand here) reaches stderr.
  it('swallows the load-time SQLite warning, then restores process.emit', () => {
    const core = new URL('../dist/index.js', import.meta.url).href;
    const script = `await import(${JSON.stringify(core)});
      setImmediate(() => setImmediate(() => process.emitWarning('late SQLite notice', 'ExperimentalWarning')));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/SQLite is an experimental/);
    expect(r.stderr).toMatch(/late SQLite notice/);
  });
});
