import { describe, it, expect } from 'vitest';
import {
  addTask, openDb, mustGetTask, CAPS, moveTask, addCriterion, setCriterionChecked,
} from '@kddkit/core';
import { getTask, listTasks, recallTool, updateTask } from '../src/handlers.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const user = { type: 'user' } as const;
const mk = () => openDb(':memory:', 'x');

describe('getTask', () => {
  it('returns detail with comments and events', () => {
    const db = mk();
    const t = addTask(db, { title: 'detail me' }, user);
    const d = getTask(db, t.id);
    expect(d.task.title).toBe('detail me');
    expect(Array.isArray(d.comments)).toBe(true);
    expect(d.events.length).toBe(1);
  });

  it('unknown id throws not found', () => {
    const db = mk();
    expect(() => getTask(db, 999)).toThrow(/not found/);
  });

  it('caps comments/events/body, totals stay honest', () => {
    const db = mk();
    const t = addTask(db, { title: 'whale', body: 'x'.repeat(9000) }, user);
    for (let i = 0; i < 25; i++) updateTask(db, { id: t.id, comment: `c${i} ${'y'.repeat(600)}` }, ai);
    const d = getTask(db, t.id) as ReturnType<typeof getTask> & {
      comments_total: number; events_total: number;
    };
    expect(d.comments.length).toBe(20);
    expect(d.comments_total).toBe(25);
    expect(d.comments.at(-1)!.body).toMatch(/^c24 /); // последние, не первые
    expect(d.comments[0]!.body).toContain('chars]'); // тело коммента капировано
    expect(d.events.length).toBe(10);
    expect(d.events_total).toBeGreaterThan(10);
    expect(d.task.body!.length).toBeLessThan(9000);
    expect(d.task.body).toContain('chars]');
  });

  it('full=true returns the uncapped record', () => {
    const db = mk();
    const t = addTask(db, { title: 'whale', body: 'x'.repeat(9000) }, user);
    for (let i = 0; i < 25; i++) updateTask(db, { id: t.id, comment: `c${i}` }, ai);
    const d = getTask(db, t.id, true);
    expect(d.comments.length).toBe(25);
    expect(d.task.body!.length).toBe(9000);
  });
});

describe('listTasks', () => {
  it('groups compact rows by status and omits body', () => {
    const db = mk();
    addTask(db, { title: 'a', body: 'secret body', priority: 'high' }, user);
    const board = listTasks(db);
    expect(Object.keys(board.tasks)).toEqual(['backlog', 'new', 'in_progress', 'review', 'done']);
    expect(board.tasks.new).toEqual([
      { id: 1, title: 'a', status: 'new', kind: 'feature', priority: 'high', blocked: false,
        ready: true, criteria: { checked: 0, total: 0 } },
    ]);
    expect(JSON.stringify(board)).not.toContain('secret body');
  });

  it('filters by status', () => {
    const db = mk();
    addTask(db, { title: 'a' }, user);
    expect(listTasks(db, { status: 'in_progress' }).tasks.in_progress).toEqual([]);
    expect(listTasks(db, { status: 'new' }).tasks.new.length).toBe(1);
  });

  it('carries ready flag and criteria counts', () => {
    const db = mk();
    addTask(db, { title: 'ready one', priority: 'urgent' }, user); // #1 new
    addTask(db, { title: 'taken' }, user);                          // #2
    moveTask(db, 2, 'in_progress', user);
    const c = addCriterion(db, 1, 'a', user);
    addCriterion(db, 1, 'b', user);
    setCriterionChecked(db, 1, c.id, true, user);
    const row = listTasks(db).tasks.new[0];
    expect(row.ready).toBe(true);
    expect(row.criteria).toEqual({ checked: 1, total: 2 });
    expect(listTasks(db).tasks.in_progress[0].ready).toBe(false);
  });

  it('ready filter narrows to takeable tasks', () => {
    const db = mk();
    addTask(db, { title: 'ready one', priority: 'urgent' }, user);
    addTask(db, { title: 'taken' }, user);
    moveTask(db, 2, 'in_progress', user);
    const r = listTasks(db, { ready: true });
    expect(r.tasks.new.map((t) => t.id)).toEqual([1]);
    expect(r.tasks.in_progress ?? []).toEqual([]);
  });

  it('caps rows per status and reports omitted outside the status map', () => {
    const db = mk();
    const over = CAPS.listRows + 3;
    for (let i = 0; i < over; i++) addTask(db, { title: `t${i}` }, user);
    const board = listTasks(db);
    expect(board.tasks.new.length).toBe(CAPS.listRows);
    expect(board.omitted).toEqual({ new: 3 });
    // generic-итератор по колонкам не должен спотыкаться об omitted
    for (const rows of Object.values(board.tasks)) expect(Array.isArray(rows)).toBe(true);
    expect(listTasks(db, { status: 'done' }).omitted).toBeUndefined();
  });
});

