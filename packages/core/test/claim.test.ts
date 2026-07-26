import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { addTask, moveTask, placeTask } from '../src/ops.js';
import { addCriterion, setCriterionChecked } from '../src/criteria.js';
import {
  claimTask, claimNext, renewClaim, reclaimExpired, releaseClaim, MAX_FAILED_ATTEMPTS, DEFAULT_TTL,
} from '../src/claim.js';
import { now } from '../src/db.js';
import { KddError } from '../src/errors.js';
import { lastAgentEventKind, appendAgentEvent, runProduced } from '../src/agent_events.js';

let db: Database.Database;
beforeEach(() => { db = openDb(':memory:', 'p'); });
const user = { type: 'user' as const };

describe('claim migration', () => {
  it('adds nullable claim columns, defaulting NULL', () => {
    addTask(db, { title: 't' }, user);
    const t = db.prepare(`SELECT claimed_by, claim_expires FROM tasks WHERE id = 1`).get();
    expect(t).toEqual({ claimed_by: null, claim_expires: null });
  });
});

const ai = { type: 'ai' as const, id: 's1' };
const ai2 = { type: 'ai' as const, id: 's2' };
const withCriteria = (title: string) => {
  const t = addTask(db, { title }, user); addCriterion(db, t.id, 'done', user); return t.id;
};

describe('claim ops', () => {
  it('claims a ready task with criteria: new -> in_progress + lease + event', () => {
    const id = withCriteria('t');
    const res = claimTask(db, id, ai);
    expect(res.ok).toBe(true);
    const t = db.prepare(`SELECT status, claimed_by, claim_expires FROM tasks WHERE id=?`).get(id) as any;
    expect(t.status).toBe('in_progress');
    expect(t.claimed_by).toBe('ai:s1');
    expect(t.claim_expires).toBeGreaterThan(now());
    expect(db.prepare(`SELECT action FROM events WHERE task_id=? ORDER BY id DESC LIMIT 1`).get(id))
      .toEqual({ action: 'claimed' });
  });

  it('mutex: second claimant loses', () => {
    const id = withCriteria('t');
    expect(claimTask(db, id, ai).ok).toBe(true);
    const r2 = claimTask(db, id, ai2);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toMatch(/not claimable/);
  });

  it('rejects claim on a task with no criteria + logs claim_rejected', () => {
    const t = addTask(db, { title: 'no-crit' }, user);
    const res = claimTask(db, t.id, ai);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no acceptance criteria/);
    expect(db.prepare(`SELECT status FROM tasks WHERE id=?`).get(t.id)).toEqual({ status: 'new' });
    expect(db.prepare(`SELECT action FROM events WHERE task_id=? ORDER BY id DESC LIMIT 1`).get(t.id))
      .toEqual({ action: 'claim_rejected' });
  });

  it('claimNext picks priority then FIFO, skips unclaimable, returns null when empty', () => {
    expect(claimNext(db, ai)).toBeNull();                       // пустая очередь
    const low = withCriteria('low');
    const high = addTask(db, { title: 'high', priority: 'high' }, user);
    addCriterion(db, high.id, 'done', user);
    addTask(db, { title: 'no-crit' }, user);                    // без критериев — пропустить
    expect(claimNext(db, ai)!.id).toBe(high.id);                // приоритет вперёд
    expect(claimNext(db, ai)!.id).toBe(low);                    // потом FIFO
    expect(claimNext(db, ai)).toBeNull();                       // остались только неclaimable
  });

  it('renew extends lease for owner, fails for non-owner', () => {
    const id = withCriteria('t');
    claimTask(db, id, ai);
    const before = db.prepare(`SELECT claim_expires e FROM tasks WHERE id=?`).get(id) as any;
    const ok = renewClaim(db, id, ai, 1800);
    expect(ok.ok).toBe(true);
    const after = db.prepare(`SELECT claim_expires e FROM tasks WHERE id=?`).get(id) as any;
    expect(after.e).toBeGreaterThanOrEqual(before.e);
    expect(renewClaim(db, id, ai2).ok).toBe(false);             // чужой lease
  });

  // B1: механическое продление (heartbeat супервизора) — не действие доски. Окна событий
  // капированы, и удар раз в ttl/3 вытеснил бы из них claim/move/block — всю настоящую историю.
  it('renew with log:false extends the lease but writes no event', () => {
    const id = withCriteria('t');
    claimTask(db, id, ai);
    const events = () => (db.prepare(
      `SELECT COUNT(*) c FROM events WHERE task_id=? AND action='claim_renewed'`).get(id) as any).c;
    const before = (db.prepare(`SELECT claim_expires e FROM tasks WHERE id=?`).get(id) as any).e;

    expect(renewClaim(db, id, ai, 1800, { log: false }).ok).toBe(true);
    expect((db.prepare(`SELECT claim_expires e FROM tasks WHERE id=?`).get(id) as any).e)
      .toBeGreaterThan(before);
    expect(events()).toBe(0);

    renewClaim(db, id, ai, 1800); // человек через `kdd claim --renew` — это действие, логируем
    expect(events()).toBe(1);
  });

  it('reclaimExpired returns expired lease to new, clears claim, logs reclaimed', () => {
    const id = withCriteria('t');
    claimTask(db, id, ai, 900);
    db.prepare(`UPDATE tasks SET claim_expires = ? WHERE id = ?`).run(now() - 1, id); // форсим истечение
    expect(reclaimExpired(db).map((r) => r.id)).toEqual([id]);
    const t = db.prepare(`SELECT status, claimed_by FROM tasks WHERE id=?`).get(id);
    expect(t).toEqual({ status: 'new', claimed_by: null });
    // после reclaim задача снова берётся
    expect(claimNext(db, ai2)!.id).toBe(id);
  });

  it('DEFAULT_TTL is 15 minutes', () => { expect(DEFAULT_TTL).toBe(900); });

  it('rejects invalid ttl (0, NaN) in claimTask, claimNext, renewClaim', () => {
    const id = withCriteria('t');
    expect(() => claimTask(db, id, ai, 0)).toThrow(KddError);
    expect(() => claimTask(db, id, ai, NaN)).toThrow(KddError);
    expect(() => claimNext(db, ai, 0)).toThrow(KddError);
    expect(() => claimNext(db, ai, NaN)).toThrow(KddError);
    claimTask(db, id, ai); // hold a lease so renewClaim has something to validate against
    expect(() => renewClaim(db, id, ai, 0)).toThrow(KddError);
    expect(() => renewClaim(db, id, ai, NaN)).toThrow(KddError);
  });
});

