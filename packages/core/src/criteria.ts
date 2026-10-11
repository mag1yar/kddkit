import type { Db } from './db.js';
import { redact } from './redact.js';
import { now } from './db.js';
import { KddError } from './errors.js';
import { authorOf, type Actor } from './state.js';
import type { Criterion } from './types.js';
import { appendTaskMutationEvent, mustGetTask } from './ops.js';

export function listCriteria(db: Db, taskId: number): Criterion[] {
  return db.prepare(
    `SELECT * FROM criteria WHERE task_id = ? ORDER BY position, id`,
  ).all(taskId) as Criterion[];
}

function mustGetCriterion(db: Db, taskId: number, id: number): Criterion {
  const c = db.prepare(`SELECT * FROM criteria WHERE id = ?`).get(id) as Criterion | undefined;
  if (!c || c.task_id !== taskId) throw new KddError(`criterion #${id} not found on task #${taskId}`);
  return c;
}

const touchTask = (db: Db, taskId: number): void => {
  db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(now(), taskId);
};

export function addCriterion(
  db: Db, taskId: number, text: string, actor: Actor,
): Criterion {
  if (!text.trim()) throw new KddError('criterion text must not be empty');
  return db.transaction(() => {
    mustGetTask(db, taskId);
    const pos = (db.prepare(
      `SELECT COALESCE(MAX(position), -1) + 1 AS p FROM criteria WHERE task_id = ?`,
    ).get(taskId) as { p: number }).p;
    const r = db.prepare(
      `INSERT INTO criteria (task_id, text, position, created_at) VALUES (?, ?, ?, ?)`,
    ).run(taskId, text, pos, now());
    const id = Number(r.lastInsertRowid);
    appendTaskMutationEvent(db, taskId, actor, 'criterion_added', { id, text });
    touchTask(db, taskId);
    return mustGetCriterion(db, taskId, id);
  }).immediate();
}

export function setCriterionChecked(
  db: Db, taskId: number, id: number, checked: boolean, actor: Actor,
  evidence?: string,
): Criterion {
  return db.transaction(() => {
    const c = mustGetCriterion(db, taskId, id);
    const proof = evidence?.trim();
    if ((c.checked_at !== null) === checked && (!checked || !proof)) return c;
    const stored = proof ? (actor.type === 'ai' ? redact(proof) : proof) : null;
    db.prepare(
      `UPDATE criteria SET checked_at = ?, evidence = ?, checked_by = ? WHERE id = ?`,
    ).run(checked ? now() : null, checked ? stored : null,
      checked ? authorOf(actor) : null, id);
    appendTaskMutationEvent(db, taskId, actor, checked ? 'criterion_checked' : 'criterion_unchecked',
      { id, text: c.text, ...(checked && stored ? { evidence: stored } : {}) });
    touchTask(db, taskId);
    return mustGetCriterion(db, taskId, id);
  }).immediate();
}

export function removeCriterion(
  db: Db, taskId: number, id: number, actor: Actor,
): void {
  db.transaction(() => {
    const c = mustGetCriterion(db, taskId, id);
    db.prepare(`DELETE FROM criteria WHERE id = ?`).run(id);
    appendTaskMutationEvent(db, taskId, actor, 'criterion_removed', { id, text: c.text });
    touchTask(db, taskId);
  }).immediate();
}
