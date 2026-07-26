import { spawn as spawnProcess } from 'node:child_process';
import { dirname } from 'node:path';
import { now, type TickRun } from '@kddkit/core';
import type { TickRunner, WorkerStopper } from '@kddkit/ui';
import { parseTickOutput } from './tick-output.js';

// Отдельный модуль (не index.ts) ради теста: index.ts вызывает program.parse() на верхнем
// уровне, так что импорт index.ts в тесте убивает процесс через process.exit — тот же приём,
// что и у tick-output.ts.
// Стоп гоняем отдельным процессом по той же причине, что и tick: killWorker ждёт смерти
// синхронно (SIGTERM -> сон -> SIGKILL -> сон), и внутри сервера это подвесило бы event loop
// Hono на секунды за воркера. Таймаут-килла тут нет намеренно: все ожидания внутри `kdd stop`
// уже ограничены (лок с retries, паузы killWorker), а вешать сторож на сторожа незачем.
export function createStopRunner(
  scriptPath: string, spawnFn: typeof spawnProcess = spawnProcess,
): WorkerStopper {
  return ({ dbPath, projectPath, toplevel }) => new Promise((resolve, reject) => {
    const child = spawnFn(process.execPath, [scriptPath, 'stop'], {
      cwd: toplevel ?? dirname(projectPath),
      env: { ...process.env, KDD_DB: dbPath },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    child.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`kdd stop exited ${code}: ${err.trim()}`));
    });
  });
}

export function createTickRunner(
  scriptPath: string,
  killTimeoutMs: number,
  spawnFn: typeof spawnProcess = spawnProcess,
  killGraceMs = 5_000,
): TickRunner {
  // Проход гоняем ОТДЕЛЬНЫМ процессом, а не вызовом tick() внутри сервера: sweepWorktrees
  // внутри прохода дёргает git через execFileSync и подвешивал бы event loop Hono на каждом
  // тике. TICK_LOCK межпроцессный, поэтому наложение с `kdd tick --watch` из терминала
  // безопасно даром. node берём тот же (process.execPath) — см. #19 про ABI better-sqlite3.
  return ({ dbPath, projectPath, toplevel }) => new Promise((resolve) => {
    const child = spawnFn(
      process.execPath, [scriptPath, 'tick', '--json'],
      {
        // cwd нужен tick'у, чтобы резолвить toplevel для воркеров; базу пиннит KDD_DB.
        // Родитель projectPath (git common-dir) — верный toplevel только для обычного
        // <repo>/.git: у submodule это <super>/.git/modules, у --separate-git-dir и у
        // bare-репо с linked worktree он тоже расходится с toplevel. Fallback нужен
        // только для досок без project_toplevel в meta (созданы до этого поля) — и это
        // ДОГАДКА по чужому cwd, а не факт: KDD_TICK_SPAWNED ниже запрещает этому же
        // ребёнку поверить в свою догадку и записать её обратно в meta как истину.
        // Такую доску чинит только `kdd tick`/`kdd ui`, запущенный руками из настоящего
        // репозитория — там cwd honest, см. onePass/uiStart в index.ts.
        cwd: toplevel ?? dirname(projectPath),
        env: { ...process.env, KDD_DB: dbPath, KDD_TICK_SPAWNED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    let err = '';
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });

    // Без этого child, зависший внутри прохода (напр. sweepWorktrees
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
    // SIGTERM, а не сразу SIGKILL: proper-lockfile снимает лок через signal-exit, а тот
    // отрабатывает на SIGTERM и не может отработать на неперехватываемом SIGKILL. Убитый
    // наглухо child оставлял бы ~/.kdd/<hash>/tick.lock со свежим mtime, и все проходы —
    // как планировщика, так и `kdd tick` из терминала — получали бы ELOCKED, пока лок не
    // сочтут протухшим (TICK_LOCK_STALE, десять минут). SIGKILL остаётся страховкой на
    // случай child'а, застрявшего в непрерываемом системном вызове.
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      escalation = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
      escalation.unref?.();
    }, killTimeoutMs);

    const settle = (run: TickRun): void => {
      clearTimeout(killer);
      if (escalation) clearTimeout(escalation);
      resolve(run);
    };

    child.on('error', (e) => {
      settle({ at: now(), reclaimed: 0, killed: 0, stuck: 0, spawned: 0, active: 0, reaped: 0, error: e.message });
    });
    child.on('close', (code) => {
      if (timedOut) {
        settle({
          at: now(), reclaimed: 0, killed: 0, stuck: 0, spawned: 0, active: 0, reaped: 0,
          error: `kdd tick killed after exceeding ${killTimeoutMs}ms timeout`,
        });
        return;
      }
      settle(parseTickOutput(out, err, code, now()));
    });
  });
}