// A2: инвариант «реклеймить чужой lease можно только вместе с его процессом» обязан держаться
// на ВСЕХ путях claim, а не только внутри tick — иначе человек забирает задачу у живого воркера.
describe('taking over an expired ai:tick lease', () => {
  const tickActor = { type: 'ai' as const, id: 'tick:1-0' };
  const expiredTick = (title = 't') => {
    const id = withCriteria(title);
    claimTask(db, id, tickActor, 900);
    db.prepare(`UPDATE tasks SET claim_expires = ? WHERE id = ?`).run(now() - 1, id);
    return id;
  };

  it('claimNext without a killer refuses it — the worker may still be alive', () => {
    expiredTick();
    expect(claimNext(db, ai2)).toBeNull();
    expect(db.prepare(`SELECT status, claimed_by FROM tasks WHERE id=1`).get())
      .toEqual({ status: 'in_progress', claimed_by: 'ai:tick:1-0' });
  });

  it('claimTask without a killer refuses it', () => {
    const id = expiredTick();
    const r = claimTask(db, id, ai2);
    expect(r.ok).toBe(false);
    expect(db.prepare(`SELECT claimed_by FROM tasks WHERE id=?`).get(id))
      .toEqual({ claimed_by: 'ai:tick:1-0' });
  });

  it('with a killer: kills first, then takes the task', () => {
    const id = expiredTick();
    const killed: number[] = [];
    const t = claimNext(db, ai2, 900, { kill: (taskId) => { killed.push(taskId); return 'gone'; } });
    expect(killed).toEqual([id]);
    expect(t!.id).toBe(id);
    expect(t!.claimed_by).toBe('ai:s2');
  });

  it('with a killer that reports stuck: lease untouched, claim refused', () => {
    const id = expiredTick();
    const r = claimTask(db, id, ai2, 900, { kill: () => 'stuck' });
    expect(r.ok).toBe(false);
    expect(db.prepare(`SELECT status, claimed_by FROM tasks WHERE id=?`).get(id))
      .toEqual({ status: 'in_progress', claimed_by: 'ai:tick:1-0' });
  });

  it('an expired NON-tick lease still reclaims without a killer (no process behind it)', () => {
    const id = withCriteria('t');
    claimTask(db, id, { type: 'user' }, 900);
    db.prepare(`UPDATE tasks SET claim_expires = ? WHERE id = ?`).run(now() - 1, id);
    expect(claimNext(db, ai2)!.id).toBe(id);
  });
});

