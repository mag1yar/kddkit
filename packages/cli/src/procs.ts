import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { KillOutcome } from '@kddkit/core';

export interface WorkerProc { pid: number; pgid: number }
export type PsFn = () => string; // инъекция для теста: канонический вывод ps без запуска ps

// Личность воркера в `ps` — эта метка, и только она. Два требования, которые она закрывает:
// 1) её несёт и супервизор (аргументом `--tag`), и сам claude (текстом в промпте) — иначе
//    осиротевший claude невидим, tick считает слот свободным и сажает второго агента в ту же
//    worktree; 2) она скоупится доской: путь установленного index.js один на всю машину,
// и без хеша tick в репозитории A убил бы воркера задачи с тем же id в репозитории Б.
// Хеш от пути к БД, а не от репо: доску определяет именно он, и он же верен под KDD_DB.
export const workerTag = (taskId: number, dbPath: string): string =>
  `kdd-worker-${taskId}@${createHash('sha256').update(dbPath).digest('hex').slice(0, 12)}`;

// pid воркера НЕ храним: pid переиспользуются ОС, и через час записанное число может
// принадлежать чужому процессу. Скан по командной строке делает поиск и проверку личности
// одним действием — а ищем ЛЮБОГО живого члена группы, не лидера: лидер-шелл мог выйти
// первым, и getpgid по нему уже не сработал бы.
// Провал скана НЕ глотаем: «ps не запустился» и «воркеров нет» — противоположные факты, а
// пустой результат означал бы второй. Тогда tick отдал бы слот живому процессу, а sweep снёс бы
// worktree под работающим агентом. Пусть падает — каждый вызывающий решает сам, что безопаснее.
const psAll: PsFn = () => execFileSync('ps', ['-eo', 'pid=,pgid=,args='],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

interface PsRow { pid: number; pgid: number; args: string }

function parsePs(out: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of out.split('\n')) {
    // два числовых поля слева, остальное — args целиком (в них есть пробелы)
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), pgid: Number(m[2]), args: m[3] });
  }
  return rows;
}

// Один скан ps даёт и жертв, и нашу собственную группу. Свой pgid берём из строки про самих
// себя, а НЕ из process.getpgrp: в worker-потоке node (vitest) его попросту нет, и гвард
// в signalGroup молча перестал бы работать.
function scan(tag: string, ps: PsFn): { hits: WorkerProc[]; own?: number } {
  const rows = parsePs(ps());
  return {
    // Подстроки достаточно: хвост `@<hash>` делает метку задачи 8 не префиксом метки задачи 85.
    hits: rows.filter((r) => r.args.includes(tag)).map((r) => ({ pid: r.pid, pgid: r.pgid })),
    own: rows.find((r) => r.pid === process.pid)?.pgid,
  };
}

// Живые процессы воркера задачи = все, чей args содержит метку.
export function findWorker(tag: string, ps: PsFn = psAll): WorkerProc[] {
  return scan(tag, ps).hits;
}

// Единственный потребитель — sweepWorktrees, а он на false сносит каталог `git worktree remove
// --force`. Поэтому «скан не удался» здесь читается как «занят»: непроверенный воркер стоит
// лишнего каталога, а не потерянной несохранённой работы. killWorker падает в другую сторону —
// там исключение честно доезжает до драйвера и слот остаётся занятым.
export function workerAlive(tag: string, ps: PsFn = psAll): boolean {
  try { return findWorker(tag, ps).length > 0; } catch { return true; }
}

// Синхронный сон без busy-loop. tick — короткоживущий батч (UI гоняет его отдельным процессом
// именно затем, чтобы он мог блокироваться), так что ждать здесь можно и нужно.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Сигнал ГРУППЕ (-pgid): всё, что claude запустил через Bash и что пережило родителя (dev-сервер,
// docker compose, билд-демон), сигнала по одному pid не заметит — а метки рана в argv у этих
// потомков нет, значит findWorker их уже никогда не увидит и ни один tick не подберёт.
// ESRCH = группы уже нет, это успех.
export function signalGroup(pgid: number, sig: NodeJS.Signals, own?: number): void {
  // POSIX: kill(-0) — это группа ВЫЗЫВАЮЩЕГО, а kill(-1) — все процессы. Плюс наша собственная
  // группа: tick-child планировщика не detached и делит группу с UI-сервером, так что воркер,
  // запущенный руками в той же группе, заставил бы tick послать SIGKILL себе и серверу.
  if (pgid <= 1 || pgid === own) return;
  try { process.kill(-pgid, sig); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
}

// SIGTERM группам -> ждём -> кто жив? SIGKILL -> ждём -> проверка. 'absent' = убивать было некого
// (воркер вышел сам, lease его пережил) — отделено от 'gone', чтобы tick не рапортовал убийства,
// которых не было. Ждать ОБЯЗАТЕЛЬНО: вернуть слот до подтверждения смерти — значит
// позволить тому же проходу переклеймить задачу и посадить второго воркера в ту же worktree.
// Весь набор разом: пауза после сигнала одна на всех, а не на каждого. Последовательная версия
// стоила бы (2s + 0.5s) * N внутри тик-лока и трёх сканов `ps` на воркера вместо трёх на проход.
export function killWorkers(
  tags: Map<number, string>,
  opts: { ps?: PsFn; termWaitMs?: number; killWaitMs?: number } = {},
): Map<number, KillOutcome> {
  const { ps = psAll, termWaitMs = 2000, killWaitMs = 500 } = opts;
  const out = new Map<number, KillOutcome>();
  if (!tags.size) return out;

  // Один скан на фазу: rows фильтруем по каждой метке сами. Свой pgid берём оттуда же.
  const sweep = (): { alive: Map<number, WorkerProc[]>; own?: number } => {
    const rows = parsePs(ps());
    const alive = new Map<number, WorkerProc[]>();
    for (const [id, tag] of tags) {
      const hits = rows.filter((r) => r.args.includes(tag)).map((r) => ({ pid: r.pid, pgid: r.pgid }));
      if (hits.length) alive.set(id, hits);
    }
    return { alive, own: rows.find((r) => r.pid === process.pid)?.pgid };
  };
  const signalAll = (alive: Map<number, WorkerProc[]>, sig: NodeJS.Signals, own?: number): void => {
    const pgids = new Set([...alive.values()].flat().map((p) => p.pgid));
    for (const pgid of pgids) signalGroup(pgid, sig, own);
  };

  const first = sweep();
  for (const id of tags.keys()) if (!first.alive.has(id)) out.set(id, 'absent');
  if (!first.alive.size) return out;
  signalAll(first.alive, 'SIGTERM', first.own);
  sleepSync(termWaitMs);

  const second = sweep();
  for (const id of first.alive.keys()) if (!second.alive.has(id)) out.set(id, 'gone');
  if (!second.alive.size) return out;
  signalAll(second.alive, 'SIGKILL', second.own);
  sleepSync(killWaitMs);

  const third = sweep();
  for (const id of second.alive.keys()) out.set(id, third.alive.has(id) ? 'stuck' : 'gone');
  return out;
}

// Один воркер — тот же путь, просто набор из одного. Оставлено ради вызовов, которым набор
// не нужен (и ради теста, читающего исход одной метки).
export const killWorker = (
  tag: string, opts: { ps?: PsFn; termWaitMs?: number; killWaitMs?: number } = {},
): KillOutcome => killWorkers(new Map([[0, tag]]), opts).get(0) ?? 'stuck';
