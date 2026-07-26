import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  KddError, MAX_WORKERS_CAP, TICK_INTERVALS, getAutoTick, getLastRun, maxWorkers,
  maxWorkersEnvLocked, openDb, setAutoTick, setLastRun,
} from '../src/index.js';

const mk = (): Database.Database => openDb(':memory:', 'x');

afterEach(() => { delete process.env.KDD_MAX_WORKERS; });

describe('getAutoTick', () => {
  it('на пустой базе отдаёт дефолты', () => {
    expect(getAutoTick(mk())).toEqual({ enabled: false, intervalSec: 60, maxWorkers: 3 });
  });

  it('мусор в meta читается как дефолт, а не роняет вызов', () => {
    const db = mk();
    db.prepare(`INSERT INTO meta (key, value) VALUES ('autotick_interval_sec', 'кажется')`).run();
    db.prepare(`INSERT INTO meta (key, value) VALUES ('autotick_max_workers', '-4')`).run();
    expect(getAutoTick(db)).toEqual({ enabled: false, intervalSec: 60, maxWorkers: 3 });
  });
});

describe('setAutoTick', () => {
  it('пишет патч и возвращает полное состояние', () => {
    const db = mk();
    expect(setAutoTick(db, { enabled: true, intervalSec: 300 }))
      .toEqual({ enabled: true, intervalSec: 300, maxWorkers: 3 });
    expect(getAutoTick(db)).toEqual({ enabled: true, intervalSec: 300, maxWorkers: 3 });
  });

  it('патч не трогает поля, которых в нём нет', () => {
    const db = mk();
    setAutoTick(db, { enabled: true, intervalSec: 900, maxWorkers: 7 });
    setAutoTick(db, { maxWorkers: 2 });
    expect(getAutoTick(db)).toEqual({ enabled: true, intervalSec: 900, maxWorkers: 2 });
  });

  it('отбивает интервал вне белого списка', () => {
    const db = mk();
    expect(() => setAutoTick(db, { intervalSec: 1 })).toThrow(KddError);
    expect(() => setAutoTick(db, { intervalSec: 45 })).toThrow(/30, 60, 300, 900/);
    expect(getAutoTick(db).intervalSec).toBe(60); // ничего не записалось
  });

  it('отбивает max workers вне 1..CAP и нецелые', () => {
    const db = mk();
    expect(() => setAutoTick(db, { maxWorkers: 0 })).toThrow(KddError);
    expect(() => setAutoTick(db, { maxWorkers: MAX_WORKERS_CAP + 1 })).toThrow(KddError);
    expect(() => setAutoTick(db, { maxWorkers: 2.5 })).toThrow(KddError);
    expect(getAutoTick(db).maxWorkers).toBe(3);
  });

  it('белый список — ровно четыре значения', () => {
    expect([...TICK_INTERVALS]).toEqual([30, 60, 300, 900]);
  });
});

describe('last run', () => {
  it('null до первого прохода, roundtrip после', () => {
    const db = mk();
    expect(getLastRun(db)).toBeNull();
    const run = { at: 1700000000, reclaimed: 1, killed: 0, stuck: 0, spawned: 2, active: 3, reaped: 0 };
    setLastRun(db, run);
    expect(getLastRun(db)).toEqual(run);
  });

  it('битый JSON в meta читается как null', () => {
    const db = mk();
    db.prepare(`INSERT INTO meta (key, value) VALUES ('autotick_last', '{oops')`).run();
    expect(getLastRun(db)).toBeNull();
  });
});

describe('maxWorkers', () => {
  it('env перебивает meta, meta перебивает дефолт', () => {
    const db = mk();
    expect(maxWorkers(db)).toBe(3);
    expect(maxWorkersEnvLocked()).toBe(false);
    setAutoTick(db, { maxWorkers: 5 });
    expect(maxWorkers(db)).toBe(5);
    process.env.KDD_MAX_WORKERS = '1';
    expect(maxWorkers(db)).toBe(1);
    expect(maxWorkersEnvLocked()).toBe(true);
  });

  it('мусорный env — внятная ошибка, а не тихий NaN', () => {
    const db = mk();
    process.env.KDD_MAX_WORKERS = 'два';
    expect(() => maxWorkers(db)).toThrow(/KDD_MAX_WORKERS/);
  });
});
