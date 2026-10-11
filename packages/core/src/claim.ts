import type Database from 'better-sqlite3';
import { now } from './db.js';
import type { Actor } from './state.js';
import { appendEvent, appendTaskMutationEvent, authorOf, mustGetTask } from './ops.js';
import { KddError } from './errors.js';
import type { Task } from './types.js';

export const DEFAULT_TTL = 15 * 60; // сек; hermes-дефолт, override через --ttl
const SYSTEM: Actor = { type: 'ai', id: 'system' }; // provenance ленивого reclaim (не притворяемся владельцем)

// NaN/0/negative ttl -> claim_expires = NaN, который проверка истечения (< ?) никогда не матчит: lease навечно.
function assertTtl(ttl: number): void {
  if (!Number.isFinite(ttl) || ttl <= 0) throw new KddError(`invalid ttl '${ttl}' (seconds > 0)`);
}

const criteriaCount = (db: Database.Database, id: number): number =>
  (db.prepare(`SELECT COUNT(*) c FROM criteria WHERE task_id = ?`).get(id) as { c: number }).c;

export function claimTask(
  db: Database.Database, id: number, actor: Actor, ttl = DEFAULT_TTL,
): { ok: true; task: Task } | { ok: false; error: string } {
  assertTtl(ttl);
  return db.transaction((): { ok: true; task: Task } | { ok: false; error: string } => {
    let t = mustGetTask(db, id);
    // Ленивый TTL-reclaim только этой задачи: за лизом нет процесса, истёк — слот свободен,
    // неудачей это не считается. Чужие просроченные лизы не трогаем: claim остаётся O(1).
    if (t.status === 'in_progress' && t.claim_expires !== null && t.claim_expires < now()) {
      db.prepare(`UPDATE tasks SET status='new', claimed_by=NULL, claim_expires=NULL, updated_at=? WHERE id=?`)
        .run(now(), id);
      appendEvent(db, id, SYSTEM, 'reclaimed', { former: t.claimed_by }, { type: 'claim', level: 'warn' });
      t = mustGetTask(db, id);
    }
    // Только ai: человеку research брать можно, `kdd claim <id>` для него — «я это взял».
    // Гейт защищает не задачу, а агента: коммита он тут не сделает, а слот займёт.
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
    appendTaskMutationEvent(db, id, actor, 'claimed', { ttl, expires }, { type: 'claim' });
    return { ok: true, task: mustGetTask(db, id) };
  }).immediate();
}

// Продление тем же CAS: rowcount 0 => «ты больше не владелец» (истёк/reclaim), агент обязан остановиться.
export function renewClaim(
  db: Database.Database, id: number, actor: Actor, ttl = DEFAULT_TTL,
): { ok: true; task: Task } | { ok: false; error: string } {
  assertTtl(ttl);
  return db.transaction((): { ok: true; task: Task } | { ok: false; error: string } => {
    const expires = now() + ttl;
    const r = db.prepare(
      `UPDATE tasks SET claim_expires=?, updated_at=? WHERE id=? AND claimed_by=? AND (claim_expires IS NULL OR claim_expires >= ?)`,
    ).run(expires, now(), id, authorOf(actor), now());
    if (r.changes !== 1) {
      return { ok: false,
        error: `#${id} not held by ${authorOf(actor)} (lease lost or reclaimed) — stop work` };
    }
    appendEvent(db, id, actor, 'claim_renewed', { ttl, expires }, { type: 'claim' });
    return { ok: true, task: mustGetTask(db, id) };
  }).immediate();
}
