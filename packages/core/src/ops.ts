import type Database from 'better-sqlite3';
import { redact } from './agent_events.js';
import { now } from './db.js';
import { KddError } from './errors.js';
import { checkMove, PRIORITIES, STATUSES, type Actor, type Priority, type Status } from './state.js';
import type { Comment, Task } from './types.js';
import { mustGetTrack } from './tracks.js';

export const authorOf = (a: Actor): string => (a.type === 'ai' ? `ai:${a.id ?? '?'}` : 'user');

export function appendEvent(
  db: Database.Database, taskId: number | null, actor: Actor,
  action: string, detail?: object,
  opts?: { parent_id?: number; type?: string; level?: 'info' | 'warn' | 'error' },
): number {
  const r = db.prepare(
    `INSERT INTO events (task_id, actor_type, actor_id, action, detail, created_at,
                         parent_id, type, level)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(taskId, actor.type, actor.id ?? null, action,
    detail ? JSON.stringify(detail) : null, now(),
    opts?.parent_id ?? null, opts?.type ?? null, opts?.level ?? 'info');
  return Number(r.lastInsertRowid);
}

export function mustGetTask(db: Database.Database, id: number): Task {
  const t = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as Task | undefined;
  if (!t) throw new KddError(`task #${id} not found`);
  return t;
}

function checkPriority(p: string): asserts p is Priority {
  if (!PRIORITIES.includes(p as Priority)) {
    throw new KddError(`invalid priority '${p}'; allowed: ${PRIORITIES.join(', ')}`);
  }
}

export function addTask(
  db: Database.Database,
  input: {
    title: string; body?: string; priority?: Priority; area?: string;
    track_id?: number; criteria?: string[];
  },
  actor: Actor,
): Task {
  const priority = input.priority ?? 'medium';
  checkPriority(priority);
  if (!input.title.trim()) throw new KddError('title must not be empty');
  if (input.criteria?.some((c) => !c.trim())) {
    throw new KddError('criterion text must not be empty');
  }
  if (input.track_id != null) mustGetTrack(db, input.track_id);
  return db.transaction(() => {
    const ts = now();
    const r = db.prepare(
      `INSERT INTO tasks (title, body, priority, area, track_id, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.title, input.body ?? null, priority, input.area ?? null, input.track_id ?? null,
      nextPosition(db, 'new'), ts, ts);
    const id = Number(r.lastInsertRowid);
    // criteria при создании — без criterion_added-событий: их покрывает 'created'
    const ins = db.prepare(
      `INSERT INTO criteria (task_id, text, position, created_at) VALUES (?, ?, ?, ?)`);
    (input.criteria ?? []).forEach((text, i) => ins.run(id, text, i, ts));
    appendEvent(db, id, actor, 'created');
    return mustGetTask(db, id);
  })();
}

export function editTask(
  db: Database.Database, id: number,
  patch: { title?: string; body?: string; priority?: Priority; area?: string; track_id?: number | null },
  actor: Actor,
): Task {
  if (patch.priority !== undefined) checkPriority(patch.priority);
  if (patch.track_id != null) mustGetTrack(db, patch.track_id);
  const fields = (Object.keys(patch) as (keyof typeof patch)[])
    .filter((k) => patch[k] !== undefined);
  if (fields.length === 0) throw new KddError('nothing to edit');
  return db.transaction(() => {
    mustGetTask(db, id);
    const sets = fields.map((f) => `${f} = ?`).join(', ');
    db.prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`)
      .run(...fields.map((f) => patch[f]), now(), id);
    appendEvent(db, id, actor, 'edited', { fields });
    return mustGetTask(db, id);
  })();
}

export function commentTask(
  db: Database.Database, id: number, body: string, actor: Actor,
): Comment {
  if (!body.trim()) throw new KddError('comment must not be empty');
  // Воркеру промптом велено оставить итоговый комментарий — и он приходит в ту же базу мимо
  // редакции фида: агент, вставивший в резюме строку из `env`, клал бы токен навсегда через
  // соседнюю дверь. Человеку текст не трогаем: он пишет своё, а не пересказывает вывод тулов.
  const text = actor.type === 'ai' ? redact(body) : body;
  return db.transaction(() => {
    mustGetTask(db, id);
    const r = db.prepare(
      `INSERT INTO comments (task_id, author, body, created_at) VALUES (?, ?, ?, ?)`,
    ).run(id, authorOf(actor), text, now());
    appendEvent(db, id, actor, 'commented');
    return db.prepare(`SELECT * FROM comments WHERE id = ?`)
      .get(Number(r.lastInsertRowid)) as Comment;
  })();
}

function checkStatus(s: string): asserts s is Status {
  if (!STATUSES.includes(s as Status)) {
    throw new KddError(`invalid status '${s}'; allowed: ${STATUSES.join(', ')}`);
  }
}

// Неотмеченные критерии приёмки — гейт ai-перехода в review (see checkMove).
function openCriteria(db: Database.Database, taskId: number): number {
  return (db.prepare(
    `SELECT COUNT(*) AS c FROM criteria WHERE task_id = ? AND checked_at IS NULL`,
  ).get(taskId) as { c: number }).c;
}

// Следующая свободная позиция в конце колонки (порядок на доске = position).
function nextPosition(db: Database.Database, status: Status): number {
  return (db.prepare(
    `SELECT COALESCE(MAX(position), -1) + 1 AS p
     FROM tasks WHERE status = ? AND archived_at IS NULL`,
  ).get(status) as { p: number }).p;
}

export function moveTask(
  db: Database.Database, id: number, to: string, actor: Actor, reason?: string,
): Task {
  checkStatus(to);
  return db.transaction(() => {
    const t = mustGetTask(db, id);
    const res = checkMove(t.status, to, actor, reason, openCriteria(db, id), t.claimed_by);
    if (!res.ok) throw new KddError(res.error);
    const leaving = t.status === 'in_progress' && to !== 'in_progress';
    const reset = to === 'review'; // достигли review = продуктивный прогресс, обнуляем счётчик неудач
    db.prepare(
      `UPDATE tasks SET status = ?, position = ?, updated_at = ?${leaving ? ', claimed_by = NULL, claim_expires = NULL' : ''}${reset ? ', failed_attempts = 0' : ''}
       WHERE id = ?`,
    ).run(to, nextPosition(db, to), now(), id); // CLI-move дописывает в конец колонки; выход из in_progress снимает claim
    appendEvent(db, id, actor, 'moved',
      reason ? { from: t.status, to, reason } : { from: t.status, to });
    if (reason) {
      db.prepare(
        `INSERT INTO comments (task_id, author, body, created_at) VALUES (?, ?, ?, ?)`,
      ).run(id, authorOf(actor), reason, now());
    }
    return mustGetTask(db, id);
  })();
}

// Расстановка колонки-назначения по явному порядку id (drag на доске).
// Смена статуса → checkMove + событие moved; чистый reorder внутри колонки — без события.
export function placeTask(
  db: Database.Database, id: number, to: string, orderedIds: number[], actor: Actor,
): Task {
  checkStatus(to);
  return db.transaction(() => {
    const t = mustGetTask(db, id);
    if (t.status !== to) {
      const res = checkMove(t.status, to, actor, undefined, openCriteria(db, id), t.claimed_by);
      if (!res.ok) throw new KddError(res.error);
      appendEvent(db, id, actor, 'moved', { from: t.status, to });
    }
    const setPos = db.prepare(`UPDATE tasks SET position = ? WHERE id = ?`);
    orderedIds.forEach((tid, i) => setPos.run(i, tid));
    const leaving = t.status === 'in_progress' && to !== 'in_progress';
    const reset = to === 'review';
    db.prepare(
      `UPDATE tasks SET status = ?, updated_at = ?${leaving ? ', claimed_by = NULL, claim_expires = NULL' : ''}${reset ? ', failed_attempts = 0' : ''}
       WHERE id = ?`,
    ).run(to, now(), id);
    return mustGetTask(db, id);
  })();
}

export function blockTask(
  db: Database.Database, id: number, reason: string, actor: Actor,
): Task {
  if (!reason.trim()) throw new KddError('block reason must not be empty');
  return db.transaction(() => {
    mustGetTask(db, id);
    db.prepare(`UPDATE tasks SET blocked = 1, block_reason = ?, updated_at = ? WHERE id = ?`)
      .run(reason, now(), id);
    appendEvent(db, id, actor, 'blocked', { reason });
    return mustGetTask(db, id);
  })();
}

export function unblockTask(db: Database.Database, id: number, actor: Actor): Task {
  return db.transaction(() => {
    mustGetTask(db, id);
    db.prepare(`UPDATE tasks SET blocked = 0, block_reason = NULL, updated_at = ? WHERE id = ?`)
      .run(now(), id);
    appendEvent(db, id, actor, 'unblocked');
    return mustGetTask(db, id);
  })();
}

export function linkTasks(
  db: Database.Database, fromId: number, toId: number, kind: string, actor: Actor,
): void {
  db.transaction(() => {
    mustGetTask(db, fromId);
    mustGetTask(db, toId);
    const r = db.prepare(
      `INSERT OR IGNORE INTO task_links (from_id, to_id, kind) VALUES (?, ?, ?)`,
    ).run(fromId, toId, kind);
    if (r.changes > 0) appendEvent(db, fromId, actor, 'linked', { to: toId, kind });
  })();
}

export function archiveTask(db: Database.Database, id: number, actor: Actor): Task {
  return db.transaction(() => {
    mustGetTask(db, id);
    db.prepare(`UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?`)
      .run(now(), now(), id);
    appendEvent(db, id, actor, 'archived');
    return mustGetTask(db, id);
  })();
}

export function unarchiveTask(db: Database.Database, id: number, actor: Actor): Task {
  return db.transaction(() => {
    mustGetTask(db, id);
    db.prepare(`UPDATE tasks SET archived_at = NULL, updated_at = ? WHERE id = ?`)
      .run(now(), id);
    appendEvent(db, id, actor, 'unarchived');
    return mustGetTask(db, id);
  })();
}
