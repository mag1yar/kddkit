import { describe, it, expect } from 'vitest';
import { openDb, addTask } from '../src/index.js';
import {
  tick, addCriterion, setCriterionChecked, claimTask, reclaimExpired, appendAgentEvent, lastAgentEventKind,
  listAgentEvents, moveTask, now,
} from '../src/index.js';

describe('failed_attempts column', () => {
  it('defaults to 0 on a new task', () => {
    const db = openDb(':memory:');
    const t = addTask(db, { title: 'x' }, { type: 'user' });
    expect(t.failed_attempts).toBe(0);
  });
});

function readyTask(db: ReturnType<typeof openDb>, title: string) {
  const t = addTask(db, { title }, { type: 'user' });
  const c = addCriterion(db, t.id, 'done', { type: 'user' });
  setCriterionChecked(db, t.id, c.id, true, { type: 'user' });
  return t.id;
}

describe('tick', () => {
  it('spawns up to maxWorkers and leaves the rest new', () => {
    const db = openDb(':memory:');
    readyTask(db, 'a'); readyTask(db, 'b'); readyTask(db, 'c');
    const calls: { taskId: number; workerId: string }[] = [];
    const r = tick(db, { maxWorkers: 2, ttl: 1800, projectDir: '/tmp',
      spawn: (taskId, workerId) => calls.push({ taskId, workerId }) });
    expect(r.spawned).toBe(2);
    expect(r.active).toBe(2);
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.workerId)).size).toBe(2); // уникальные токены
    const newCount = (db.prepare(`SELECT COUNT(*) c FROM tasks WHERE status='new'`).get() as any).c;
    expect(newCount).toBe(1);
  });

  it('claims each task as its unique worker token', () => {
    const db = openDb(':memory:');
    const id = readyTask(db, 'a');
    const seen: string[] = [];
    tick(db, { maxWorkers: 1, ttl: 1800, projectDir: '/tmp',
      spawn: (_t, workerId) => seen.push(workerId) });
    const claimed = (db.prepare(`SELECT claimed_by FROM tasks WHERE id=?`).get(id) as any).claimed_by;
    expect(claimed).toBe(`ai:${seen[0]}`); // токен воркера == claimed_by
  });

  it('empty queue spawns nothing', () => {
    const db = openDb(':memory:');
    const r = tick(db, { maxWorkers: 3, ttl: 1800, projectDir: '/tmp', spawn: () => {} });
    expect(r.spawned).toBe(0);
  });

  it('sync spawn failure releases the claim and counts a failure', () => {
    const db = openDb(':memory:');
    const id = readyTask(db, 'a');
    const r = tick(db, { maxWorkers: 1, ttl: 1800, projectDir: '/tmp',
      spawn: () => { throw new Error('ENOENT'); } });
    expect(r.spawned).toBe(0);
    const t = db.prepare(`SELECT status, claimed_by, failed_attempts FROM tasks WHERE id=?`).get(id) as any;
    expect(t.status).toBe('new');
    expect(t.claimed_by).toBeNull();
    expect(t.failed_attempts).toBe(1);
  });

  it('reclaims a dead ai:tick lease and closes its orphaned run', () => {
    const db = openDb(':memory:');
    const id = readyTask(db, 'a');
    // спаунить воркера через tick (claim под tick-токеном), затем эмулировать смерть: висячий run_start
    let workerId = '';
    tick(db, { maxWorkers: 1, ttl: 1800, projectDir: '/tmp',
      spawn: (_t, w) => { workerId = w; } }); // claimed_by = ai:<workerId>
    appendAgentEvent(db, id, workerId, 'run_start', { detail: { head: 'aaa' } });
    // форсим истечение lease и реклеймим (как boot-reaper в начале следующего tick)
    db.prepare(`UPDATE tasks SET claim_expires = ? WHERE id = ?`).run(now() - 1, id);
    expect(reclaimExpired(db).map((r) => r.id)).toEqual([id]);
    const t = db.prepare(`SELECT status, claimed_by FROM tasks WHERE id=?`).get(id);
    expect(t).toEqual({ status: 'new', claimed_by: null });
    expect(lastAgentEventKind(db, id, workerId)).toBe('run_end'); // ран закрыт
  });
});

