import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveDbPath, listProjects, kddHome } from '../src/paths.js';
import { openDb } from '../src/db.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kdd-t-')); });
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.KDD_DB; delete process.env.KDD_HOME;
});

describe('resolveDbPath', () => {
  it('honors KDD_DB override', () => {
    process.env.KDD_DB = join(dir, 'x.db');
    expect(resolveDbPath(dir).dbPath).toBe(join(dir, 'x.db'));
  });

  it('maps a git repo (and its worktree) to the same db path', () => {
    execFileSync('git', ['init', dir]);
    const a = resolveDbPath(dir);
    const wt = join(dir, '..', 'kdd-t-wt');
    execFileSync('git', ['worktree', 'add', '-b', 'w', wt], { cwd: dir });
    try {
      expect(resolveDbPath(wt).dbPath).toBe(a.dbPath);
    } finally { execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: dir }); }
  });

  it('throws KddError outside a git repo', () => {
    expect(() => resolveDbPath(tmpdir())).toThrow(/not in a git repository/);
  });
});

describe('listProjects', () => {
  it('finds created dbs with their project paths', () => {
    process.env.KDD_HOME = join(dir, 'home');
    mkdirSync(join(dir, 'home', 'abc123'), { recursive: true });
    openDb(join(dir, 'home', 'abc123', 'kdd.db'), 'C:/my/proj').close();
    expect(listProjects()).toEqual([
      { dbPath: join(kddHome(), 'abc123', 'kdd.db'), projectPath: 'C:/my/proj' },
    ]);
  });
});
