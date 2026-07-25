import type Database from 'better-sqlite3';
import { KddError } from './errors.js';

// Интервал приходит из HTTP: белый список, а не «любое положительное число».
// Таймер на 1 секунду — это шестьдесят спаунов `kdd tick` в минуту.
export const TICK_INTERVALS = [30, 60, 300, 900] as const;
export const MAX_WORKERS_CAP = 10;

export interface AutoTick { enabled: boolean; intervalSec: number; maxWorkers: number }

export interface TickRun {
  at: number; // секунды, как все таймстемпы в kdd
  reclaimed: number; spawned: number; active: number; reaped: number;
  skipped?: boolean; // проход не состоялся: TICK_LOCK держит другой процесс
  error?: string;
}

const DEFAULTS: AutoTick = { enabled: false, intervalSec: 60, maxWorkers: 3 };

const isInterval = (n: number): boolean =>
  (TICK_INTERVALS as readonly number[]).includes(n);
const isWorkers = (n: number): boolean =>
  Number.isInteger(n) && n >= 1 && n <= MAX_WORKERS_CAP;

function readMeta(db: Database.Database, key: string): string | undefined {
  return (db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
    { value: string } | undefined)?.value;
}

function writeMeta(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function getAutoTick(db: Database.Database): AutoTick {
  const interval = Number(readMeta(db, 'autotick_interval_sec'));
  const workers = Number(readMeta(db, 'autotick_max_workers'));
  // Невалидное значение в meta (правка руками, откат схемы) читается как дефолт:
  // доска важнее, чем строгость к содержимому key-value таблицы.
  return {
    enabled: readMeta(db, 'autotick_enabled') === '1',
    intervalSec: isInterval(interval) ? interval : DEFAULTS.intervalSec,
    maxWorkers: isWorkers(workers) ? workers : DEFAULTS.maxWorkers,
  };
}

export function setAutoTick(db: Database.Database, patch: Partial<AutoTick>): AutoTick {
  if (patch.intervalSec !== undefined && !isInterval(patch.intervalSec)) {
    throw new KddError(`interval must be one of ${TICK_INTERVALS.join(', ')} seconds`);
  }
  if (patch.maxWorkers !== undefined && !isWorkers(patch.maxWorkers)) {
    throw new KddError(`max workers must be an integer between 1 and ${MAX_WORKERS_CAP}`);
  }
  return db.transaction(() => {
    if (patch.enabled !== undefined) {
      writeMeta(db, 'autotick_enabled', patch.enabled ? '1' : '0');
    }
    if (patch.intervalSec !== undefined) {
      writeMeta(db, 'autotick_interval_sec', String(patch.intervalSec));
    }
    if (patch.maxWorkers !== undefined) {
      writeMeta(db, 'autotick_max_workers', String(patch.maxWorkers));
    }
    return getAutoTick(db);
  })();
}

export function getLastRun(db: Database.Database): TickRun | null {
  const raw = readMeta(db, 'autotick_last');
  if (raw === undefined) return null;
  try { return JSON.parse(raw) as TickRun; } catch { return null; }
}

export function setLastRun(db: Database.Database, run: TickRun): void {
  db.transaction(() => writeMeta(db, 'autotick_last', JSON.stringify(run)))();
}

// Единая точка правды для обоих потребителей — `kdd tick` и web UI. env выше
// сохранённой настройки: это разовый override для скриптов и тестов, а не
// пользовательский выбор, поэтому UI при выставленном env гасит поле.
export function maxWorkers(db: Database.Database): number {
  const env = process.env.KDD_MAX_WORKERS;
  if (env === undefined) return getAutoTick(db).maxWorkers;
  const n = Number(env);
  if (!Number.isInteger(n) || n < 1) {
    throw new KddError('KDD_MAX_WORKERS must be a positive integer');
  }
  return n;
}

export const maxWorkersEnvLocked = (): boolean =>
  process.env.KDD_MAX_WORKERS !== undefined;