// хелпер: довести задачу до состояния «занята мёртвым tick-воркером»
function deadTickLease(db: ReturnType<typeof openDb>, title: string): number {
  const id = readyTask(db, title);
  tick(db, { maxWorkers: 1, ttl: 1800, projectDir: '/tmp', spawn: () => {} });
  db.prepare(`UPDATE tasks SET claim_expires = ? WHERE id = ?`).run(now() - 1, id);
  return id;
}

describe('tick kills reclaimed workers', () => {
  it('kills the process of a reclaimed ai:tick lease', () => {
    const db = openDb(':memory:');
    const id = deadTickLease(db, 'a');
    const killed: number[] = [];
    const r = tick(db, { maxWorkers: 1, ttl: 1800, projectDir: '/tmp',
      spawn: () => {}, kill: (ids) => { killed.push(...ids); return new Map(ids.map((i) => [i, 'gone' as const])); } });
    expect(killed).toEqual([id]);
    expect(r.reclaimed).toBe(1);
    expect(r.killed).toBe(1);
  });

  // Обычный случай: воркер вышел сам, а lease его пережил. Слот освобождается, но убивать
  // было некого — 'absent' не должен попадать в killed и не должен блокировать задачу.
  it('an absent process frees the slot without counting as a kill', () => {
    const db = openDb(':memory:');
    const id = deadTickLease(db, 'a');
    const r = tick(db, { maxWorkers: 1, ttl: 1800, projectDir: '/tmp',
      spawn: () => {}, kill: (ids) => new Map(ids.map((i) => [i, 'absent' as const])) });
    expect(r.reclaimed).toBe(1);
    expect(r.killed).toBe(0);
    const t = db.prepare(`SELECT blocked FROM tasks WHERE id=?`).get(id) as any;
    expect(t.blocked).toBe(0);
  });

  it('does not kill an expired manual user claim — there is no process', () => {
    const db = openDb(':memory:');
    const id = readyTask(db, 'a');
    claimTask(db, id, { type: 'user' }, 1800);
    db.prepare(`UPDATE tasks SET claim_expires = ? WHERE id = ?`).run(now() - 1, id);
    const killed: number[] = [];
    const r = tick(db, { maxWorkers: 1, ttl: 1800, projectDir: '/tmp',
      spawn: () => {}, kill: (ids) => { killed.push(...ids); return new Map(ids.map((i) => [i, 'gone' as const])); } });
    expect(killed).toEqual([]);
    expect(r.killed).toBe(0);
  });

  // Репро A1: слот НЕ возвращается, пока процесс жив. Иначе тот же проход клеймит следующую
  // готовую задачу и сажает второго агента при maxWorkers=1 — юзер платит за двоих.
  it('a process surviving SIGKILL keeps its slot: nothing new is spawned under the cap', () => {
    const db = openDb(':memory:');
    const id = deadTickLease(db, 'a');
    const next = readyTask(db, 'b'); // единственный кандидат на «освободившийся» слот
    const spawns: number[] = [];
    const r = tick(db, { maxWorkers: 1, ttl: 1800, projectDir: '/tmp',
      spawn: (taskId) => spawns.push(taskId), kill: (ids) => new Map(ids.map((i) => [i, 'stuck' as const])) });
    expect(spawns).toEqual([]);
    expect(r.spawned).toBe(0);
    expect(r.stuck).toBe(1);
    expect(r.killed).toBe(0);
    expect(r.reclaimed).toBe(0);
    expect(r.active).toBe(1); // застрявший воркер по-прежнему считается — кап соблюдён
    const t = db.prepare(`SELECT status, claimed_by, blocked FROM tasks WHERE id=?`).get(id) as any;
    expect(t.status).toBe('in_progress');
    expect(t.claimed_by).toMatch(/^ai:tick:/);
    expect(t.blocked).toBe(0); // это не проблема человека, а ещё живой воркер
    expect(db.prepare(`SELECT status FROM tasks WHERE id=?`).get(next))
      .toEqual({ status: 'new' });
  });

  it('a stuck lease is retried on the next pass and frees the slot once it dies', () => {
    const db = openDb(':memory:');
    const id = deadTickLease(db, 'a');
    tick(db, { maxWorkers: 1, ttl: 1800, projectDir: '/tmp', spawn: () => {}, kill: (ids) => new Map(ids.map((i) => [i, 'stuck' as const])) });
    const killed: number[] = [];
    // lease так и остался истёкшим -> следующий проход сам повторяет попытку, без человека
    const r = tick(db, { maxWorkers: 1, ttl: 1800, projectDir: '/tmp',
      spawn: () => {}, kill: (ids) => { killed.push(...ids); return new Map(ids.map((i) => [i, 'gone' as const])); } });
    expect(killed).toEqual([id]);
    expect(r.killed).toBe(1);
    expect(r.reclaimed).toBe(1);
    expect(r.stuck).toBe(0);
  });

  it('a throwing killer is treated as stuck, not as success', () => {
    const db = openDb(':memory:');
    const id = deadTickLease(db, 'a');
    const r = tick(db, { maxWorkers: 1, ttl: 1800, projectDir: '/tmp',
      spawn: () => {}, kill: () => { throw new Error('ps exploded'); } });
    expect(r.stuck).toBe(1);
    const t = db.prepare(`SELECT status, blocked FROM tasks WHERE id=?`).get(id) as any;
    expect(t.status).toBe('in_progress'); // слот не отдан — безопасная сторона
    expect(t.blocked).toBe(0);
  });

  // Убить нечем — значит и отдавать слот нельзя: реклеймит тот, кто умеет убивать (`kdd tick`).
  it('without a killer a tick lease is left alone entirely', () => {
    const db = openDb(':memory:');
    const id = deadTickLease(db, 'a');
    const r = tick(db, { maxWorkers: 1, ttl: 1800, projectDir: '/tmp', spawn: () => {} });
    expect(r.killed).toBe(0);
    expect(r.reclaimed).toBe(0);
    const t = db.prepare(`SELECT status, blocked FROM tasks WHERE id=?`).get(id) as any;
    expect(t.status).toBe('in_progress');
    expect(t.blocked).toBe(0);
  });

  it('reclaimExpired returns the rows, carrying claimed_by', () => {
    const db = openDb(':memory:');
    const id = deadTickLease(db, 'a');
    const rows = reclaimExpired(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].claimed_by).toMatch(/^ai:tick:/);
  });
});

// Хозяйство базы висит на тике намеренно: agent_events рождаются только там, где ходят
// воркеры, и отдельной команды-уборщика, которую надо помнить запускать, быть не должно.
describe('tick keeps the store from growing forever', () => {
  it('prunes the stale feed of a finished task on its way through', () => {
    const db = openDb(':memory:');
    const t = addTask(db, { title: 'old' }, { type: 'user' });
    appendAgentEvent(db, t.id, 'w', 'tool_finish', { detail: { output: 'x'.repeat(1000) } });
    appendAgentEvent(db, t.id, 'w', 'run_end', { detail: { head: 'aaa' } });
    moveTask(db, t.id, 'done', { type: 'user' });
    // срок считается от завершения задачи, а не от возраста строк фида
    db.prepare(`UPDATE tasks SET updated_at = updated_at - ? WHERE id = ?`).run(30 * 86_400, t.id);

    tick(db, { maxWorkers: 1, ttl: 1800, projectDir: '/tmp', spawn: () => {} });

    expect(listAgentEvents(db, t.id).map((e) => e.kind)).toEqual(['run_end']);
  });
});
