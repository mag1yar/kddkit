import type Database from 'better-sqlite3';
import { redact } from './agent_events.js';
import { now } from './db.js';
import { KddError } from './errors.js';
import { authorOf, type Actor } from './state.js';
import type { Criterion } from './types.js';
import { appendEvent, mustGetTask } from './ops.js';

export function listCriteria(db: Database.Database, taskId: number): Criterion[] {
  return db.prepare(
    `SELECT * FROM criteria WHERE task_id = ? ORDER BY position, id`,
  ).all(taskId) as Criterion[];
}

function mustGetCriterion(db: Database.Database, taskId: number, id: number): Criterion {
  const c = db.prepare(`SELECT * FROM criteria WHERE id = ? AND task_id = ?`)
    .get(id, taskId) as Criterion | undefined;
  if (!c) throw new KddError(`criterion #${id} not found on task #${taskId}`);
  return c;
}

const touchTask = (db: Database.Database, taskId: number): void => {
  db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(now(), taskId);
};

export function addCriterion(
  db: Database.Database, taskId: number, text: string, actor: Actor,
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
    appendEvent(db, taskId, actor, 'criterion_added', { id, text });
    touchTask(db, taskId);
    return mustGetCriterion(db, taskId, id);
  })();
}

export function setCriterionChecked(
  db: Database.Database, taskId: number, id: number, checked: boolean, actor: Actor,
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
    appendEvent(db, taskId, actor, checked ? 'criterion_checked' : 'criterion_unchecked',
      { id, text: c.text, ...(checked && stored ? { evidence: stored } : {}) });
    touchTask(db, taskId);
    return mustGetCriterion(db, taskId, id);
  })();
}

export function removeCriterion(
  db: Database.Database, taskId: number, id: number, actor: Actor,
): void {
  db.transaction(() => {
    const c = mustGetCriterion(db, taskId, id);
    db.prepare(`DELETE FROM criteria WHERE id = ?`).run(id);
    appendEvent(db, taskId, actor, 'criterion_removed', { id, text: c.text });
    touchTask(db, taskId);
  })();
}