describe('claim invariant on move', () => {
  it('leaving in_progress clears the claim (ai finishing -> review)', () => {
    const id = withCriteria('t');
    claimTask(db, id, ai);
    addCriterion(db, id, 'x', user); // чтобы ai мог уйти в review нужно закрыть критерии
    db.prepare(`UPDATE criteria SET checked_at = ? WHERE task_id = ?`).run(now(), id);
    moveTask(db, id, 'review', ai);
    expect(db.prepare(`SELECT status, claimed_by, claim_expires FROM tasks WHERE id=?`).get(id))
      .toEqual({ status: 'review', claimed_by: null, claim_expires: null });
  });

  it('user pulling a claimed task back to new clears the claim (human > lease)', () => {
    const id = withCriteria('t');
    claimTask(db, id, ai);
    moveTask(db, id, 'new', user);
    expect(db.prepare(`SELECT claimed_by FROM tasks WHERE id=?`).get(id)).toEqual({ claimed_by: null });
    // и снова берётся
    expect(claimNext(db, ai2)!.id).toBe(id);
  });
});

describe('run-token fence', () => {
  function readyClaimed(db: ReturnType<typeof openDb>, holder: string) {
    const t = addTask(db, { title: 'w' }, { type: 'user' });
    const c = addCriterion(db, t.id, 'done', { type: 'user' });
    setCriterionChecked(db, t.id, c.id, true, { type: 'user' });
    const r = claimTask(db, t.id, { type: 'ai', id: holder });
    expect(r.ok).toBe(true);
    return t.id;
  }

  it('rejects an ai move from in_progress when the lease is held by another tick worker', () => {
    const db = openDb(':memory:');
    const id = readyClaimed(db, 's1');
    // симулируем reclaim+respawn: задачу теперь держит другой tick-воркер
    db.prepare(`UPDATE tasks SET claimed_by='ai:tick:999-0' WHERE id=?`).run(id);
    expect(() => moveTask(db, id, 'review', { type: 'ai', id: 's1' }))
      .toThrow(/lease lost/);
  });

  it('rejects an ai move when the lease is held by another (non-tick) ai session', () => {
    const db = openDb(':memory:');
    const id = readyClaimed(db, 's1');
    db.prepare(`UPDATE tasks SET claimed_by='ai:s2' WHERE id=?`).run(id); // другая ai-сессия
    expect(() => moveTask(db, id, 'review', { type: 'ai', id: 's1' }))
      .toThrow(/lease lost/);
  });

  it('allows the holder to move to review and resets failed_attempts', () => {
    const db = openDb(':memory:');
    const id = readyClaimed(db, 's1');
    db.prepare(`UPDATE tasks SET failed_attempts=2 WHERE id=?`).run(id);
    const t = moveTask(db, id, 'review', { type: 'ai', id: 's1' });
    expect(t.status).toBe('review');
    expect(t.failed_attempts).toBe(0);
  });

  it('never fences a user actor', () => {
    const db = openDb(':memory:');
    const id = readyClaimed(db, 's1');
    db.prepare(`UPDATE tasks SET claimed_by='ai:tick:999-0' WHERE id=?`).run(id);
    expect(() => moveTask(db, id, 'review', { type: 'user' })).not.toThrow();
  });

  it('does NOT fence an ai move on a USER-held in_progress task (manual claim)', () => {
    const db = openDb(':memory:');
    const id = readyClaimed(db, 's1');
    db.prepare(`UPDATE tasks SET claimed_by='user' WHERE id=?`).run(id);
    expect(() => moveTask(db, id, 'review', { type: 'ai', id: 'x' })).not.toThrow();
  });

  it('does NOT fence an ai move on an UNCLAIMED in_progress task (doc-mode)', () => {
    // doc-режим: ai двигает доску без claim -> claimed_by NULL -> fence не срабатывает.
    const db = openDb(':memory:');
    const t = addTask(db, { title: 'doc' }, { type: 'user' });
    const c = addCriterion(db, t.id, 'done', { type: 'user' });
    setCriterionChecked(db, t.id, c.id, true, { type: 'user' });
    moveTask(db, t.id, 'in_progress', { type: 'ai', id: 's9' }); // raw move, без claim -> claimed_by NULL
    expect(() => moveTask(db, t.id, 'review', { type: 'ai', id: 's9' })).not.toThrow();
  });

  it('placeTask fences an ai move on a task held by another tick worker', () => {
    const db = openDb(':memory:');
    const id = readyClaimed(db, 's1');
    db.prepare(`UPDATE tasks SET claimed_by='ai:tick:999-0' WHERE id=?`).run(id);
    expect(() => placeTask(db, id, 'review', [id], { type: 'ai', id: 's1' }))
      .toThrow(/lease lost/);
  });

  it('placeTask resets failed_attempts when the holder reaches review', () => {
    const db = openDb(':memory:');
    const id = readyClaimed(db, 's1');
    db.prepare(`UPDATE tasks SET failed_attempts=2 WHERE id=?`).run(id);
    const t = placeTask(db, id, 'review', [id], { type: 'ai', id: 's1' });
    expect(t.status).toBe('review');
    expect(t.failed_attempts).toBe(0);
  });
});

