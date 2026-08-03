import type Database from 'better-sqlite3';
import { KddError } from './errors.js';

// Интервал приходит из HTTP: белый список, а не «любое положительное число».
// Таймер на 1 секунду — это шестьдесят спаунов `kdd tick` в минуту.
export const TICK_INTERVALS = [30, 60, 300, 900] as const;
export const MAX_WORKERS_CAP = 10;

export interface AutoTick { enabled: boolean; intervalSec: number; maxWorkers: number }

export interface TickRun {
  at: number; // секунды, как все таймстемпы в kdd
  // stuck — воркер пережил SIGKILL и всё ещё держит слот: единственный сигнал доски о том,
  // что чинить надо руками. Поле обязательное, чтобы ни один продюсер TickRun о нём не забыл.
  reclaimed: number; killed: number; stuck: number; spawned: number; active: number; reaped: number;
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

// Сколько сессий держим в дедупе одновременно — старейшая (по очереди записи) вылетает первой.
// Один воркер на слот, слотов до MAX_WORKERS_CAP: этого хватает с запасом на всю ночь тика.
const MAX_REMINDED_SESSIONS = 10;

/**
 * Дедуп Stop-напоминаний (#119): одно напоминание на задачу за сессию. `Stop` срабатывает на
 * каждом ходу, и хук, повторяющий одно и то же, читается как шум.
 *
 * Строка одна на всю базу, но внутри — список пар session/ids, а не одна пара: store keyed по
 * git-common-dir, так что все воркеры одного репо делят этот `meta`-ключ. Одна пара на всех
 * значила бы, что вторая параллельная сессия при каждом ходе стирает дедуп первой — и обе
 * напоминают на каждом ходу вечно, ровно тот шум, для которого дедуп существует. Список с
 * потолком в MAX_REMINDED_SESSIONS держит строку одной и ограниченной без отдельной таблицы.
 */
export function getReminded(db: Database.Database, session: string): number[] {
  return readReminded(db).find(([s]) => s === session)?.[1] ?? [];
}

export function setReminded(db: Database.Database, session: string, ids: number[]): void {
  db.transaction(() => {
    const kept = readReminded(db).filter(([s]) => s !== session);
    kept.push([session, ids]); // недавняя сессия — в конец
    writeMeta(db, 'stop_reminded',
      JSON.stringify(kept.slice(Math.max(0, kept.length - MAX_REMINDED_SESSIONS))));
  })();
}

/**
 * Список пар, а не объект: у объекта числоподобный ключ («7») JS всегда сортирует впереди всех
 * прочих, сколько его ни перезаписывай, — такая сессия вылетала бы по потолку сразу после
 * записи. У массива порядок это и есть порядок. Всё, что не список пар (легаси-формат
 * {session, ids}, карта, мусор), читается как «пусто», а не чинится: дедуп восстановится сам
 * на следующей записи, а вот угадывать чужой формат нечем.
 */
function readReminded(db: Database.Database): [string, number[]][] {
  try {
    const raw = JSON.parse(readMeta(db, 'stop_reminded') ?? 'null') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((e): e is [string, number[]] =>
      Array.isArray(e) && typeof e[0] === 'string' && Array.isArray(e[1]));
  } catch {
    return [];
  }
}
