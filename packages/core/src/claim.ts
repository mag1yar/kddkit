import type Database from 'better-sqlite3';
import { now } from './db.js';
import { type Actor } from './state.js';
import { appendEvent, authorOf, mustGetTask } from './ops.js';
import { KddError } from './errors.js';
import { PRIORITY_ORDER } from './queries.js';
import type { Task } from './types.js';
import { appendAgentEvent, lastAgentEventKind } from './agent_events.js';

export const DEFAULT_TTL = 15 * 60; // сек; hermes-дефолт, override через --ttl
const SYSTEM: Actor = { type: 'ai', id: 'system' }; // provenance ленивого reclaim (не притворяемся владельцем)

export const MAX_FAILED_ATTEMPTS = 3; // K: подряд неудачных попыток -> авто-блок задачи

// Учёт неудачной попытки агента: ++счётчик, при K -> блок. Внутри открытой транзакции.
export function recordFailedAttempt(
  db: Database.Database, id: number, actor: Actor, reason: string,
): void {
  db.prepare(`UPDATE tasks SET failed_attempts = failed_attempts + 1, updated_at = ? WHERE id = ?`)
    .run(now(), id);
  const fa = (db.prepare(`SELECT failed_attempts FROM tasks WHERE id = ?`).get(id) as
    { failed_attempts: number }).failed_attempts;
  if (fa >= MAX_FAILED_ATTEMPTS) {
    db.prepare(`UPDATE tasks SET blocked = 1, block_reason = ?, updated_at = ? WHERE id = ?`)
      .run(`${fa} failed attempts (agent driver): ${reason}`, now(), id);
    appendEvent(db, id, actor, 'blocked',
      { reason: `${fa} failed attempts`, last: reason }, { type: 'claim', level: 'error' });
  }
}

