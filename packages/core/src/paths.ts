import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { KddError } from './errors.js';
import { lookupProjectStore } from './project_store.js';
import { realpathSync } from 'node:fs';

export const kddHome = (): string => process.env.KDD_HOME ?? join(homedir(), '.kdd');

// KDD_DB выбирает доску по умолчанию, KDD_HOME — остальные доски в UI.
export const storeIdentity = (): string => createHash('sha256')
  .update(resolve(kddHome())).update('\0')
  .update(process.env.KDD_DB ? resolve(process.env.KDD_DB) : '')
  .digest('hex').slice(0, 16);

export function resolveDbPath(cwd: string = process.cwd()): { dbPath: string; projectPath: string } {
  if (process.env.KDD_DB) return { dbPath: process.env.KDD_DB, projectPath: cwd };
  let common: string;
  try {
    common = execFileSync('git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new KddError('not in a git repository (kdd resolves its store via git)');
  }
  const registered = lookupProjectStore(realpathSync(common), kddHome());
  if (registered) return registered;
  const hash = createHash('sha256').update(common).digest('hex').slice(0, 16);
  return { dbPath: join(kddHome(), hash, 'kdd.db'), projectPath: common };
}

export function resolveDecisionsDir(cwd: string = process.cwd()): string {
  if (process.env.KDD_DECISIONS_DIR) return process.env.KDD_DECISIONS_DIR;
  let top: string;
  try {
    top = execFileSync('git', ['rev-parse', '--show-toplevel'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new KddError('not in a git repository (kdd resolves .planning via git)');
  }
  return join(top, '.planning', 'decisions');
}

export function resolveToplevel(cwd: string = process.cwd()): string {
  if (process.env.KDD_TOPLEVEL) return process.env.KDD_TOPLEVEL; // override для тестов/edge
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new KddError('not in a git repository (kdd resolves the checkout via git)');
  }
}

export function listProjects(): { dbPath: string; projectPath: string }[] {
  const home = kddHome();
  if (!existsSync(home)) return [];
  const out: { dbPath: string; projectPath: string }[] = [];
  for (const entry of readdirSync(home, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dbPath = join(home, entry.name, 'kdd.db');
    if (!existsSync(dbPath)) continue;
    try {
      const db = new Database(dbPath, { readonly: true });
      const row = db.prepare(`SELECT value FROM meta WHERE key = 'project_path'`).get() as
        { value: string } | undefined;
      db.close();
      out.push({ dbPath, projectPath: row?.value ?? '(unknown)' });
    } catch { /* повреждённая база — пропускаем, не падаем */ }
  }
  return out;
}
