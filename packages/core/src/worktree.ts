import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { slugify } from './decisions.js';

const branchName = (taskId: number): string => `kdd/task-${taskId}`;
const BRANCH_RE = /^refs\/heads\/kdd\/task-(\d+)$/;

// git в repoRoot; бросает при ненулевом коде. stderr капчерим (pipe), иначе упавший
// `git worktree add` даёт только exit-код — на молчаливом tick-пути это единственная диагностика.
function git(repoRoot: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    const detail = (err.stderr ?? '').trim() || err.message || 'git failed';
    throw new Error(`git ${args.join(' ')}: ${detail}`);
  }
}
// git best-effort: глотает ошибку (remove/prune несуществующего — не беда).
function gitTry(repoRoot: string, args: string[]): void {
  try { git(repoRoot, args); } catch { /* ignore */ }
}

// Детерминированный путь worktree задачи. Корень стора = dirname(kdd.db) = ~/.kdd/<hash>/.
// realpath корня: git worktree add канонизирует путь через symlink-родителя (macOS /tmp,/var → /private/...),
// без этого свежесозданный путь разошёлся бы со строкой, которую вернёт `git worktree list`.
export function worktreePath(dbPath: string, taskId: number, title: string): string {
  const root = dirname(dbPath);
  const realRoot = existsSync(root) ? realpathSync(root) : root;
  return join(realRoot, 'worktrees', `task-${taskId}-${slugify(title)}`);
}

// HEAD-коммит worktree/репо. Тонкая обёртка над git() — воркер снимает before/after HEAD рана.
export function headCommit(repoRoot: string): string {
  return git(repoRoot, ['rev-parse', 'HEAD']);
}

// Тип коммита ВЕТКИ задачи (kdd/task-<id>) из главного репо. null — ветки нет.
// Ветка живёт в главном репо и переживает снос worktree (sweepWorktrees удаляет worktree, ветку
// оставляет). Для run_end: after_head остаётся читаемым, даже если worktree воркера уже сметён
// гонкой с tick.sweepWorktrees — иначе завершённый ран с реальными коммитами выглядел бы пустым.
export function taskBranchHead(repoRoot: string, taskId: number): string | null {
  try { return git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName(taskId)}`]); }
  catch { return null; } // ref нет → non-zero exit → git() бросает
}

interface WtEntry { path: string; branch: string | null }
// Парс `git worktree list --porcelain`. branch=null для detached/main-bare. Internal — не в barrel.
function listWorktrees(repoRoot: string): WtEntry[] {
  const out = git(repoRoot, ['worktree', 'list', '--porcelain']);
  const entries: WtEntry[] = [];
  let cur: WtEntry | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) entries.push(cur);
      cur = { path: line.slice(9), branch: null }; // 'worktree '.length === 9
    } else if (line.startsWith('branch ') && cur) {
      cur.branch = line.slice(7); // 'branch '.length === 7
    }
  }
  if (cur) entries.push(cur);
  return entries;
}

function branchExists(repoRoot: string, branch: string): boolean {
  try { git(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]); return true; }
  catch { return false; }
}

// Idempotent: гарантирует worktree на ветке kdd/task-<id>, возвращает путь.
// Reuse — по ВЕТКЕ (path-agnostic: обходит macos /tmp↔/private/tmp symlink-сравнение и смену slug).
export function ensureWorktree(
  repoRoot: string, dbPath: string, taskId: number, title: string,
): string {
  const branch = branchName(taskId);
  const ref = `refs/heads/${branch}`;
  const existing = listWorktrees(repoRoot).find((e) => e.branch === ref);
  if (existing && existsSync(existing.path)) return existing.path; // живой — reuse как есть
  if (existing) gitTry(repoRoot, ['worktree', 'remove', '--force', existing.path]); // ветка есть, каталог пропал
  const path = worktreePath(dbPath, taskId, title);
  gitTry(repoRoot, ['worktree', 'prune']);
  rmSync(path, { recursive: true, force: true }); // снести незарегистрированный каталог на целевом слоте
  const tail = branchExists(repoRoot, branch) ? [path, branch] : [path, '-b', branch];
  git(repoRoot, ['worktree', 'add', ...tail]);
  return path;
}

// Рипер: снести kdd-worktree, чья задача НЕ in_progress. Ветку оставить (работа в коммитах). → число снесённых.
// DB-driven: tasks.status и есть tombstone. Зовётся из `kdd tick` после reclaimExpired.
// isBusy — вторая, ОС-овая половина правды: kill best-effort, и процесс может пережить реклейм.
// Снести каталог под живым процессом = отобрать у него рабочую копию посреди записи.
export function sweepWorktrees(
  db: Database.Database, repoRoot: string, isBusy?: (taskId: number) => boolean,
): number {
  const stmt = db.prepare(`SELECT status FROM tasks WHERE id = ?`);
  let removed = 0;
  for (const e of listWorktrees(repoRoot)) {
    const m = e.branch?.match(BRANCH_RE);
    if (!m) continue; // чужой worktree или main — не наша забота
    const taskId = Number(m[1]);
    const row = stmt.get(taskId) as { status: string } | undefined;
    if (row?.status === 'in_progress') continue; // активная задача — worktree жив
    if (isBusy?.(taskId)) continue; // процесс ещё жив, что бы ни говорил статус
    gitTry(repoRoot, ['worktree', 'remove', '--force', e.path]);
    removed++;
  }
  if (removed) gitTry(repoRoot, ['worktree', 'prune']);
  return removed;
}
