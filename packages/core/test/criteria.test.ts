import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { addTask, appendEvent } from '../src/ops.js';
import {
  addCriterion, listCriteria, removeCriterion, setCriterionChecked,
} from '../src/criteria.js';
import { taskDetail, taskDetailCapped } from '../src/queries.js';

let db: Database.Database;
beforeEach(() => { db = openDb(':memory:', 'p'); });
const user = { type: 'user' as const };
const ai = { type: 'ai' as const, id: 's1' };

describe('criteria', () => {
  it('add/check/uncheck/remove with events and attribution', () => {
    addTask(db, { title: 't' }, user);
    const c = addCriterion(db, 1, 'tests green', ai);
    expect(c).toMatchObject({ task_id: 1, text: 'tests green', checked_at: null, position: 0 });

    const checked = setCriterionChecked(db, 1, c.id, true, ai);
    expect(checked.checked_at).not.toBeNull();
    // идемпотентность: повторный check не пишет событие-дубль
    setCriterionChecked(db, 1, c.id, true, ai);
    setCriterionChecked(db, 1, c.id, false, user);
    removeCriterion(db, 1, c.id, user);

    const actions = db.prepare(
      `SELECT action, actor_type FROM events WHERE action LIKE 'criterion%' ORDER BY id`,
    ).all();
    expect(actions).toEqual([
      { action: 'criterion_added', actor_type: 'ai' },
      { action: 'criterion_checked', actor_type: 'ai' },
      { action: 'criterion_unchecked', actor_type: 'user' },
      { action: 'criterion_removed', actor_type: 'user' },
    ]);
    expect(listCriteria(db, 1)).toEqual([]);
  });

  it('stores evidence and the checking actor in the current snapshot and event', () => {
    addTask(db, { title: 't' }, user);
    const c = addCriterion(db, 1, 'tests green', user);

    const checked = setCriterionChecked(db, 1, c.id, true, ai, 'pnpm test');

    expect(checked).toMatchObject({
      evidence: 'pnpm test', checked_by: 'ai:s1',
    });
    const event = db.prepare(
      `SELECT detail FROM events WHERE action = 'criterion_checked'`,
    ).get() as { detail: string };
    expect(JSON.parse(event.detail)).toEqual({ id: c.id, text: 'tests green', evidence: 'pnpm test' });
  });

  it('rechecking with explicit evidence refreshes snapshot and audit even when text is unchanged', () => {
    addTask(db, { title: 't' }, user);
    const c = addCriterion(db, 1, 'tests green', user);
    setCriterionChecked(db, 1, c.id, true, ai, 'pnpm test');
    db.prepare(`UPDATE criteria SET checked_at = 1 WHERE id = ?`).run(c.id);

    const refreshed = setCriterionChecked(
      db, 1, c.id, true, { type: 'ai', id: 's2' }, 'pnpm test',
    );

    expect(refreshed).toMatchObject({ evidence: 'pnpm test', checked_by: 'ai:s2' });
    expect(refreshed.checked_at).toBeGreaterThan(1);
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM events WHERE action = 'criterion_checked'`,
    ).get()).toEqual({ count: 2 });
  });

  it('rechecking without non-empty evidence is a complete no-op', () => {
    addTask(db, { title: 't' }, user);
    const c = addCriterion(db, 1, 'tests green', user);
    const before = setCriterionChecked(db, 1, c.id, true, ai, 'pnpm test');

    expect(setCriterionChecked(db, 1, c.id, true, user)).toEqual(before);
    expect(setCriterionChecked(db, 1, c.id, true, user, '   ')).toEqual(before);
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM events WHERE action = 'criterion_checked'`,
    ).get()).toEqual({ count: 1 });
  });

  it('uncheck clears the current snapshot but keeps prior verification events', () => {
    addTask(db, { title: 't' }, user);
    const c = addCriterion(db, 1, 'tests green', user);
    setCriterionChecked(db, 1, c.id, true, ai, 'pnpm test');

    const unchecked = setCriterionChecked(db, 1, c.id, false, user);

    expect(unchecked).toMatchObject({ checked_at: null, evidence: null, checked_by: null });
    expect(db.prepare(
      `SELECT action, detail FROM events WHERE action LIKE 'criterion_%' ORDER BY id`,
    ).all()).toEqual([
      { action: 'criterion_added', detail: JSON.stringify({ id: c.id, text: 'tests green' }) },
      { action: 'criterion_checked', detail: JSON.stringify({
        id: c.id, text: 'tests green', evidence: 'pnpm test',
      }) },
      { action: 'criterion_unchecked', detail: JSON.stringify({ id: c.id, text: 'tests green' }) },
    ]);
  });

  it('addTask creates criteria in order without per-criterion events', () => {
    addTask(db, { title: 't', criteria: ['a', 'b'] }, user);
    expect(listCriteria(db, 1).map((c) => c.text)).toEqual(['a', 'b']);
    expect(db.prepare(`SELECT COUNT(*) c FROM events WHERE action LIKE 'criterion%'`).get())
      .toEqual({ c: 0 });
  });

  it('rejects empty text and foreign task/criterion ids', () => {
    addTask(db, { title: 'a' }, user);
    addTask(db, { title: 'b' }, user);
    expect(() => addCriterion(db, 1, '  ', user)).toThrow(/must not be empty/);
    expect(() => addTask(db, { title: 'x', criteria: [' '] }, user))
      .toThrow(/must not be empty/);
    const c = addCriterion(db, 1, 'ok', user);
    // criterion чужой задачи недоступен
    expect(() => setCriterionChecked(db, 2, c.id, true, user)).toThrow(/not found on task #2/);
  });

  it('taskDetail and capped include full criteria list', () => {
    addTask(db, { title: 't', criteria: ['a', 'b', 'c'] }, user);
    expect(taskDetail(db, 1).criteria).toHaveLength(3);
    expect(taskDetailCapped(db, 1).criteria).toHaveLength(3);
  });

  it('appendEvent stores parent_id/type/level, defaults NULL/NULL/info', () => {
    addTask(db, { title: 't' }, user);
    const parentId = appendEvent(db, 1, ai, 'claim', undefined,
      { type: 'claim', level: 'warn' });
    appendEvent(db, 1, ai, 'verify', { exit_code: 0 }, { parent_id: parentId });
    const rows = db.prepare(
      `SELECT parent_id, type, level FROM events WHERE task_id = 1 ORDER BY id`,
    ).all();
    expect(rows).toEqual([
      { parent_id: null, type: null, level: 'info' },      // created (без opts)
      { parent_id: null, type: 'claim', level: 'warn' },
      { parent_id: parentId, type: null, level: 'info' },
    ]);
  });

  it('migration keeps legacy events and allows open action vocabulary', () => {
    addTask(db, { title: 't' }, user);
    db.prepare(
      `INSERT INTO events (task_id, actor_type, action, created_at) VALUES (1, 'ai', 'verify', 0)`,
    ).run();
    expect(db.prepare(`SELECT COUNT(*) c FROM events`).get()).toEqual({ c: 2 });
  });
});