describe('failure accounting', () => {
  // tick-спаун: claimed_by='ai:tick:1-0' -> reclaim штрафует (Fix B).
  function claimedExpired(db: ReturnType<typeof openDb>) {
    const t = addTask(db, { title: 'w' }, { type: 'user' });
    const c = addCriterion(db, t.id, 'd', { type: 'user' });
    setCriterionChecked(db, t.id, c.id, true, { type: 'user' });
    claimTask(db, t.id, { type: 'ai', id: 'tick:1-0' });
    db.prepare(`UPDATE tasks SET claim_expires = 1 WHERE id=?`).run(t.id); // истёк в прошлом
    return t.id;
  }

  it('reclaim increments failed_attempts and returns task to new', () => {
    const db = openDb(':memory:');
    const id = claimedExpired(db);
    reclaimExpired(db);
    const t = db.prepare(`SELECT status, failed_attempts, blocked FROM tasks WHERE id=?`).get(id) as any;
    expect(t.status).toBe('new');
    expect(t.failed_attempts).toBe(1);
    expect(t.blocked).toBe(0);
  });

  it('auto-blocks after K reclaims', () => {
    const db = openDb(':memory:');
    const id = claimedExpired(db);
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      db.prepare(`UPDATE tasks SET status='in_progress', claimed_by='ai:tick:1-0', claim_expires=1 WHERE id=?`).run(id);
      reclaimExpired(db);
    }
    const t = db.prepare(`SELECT blocked, failed_attempts FROM tasks WHERE id=?`).get(id) as any;
    expect(t.failed_attempts).toBeGreaterThanOrEqual(MAX_FAILED_ATTEMPTS);
    expect(t.blocked).toBe(1);
  });

  it('reclaim of a USER-claimed expired lease returns to new without counting a failure', () => {
    const db = openDb(':memory:');
    const t = addTask(db, { title: 'w' }, { type: 'user' });
    const c = addCriterion(db, t.id, 'd', { type: 'user' });
    setCriterionChecked(db, t.id, c.id, true, { type: 'user' });
    claimTask(db, t.id, { type: 'user' }); // claimed_by='user'
    db.prepare(`UPDATE tasks SET claim_expires = 1 WHERE id=?`).run(t.id);
    reclaimExpired(db);
    const row = db.prepare(`SELECT status, failed_attempts FROM tasks WHERE id=?`).get(t.id) as any;
    expect(row.status).toBe('new');
    expect(row.failed_attempts).toBe(0);
  });

  it('releaseClaim returns task to new and counts a failure', () => {
    const db = openDb(':memory:');
    const id = claimedExpired(db);
    db.prepare(`UPDATE tasks SET claim_expires = ${2 ** 31} WHERE id=?`).run(id); // не истёк
    releaseClaim(db, id, { type: 'ai', id: 'tick:1-0' }, 'spawn failed');
    const t = db.prepare(`SELECT status, claimed_by, failed_attempts FROM tasks WHERE id=?`).get(id) as any;
    expect(t.status).toBe('new');
    expect(t.claimed_by).toBeNull();
    expect(t.failed_attempts).toBe(1);
  });
});

