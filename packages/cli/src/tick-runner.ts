import { spawn as spawnProcess } from 'node:child_process';
import { dirname } from 'node:path';
import { now } from '@kddkit/core';
import type { TickRunner } from '@kddkit/ui';
import { parseTickOutput } from './tick-output.js';

// Отдельный модуль (не index.ts) ради теста: index.ts вызывает program.parse() на верхнем
// уровне, так что импорт index.ts в тесте убивает процесс через process.exit — тот же приём,
// что и у tick-output.ts.
export function createTickRunner(
  scriptPath: string,
  killTimeoutMs: number,
  spawnFn: typeof spawnProcess = spawnProcess,
): TickRunner {
  // Проход гоняем ОТДЕЛЬНЫМ процессом, а не вызовом tick() внутри сервера: sweepWorktrees
  // внутри прохода дёргает git через execFileSync и подвешивал бы event loop Hono на каждом
  // тике. TICK_LOCK межпроцессный, поэтому наложение с `kdd tick --watch` из терминала
  // безопасно даром. node берём тот же (process.execPath) — см. #19 про ABI better-sqlite3.
  return ({ dbPath, projectPath }) => new Promise((resolve) => {
    const child = spawnFn(
      process.execPath, [scriptPath, 'tick', '--json'],
      {
        // cwd нужен tick'у, чтобы резолвить toplevel для воркеров; базу пиннит KDD_DB,
        // projectPath — это git common-dir, его родитель и есть toplevel.
        cwd: dirname(projectPath),
        env: { ...process.env, KDD_DB: dbPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    let err = '';
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });

    // Fix (review, wave final): без этого child, зависший внутри прохода (напр. sweepWorktrees
    // дёргает `git worktree remove --force` на упавшей сетевой fs-mount и git блокируется
    // навсегда), никогда не эмиттит close/error → промис никогда не settles → scheduler.inFlight
    // для проекта не очищается (снимается в finally, который не наступает) → хвост прохода не
    // перевзводит таймер: enabled в базе остаётся true, next: — навечно, ни строки в логе. Хуже:
    // тот же child всё ещё держит ~/.kdd/<hash>/tick.lock, и proper-lockfile продолжает освежать
    // его mtime, пока процесс жив, — лок никогда не станет stale, и параллельный `kdd tick` /
    // `kdd tick --watch` из терминала тоже вечно получает ELOCKED. killTimeoutMs обязан быть
    // МЕНЬШЕ TICK_LOCK_STALE: тик обязан быть убит и лок — освобождён раньше, чем лок сочтут
    // протухшим, иначе другой процесс украдёт лок у ещё живого (просто медленного) child и оба
    // насчитают active < maxWorkers независимо, наспавнив вдвое больше воркеров.
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, killTimeoutMs);

    child.on('error', (e) => {
      clearTimeout(killer);
      resolve({ at: now(), reclaimed: 0, spawned: 0, active: 0, reaped: 0, error: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      if (timedOut) {
        resolve({
          at: now(), reclaimed: 0, spawned: 0, active: 0, reaped: 0,
          error: `kdd tick killed after exceeding ${killTimeoutMs}ms timeout`,
        });
        return;
      }
      resolve(parseTickOutput(out, err, code, now()));
    });
  });
}
