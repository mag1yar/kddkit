import type Database from 'better-sqlite3';
import {
  CAPS, capText, boardData, taskDetail, taskDetailCapped, recall, editTask, moveTask,
  commentTask, mustGetTask, listTracks, KddError, type Actor, type Priority, type Status, type Kind,
} from '@kddkit/core';

export interface TaskRow {
  id: number;
  title: string;
  status: string;
  kind: string;
  priority: string;
  blocked: boolean;
  ready: boolean;
  criteria: { checked: number; total: number };
}

export function getTask(db: Database.Database, id: number, full = false) {
  // капы — в core taskDetailCapped (та же политика, что kdd show); full — escape hatch
  return full ? taskDetail(db, id) : taskDetailCapped(db, id);
}

export function listTracksTool(db: Database.Database) {
  // все track-и, включая done: routing → active; done = завершённый пласт работы (контекст)
  return listTracks(db, {}).map((t) => ({
    id: t.id, name: t.name,
    description: t.description === null ? null : capText(t.description, CAPS.trackDescChars),
    status: t.status, open_tasks: t.open_tasks,
  }));
}

export function listTasks(
  db: Database.Database,
  filter: { status?: Status; area?: string; track_id?: number; ready?: boolean; kind?: Kind } = {},
): { tasks: Record<string, TaskRow[]>; omitted?: Record<string, number> } {
  const board = boardData(db, filter);
  const tasks: Record<string, TaskRow[]> = {};
  const omitted: Record<string, number> = {};
  for (const [status, rows] of Object.entries(board)) {
    if (rows.length > CAPS.listRows) omitted[status] = rows.length - CAPS.listRows;
    tasks[status] = rows.slice(0, CAPS.listRows).map((t) => ({
      id: t.id, title: t.title, status: t.status, kind: t.kind,
      priority: t.priority, blocked: !!t.blocked, ready: !!t.ready,
      criteria: { checked: t.criteria_checked, total: t.criteria_total },
    }));
  }
  return Object.keys(omitted).length ? { tasks, omitted } : { tasks };
}

export function recallTool(
  db: Database.Database, dir: string, query: string,
  opts: { k?: number; kind?: 'decision' | 'task' } = {},
) {
  return recall(db, dir, query, opts);
}

export interface UpdateInput {
  id: number;
  edit?: { title?: string; body?: string; priority?: Priority; area?: string; track_id?: number | null; kind?: Kind };
  move?: { to: string; reason?: string };
  comment?: string;
}

export function updateTask(db: Database.Database, input: UpdateInput, actor: Actor) {
  if (!input.edit && !input.move && !input.comment) {
    throw new KddError('nothing to update');
  }
  return db.transaction(() => {
    mustGetTask(db, input.id); // validates existence up front
    if (input.edit) editTask(db, input.id, input.edit, actor);
    if (input.move) moveTask(db, input.id, input.move.to, actor, input.move.reason);
    if (input.comment) commentTask(db, input.id, input.comment, actor);
    return mustGetTask(db, input.id);
  })();
}
