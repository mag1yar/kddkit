import { describe, it, expect, beforeEach } from 'vitest';
import type { Db } from '../src/db.js';
import { openDb } from '../src/db.js';
import { addTask, moveTask, placeTask } from '../src/ops.js';
import { addCriterion, setCriterionChecked } from '../src/criteria.js';
import { claimTask, renewClaim, DEFAULT_TTL } from '../src/claim.js';
import { now } from '../src/db.js';
import { KddError } from '../src/errors.js';

let db: Db;
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

  it('claimTask reclaims an expired lease, logs reclaimed, and leaves other leases alone', () => {
    const id = withCriteria('t');
    const other = withCriteria('o');
    claimTask(db, id, ai, 900);
    claimTask(db, other, ai, 900);
    db.prepare(`UPDATE tasks SET claim_expires = ? WHERE id IN (?, ?)`).run(now() - 1, id, other); // форсим истечение
    expect(claimTask(db, id, ai2).ok).toBe(true);
    const events = db.prepare(`SELECT action, detail FROM events WHERE task_id=? AND action='reclaimed'`).all(id) as any[];
    expect(JSON.parse(events[0].detail).former).toBe('ai:s1');
    // чужой просроченный лиз ждёт своего claim
    expect(db.prepare(`SELECT status, claimed_by FROM tasks WHERE id=?`).get(other))
      .toEqual({ status: 'in_progress', claimed_by: 'ai:s1' });
  });

  // Владение — claimed_by, а не срок: свой просроченный и никем не забранный lease продлевается.
  it('renewClaim extends its own expired lease nobody reclaimed, and fails after a reclaim', () => {
    const id = withCriteria('t');
    claimTask(db, id, ai, 900);
    db.prepare(`UPDATE tasks SET claim_expires = ? WHERE id = ?`).run(now() - 1, id);
    const r = renewClaim(db, id, ai, 900);
    expect(r.ok && r.task.claim_expires).toBeGreaterThanOrEqual(now() + 899);
    db.prepare(`UPDATE tasks SET claim_expires = ? WHERE id = ?`).run(now() - 1, id);
    expect(claimTask(db, id, ai2).ok).toBe(true); // reclaim другим актором
    expect(renewClaim(db, id, ai).ok).toBe(false);
  });

  it('DEFAULT_TTL is 15 minutes', () => { expect(DEFAULT_TTL).toBe(900); });

  it('rejects invalid ttl (0, NaN) in claimTask, renewClaim', () => {
    const id = withCriteria('t');
    expect(() => claimTask(db, id, ai, 0)).toThrow(KddError);
    expect(() => claimTask(db, id, ai, NaN)).toThrow(KddError);
    claimTask(db, id, ai); // hold a lease so renewClaim has something to validate against
    expect(() => renewClaim(db, id, ai, 0)).toThrow(KddError);
    expect(() => renewClaim(db, id, ai, NaN)).toThrow(KddError);
  });

  it('rejects a ttl above 30 days and writes nothing', () => {
    const id = withCriteria('t');
    const events = (): number => (db.prepare(`SELECT COUNT(*) c FROM events`).get() as { c: number }).c;
    const before = events();
    expect(() => claimTask(db, id, ai, 1e16)).toThrow(/max 2592000/);
    expect(() => claimTask(db, id, ai, 1e16)).toThrow(KddError);
    expect(db.prepare(`SELECT status, claimed_by, claim_expires FROM tasks WHERE id = ?`).get(id))
      .toEqual({ status: 'new', claimed_by: null, claim_expires: null });
    expect(events()).toBe(before);
    expect(claimTask(db, id, ai, 2_592_000).ok).toBe(true);
  });
});

describe('expired lease', () => {
  // За лизом нет процесса: истёк — слот свободен, следующий claim забирает задачу сам.
  it('claimTask takes over an expired ai lease', () => {
    const id = withCriteria('t');
    claimTask(db, id, ai, 900);
    db.prepare(`UPDATE tasks SET claim_expires = ? WHERE id = ?`).run(now() - 1, id);
    const r = claimTask(db, id, ai2);
    expect(r.ok && r.task.claimed_by).toBe('ai:s2');
  });

  it('an expired USER lease is taken over like any other', () => {
    const id = withCriteria('t');
    claimTask(db, id, user);
    db.prepare(`UPDATE tasks SET claim_expires = 1 WHERE id=?`).run(id);
    const r = claimTask(db, id, ai);
    expect(r.ok && r.task.claimed_by).toBe('ai:s1');
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
    expect(claimTask(db, id, ai2).ok).toBe(true);
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

  it('rejects an ai move when the lease is held by another ai session', () => {
    const db = openDb(':memory:');
    const id = readyClaimed(db, 's1');
    db.prepare(`UPDATE tasks SET claimed_by='ai:s2' WHERE id=?`).run(id); // другая ai-сессия
    expect(() => moveTask(db, id, 'review', { type: 'ai', id: 's1' }))
      .toThrow(/lease lost/);
  });

  it('allows the holder to move to review', () => {
    const db = openDb(':memory:');
    const id = readyClaimed(db, 's1');
    const t = moveTask(db, id, 'review', { type: 'ai', id: 's1' });
    expect(t.status).toBe('review');
  });

  it('never fences a user actor', () => {
    const db = openDb(':memory:');
    const id = readyClaimed(db, 's1');
    db.prepare(`UPDATE tasks SET claimed_by='ai:s2' WHERE id=?`).run(id);
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

  // Подметать просроченные lease некому: мёртвая сессия не должна запирать задачу навсегда.
  it('lets another ai move a task whose foreign lease expired, and clears the lease', () => {
    const db = openDb(':memory:');
    const id = readyClaimed(db, 's1');
    db.prepare(`UPDATE tasks SET claim_expires = ? WHERE id = ?`).run(now() - 1, id);
    const t = moveTask(db, id, 'review', { type: 'ai', id: 's2' });
    expect([t.status, t.claimed_by, t.claim_expires]).toEqual(['review', null, null]);
    const ev = db.prepare(`SELECT detail FROM events WHERE task_id=? AND action='moved' ORDER BY id DESC LIMIT 1`)
      .get(id) as { detail: string };
    expect(JSON.parse(ev.detail).reclaimed_from).toBe('ai:s1');
  });

  it('still fences on an active foreign lease', () => {
    const db = openDb(':memory:');
    const id = readyClaimed(db, 's1');
    expect(() => moveTask(db, id, 'review', { type: 'ai', id: 's2' })).toThrow(/lease lost/);
    expect(() => placeTask(db, id, 'review', [id], { type: 'ai', id: 's2' })).toThrow(/lease lost/);
  });

  it('placeTask fences an ai move on a task held by another ai session', () => {
    const db = openDb(':memory:');
    const id = readyClaimed(db, 's1');
    db.prepare(`UPDATE tasks SET claimed_by='ai:s2' WHERE id=?`).run(id);
    expect(() => placeTask(db, id, 'review', [id], { type: 'ai', id: 's1' }))
      .toThrow(/lease lost/);
  });

});
