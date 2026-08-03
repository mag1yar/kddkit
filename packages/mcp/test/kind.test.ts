import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { addTask, openDb } from '@kddkit/core';
import { listTasks, updateTask } from '../src/handlers.js';

let db: Database.Database;
beforeEach(() => { db = openDb(':memory:', 'p'); });
const user = { type: 'user' as const };
const ai = { type: 'ai' as const, id: 'mcp' };

describe('list_tasks and kind', () => {
  it('carries the kind on every row', () => {
    addTask(db, { title: 'b', kind: 'bug' }, user);
    const { tasks } = listTasks(db);
    expect(tasks.new[0]).toMatchObject({ title: 'b', kind: 'bug' });
  });

  it('narrows to a single kind when asked', () => {
    addTask(db, { title: 'f' }, user);
    addTask(db, { title: 'b', kind: 'bug' }, user);
    const { tasks } = listTasks(db, { kind: 'bug' });
    expect(tasks.new.map((t) => t.title)).toEqual(['b']);
  });
});

describe('update_task and kind', () => {
  it('retypes a task', () => {
    addTask(db, { title: 'a' }, user);
    expect(updateTask(db, { id: 1, edit: { kind: 'bug' } }, ai).kind).toBe('bug');
  });

  it('refuses a value outside the vocabulary', () => {
    addTask(db, { title: 'a' }, user);
    expect(() => updateTask(db, { id: 1, edit: { kind: 'epic' as any } }, ai))
      .toThrow(/invalid kind/);
  });
});
