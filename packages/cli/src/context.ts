import Database from 'better-sqlite3';
import { agentId, KddError, openDb, resolveDbPath, type Actor } from '@kddkit/core';

/**
 * Кто дёргает CLI. KDD_ACTOR — явное слово (его ставят tick/worker), иначе смотрим на само
 * окружение: Claude Code выставляет CLAUDECODE=1 каждой команде своего Bash-инструмента.
 * Раньше дефолтом был `user`, и агент без экспортированной переменной писался в лог человеком —
 * а заодно проскакивал мимо всех ai-гейтов checkMove: правило ядра работало как opt-in.
 * Ручной запуск из сессии Claude («! kdd …») тоже посчитается агентом — обходится KDD_ACTOR=user.
 */
export function getActor(): Actor {
  const explicit = process.env.KDD_ACTOR;
  if (explicit === 'user') return { type: 'user' };
  if (explicit !== 'ai' && process.env.CLAUDECODE !== '1') return { type: 'user' };
  return { type: 'ai', id: agentId() };
}

export function withDbAt<T>(dbPath: string, projectPath: string, fn: (db: Database.Database) => T): T {
  const db = openDb(dbPath, projectPath);
  try { return fn(db); } finally { db.close(); }
}

export function withDb<T>(fn: (db: Database.Database) => T): T {
  const { dbPath, projectPath } = resolveDbPath();
  return withDbAt(dbPath, projectPath, fn);
}

export function parseId(s: string): number {
  const n = Number(s.replace(/^#/, ''));
  if (!Number.isInteger(n) || n <= 0) throw new KddError(`invalid task id '${s}'`);
  return n;
}

export function fail(msg: string, json: boolean): never {
  if (json) console.log(JSON.stringify({ error: msg }));
  else console.error(`error: ${msg}`);
  process.exit(1);
}
