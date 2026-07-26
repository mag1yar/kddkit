import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import {
  getAutoTick, kddHome, listProjects, now, projectPathOf, projectToplevelOf, setLastRun,
  type TickRun,
} from '@kddkit/core';

export type TickRunner = (
  p: { dbPath: string; projectPath: string; toplevel: string | null },
) => Promise<TickRun>;

export interface Scheduler {
  /** Перечитать настройки проекта и взвести либо снять его таймер. */
  sync(hash: string): void;
  /** Поднять таймеры всех включённых проектов — вызывается на старте сервера. */
  syncAll(): void;
  /** Время следующего срабатывания в секундах, либо null если таймер не взведён. */
  nextAt(hash: string): number | null;
  /** Идёт ли прямо сейчас проход по проекту — обратный отсчёт в это время бессмыслен. */
  isRunning(hash: string): boolean;
  stopAll(): void;
}

interface Slot { timer: ReturnType<typeof setTimeout>; nextAt: number; intervalSec: number }

const dbPathOf = (hash: string): string => join(kddHome(), hash, 'kdd.db');

// Разбег первых проходов при старте сервера: N включённых проектов не должны спаунить
// N тиков (и до N*maxWorkers воркеров) в одну секунду. Пара секунд на проект — это всё ещё
// «работа, накопившаяся за ночь, подхватывается сразу», а не отложенный на интервал старт.
const BOOT_STAGGER_MS = 3_000;

// Потолок паузы после подряд идущих сбоев. Read-only fs под ~/.kdd чинится руками и не за
// секунду — долбиться в неё раз в 30 секунд до утра смысла нет.
const FAILURE_BACKOFF_CAP_SEC = 15 * 60;

// Сбой до того, как удалось прочитать настройки: интервала проекта мы не знаем, отступаем
// от минуты.
const FAILURE_BASE_SEC = 60;

