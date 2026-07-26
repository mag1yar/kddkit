import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addTask, ensureWorktree, openDb, sweepWorktrees, taskBranchHead, worktreePath } from '../src/index.js';

let repo: string;
let dbPath: string;

function g(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'kdd-wt-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  execFileSync('git', ['commit', '--allow-empty', '-qm', 'root'], { cwd: repo });
  // стор-корень = dirname(dbPath); держим отдельно от репо, как в проде (~/.kdd/<hash>/kdd.db)
  const store = mkdtempSync(join(tmpdir(), 'kdd-wt-store-'));
  dbPath = join(store, 'kdd.db');
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(join(dbPath, '..'), { recursive: true, force: true });
});

describe('worktreePath', () => {
  it('детерминирован, в worktrees/, slug из title', () => {
    const p = worktreePath(dbPath, 7, 'Fix The Bug!');
    expect(p).toBe(worktreePath(dbPath, 7, 'Fix The Bug!'));
    expect(p).toContain(join('worktrees', 'task-7-'));
    expect(p).toMatch(/task-7-fix-the-bug$/);
  });
});

describe('taskBranchHead', () => {
  it('возвращает tip ветки kdd/task-<id> и переживает снос worktree', () => {
    const wt = ensureWorktree(repo, dbPath, 1, 'x');
    g(['-C', wt, 'commit', '--allow-empty', '-qm', 'work']);
    const tip = g(['rev-parse', 'HEAD'], wt);
    expect(taskBranchHead(repo, 1)).toBe(tip);
    // снос worktree (как sweepWorktrees) — ветка остаётся в главном репо
    g(['worktree', 'remove', '--force', wt]);
    expect(existsSync(wt)).toBe(false);
    expect(taskBranchHead(repo, 1)).toBe(tip); // всё ещё читается из ветки
  });

  it('null когда ветки задачи нет', () => {
    expect(taskBranchHead(repo, 999)).toBeNull();
  });
});

describe('ensureWorktree', () => {
  it('создаёт worktree на ветке kdd/task-<id>', () => {
    const p = ensureWorktree(repo, dbPath, 3, 'my task');
    expect(existsSync(p)).toBe(true);
    const list = g(['worktree', 'list', '--porcelain']);
    expect(list).toContain(`worktree ${p}`);
    expect(list).toContain('branch refs/heads/kdd/task-3');
  });

  it('повторный вызов (healthy) → тот же путь, не падает', () => {
    const a = ensureWorktree(repo, dbPath, 3, 'my task');
    const b = ensureWorktree(repo, dbPath, 3, 'my task');
    expect(b).toBe(a);
    expect(existsSync(b)).toBe(true);
  });

  it('каталог удалён вручную → пересоздаёт (idempotent recovery)', () => {
    const a = ensureWorktree(repo, dbPath, 3, 'my task');
    rmSync(a, { recursive: true, force: true });
    const b = ensureWorktree(repo, dbPath, 3, 'my task');
    expect(existsSync(b)).toBe(true);
    expect(g(['worktree', 'list', '--porcelain'])).toContain('branch refs/heads/kdd/task-3');
  });

  it('ветка уже есть, worktree снят → checkout существующей (не -b)', () => {
    const a = ensureWorktree(repo, dbPath, 3, 'my task');
    g(['worktree', 'remove', '--force', a]); // worktree убран, ВЕТКА kdd/task-3 осталась
    const b = ensureWorktree(repo, dbPath, 3, 'my task'); // не должно упасть "branch already exists"
    expect(existsSync(b)).toBe(true);
    expect(g(['branch', '--list', 'kdd/task-3'])).toContain('kdd/task-3');
  });
});

describe('sweepWorktrees', () => {
  // Задача с worktree, статус которой задаём. db из openDb(':memory:') — реальная схема.
  function seed(status: 'in_progress' | 'review'): { db: Database.Database; p: string } {
    const db = openDb(':memory:');
    const t = addTask(db, { title: 'w' }, { type: 'user' }); // #1
    const p = ensureWorktree(repo, dbPath, t.id, 'w');
    // прогнать в нужный статус напрямую (claim-инварианты тут не тестируем)
    db.prepare(`UPDATE tasks SET status=? WHERE id=?`).run(status, t.id);
    return { db, p };
  }

  it('задача in_progress → worktree жив, ничего не снесено', () => {
    const { db, p } = seed('in_progress');
    expect(sweepWorktrees(db, repo)).toBe(0);
    expect(existsSync(p)).toBe(true);
    db.close();
  });

  it('задача не in_progress → worktree снесён, ВЕТКА осталась', () => {
    const { db, p } = seed('review');
    expect(sweepWorktrees(db, repo)).toBe(1);
    expect(existsSync(p)).toBe(false);
    expect(g(['branch', '--list', 'kdd/task-1'])).toContain('kdd/task-1'); // коммиты агента целы
    db.close();
  });

  it('чужой worktree (не kdd/task-*) не тронут', () => {
    const db = openDb(':memory:');
    // уникальный путь (не repo/../other-wt — тот коллапсирует в общий tmp-корень и течёт между запусками)
    const otherRoot = mkdtempSync(join(tmpdir(), 'kdd-wt-other-'));
    const other = join(otherRoot, 'wt');
    try {
      g(['worktree', 'add', other, '-b', 'feature/x']);
      const before = g(['worktree', 'list', '--porcelain']);
      expect(sweepWorktrees(db, repo)).toBe(0);
      expect(g(['worktree', 'list', '--porcelain'])).toBe(before);
    } finally {
      g(['worktree', 'remove', '--force', other]);
      rmSync(otherRoot, { recursive: true, force: true });
      db.close();
    }
  });
});

describe('sweepWorktrees isBusy guard', () => {
  it('keeps a worktree whose task is done but whose process is still alive', () => {
    const db = openDb(dbPath, repo);
    const t = addTask(db, { title: 'busy' }, { type: 'user' });
    const wt = ensureWorktree(repo, dbPath, t.id, 'busy'); // задача в new → sweep обычно снёс бы
    expect(sweepWorktrees(db, repo, () => true)).toBe(0);
    expect(existsSync(wt)).toBe(true);
    db.close();
  });

  it('removes it once the process is gone', () => {
    const db = openDb(dbPath, repo);
    const t = addTask(db, { title: 'idle' }, { type: 'user' });
    const wt = ensureWorktree(repo, dbPath, t.id, 'idle');
    expect(sweepWorktrees(db, repo, () => false)).toBe(1);
    expect(existsSync(wt)).toBe(false);
    db.close();
  });

  it('without a probe behaves exactly as before', () => {
    const db = openDb(dbPath, repo);
    const t = addTask(db, { title: 'plain' }, { type: 'user' });
    ensureWorktree(repo, dbPath, t.id, 'plain');
    expect(sweepWorktrees(db, repo)).toBe(1);
    db.close();
  });
});