const ai = { type: 'ai', id: 'sess-1' } as const;
const emptyDir = () => mkdtempSync(join(tmpdir(), 'kdd-mcp-'));

describe('recallTool', () => {
  it('finds a task by title', () => {
    const db = openDb(':memory:', 'x');
    addTask(db, { title: 'quantum widget' }, { type: 'user' });
    const hits = recallTool(db, emptyDir(), 'quantum', {});
    expect(hits.some((h) => h.kind === 'task' && /quantum/.test(h.title))).toBe(true);
  });
});

describe('updateTask', () => {
  it('edit records an ai event', () => {
    const db = openDb(':memory:', 'x');
    const t = addTask(db, { title: 'old' }, { type: 'user' });
    const u = updateTask(db, { id: t.id, edit: { title: 'new', priority: 'urgent' } }, ai);
    expect([u.title, u.priority]).toEqual(['new', 'urgent']);
    const ev = db.prepare(`SELECT actor_type, action FROM events WHERE task_id=? ORDER BY id`).all(t.id);
    expect(ev).toEqual([
      { actor_type: 'user', action: 'created' },
      { actor_type: 'ai', action: 'edited' },
    ]);
  });

  it('move follows the state machine and records ai event', () => {
    const db = openDb(':memory:', 'x');
    const t = addTask(db, { title: 'm' }, { type: 'user' });
    const u = updateTask(db, { id: t.id, move: { to: 'in_progress' } }, ai);
    expect(u.status).toBe('in_progress');
  });

  it('comment is attributed to ai session', () => {
    const db = openDb(':memory:', 'x');
    const t = addTask(db, { title: 'c' }, { type: 'user' });
    updateTask(db, { id: t.id, comment: 'progress note' }, ai);
    const c = db.prepare(`SELECT author, body FROM comments WHERE task_id=?`).get(t.id);
    expect(c).toEqual({ author: 'ai:sess-1', body: 'progress note' });
  });

  it('applies edit, move and comment together', () => {
    const db = openDb(':memory:', 'x');
    const t = addTask(db, { title: 'x' }, { type: 'user' });
    const u = updateTask(db,
      { id: t.id, edit: { body: 'b' }, move: { to: 'in_progress' }, comment: 'go' }, ai);
    expect(u.status).toBe('in_progress');
    expect(u.body).toBe('b');
  });

  it('empty update throws', () => {
    const db = openDb(':memory:', 'x');
    const t = addTask(db, { title: 'x' }, { type: 'user' });
    expect(() => updateTask(db, { id: t.id }, ai)).toThrow(/nothing to update/);
  });

  it('invalid move surfaces the state-machine error', () => {
    const db = openDb(':memory:', 'x');
    const t = addTask(db, { title: 'x' }, { type: 'user' });
    expect(() => updateTask(db, { id: t.id, move: { to: 'done' } }, ai)).toThrow(/invalid transition/);
  });

  it('rolls back the edit when a later move fails (atomic)', () => {
    const db = openDb(':memory:', 'x');
    const t = addTask(db, { title: 'orig' }, { type: 'user' });
    // ai move new->done is an invalid transition; the edit must NOT persist
    expect(() => updateTask(db,
      { id: t.id, edit: { title: 'changed' }, move: { to: 'done' } }, ai)).toThrow(/invalid transition/);
    expect(mustGetTask(db, t.id).title).toBe('orig');
  });
});