// Освобождение claim без прогресса (sync spawn-fail): in_progress -> new, снять lease, засчитать неудачу.
export function releaseClaim(
  db: Database.Database, id: number, actor: Actor, reason: string,
): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE tasks SET status='new', claimed_by=NULL, claim_expires=NULL, updated_at=? WHERE id=?`,
    ).run(now(), id);
    appendEvent(db, id, actor, 'released', { reason }, { type: 'claim', level: 'warn' });
    recordFailedAttempt(db, id, actor, reason);
  })();
}

// NaN/0/negative ttl -> claim_expires = NaN, который reclaimExpired (< ?) никогда не матчит: lease навечно.
function assertTtl(ttl: number): void {
  if (!Number.isFinite(ttl) || ttl <= 0) throw new KddError(`invalid ttl '${ttl}' (seconds > 0)`);
}

// Очередь: ready + есть критерии (definition of done) + не занята + это работа с кодом.
// status='new' уже исключает занятые (инвариант claimed<=>in_progress); claimed_by IS NULL — гвард окна гонки.
// kind='research' исключён БЕЗ учёта actor — claimNext его вообще не принимает как параметр:
// очередной обход никому не отдаёт research, потому что отдавать его тут некому — результат
// research — записанное решение, а не коммит, и вся механика ниже (критерии → review → тип
// коммита) под него не заточена. Контраст: claimTask ниже actor знает и гейтит по нему —
// человеку через явный `kdd claim <id>` research взять можно, агенту нет.
const CLAIMABLE_SQL =
  `status = 'new' AND blocked = 0 AND archived_at IS NULL AND claimed_by IS NULL
   AND kind <> 'research'
   AND (SELECT COUNT(*) FROM criteria WHERE criteria.task_id = tasks.id) > 0`;

const criteriaCount = (db: Database.Database, id: number): number =>
  (db.prepare(`SELECT COUNT(*) c FROM criteria WHERE task_id = ?`).get(id) as { c: number }).c;

export interface ReclaimedLease { id: number; claimed_by: string | null }

// 'gone' — процесс был и умер; 'absent' — его уже не было; 'stuck' — пережил SIGKILL.
// 'absent' отделён от 'gone' ради честного счётчика killed: слот освобождается одинаково,
// но «killed 2» там, где никого не убивали, — вранье в UI.
export type KillOutcome = 'gone' | 'absent' | 'stuck';
// Убийца воркеров. Инъекция, как SpawnFn: знание об ОС-процессах живёт в CLI, не в ядре.
// Принимает ВЕСЬ набор сразу, а не по задаче: убийство — это «сигнал, подождать, проверить»,
// и ждать один раз на всех дешевле ровно во столько раз, сколько воркеров. Задача, которой нет
// в ответе, считается 'stuck' — молчание не повод отдавать слот.
export type KillFn = (taskIds: number[]) => Map<number, KillOutcome>;

// Общий для reapExpired и stopWorkers вызов killer'а: один заход на весь набор, любой отказ
// (нет killer'а, исключение, пропуск в ответе) читается как 'stuck' — безопасная сторона:
// слот остаётся занятым, следующий проход попробует снова.
function killAll(ids: number[], kill?: KillFn): Map<number, KillOutcome> {
  if (!ids.length) return new Map();
  if (!kill) return new Map(ids.map((id) => [id, 'stuck']));
  try { return kill(ids); } catch { return new Map(ids.map((id) => [id, 'stuck'])); }
}

// За tick-лизом стоит ОС-процесс; за ручным user-claim — нет. Отсюда всё разное обращение.
const isTickLease = (claimedBy: string | null): claimedBy is string =>
  !!claimedBy?.startsWith('ai:tick:');

// Read-only снимок просроченных лизов. Отдельно от reclaimExpired, потому что убивать процесс
// надо ДО того, как слот отдан, и вне транзакции — смерть процесса не откатывается.
export function expiredLeases(db: Database.Database): ReclaimedLease[] {
  return db.prepare(
    `SELECT id, claimed_by FROM tasks
     WHERE status = 'in_progress' AND claim_expires IS NOT NULL AND claim_expires < ?`,
  ).all(now()) as ReclaimedLease[];
}

// Ленивый TTL-reclaim: истёкший lease -> задача обратно в new, claim снят, событие.
// Вызывается в начале claim/claimNext — без демона, kdd живёт только когда его зовут.
// Возвращает СТРОКИ, а не id: вызывающему нужен claimed_by, чтобы решить, есть ли что убивать.
// opts.except — id, чей слот отдавать НЕЛЬЗЯ (процесс не подтверждён мёртвым): см. reapExpired.
export function reclaimExpired(
  db: Database.Database, opts: { except?: ReadonlySet<number> } = {},
): ReclaimedLease[] {
  const t = now();
  const expired = expiredLeases(db).filter((e) => !opts.except?.has(e.id));
  const clear = db.prepare(
    `UPDATE tasks SET status='new', claimed_by=NULL, claim_expires=NULL, updated_at=? WHERE id=?`);
  for (const e of expired) {
    clear.run(t, e.id);
    appendEvent(db, e.id, SYSTEM, 'reclaimed', { former: e.claimed_by }, { type: 'claim', level: 'warn' });
    // только tick-спауны штрафуем: долгая/ручная user-claim, истёкшая по TTL, не должна авто-блокироваться
    if (isTickLease(e.claimed_by)) {
      recordFailedAttempt(db, e.id, SYSTEM, 'lease expired without progress');
      // observability best-effort: закрытие осиротевшего рана НЕ должно ронять reclaim.
      // appendAgentEvent открывает вложенный savepoint — его падение откатывает ТОЛЬКО себя;
      // без catch оно бы пробилось наружу и откатило весь sweep (задачи застряли бы in_progress).
      // Реклейм задачи (clear + reclaimed event) уже закоммичен выше — он durable, feed-запись нет.
      try { closeOrphanRun(db, e.id, e.claimed_by, 'lease expired, reclaimed by driver'); }
      catch { /* run-close потерян, задача всё равно reclaimed */ }
    }
  }
  return expired;
}

// observability: закрыть осиротевший agent-run reclaim'нутого воркера, чтобы feed не показывал
// мёртвого воркера вечно-активным. worker_id = claimed_by без 'ai:' (spawnWorker ставит
// KDD_SESSION=tick:<nonce>-<i>, а claimed_by = authorOf → ai:tick:...).
// reason — почему ран оборвался: TTL-reclaim и ручной стоп это разные события для человека,
// который через час читает фид и решает, чинить воркера или нет.
function closeOrphanRun(
  db: Database.Database, taskId: number, claimedBy: string, reason: string,
): void {
  const wid = claimedBy.slice(3); // 'ai:'.length — ai:tick:.. → tick:..
  const last = lastAgentEventKind(db, taskId, wid);
  if (last === 'run_end') return; // воркер уже закрыл ран сам — не дублируем
  if (last === null) {
    // воркер вообще не стартовал (spawn/worktree fail до run_start): рана нет — закрывать нечего.
    // Пишем ТОЛЬКО error (причина для feed). НЕ run_end: run_end без своего run_start — сирота,
    // а runProduced task-scoped спарил бы его с run_start ПРЕДЫДУЩего воркера и вернул null,
    // замаскировав результат того завершённого рана. Нет run_start → нет run_end.
    appendAgentEvent(db, taskId, wid, 'error',
      { detail: { message: `worker never started (spawn or worktree setup failed) — ${reason}` } });
    return;
  }
  // висячий run_start (или text/tool_* мид-стрим): воркер стартовал и умер. Закрываем ран.
  // head в run_end НЕ пишем: commit-state убитого воркера неизвестен → runProduced=null (контракт #9).
  appendAgentEvent(db, taskId, wid, 'error',
    { detail: { message: `worker died (SIGKILL/OOM/reboot) — ${reason}` } });
  appendAgentEvent(db, taskId, wid, 'run_end', { detail: { exitCode: null } });
}

export interface ReapResult { reclaimed: ReclaimedLease[]; killed: number; stuck: number }

// Единственное место, где решается, можно ли вернуть слот tick-воркера: сначала убить процесс,
// реклеймить только то, что действительно умерло. Иначе новый воркер садится в ту же worktree
// и ту же ветку, что живой старый — ровно тот дубль, ради которого всё это и написано.
// Без killer'а tick-лиз не реклеймится ВООБЩЕ: нельзя отдать слот процесса, который тебе нечем
// остановить — его заберёт `kdd tick`, у которого killer есть. Ручной user-claim процесса не
// имеет и реклеймится как раньше, кем угодно.
export function reapExpired(db: Database.Database, kill?: KillFn): ReapResult {
  const seen = expiredLeases(db);
  const except = new Set<number>();
  let killed = 0;
  let stuck = 0;
  // Вне транзакции: смерть процесса нельзя откатить вместе с ней. Одним заходом на весь набор:
  // проход держит межпроцессный лок, и последовательные ожидания смерти складывались бы в него
  // целиком — три протухших лиза стоили бы тику лишних секунд сна на каждом круге.
  const outcomes = killAll(seen.filter((l) => isTickLease(l.claimed_by)).map((l) => l.id), kill);
  for (const l of seen) {
    if (!isTickLease(l.claimed_by)) continue;
    const outcome = outcomes.get(l.id) ?? 'stuck'; // не ответили про задачу — слот не отдаём
    if (outcome === 'gone') killed++;
    if (outcome === 'stuck') { except.add(l.id); stuck++; }
  }
  const reclaimed = db.transaction(() => {
    // kill ждёт смерти секундами — за это время мог истечь ЕЩЁ один tick-лиз. Его процесс мы не
    // трогали, значит и слот не наш: пусть его добьёт следующий проход.
    for (const l of expiredLeases(db)) {
      if (isTickLease(l.claimed_by) && !seen.some((s) => s.id === l.id)) except.add(l.id);
    }
    return reclaimExpired(db, { except });
  })();
  return { reclaimed, killed, stuck };
}

export interface StopResult { killed: number; released: number; stuck: number }

// Ручная остановка автономии (тумблер auto-tick в off, `kdd stop`). Отличий от reapExpired два,
// и оба принципиальные: бьём по ВСЕМ живым tick-лизам, а не только по истёкшим — человек
// выключил автономию сейчас, а не через TTL; и неудачную попытку НЕ считаем — воркера остановил
// он, задача не виновата, иначе три щелчка тумблером авто-блокируют её за «3 failed attempts».
// Порядок тот же: сначала убить, вернуть в new только подтверждённо мёртвых. Переживший SIGKILL
// держит слот дальше — его добьёт TTL-путь, повторять нечего.
export function stopWorkers(db: Database.Database, kill?: KillFn): StopResult {
  const live = db.prepare(
    `SELECT id, claimed_by FROM tasks WHERE status='in_progress' AND claimed_by IS NOT NULL`,
  ).all() as ReclaimedLease[];
  const dead: { id: number; claimedBy: string }[] = [];
  let killed = 0;
  let stuck = 0;
  // Вне транзакции: смерть процесса не откатывается вместе с ней. Весь набор одним заходом —
  // человек ждёт ответа «остановлено», и складывать ожидания смерти по воркерам незачем.
  const outcomes = killAll(live.filter((l) => isTickLease(l.claimed_by)).map((l) => l.id), kill);
  for (const l of live) {
    const claimedBy = l.claimed_by;
    if (!isTickLease(claimedBy)) continue; // за ручным user-claim процесса нет — не наш
    const outcome = outcomes.get(l.id) ?? 'stuck'; // без killer'а и без ответа — слот занят
    if (outcome === 'stuck') { stuck++; continue; }
    if (outcome === 'gone') killed++; // 'absent' — воркер вышел сам, убивать было некого
    dead.push({ id: l.id, claimedBy });
  }
  const released = db.transaction(() => {
    // Снимок брали ДО убийства, а kill спит секундами — за это время воркер мог успеть честно
    // доделать работу и уйти в review, сняв claim. Без CAS мы вернули бы его готовую задачу в
    // new и следующим тиком посадили бы на неё второго агента. Условие в WHERE — та же защита,
    // что reclaimExpired получает даром, перечитывая expiredLeases внутри транзакции.
    const clear = db.prepare(
      `UPDATE tasks SET status='new', claimed_by=NULL, claim_expires=NULL, updated_at=?
       WHERE id=? AND status='in_progress' AND claimed_by=?`);
    let n = 0;
    for (const d of dead) {
      if (clear.run(now(), d.id, d.claimedBy).changes !== 1) continue; // ушла из-под нас — не трогаем
      n++;
      appendEvent(db, d.id, SYSTEM, 'released',
        { reason: 'agent mode stopped', former: d.claimedBy }, { type: 'claim', level: 'warn' });
      try { closeOrphanRun(db, d.id, d.claimedBy, 'stopped by hand (agent mode off)'); }
      catch { /* фид — best effort, задача всё равно освобождена */ }
    }
    return n;
  })();
  return { killed, released, stuck };
}

export function claimTask(
  db: Database.Database, id: number, actor: Actor, ttl = DEFAULT_TTL,
  opts: { kill?: KillFn } = {},
): { ok: true; task: Task } | { ok: false; error: string } {
  assertTtl(ttl);
  reapExpired(db, opts.kill); // ДО транзакции: внутри неё нельзя убивать
  return db.transaction((): { ok: true; task: Task } | { ok: false; error: string } => {
    const t = mustGetTask(db, id);
    // Только ai: человеку research брать можно, `kdd claim <id>` для него — «я это взял».
    // Контраст с CLAIMABLE_SQL выше: там research исключён для ВСЕХ (actor туда не приходит),
    // здесь actor известен и гейт бьёт только по ai. Гейт защищает не задачу, а агента:
    // коммита он тут не сделает, а слот займёт.
    if (t.kind === 'research' && actor.type === 'ai') {
      appendEvent(db, id, actor, 'claim_rejected',
        { reason: 'research is not agent work' }, { type: 'claim', level: 'warn' });
      return { ok: false,
        error: `cannot claim #${id}: kind=research — the deliverable is a recorded decision, not code` };
    }
    if (criteriaCount(db, id) === 0) {
      appendEvent(db, id, actor, 'claim_rejected',
        { reason: 'no acceptance criteria' }, { type: 'claim', level: 'warn' });
      return { ok: false, error: `cannot claim #${id}: no acceptance criteria (define done first)` };
    }
    const expires = now() + ttl;
    const r = db.prepare(
      `UPDATE tasks SET status='in_progress', claimed_by=?, claim_expires=?, updated_at=?
       WHERE id=? AND status='new' AND blocked=0 AND archived_at IS NULL AND claimed_by IS NULL`,
    ).run(authorOf(actor), expires, now(), id);
    if (r.changes !== 1) {
      return { ok: false,
        error: `#${id} is not claimable (status ${t.status}${t.claimed_by ? `, held by ${t.claimed_by}` : ''})` };
    }
    appendEvent(db, id, actor, 'claimed', { ttl, expires }, { type: 'claim' });
    return { ok: true, task: mustGetTask(db, id) };
  })();
}

