import { basename, dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { getAutoTick, kddHome, listProjects, now, setLastRun, type TickRun } from '@kddkit/core';

export type TickRunner = (p: { dbPath: string; projectPath: string }) => Promise<TickRun>;

export interface Scheduler {
  /** Перечитать настройки проекта и взвести либо снять его таймер. */
  sync(hash: string): void;
  /** Поднять таймеры всех включённых проектов — вызывается на старте сервера. */
  syncAll(): void;
  /** Время следующего срабатывания в секундах, либо null если таймер не взведён. */
  nextAt(hash: string): number | null;
  stopAll(): void;
}

interface Slot { timer: ReturnType<typeof setTimeout>; nextAt: number; intervalSec: number }

const dbPathOf = (hash: string): string => join(kddHome(), hash, 'kdd.db');

export function createScheduler(
  runner: TickRunner, openProject: (hash: string) => Database.Database,
): Scheduler {
  const slots = new Map<string, Slot>();
  let stopped = false;

  const clear = (hash: string): void => {
    const s = slots.get(hash);
    if (!s) return;
    clearTimeout(s.timer);
    slots.delete(hash);
  };

  // Цепочка setTimeout, а не setInterval: следующий таймер взводится ПОСЛЕ прохода,
  // поэтому наложение проходов невозможно структурно, без флага «уже бегу».
  const arm = (hash: string, delayMs: number, intervalSec: number): void => {
    if (stopped) return;
    clear(hash);
    const timer = setTimeout(() => { void pass(hash); }, delayMs);
    timer.unref?.(); // таймер не должен держать процесс живым: его держит сокет сервера
    slots.set(hash, { timer, nextAt: now() + Math.round(delayMs / 1000), intervalSec });
  };

  const pass = async (hash: string): Promise<void> => {
    if (stopped) return;
    let db: Database.Database;
    let projectPath: string;
    try {
      db = openProject(hash);
      const dbPath = dbPathOf(hash);
      const found = listProjects().find((p) => p.dbPath === dbPath);
      if (!found) { clear(hash); return; } // проект исчез из ~/.kdd — тихо снимаем таймер
      projectPath = found.projectPath;
    } catch {
      clear(hash);
      return;
    }

    let run: TickRun;
    try {
      run = await runner({ dbPath: dbPathOf(hash), projectPath });
    } catch (e) {
      // Overnight-раннер не умирает от транзиентного глюка: ошибка едет в индикатор,
      // цикл продолжается тем же интервалом.
      run = {
        at: now(), reclaimed: 0, spawned: 0, active: 0, reaped: 0,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    if (stopped) return;

    try {
      setLastRun(db, run);
      // Настройки могли смениться, пока шёл проход, — перечитываем, а не помним.
      const cfg = getAutoTick(db);
      if (cfg.enabled) arm(hash, cfg.intervalSec * 1000, cfg.intervalSec);
      else clear(hash);
    } catch {
      clear(hash); // базу закрыли под нами (остановка сервера)
    }
  };

  const sync = (hash: string): void => {
    if (stopped) return;
    let cfg;
    try { cfg = getAutoTick(openProject(hash)); } catch { clear(hash); return; }
    if (!cfg.enabled) { clear(hash); return; }
    const s = slots.get(hash);
    // Выключено -> включено: первый проход немедленно, юзер щёлкнул и должен увидеть реакцию.
    if (!s) { arm(hash, 0, cfg.intervalSec); return; }
    // Сменили интервал — перевзвести. Сменили только max workers — отсчёт не трогаем.
    if (s.intervalSec !== cfg.intervalSec) arm(hash, cfg.intervalSec * 1000, cfg.intervalSec);
  };

  return {
    sync,

    syncAll() {
      // hash проекта — имя каталога перед kdd.db, тот же вывод, что у hashOf в server.ts
      for (const p of listProjects()) {
        try { sync(basename(dirname(p.dbPath))); } catch { /* битая база одного проекта не ломает старт */ }
      }
    },

    nextAt(hash) { return slots.get(hash)?.nextAt ?? null; },

    stopAll() {
      stopped = true;
      for (const hash of [...slots.keys()]) clear(hash);
    },
  };
}