export function createScheduler(
  runner: TickRunner, openProject: (hash: string) => Database.Database,
): Scheduler {
  const slots = new Map<string, Slot>();
  // Хэши, у которых pass() сейчас реально бежит — от входа до перевзвода в хвосте. Без этого
  // sync(), вызванный, пока runner() ещё висит в await, может взвести второй немедленный проход.
  const inFlight = new Set<string>();
  // Сколько сбоев подряд у проекта. Растёт только на сбоях, обнуляется первым же успешным
  // проходом — см. retryAfterFailure.
  const failures = new Map<string, number>();
  let stopped = false;

  const disarm = (hash: string): void => {
    const s = slots.get(hash);
    if (!s) return;
    clearTimeout(s.timer);
    slots.delete(hash);
  };

  const clear = (hash: string): void => {
    disarm(hash);
    failures.delete(hash);
  };

  // Цепочка setTimeout, а не setInterval: следующий таймер взводится ПОСЛЕ прохода. Само по
  // себе это не исключает наложение (sync() способен взвести новый немедленный проход, пока
  // старый ещё в await) — от двойного запуска защищает inFlight, см. pass().
  const arm = (hash: string, delayMs: number, intervalSec: number): void => {
    if (stopped) return;
    disarm(hash);
    const timer = setTimeout(() => { void pass(hash); }, delayMs);
    timer.unref?.(); // таймер не должен держать процесс живым: его держит сокет сервера
    slots.set(hash, { timer, nextAt: now() + Math.round(delayMs / 1000), intervalSec });
  };

  // Хранилище проекта удалили (человек снёс ~/.kdd/<hash>, чтобы начать доску заново) —
  // это определённый ответ, а не сбой: тикать нечего. Спаунить тик по удалённому пути нельзя,
  // openDb на той стороне создал бы пустую базу заново, и снесённая доска воскресала бы
  // пустой на каждом проходе.
  const storeGone = (hash: string): boolean => {
    if (existsSync(dbPathOf(hash))) return false;
    console.error(`[scheduler] ${hash}: store is gone (${dbPathOf(hash)}) — timer cleared`);
    clear(hash);
    return true;
  };

  // Транзиентный сбой в обвязке прохода (SQLITE_BUSY, EMFILE, read-only диск) — не приговор
  // проекту: enabled остаётся true в базе, значит цикл обязан ретраить, а не гаснуть молча.
  // Пауза растёт экспоненциально с числом сбоев подряд — это касается ТОЛЬКО ретраев после
  // сбоя. К обычному интервалу backoff применять нельзя ни при каких обстоятельствах:
  // интервал выбрал человек, и планировщик исполняет его буквально.
  const retryAfterFailure = (hash: string, e: unknown): void => {
    const msg = e instanceof Error ? e.message : String(e);
    const n = (failures.get(hash) ?? 0) + 1;
    const intervalSec = slots.get(hash)?.intervalSec ?? FAILURE_BASE_SEC;
    const delaySec = Math.min(intervalSec * 2 ** (n - 1), FAILURE_BACKOFF_CAP_SEC);
    console.error(`[scheduler] ${hash}: pass failed (${n} in a row), retry in ${delaySec}s: ${msg}`);
    arm(hash, delaySec * 1000, intervalSec); // в слоте — нормальный интервал, не пауза ретрая
    failures.set(hash, n); // после arm(): disarm внутри него чистит только таймер, не счётчик
  };

  const pass = async (hash: string): Promise<void> => {
    if (stopped) return;
    if (inFlight.has(hash)) return; // проход для этого хэша уже бежит — второй не стартуем
    if (storeGone(hash)) return;
    inFlight.add(hash);
    try {
      let db: Database.Database;
      let projectPath: string;
      let toplevel: string | null;
      try {
        db = openProject(hash);
        const p = projectPathOf(db);
        // null — определённый ответ: строки project_path нет, проект непригоден. Это не
        // то же самое, что брошенное исключение (ниже трактуется как транзиентный сбой):
        // ретраить нечего, path не появится сам, поэтому только clear() — но молча гасить
        // таймер нельзя, иначе enabled=true в базе и next: — навечно необъяснимы.
        if (p === null) {
          console.error(`[scheduler] ${hash}: no project_path recorded, cannot tick — timer cleared`);
          clear(hash);
          return;
        }
        projectPath = p;
        toplevel = projectToplevelOf(db);
      } catch (e) {
        retryAfterFailure(hash, e);
        return;
      }

      let run: TickRun;
      try {
        run = await runner({ dbPath: dbPathOf(hash), projectPath, toplevel });
      } catch (e) {
        // Overnight-раннер не умирает от транзиентного глюка: ошибка едет в индикатор,
        // цикл продолжается тем же интервалом.
        run = {
          at: now(), reclaimed: 0, killed: 0, stuck: 0, spawned: 0, active: 0, reaped: 0,
          error: e instanceof Error ? e.message : String(e),
        };
      }
      if (stopped) return;

      try {
        setLastRun(db, run);
        // Настройки могли смениться, пока шёл проход, — перечитываем, а не помним.
        const cfg = getAutoTick(db);
        if (cfg.enabled) arm(hash, cfg.intervalSec * 1000, cfg.intervalSec);
        else disarm(hash);
        failures.delete(hash); // проход дошёл до конца — цепочка сбоев прервана
      } catch (e) {
        retryAfterFailure(hash, e);
      }
    } finally {
      inFlight.delete(hash);
    }
  };

  // firstDelayMs — задержка первого прохода для проекта, у которого таймера ещё нет.
  // 0 для явного щелчка в UI (человек должен увидеть реакцию), разбег — для старта сервера.
  const sync = (hash: string, firstDelayMs = 0): void => {
    if (stopped) return;
    if (storeGone(hash)) return;
    let cfg;
    try { cfg = getAutoTick(openProject(hash)); } catch (e) {
      // Сбой открытия (SQLITE_BUSY, EMFILE, упавшая миграция) раньше гасил проект навсегда:
      // enabled=true в базе, таймера нет, ретраить некому. Ретраим, как и pass().
      retryAfterFailure(hash, e);
      return;
    }
    if (!cfg.enabled) { clear(hash); return; } // снять таймер — действует и во время висящего прохода
    // Проход уже бежит: его собственный хвост перечитает настройки и перевзведётся сам —
    // взвести здесь второй немедленный проход и есть баг с двойным раннером.
    if (inFlight.has(hash)) return;
    const s = slots.get(hash);
    // Выключено -> включено: первый проход немедленно, юзер щёлкнул и должен увидеть реакцию.
    if (!s) { arm(hash, firstDelayMs, cfg.intervalSec); return; }
    // Сменили интервал — перевзвести. Сменили только max workers — отсчёт не трогаем.
    if (s.intervalSec !== cfg.intervalSec) arm(hash, cfg.intervalSec * 1000, cfg.intervalSec);
  };

  return {
    sync: (hash) => { sync(hash); },

    syncAll() {
      let i = 0;
      // hash проекта — имя каталога перед kdd.db, тот же вывод, что у hashOf в server.ts
      for (const p of listProjects()) {
        // Выключенные проекты не открываем вовсе: openProject берёт handle на запись, а это
        // миграции по чужим доскам (см. комментарий у listProjects).
        if (!p.autoTickEnabled) continue;
        sync(basename(dirname(p.dbPath)), i * BOOT_STAGGER_MS);
        i += 1;
      }
    },

    nextAt(hash) { return slots.get(hash)?.nextAt ?? null; },

    isRunning(hash) { return inFlight.has(hash); },

    stopAll() {
      stopped = true;
      for (const hash of [...slots.keys()]) clear(hash);
    },
  };
}
