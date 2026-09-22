import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { addTask, blockTask, moveTask, unblockTask } from '../src/ops.js';
import { addCriterion, removeCriterion, setCriterionChecked } from '../src/criteria.js';
import { recordFailedAttempt } from '../src/claim.js';
import { MAX_FAILED_ATTEMPTS } from '../src/state.js';
import { attentionData } from '../src/queries.js';
import { CAPS } from '../src/caps.js';

const NOW = 2_000_000;
const DAY = 86_400;
const user = { type: 'user' as const };
const ai = { type: 'ai' as const, id: 'worker' };
let db: Database.Database;

beforeEach(() => { db = openDb(':memory:', 'attention'); });

function add(title: string) {
  return addTask(db, { title }, user);
}

function setActivity(taskId: number, taskTime: number, eventTime = taskTime) {
  db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(taskTime, taskId);
  db.prepare(`UPDATE events SET created_at = ? WHERE task_id = ?`).run(eventTime, taskId);
}

describe('attentionData', () => {
  it('accepts only the exact needs-human prefix and preserves blocker text', () => {
    const yes = add('yes');
    const wrongCase = add('wrong case');
    const leading = add('leading');
    const dependency = add('dependency');
    blockTask(db, yes.id, 'needs human: choose API', user);
    blockTask(db, wrongCase.id, 'Needs human: choose API', user);
    blockTask(db, leading.id, ' needs human: choose API', user);
    blockTask(db, dependency.id, 'dependency: API unavailable', user);

    expect(attentionData(db, NOW).items).toMatchObject([
      { id: yes.id, reason: 'needs_input', block_reason: 'needs human: choose API' },
    ]);
  });

  it('requires the current blocked event to be an automatic claim escalation', () => {
    const task = add('automatic');
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      recordFailedAttempt(db, task.id, ai, `failure ${i}`);
    }
    expect(attentionData(db, NOW).items[0].reason).toBe('needs_input');

    unblockTask(db, task.id, user);
    expect(attentionData(db, NOW).items).toEqual([]);
    blockTask(db, task.id, 'dependency: service offline', user);
    expect(attentionData(db, NOW).items).toEqual([]);
  });

  it('uses event id for rework, ignores malformed details, and stops after recheck', () => {
    const task = add('rework');
    const criterion = addCriterion(db, task.id, 'tests pass', user);
    moveTask(db, task.id, 'in_progress', user);
    setCriterionChecked(db, task.id, criterion.id, true, user, 'pnpm test');
    moveTask(db, task.id, 'review', user);
    setCriterionChecked(db, task.id, criterion.id, false, user);
    db.prepare(`UPDATE events SET created_at = 100 WHERE task_id = ?`).run(task.id);
    const insert = db.prepare(
      `INSERT INTO events
         (task_id, actor_type, actor_id, action, detail, created_at, parent_id, type, level)
       VALUES (?, 'user', NULL, ?, 'not-json', 100, NULL, NULL, 'info')`,
    );
    insert.run(task.id, 'criterion_unchecked');
    insert.run(task.id, 'moved');

    expect(attentionData(db, NOW).items).toMatchObject([
      { id: task.id, reason: 'review_rework' },
    ]);

    setCriterionChecked(db, task.id, criterion.id, true, user, 'fixed');
    expect(attentionData(db, NOW).items).toMatchObject([
      { id: task.id, reason: 'await_acceptance' },
    ]);
  });

  it.each([
    { label: 'numeric', suffix: '' },
    { label: 'nonnumeric', suffix: 'oops' },
  ])('does not coerce a $label JSON string criterion id into a matching id', ({ suffix }) => {
    const task = add('legacy uncheck');
    const criterion = addCriterion(db, task.id, 'verify', user);
    moveTask(db, task.id, 'in_progress', user);
    setCriterionChecked(db, task.id, criterion.id, true, user);
    moveTask(db, task.id, 'review', user);
    setCriterionChecked(db, task.id, criterion.id, false, user);
    db.prepare(`UPDATE events SET detail = ? WHERE task_id = ? AND action = 'criterion_unchecked'`)
      .run(JSON.stringify({ id: `${criterion.id}${suffix}` }), task.id);

    expect(attentionData(db, NOW).items).toMatchObject([
      { id: task.id, reason: 'await_acceptance' },
    ]);
  });

  it('uses events as activity and includes the exact 24-hour boundary', () => {
    const stale = add('stale');
    const fresh = add('fresh by event');
    moveTask(db, stale.id, 'in_progress', user);
    moveTask(db, fresh.id, 'in_progress', user);
    setActivity(stale.id, NOW - DAY, NOW - DAY);
    setActivity(fresh.id, NOW - DAY - 1, NOW - 1);

    expect(attentionData(db, NOW).items).toMatchObject([
      { id: stale.id, reason: 'stale_in_progress', last_activity: NOW - DAY },
    ]);
  });

  it('excludes non-human blockers even when review or stale would match', () => {
    const task = add('blocked review');
    moveTask(db, task.id, 'in_progress', user);
    moveTask(db, task.id, 'review', user);
    blockTask(db, task.id, 'dependency: service offline', user);
    setActivity(task.id, NOW - DAY, NOW - DAY);
    expect(attentionData(db, NOW).items).toEqual([]);
  });

  it('matches only a current unchecked criterion after the latest review entry', () => {
    const task = add('latest review');
    const criterion = addCriterion(db, task.id, 'verify', user);
    moveTask(db, task.id, 'in_progress', user);
    setCriterionChecked(db, task.id, criterion.id, true, user);
    moveTask(db, task.id, 'review', user);
    setCriterionChecked(db, task.id, criterion.id, false, user);
    expect(attentionData(db, NOW).items[0].reason).toBe('review_rework');

    removeCriterion(db, task.id, criterion.id, user);
    expect(attentionData(db, NOW).items[0].reason).toBe('await_acceptance');
  });

  it('deduplicates reasons and orders by rank, activity, then id', () => {
    const stale = add('stale');
    moveTask(db, stale.id, 'in_progress', user);
    setActivity(stale.id, NOW - DAY, NOW - DAY);

    const review = add('review');
    moveTask(db, review.id, 'in_progress', user);
    moveTask(db, review.id, 'review', user);

    const rework = add('rework and stale');
    const criterion = addCriterion(db, rework.id, 'redo', user);
    moveTask(db, rework.id, 'in_progress', user);
    setCriterionChecked(db, rework.id, criterion.id, true, user);
    moveTask(db, rework.id, 'review', user);
    setCriterionChecked(db, rework.id, criterion.id, false, user);
    moveTask(db, rework.id, 'in_progress', user);
    setActivity(rework.id, NOW - DAY, NOW - DAY);

    const inputA = add('input A');
    const inputB = add('input B');
    blockTask(db, inputA.id, 'needs human: A', user);
    blockTask(db, inputB.id, 'needs human: B', user);
    setActivity(inputA.id, 50, 50);
    setActivity(inputB.id, 50, 50);

    expect(attentionData(db, NOW).items.map(({ id, reason }) => [id, reason])).toEqual([
      [inputA.id, 'needs_input'],
      [inputB.id, 'needs_input'],
      [rework.id, 'review_rework'],
      [review.id, 'await_acceptance'],
      [stale.id, 'stale_in_progress'],
    ]);
  });

  it('caps after deduplication, reports omitted, and never writes', () => {
    expect(attentionData(db, NOW)).toEqual({ items: [], omitted: 0 });
    const ids: number[] = [];
    for (let i = 0; i < CAPS.attentionRows + 2; i++) {
      const task = add(`review ${i}`);
      moveTask(db, task.id, 'in_progress', user);
      moveTask(db, task.id, 'review', user);
      setActivity(task.id, 100, 100);
      ids.push(task.id);
    }
    const snapshot = () => JSON.stringify({
      tasks: db.prepare(`SELECT * FROM tasks ORDER BY id`).all(),
      criteria: db.prepare(`SELECT * FROM criteria ORDER BY id`).all(),
      events: db.prepare(`SELECT * FROM events ORDER BY id`).all(),
    });
    const before = snapshot();
    const inbox = attentionData(db, NOW);
    expect(inbox.items.map(({ id }) => id)).toEqual(ids.slice(0, CAPS.attentionRows));
    expect(inbox.omitted).toBe(2);
    expect(snapshot()).toBe(before);
  });
});
