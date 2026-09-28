import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import * as core from '../src/index.js';
import type Database from 'better-sqlite3';

const cleanups: (() => void)[] = [];
export function cleanupFixtures(): void {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
}
export function fixture(): {
  root: string; home: string; repo: string; dbPath: string; db: Database.Database;
  handle: core.ControllerHandle; projectId: string; ref: (id: number) => core.TaskRef;
  task: (title: string) => core.Task; git: (...args: string[]) => string;
} {
  const saved = { ...process.env };
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kdd-execution-')));
  const home = join(root, 'home'), repo = join(root, 'source');
  mkdirSync(repo); process.env.KDD_HOME = home;
  delete process.env.KDD_DB; delete process.env.KDD_DECISIONS_DIR;
  const git = (...args: string[]) => execFileSync('git', args,
    { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '--allow-empty', '-m', 'seed');
  const dbPath = join(home, 'external-store.db');
  const db: Database.Database = core.openDb(dbPath, core.canonicalCommonDir(repo), repo);
  const handle = core.openController(db), projectId = core.projectOf(db).project_id;
  const ref = (taskId: number): core.TaskRef => ({ projectId, taskId });
  const task = (title: string) => core.addTask(db,
    { title, body: 'contract', criteria: ['required outcome'] }, { type: 'ai', id: 'fixture' });
  cleanups.push(() => {
    if (db.open) db.close(); process.env = saved;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, home, repo, dbPath, db, handle, projectId, ref, task, git };
}
