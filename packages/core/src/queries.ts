import type Database from 'better-sqlite3';
import { CAPS, capText } from './caps.js';
import { STATUSES, type Status } from './state.js';
import type { Comment, Criterion, EventRow, Task, TaskListRow } from './types.js';
import { mustGetTask } from './ops.js';
import { listCriteria } from './criteria.js';

export const PRIORITY_ORDER =
  `CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

// takeable «прямо сейчас»: new-очередь, не заблокирована, не в архиве.
// Один источник правды — используется и как колонка, и как фильтр.
const READY_SQL = `(status = 'new' AND blocked = 0 AND archived_at IS NULL)`;

export function boardData(
  db: Database.Database,
  f: { area?: string; status?: Status; archived?: boolean; track_id?: number; ready?: boolean } = {},
): Record<Status, TaskListRow[]> {
  const where: string[] = [f.archived ? 'archived_at IS NOT NULL' : 'archived_at IS NULL'];
  const params: unknown[] = [];
  if (f.area) { where.push('area = ?'); params.push(f.area); }
  if (f.track_id != null) { where.push('track_id = ?'); params.push(f.track_id); }
  if (f.status) { where.push('status = ?'); params.push(f.status); }
  if (f.ready != null) where.push(f.ready ? READY_SQL : `NOT ${READY_SQL}`);
  const rows = db.prepare(
    `SELECT *,
       ${READY_SQL} AS ready,
       (SELECT COUNT(*) FROM criteria WHERE criteria.task_id = tasks.id) AS criteria_total,
       (SELECT COUNT(*) FROM criteria WHERE criteria.task_id = tasks.id AND checked_at IS NOT NULL)
         AS criteria_checked
     FROM tasks WHERE ${where.join(' AND ')}
     ORDER BY position, ${PRIORITY_ORDER}, created_at`,
  ).all(...params) as TaskListRow[];
  const out = Object.fromEntries(STATUSES.map((s) => [s, [] as TaskListRow[]])) as Record<Status, TaskListRow[]>;
  for (const r of rows) out[r.status].push(r);
  return out;
}

export function taskDetail(db: Database.Database, id: number): {
  task: Task; criteria: Criterion[]; comments: Comment[]; events: EventRow[];
  links: { id: number; title: string; kind: string }[];
  // Не сами события агента, а только их число: лента едет отдельной ручкой (инкрементально,
  // по since=<id>), а вкладке нужно лишь знать, есть ли там что-нибудь, не открывая её.
  agent_events_total: number;
} {
  const task = mustGetTask(db, id);
  const criteria = listCriteria(db, id);
  const comments = db.prepare(
    `SELECT * FROM comments WHERE task_id = ? ORDER BY created_at, id`).all(id) as Comment[];
  const events = db.prepare(
    `SELECT * FROM events WHERE task_id = ? ORDER BY created_at, id`).all(id) as EventRow[];
  const links = db.prepare(
    `SELECT t.id, t.title, l.kind FROM task_links l
     JOIN tasks t ON t.id = CASE WHEN l.from_id = ? THEN l.to_id ELSE l.from_id END
     WHERE l.from_id = ? OR l.to_id = ?`,
  ).all(id, id, id) as { id: number; title: string; kind: string }[];
  const agent_events_total = (db.prepare(
    `SELECT COUNT(*) c FROM agent_events WHERE task_id = ?`).get(id) as { c: number }).c;
  return { task, criteria, comments, events, links, agent_events_total };
}

export interface TaskDetailCapped {
  task: Task;
  criteria: Criterion[];
  comments: Comment[];
  comments_total: number;
  events: EventRow[];
  events_total: number;
  links: { id: number; title: string; kind: string }[];
}

// Единственный источник trim-политики show/get_task: последние N с честными totals.
export function taskDetailCapped(db: Database.Database, id: number): TaskDetailCapped {
  const d = taskDetail(db, id);
  return {
    task: {
      ...d.task,
      body: d.task.body === null ? null : capText(d.task.body, CAPS.bodyChars),
    },
    // criteria не режем: неполный список приёмки бесполезен
    criteria: d.criteria,
    comments: d.comments.slice(-CAPS.comments)
      .map((c) => ({ ...c, body: capText(c.body, CAPS.commentChars) })),
    comments_total: d.comments.length,
    events: d.events.slice(-CAPS.events),
    events_total: d.events.length,
    links: d.links,
  };
}

export function statusDigest(db: Database.Database): {
  in_progress: Task[]; review: Task[]; blocked: Task[]; recent: EventRow[];
} {
  const active = `archived_at IS NULL`;
  const q = (w: string) => db.prepare(
    `SELECT * FROM tasks WHERE ${active} AND ${w}
     ORDER BY ${PRIORITY_ORDER}, created_at`).all() as Task[];
  return {
    in_progress: q(`status = 'in_progress'`),
    review: q(`status = 'review'`),
    blocked: q(`blocked = 1`),
    recent: db.prepare(
      `SELECT * FROM events ORDER BY id DESC LIMIT ${CAPS.statusEvents}`).all() as EventRow[],
  };
}

export function exportBoard(db: Database.Database): {
  tasks: Task[]; comments: Comment[]; links: unknown[]; events: EventRow[];
} {
  return {
    tasks: db.prepare(`SELECT * FROM tasks ORDER BY id`).all() as Task[],
    comments: db.prepare(`SELECT * FROM comments ORDER BY id`).all() as Comment[],
    links: db.prepare(`SELECT * FROM task_links`).all(),
    events: db.prepare(`SELECT * FROM events ORDER BY id`).all() as EventRow[],
  };
}
