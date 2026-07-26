import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { getLastRun, openDb, setAutoTick, setProjectToplevel, type TickRun } from '@kddkit/core';
import { createScheduler, type TickRunner } from '../src/scheduler.js';

// Настоящая база в настоящем KDD_HOME: планировщик резолвит проекты через
// listProjects(), а он ходит по файловой системе. Моков в доме нет.
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'kdd-sched-'));
  process.env.KDD_HOME = home;
  return home;
}

const projectIn = (home: string, hash: string): Database.Database =>
  openDb(join(home, hash, 'kdd.db'), '/repo/.git');

function project(): { hash: string; db: Database.Database; home: string } {
  const home = makeHome();
  const hash = 'abc123';
  return { hash, db: projectIn(home, hash), home };
}

const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

const ok = (over: Partial<TickRun> = {}): TickRun =>
  ({ at: 1700000000, reclaimed: 0, killed: 0, stuck: 0, spawned: 0, active: 0, reaped: 0, ...over });

afterEach(() => { vi.useRealTimers(); delete process.env.KDD_HOME; });

describe('createScheduler', () => {
  it('выключённый проект не взводит таймер', () => {
    const { hash, db } = project();
    const runner = vi.fn<TickRunner>(async () => ok());
    const s = createScheduler(runner, () => db);
    s.sync(hash);
    expect(s.nextAt(hash)).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });

  it('включение даёт немедленный первый проход и пишет last run', async () => {
    vi.useFakeTimers();
    const { hash, db } = project();
    setAutoTick(db, { enabled: true, intervalSec: 30 });
    const runner = vi.fn<TickRunner>(async () => ok({ spawned: 2 }));
    const s = createScheduler(runner, () => db);
    s.sync(hash);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(getLastRun(db)?.spawned).toBe(2);
    s.stopAll();
  });

  it('следующий проход идёт через intervalSec, а не раньше', async () => {
    vi.useFakeTimers();
    const { hash, db } = project();
    setAutoTick(db, { enabled: true, intervalSec: 30 });
    const runner = vi.fn<TickRunner>(async () => ok());
    const s = createScheduler(runner, () => db);
    s.sync(hash);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(runner).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runner).toHaveBeenCalledTimes(2);
    s.stopAll();
  });

  it('пока висит проход, второй не стартует', async () => {
    vi.useFakeTimers();
    const { hash, db } = project();
    setAutoTick(db, { enabled: true, intervalSec: 30 });
    let release: (() => void) | undefined;
    const runner = vi.fn<TickRunner>(() => new Promise((res) => {
      release = () => res(ok());
    }));
    const s = createScheduler(runner, () => db);
    s.sync(hash);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(120_000); // проход всё ещё не завершился
    expect(runner).toHaveBeenCalledTimes(1);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runner).toHaveBeenCalledTimes(2);
    s.stopAll();
  });

  it('падение раннера пишется в last run и не рвёт цикл', async () => {
    vi.useFakeTimers();
    const { hash, db } = project();
    setAutoTick(db, { enabled: true, intervalSec: 30 });
    let calls = 0;
    const runner = vi.fn<TickRunner>(async () => {
      calls += 1;
      if (calls === 1) throw new Error('git exploded');
      return ok();
    });
    const s = createScheduler(runner, () => db);
    s.sync(hash);
    await vi.advanceTimersByTimeAsync(0);
    expect(getLastRun(db)?.error).toBe('git exploded');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runner).toHaveBeenCalledTimes(2);
    s.stopAll();
  });

  it('выключение снимает таймер', async () => {
    vi.useFakeTimers();
    const { hash, db } = project();
    setAutoTick(db, { enabled: true, intervalSec: 30 });
    const runner = vi.fn<TickRunner>(async () => ok());
    const s = createScheduler(runner, () => db);
    s.sync(hash);
    await vi.advanceTimersByTimeAsync(0);
    setAutoTick(db, { enabled: false });
    s.sync(hash);
    expect(s.nextAt(hash)).toBeNull();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runner).toHaveBeenCalledTimes(1);
    s.stopAll();
  });

  it('смена интервала перевзводит таймер, смена только max workers — нет', async () => {
    vi.useFakeTimers();
    const { hash, db } = project();
    setAutoTick(db, { enabled: true, intervalSec: 900 });
    const runner = vi.fn<TickRunner>(async () => ok());
    const s = createScheduler(runner, () => db);
    s.sync(hash);
    await vi.advanceTimersByTimeAsync(0);
    const before = s.nextAt(hash);
    setAutoTick(db, { maxWorkers: 5 });
    s.sync(hash);
    expect(s.nextAt(hash)).toBe(before); // отсчёт не сброшен
    setAutoTick(db, { intervalSec: 30 });
    s.sync(hash);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runner).toHaveBeenCalledTimes(2);
    s.stopAll();
  });

  it('syncAll поднимает таймеры включённых проектов — это и есть «переживает рестарт»', async () => {
    vi.useFakeTimers();
    const { hash, db } = project();
    setAutoTick(db, { enabled: true, intervalSec: 30 });
    const runner = vi.fn<TickRunner>(async () => ok());
    const s = createScheduler(runner, () => db); // «новый сервер», настройки уже в базе
    s.syncAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(s.nextAt(hash)).not.toBeNull();
    s.stopAll();
  });

  it('stopAll глушит всё и не даёт взвестись заново', async () => {
    vi.useFakeTimers();
    const { hash, db } = project();
    setAutoTick(db, { enabled: true, intervalSec: 30 });
    const runner = vi.fn<TickRunner>(async () => ok());
    const s = createScheduler(runner, () => db);
    s.sync(hash);
    await vi.advanceTimersByTimeAsync(0);
    s.stopAll();
    expect(s.nextAt(hash)).toBeNull();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runner).toHaveBeenCalledTimes(1);
    s.sync(hash);
    expect(s.nextAt(hash)).toBeNull();
  });

  // sync() во время висящего прохода не должен взводить второй.
  it('выкл→вкл во время висящего прохода не даёт второй конкурентный проход', async () => {
    vi.useFakeTimers();
    const { hash, db } = project();
    setAutoTick(db, { enabled: true, intervalSec: 30 });
    let release: (() => void) | undefined;
    let concurrent = 0;
    let maxConcurrent = 0;
    const runner = vi.fn<TickRunner>(() => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      return new Promise((res) => { release = () => { concurrent -= 1; res(ok()); }; });
    });
    const s = createScheduler(runner, () => db);
    s.sync(hash);
    await vi.advanceTimersByTimeAsync(0); // первый проход стартовал и висит в await
    expect(runner).toHaveBeenCalledTimes(1);

    setAutoTick(db, { enabled: false });
    s.sync(hash); // снимает слот немедленно
    expect(s.nextAt(hash)).toBeNull();

    setAutoTick(db, { enabled: true });
    s.sync(hash); // проход всё ещё висит — второй немедленный проход не взводится
    expect(runner).toHaveBeenCalledTimes(1);

    release?.();
    await vi.advanceTimersByTimeAsync(0); // хвост первого прохода видит enabled=true и сам перевзводит
    expect(maxConcurrent).toBe(1); // ни разу не было двух одновременных раннеров
    expect(runner).toHaveBeenCalledTimes(1);
    expect(s.nextAt(hash)).not.toBeNull();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(runner).toHaveBeenCalledTimes(2); // цикл продолжается штатно
    s.stopAll();
  });

  it('смена интервала во время висящего прохода не взводит таймер поверх него', async () => {
    vi.useFakeTimers();
    const { hash, db } = project();
    setAutoTick(db, { enabled: true, intervalSec: 30 });
    let release: (() => void) | undefined;
    const runner = vi.fn<TickRunner>(() => new Promise((res) => { release = () => res(ok()); }));
    const s = createScheduler(runner, () => db);
    s.sync(hash);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner).toHaveBeenCalledTimes(1);

    setAutoTick(db, { intervalSec: 60 });
    s.sync(hash); // проход в процессе — sync() не трогает таймер, хвост прохода сам перечитает
    expect(runner).toHaveBeenCalledTimes(1);

    release?.();
    await vi.advanceTimersByTimeAsync(0); // хвост читает intervalSec=60 из базы и взводит по нему
    await vi.advanceTimersByTimeAsync(59_999);
    expect(runner).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runner).toHaveBeenCalledTimes(2);
    s.stopAll();
  });

  // Транзиентный сбой в обвязке прохода ретраит, а не гасит таймер.
  it('исключение при открытии проекта не убивает таймер — ретрай тем же интервалом', async () => {
    vi.useFakeTimers();
    const { hash, db } = project();
    setAutoTick(db, { enabled: true, intervalSec: 30 });
    const runner = vi.fn<TickRunner>(async () => ok());
    let calls = 0;
    // 1-й вызов — внутри sync() (читает cfg), успешен; 2-й — внутри первого pass(), падает.
    const s = createScheduler(runner, () => {
      calls += 1;
      if (calls === 2) throw new Error('EMFILE');
      return db;
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    s.sync(hash);
    await vi.advanceTimersByTimeAsync(0); // первая попытка прохода падает при открытии проекта
    expect(runner).not.toHaveBeenCalled();
    expect(s.nextAt(hash)).not.toBeNull(); // таймер ретраит, а не гаснет молча
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]?.[0]).toContain(hash);

    await vi.advanceTimersByTimeAsync(30_000); // тот же intervalSec, вторая попытка проходит
    expect(runner).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
    s.stopAll();
  });

  // Доску сбрасывают, снося ~/.kdd/<hash>. Таймер обязан замолчать: иначе каждый проход
  // спаунит тик по удалённому пути, openDb на той стороне создаёт базу заново, и снесённая
  // доска возвращается пустой.
  it('удалённое хранилище снимает таймер и не воскрешает доску', async () => {
    vi.useFakeTimers();
    const { hash, db, home } = project();
    setAutoTick(db, { enabled: true, intervalSec: 30 });
    const runner = vi.fn<TickRunner>(async () => ok());
    const s = createScheduler(runner, () => db);
    s.sync(hash);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner).toHaveBeenCalledTimes(1);

    const errSpy = quiet();
    rmSync(join(home, hash), { recursive: true, force: true });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runner).toHaveBeenCalledTimes(1); // проход не состоялся
    expect(s.nextAt(hash)).toBeNull(); // и больше не взведётся
    expect(existsSync(join(home, hash, 'kdd.db'))).toBe(false); // база не пересоздана
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
    s.stopAll();
  });

  it('сбой открытия на старте сервера ретраит, а не гасит проект навсегда', async () => {
    vi.useFakeTimers();
    const { hash, db } = project();
    setAutoTick(db, { enabled: true, intervalSec: 30 });
    const runner = vi.fn<TickRunner>(async () => ok());
    let calls = 0;
    const s = createScheduler(runner, () => {
      calls += 1;
      if (calls === 1) throw new Error('SQLITE_BUSY'); // первое же открытие на старте
      return db;
    });
    const errSpy = quiet();
    s.syncAll();
    expect(s.nextAt(hash)).not.toBeNull(); // enabled=true в базе — цикл обязан ретраить
    await vi.advanceTimersByTimeAsync(60_000); // интервал проекта ещё не прочитан: базовая пауза
    expect(runner).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
    s.stopAll();
  });

  it('старт сервера разносит первые проходы, а не палит все разом', async () => {
    vi.useFakeTimers();
    const home = makeHome();
    const dbs: Record<string, Database.Database> = {
      aaa111: projectIn(home, 'aaa111'), bbb222: projectIn(home, 'bbb222'),
    };
    for (const db of Object.values(dbs)) setAutoTick(db, { enabled: true, intervalSec: 30 });
    const runner = vi.fn<TickRunner>(async () => ok());
    const s = createScheduler(runner, (h) => dbs[h]);
    s.syncAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(runner).toHaveBeenCalledTimes(1); // второй проект ждёт своей очереди
    await vi.advanceTimersByTimeAsync(3_000);
    expect(runner).toHaveBeenCalledTimes(2);
    s.stopAll();
  });

  it('выключённый проект на старте не открывается вовсе', () => {
    const { db } = project(); // enabled=false по умолчанию
    const opened: string[] = [];
    const s = createScheduler(async () => ok(), (h) => { opened.push(h); return db; });
    s.syncAll();
    expect(opened).toEqual([]); // открытие на запись = миграции чужой доски
    s.stopAll();
  });

  it('пауза растёт на сбоях подряд и сбрасывается первым успехом', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const T = 1_700_000_000;
    const { hash, db } = project();
    setAutoTick(db, { enabled: true, intervalSec: 30 });
    const runner = vi.fn<TickRunner>(async () => ok());
    let broken = true;
    let calls = 0;
    const s = createScheduler(runner, () => {
      calls += 1;
      if (calls > 1 && broken) throw new Error('EROFS'); // 1-й вызов — sync(), он проходит
      return db;
    });
    const errSpy = quiet();

    s.sync(hash);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.nextAt(hash)).toBe(T + 30); // первый сбой — ретрай штатным интервалом

    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.nextAt(hash)).toBe(T + 30 + 60); // второй подряд — вдвое дольше

    broken = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(s.nextAt(hash)).toBe(T + 90 + 30); // успех — обратно на выбранный человеком интервал

    broken = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.nextAt(hash)).toBe(T + 120 + 30); // счётчик сбоев обнулён, пауза снова с нуля
    errSpy.mockRestore();
    s.stopAll();
  });

  it('isRunning поднят, пока проход висит', async () => {
    vi.useFakeTimers();
    const { hash, db } = project();
    setAutoTick(db, { enabled: true, intervalSec: 30 });
    let release: (() => void) | undefined;
    const runner = vi.fn<TickRunner>(() => new Promise((res) => { release = () => res(ok()); }));
    const s = createScheduler(runner, () => db);
    expect(s.isRunning(hash)).toBe(false);
    s.sync(hash);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.isRunning(hash)).toBe(true);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.isRunning(hash)).toBe(false);
    s.stopAll();
  });

  // Планировщик сам cwd для тика не резолвит: у сервера нет своего cwd в проекте.
  it('раннер получает записанный toplevel, а не догадку по project_path', async () => {
    vi.useFakeTimers();
    const { hash, db } = project();
    setAutoTick(db, { enabled: true, intervalSec: 30 });
    const seen: (string | null)[] = [];
    const runner = vi.fn<TickRunner>(async (p) => { seen.push(p.toplevel); return ok(); });
    const s = createScheduler(runner, () => db);
    s.sync(hash);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([null]); // ключа ещё нет — раннер откатится на dirname(project_path)
    setProjectToplevel(db, '/super/sub');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(seen[1]).toBe('/super/sub');
    s.stopAll();
  });

  // nextAt должен быть в секундах, а не в миллисекундах.
  it('nextAt возвращает абсолютные секунды, не миллисекунды', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const { hash, db } = project();
    setAutoTick(db, { enabled: true, intervalSec: 30 });
    const runner = vi.fn<TickRunner>(async () => ok());
    const s = createScheduler(runner, () => db);
    s.sync(hash);
    await vi.advanceTimersByTimeAsync(0); // проход стартовал и завершился, взведён следующий через 30s
    expect(s.nextAt(hash)).toBe(1_700_000_030);
    s.stopAll();
  });
});