// null = очередь пуста (не ошибка). Гонка разрешается перебором: проигравший CAS -> следующий кандидат.
// opts.reclaim=false пропускает внутренний reap — для caller'ов (tick), которые уже прогнали его сами.
export function claimNext(
  db: Database.Database, actor: Actor, ttl = DEFAULT_TTL,
  opts: { reclaim?: boolean; kill?: KillFn } = {},
): Task | null {
  assertTtl(ttl);
  if (opts.reclaim !== false) reapExpired(db, opts.kill); // ДО транзакции: внутри неё нельзя убивать
  return db.transaction(() => {
    const rows = db.prepare(
      `SELECT id FROM tasks WHERE ${CLAIMABLE_SQL} ORDER BY ${PRIORITY_ORDER}, created_at, id`,
    ).all() as { id: number }[];
    for (const { id } of rows) {
      const expires = now() + ttl;
      const r = db.prepare(
        `UPDATE tasks SET status='in_progress', claimed_by=?, claim_expires=?, updated_at=?
         WHERE id=? AND status='new' AND blocked=0 AND archived_at IS NULL AND claimed_by IS NULL`,
      ).run(authorOf(actor), expires, now(), id);
      if (r.changes === 1) {
        appendEvent(db, id, actor, 'claimed', { ttl, expires }, { type: 'claim' });
        return mustGetTask(db, id);
      }
    }
    return null;
  })();
}

