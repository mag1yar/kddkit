import type Database from 'better-sqlite3';
import { pruneAgentEvents } from './agent_events.js';
import { claimNext, reapExpired, releaseClaim, type KillFn } from './claim.js';
import { checkpointWal, now } from './db.js';

// stuck — лизы, чей процесс пережил SIGKILL: слот НЕ отдан, задача осталась in_progress.
export interface TickResult {
  reclaimed: number; killed: number; stuck: number; spawned: number; active: number;
}
export type SpawnFn = (taskId: number, workerId: string, projectDir: string) => void;

// Число живых воркеров = задачи в работе с непустым lease (инвариант claim).
function activeWorkers(db: Database.Database): number {
  return (db.prepare(
    `SELECT COUNT(*) c FROM tasks WHERE status='in_progress' AND claimed_by IS NOT NULL`,
  ).get() as { c: number }).c;
}

// Тупой механический tick: kill -> reclaim -> cap-loop (claim+spawn). Ноль LLM.
// spawn/kill инъектятся: тест передаёт recorder, прод — детач-спаун и ps-скан. Часы снаружи (cron).
export function tick(
  db: Database.Database,
  opts: { maxWorkers: number; ttl: number; projectDir: string; spawn: SpawnFn; kill?: KillFn },
): TickResult {
  // Сначала убить, потом реклеймить — и только то, что умерло. Переживший SIGKILL лиз остаётся
  // in_progress: его считает activeWorkers (кап соблюдён), а истёкшим он и остался — следующий
  // проход повторит попытку убийства сам, без участия человека.
  const { reclaimed, killed, stuck } = reapExpired(db, opts.kill);
  let active = activeWorkers(db);
  let spawned = 0;
  const nonce = now(); // уникальная база токена на этот tick
  while (active < opts.maxWorkers) {
    const workerId = `tick:${nonce}-${spawned}`; // run-token: уникален на спаун -> reclaim инвалидирует старый
    // tick уже прогнал reap выше — не сканировать (и не убивать) истёкшие лизы дважды за тик.
    const t = claimNext(db, { type: 'ai', id: workerId }, opts.ttl, { reclaim: false });
    if (!t) break; // очередь суха — fast-forward, не догоняем
    try {
      opts.spawn(t.id, workerId, opts.projectDir);
      active++; spawned++;
    } catch (e) {
      // sync spawn-fail (bad cwd, EMFILE, shell ENOENT): вернуть claim, засчитать неудачу, не занимать слот.
      // break, а не continue: причина обычно системная (плохой projectDir/бинарь) — она не исчезнет
      // для следующей задачи в этом же тике, а долбить очередь до auto-block того же таска бессмысленно.
      releaseClaim(db, t.id, { type: 'ai', id: workerId },
        `spawn failed: ${e instanceof Error ? e.message : String(e)}`);
      break;
    }
  }
  // Хозяйство базы — здесь, а не отдельной командой: agent_events рождаются только там, где
  // ходят воркеры, а tick — единственный процесс, который в агент-режиме заведомо запускается
  // регулярно. Сама ротация ходит не чаще раза в сутки (водяной знак в meta) — тик идёт каждую
  // минуту, и без него это был бы поминутный перечит фидов всех завершённых задач ради нуля строк.
  const pruned = pruneAgentEvents(db);
  if (pruned) checkpointWal(db); // WAL только что подрос на объём удалённого — самое время
  return { reclaimed: reclaimed.length, killed, stuck, spawned, active };
}
