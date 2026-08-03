import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  KddError, MAX_WORKERS_CAP, TICK_INTERVALS, getAutoTick, getLastRun, getReminded, maxWorkers,
  maxWorkersEnvLocked, openDb, setAutoTick, setLastRun, setReminded,
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

// #119: дедуп Stop-напоминаний. Строка одна на базу и принадлежит текущей сессии.
describe('stop reminders', () => {
  it('на чистой базе ничего не напомнено', () => {
    expect(getReminded(mk(), 'cc:abcdef12')).toEqual([]);
  });

  it('читает записанное этой же сессией', () => {
    const db = mk();
    setReminded(db, 'cc:abcdef12', [119, 121]);
    expect(getReminded(db, 'cc:abcdef12')).toEqual([119, 121]);
  });

  it('чужая сессия не видит чужого списка, но своя выживает: meta не растёт', () => {
    const db = mk();
    setReminded(db, 'cc:abcdef12', [119]);
    expect(getReminded(db, 'cc:99999999')).toEqual([]);
    setReminded(db, 'cc:99999999', [7]);
    // до Fix 2 вторая запись стирала первую целиком; теперь обе сессии живут в одной строке.
    expect(getReminded(db, 'cc:abcdef12')).toEqual([119]);
    expect(getReminded(db, 'cc:99999999')).toEqual([7]);
    expect(db.prepare(`SELECT COUNT(*) c FROM meta WHERE key = 'stop_reminded'`).get())
      .toEqual({ c: 1 });
  });

  it('две сессии чередуют записи и каждая хранит свой список', () => {
    const db = mk();
    setReminded(db, 'cc:aaaaaaaa', [1]);
    setReminded(db, 'cc:bbbbbbbb', [2]);
    setReminded(db, 'cc:aaaaaaaa', [1, 3]);
    setReminded(db, 'cc:bbbbbbbb', [2, 4]);
    expect(getReminded(db, 'cc:aaaaaaaa')).toEqual([1, 3]);
    expect(getReminded(db, 'cc:bbbbbbbb')).toEqual([2, 4]);
    expect(db.prepare(`SELECT COUNT(*) c FROM meta WHERE key = 'stop_reminded'`).get())
      .toEqual({ c: 1 });
  });

  it('потолок в 10 сессий: старейшая выпадает первой', () => {
    const db = mk();
    for (let i = 0; i < 11; i++) setReminded(db, `cc:sess${String(i).padStart(2, '0')}`, [i]);
    expect(getReminded(db, 'cc:sess00')).toEqual([]); // вытеснена
    expect(getReminded(db, 'cc:sess01')).toEqual([1]); // старейшая из оставшихся выжила
    expect(getReminded(db, 'cc:sess10')).toEqual([10]); // самая свежая на месте
  });

  // Числоподобный ключ объекта JS сортирует впереди всех прочих, сколько его ни перезаписывай:
  // на карте такая сессия вылетала бы по потолку сразу после записи. Порядок хранится списком.
  it('сессия из одних цифр вытесняется по очереди записи, а не первой', () => {
    const db = mk();
    for (let i = 0; i < 9; i++) setReminded(db, `cc:sess${i}`, [i]);
    setReminded(db, '7', [77]); // самая свежая, десятая
    setReminded(db, 'cc:last', [99]); // одиннадцатая — выпадает старейшая
    expect(getReminded(db, 'cc:sess0')).toEqual([]);
    expect(getReminded(db, '7')).toEqual([77]);
  });

  it('старый формат-объект читается как «ничего не напомнено», а запись его чинит', () => {
    const db = mk();
    db.prepare(`INSERT INTO meta (key, value) VALUES ('stop_reminded', ?)`)
      .run(JSON.stringify({ session: 'cc:abcdef12', ids: [119] }));
    expect(getReminded(db, 'cc:abcdef12')).toEqual([]);
    setReminded(db, 'cc:abcdef12', [119]);
    expect(getReminded(db, 'cc:abcdef12')).toEqual([119]);
  });

  it('битое значение читается как «ничего не напомнено», а не бросает', () => {
    const db = mk();
    db.prepare(`INSERT INTO meta (key, value) VALUES ('stop_reminded', 'not json{')`).run();
    expect(getReminded(db, 'cc:abcdef12')).toEqual([]);
  });
});