// Продление тем же CAS: rowcount 0 => «ты больше не владелец» (истёк/reclaim), агент обязан остановиться.
// opts.log=false — механическое продление (heartbeat супервизора): оно НЕ действие доски и не
// должно попадать в историю. Окна событий капированы (CAPS.statusEvents=5, CAPS.events=10), а
// удар раз в ttl/3 вытеснил бы из них всё настоящее — claim/move/block — и человек с Claude
// видели бы только «claim renewed». Кто чем владеет, и так записано в claimed_by/claim_expires,
// а сам ран виден в agent_events. Ручной `kdd claim --renew` логируется как раньше: он — действие.
export function renewClaim(
  db: Database.Database, id: number, actor: Actor, ttl = DEFAULT_TTL,
  opts: { log?: boolean } = {},
): { ok: true; task: Task } | { ok: false; error: string } {
  assertTtl(ttl);
  return db.transaction((): { ok: true; task: Task } | { ok: false; error: string } => {
    mustGetTask(db, id);
    const expires = now() + ttl;
    const r = db.prepare(
      `UPDATE tasks SET claim_expires=?, updated_at=? WHERE id=? AND claimed_by=?`,
    ).run(expires, now(), id, authorOf(actor));
    if (r.changes !== 1) {
      return { ok: false,
        error: `#${id} not held by ${authorOf(actor)} (lease lost or reclaimed) — stop work` };
    }
    if (opts.log !== false) {
      appendEvent(db, id, actor, 'claim_renewed', { ttl, expires }, { type: 'claim' });
    }
    return { ok: true, task: mustGetTask(db, id) };
  })();
}
