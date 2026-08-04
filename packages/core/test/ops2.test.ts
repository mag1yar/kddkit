import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import {
  addTask, moveTask, placeTask, mustGetTask,
  blockTask, unblockTask, linkTasks, archiveTask, unarchiveTask,
} from '../src/ops.js';
import { boardData } from '../src/queries.js';
import type { Actor } from '../src/state.js';

let db: Database.Database;
const user = { type: 'user' as const };
const ai = { type: 'ai' as const, id: 's1' };
beforeEach(() => { db = openDb(':memory:', 'p'); addTask(db, { title: 'a' }, user); });

describe('moveTask', () => {
  it('moves along the matrix and logs from/to', () => {
    const t = moveTask(db, 1, 'in_progress', ai);
    expect(t.status).toBe('in_progress');
    const ev: any = db.prepare(`SELECT detail FROM events WHERE action='moved'`).get();
    expect(JSON.parse(ev.detail)).toEqual({ from: 'new', to: 'in_progress' });
  });

  // #117: «кто сдал» берётся из журнала — проверяем сам вывод, а не только правило в checkMove.
  describe('self-accept', () => {
    const submit = (actor: Actor = ai) => {
      moveTask(db, 1, 'in_progress', actor);
      moveTask(db, 1, 'review', actor);
    };

    it('the agent that submitted does not close its own task on its own', () => {
      submit();
      expect(() => moveTask(db, 1, 'done', ai)).toThrow(/submitted this task for review yourself/);
      expect(mustGetTask(db, 1).status).toBe('review');
      // тот же запрет на drag-пути доски
      expect(() => placeTask(db, 1, 'done', [1], ai)).toThrow(/submitted this task for review/);
    });

    it('a reason closes it and the event says the submitter accepted itself', () => {
      submit();
      expect(moveTask(db, 1, 'done', ai, 'пользователь попросил закрыть').status).toBe('done');
      const ev: any = db.prepare(
        `SELECT detail FROM events WHERE action='moved' ORDER BY id DESC LIMIT 1`).get();
      expect(JSON.parse(ev.detail)).toMatchObject({ to: 'done', self_accepted: true });
    });

    it('an ordinary acceptance carries no such mark', () => {
      submit();
      moveTask(db, 1, 'done', { type: 'ai', id: 's2' });
      const ev: any = db.prepare(
        `SELECT detail FROM events WHERE action='moved' ORDER BY id DESC LIMIT 1`).get();
      expect(JSON.parse(ev.detail).self_accepted).toBeUndefined();
    });

    it('a human or another session closes it', () => {
      submit();
      expect(moveTask(db, 1, 'done', { type: 'ai', id: 's2' }).status).toBe('done');
    });

    it('only the last submission counts: reject, rework by another agent, close', () => {
      submit();                                            // сдал s1
      moveTask(db, 1, 'in_progress', user);                // человек вернул
      moveTask(db, 1, 'review', { type: 'ai', id: 's2' }); // переделал и сдал s2
      expect(() => moveTask(db, 1, 'done', { type: 'ai', id: 's2' })).toThrow(/yourself/);
      expect(moveTask(db, 1, 'done', ai).status).toBe('done'); // s1 теперь принимающая сторона
    });
  });

  it('rejects ai skip without reason, task untouched', () => {
    expect(() => moveTask(db, 1, 'done', ai)).toThrow(/invalid transition/);
    expect(db.prepare(`SELECT status FROM tasks WHERE id=1`).get())
      .toEqual({ status: 'new' });
  });

  it('ai skip with reason → moved + reason stored as comment', () => {
    moveTask(db, 1, 'done', ai, 'пропустили по просьбе пользователя');
    expect(db.prepare(`SELECT status FROM tasks WHERE id=1`).get())
      .toEqual({ status: 'done' });
    const c: any = db.prepare(`SELECT author, body FROM comments`).get();
    expect(c).toEqual({ author: 'ai:s1', body: 'пропустили по просьбе пользователя' });
  });

  it('user jumps freely', () => {
    expect(moveTask(db, 1, 'done', user).status).toBe('done');
  });
});

describe('block/unblock', () => {
  it('sets flag + reason at any status, logs events', () => {
    const t = blockTask(db, 1, 'жду ответа', user);
    expect(t).toMatchObject({ blocked: 1, block_reason: 'жду ответа', status: 'new' });
    const t2 = unblockTask(db, 1, ai);
    expect(t2).toMatchObject({ blocked: 0, block_reason: null });
    expect(db.prepare(
      `SELECT COUNT(*) c FROM events WHERE action IN ('blocked','unblocked')`).get())
      .toEqual({ c: 2 });
  });
});

describe('linkTasks', () => {
  it('links two tasks, duplicate link is a silent success', () => {
    addTask(db, { title: 'b' }, user);
    linkTasks(db, 1, 2, 'relates_to', user);
    linkTasks(db, 1, 2, 'relates_to', user); // не бросает
    expect(db.prepare(`SELECT COUNT(*) c FROM task_links`).get()).toEqual({ c: 1 });
  });

  it('refuses to link to a missing task', () => {
    expect(() => linkTasks(db, 1, 99, 'relates_to', user)).toThrow('task #99 not found');
  });
});

describe('archive', () => {
  it('archives and restores, keeping the column', () => {
    moveTask(db, 1, 'in_progress', user);
    const t = archiveTask(db, 1, user);
    expect(t.archived_at).not.toBeNull();
    expect(t.status).toBe('in_progress');
    const t2 = unarchiveTask(db, 1, user);
    expect(t2.archived_at).toBeNull();
  });
});

describe('placeTask (order)', () => {
  beforeEach(() => { addTask(db, { title: 'b' }, user); addTask(db, { title: 'c' }, user); });
  // старт: три задачи в 'new', позиции 0,1,2 (addTask дописывает в конец)

  it('reorders within a column, no move event', () => {
    placeTask(db, 1, 'new', [3, 2, 1], user); // #1 в конец
    const order = boardData(db).new.map((t) => t.id);
    expect(order).toEqual([3, 2, 1]);
    expect(db.prepare(`SELECT COUNT(*) c FROM events WHERE action='moved'`).get()).toEqual({ c: 0 });
  });

  it('moves across columns at an index + logs moved', () => {
    placeTask(db, 1, 'in_progress', [1], user);
    expect(mustGetTask(db, 1).status).toBe('in_progress');
    expect(boardData(db).new.map((t) => t.id)).toEqual([2, 3]);
    const ev: any = db.prepare(`SELECT detail FROM events WHERE action='moved'`).get();
    expect(JSON.parse(ev.detail)).toEqual({ from: 'new', to: 'in_progress' });
  });
});
