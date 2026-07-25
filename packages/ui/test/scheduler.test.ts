import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { getLastRun, openDb, setAutoTick, type TickRun } from '@kddkit/core';
import { createScheduler, type TickRunner } from '../src/scheduler.js';

// Настоящая база в настоящем KDD_HOME: планировщик резолвит проекты через
// listProjects(), а он ходит по файловой системе. Моков в доме нет.
function project(): { hash: string; db: Database.Database } {
  const home = mkdtempSync(join(tmpdir(), 'kdd-sched-'));
  process.env.KDD_HOME = home;
  const hash = 'abc123';
  const db = openDb(join(home, hash, 'kdd.db'), '/repo/.git');
  return { hash, db };
}

const ok = (over: Partial<TickRun> = {}): TickRun =>
  ({ at: 1700000000, reclaimed: 0, spawned: 0, active: 0, reaped: 0, ...over });

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

  // Round 1 fix — finding 1: sync() во время висящего прохода не должен взводить второй.
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

  // Round 1 fix — finding 2: транзиентный сбой в обвязке прохода ретраит, а не гасит таймер.
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

  // Round 1 fix — finding 4: nextAt должен быть в секундах, а не в миллисекундах.
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