describe('reclaimExpired closes orphaned agent-runs', () => {
  // helper: claim under a tick-worker actor, then force the lease expired.
  // claimed_by = 'ai:tick:1-0'  →  agent_events worker_id = 'tick:1-0'
  const tickActor = { type: 'ai' as const, id: 'tick:1-0' };
  const expireTick = (title = 't') => {
    const id = withCriteria(title);
    claimTask(db, id, tickActor, 900);
    db.prepare(`UPDATE tasks SET claim_expires = ? WHERE id = ?`).run(now() - 1, id);
    return id;
  };

  it('died mid-run (dangling run_start) → writes error + run_end', () => {
    const id = expireTick();
    appendAgentEvent(db, id, 'tick:1-0', 'run_start', { detail: { head: 'aaa' } });
    reclaimExpired(db);
    const evs = db.prepare(
      `SELECT kind, detail FROM agent_events WHERE task_id=? AND worker_id='tick:1-0' ORDER BY id`,
    ).all(id) as { kind: string; detail: string }[];
    expect(evs.map((e) => e.kind)).toEqual(['run_start', 'error', 'run_end']);
    expect(JSON.parse(evs[1].detail).message).toMatch(/died/);
    expect(JSON.parse(evs[2].detail)).toEqual({ exitCode: null });
    expect(lastAgentEventKind(db, id, 'tick:1-0')).toBe('run_end');
    // синтетический run_end без head → runProduced null (контракт #9: убитый ран = unknown, не действовать)
    expect(runProduced(db, id)).toBeNull();
  });

  it('never started (no agent_events) → writes error ONLY, no run_end', () => {
    const id = expireTick();
    reclaimExpired(db);
    const evs = db.prepare(
      `SELECT kind, detail FROM agent_events WHERE task_id=? AND worker_id='tick:1-0' ORDER BY id`,
    ).all(id) as { kind: string; detail: string }[];
    // рана не было (нет run_start) → закрывать нечего. Только error: run_end-сирота без run_start
    // спарился бы в task-scoped runProduced с run_start предыдущего воркера и замаскировал его результат.
    expect(evs.map((e) => e.kind)).toEqual(['error']);
    expect(JSON.parse(evs[0].detail).message).toMatch(/never started/);
  });

  it('never-started reclaim does NOT mask a prior worker\'s committed run', () => {
    // воркер A: завершённый закоммиченный ран (run_start head=A, run_end head=B).
    const id = withCriteria('t');
    claimTask(db, id, { type: 'ai', id: 'tick:1-0' }, 900);
    appendAgentEvent(db, id, 'tick:1-0', 'run_start', { detail: { head: 'A' } });
    appendAgentEvent(db, id, 'tick:1-0', 'run_end', { detail: { exitCode: 0, head: 'B' } });
    db.prepare(`UPDATE tasks SET claim_expires = ? WHERE id = ?`).run(now() - 1, id);
    reclaimExpired(db); // reclaim воркера A: last=run_end → guard, ничего не пишет
    // задача снова взята воркером B, который не стартовал, и его lease истёк
    claimTask(db, id, { type: 'ai', id: 'tick:2-0' }, 900);
    db.prepare(`UPDATE tasks SET claim_expires = ? WHERE id = ?`).run(now() - 1, id);
    reclaimExpired(db); // reclaim воркера B: never-started → только error, НЕ run_end-сирота
    // результат рана A цел: без сиротского run_end runProduced видит настоящий run_end (head=B)
    expect(runProduced(db, id)).toEqual({ before: 'A', after: 'B', committed: true });
  });

  it('already-closed run → no second run_end', () => {
    const id = expireTick();
    appendAgentEvent(db, id, 'tick:1-0', 'run_start', { detail: { head: 'aaa' } });
    appendAgentEvent(db, id, 'tick:1-0', 'run_end', { detail: { exitCode: 0, head: 'aaa' } });
    reclaimExpired(db);
    const kinds = (db.prepare(
      `SELECT kind FROM agent_events WHERE task_id=? AND worker_id='tick:1-0' ORDER BY id`,
    ).all(id) as { kind: string }[]).map((e) => e.kind);
    expect(kinds).toEqual(['run_start', 'run_end']); // guard: не добавили второй run_end
  });

  it('non-tick lease → no synthetic agent_events', () => {
    const id = withCriteria('t');
    claimTask(db, id, ai, 900); // ai = {type:'ai', id:'s1'} → claimed_by 'ai:s1' (не tick)
    db.prepare(`UPDATE tasks SET claim_expires = ? WHERE id = ?`).run(now() - 1, id);
    reclaimExpired(db);
    const n = (db.prepare(`SELECT COUNT(*) c FROM agent_events WHERE task_id=?`).get(id) as any).c;
    expect(n).toBe(0);
  });

  it('run-close write failure does not roll back the reclaim (best-effort)', () => {
    const id = expireTick();
    appendAgentEvent(db, id, 'tick:1-0', 'run_start', { detail: { head: 'aaa' } }); // died mid-run
    db.exec('DROP TABLE agent_events'); // форсим реальный провал INSERT'а в closeOrphanRun
    expect(() => reclaimExpired(db)).not.toThrow();
    // задача всё равно реклейм: closeOrphanRun упал, но try/catch не дал ему откатить sweep
    expect(db.prepare(`SELECT status, claimed_by FROM tasks WHERE id=?`).get(id))
      .toEqual({ status: 'new', claimed_by: null });
  });
});
