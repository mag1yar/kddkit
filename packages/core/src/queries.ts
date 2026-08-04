import type Database from 'better-sqlite3';
import { CAPS, capText } from './caps.js';
import { authorOf, STATUSES, type Kind, type Status } from './state.js';
import type { Comment, Criterion, EventRow, FileRow, Task, TaskListRow } from './types.js';
import { mustGetTask } from './ops.js';
import { listCriteria } from './criteria.js';
import { filePath, listFiles } from './files.js';

export const PRIORITY_ORDER =
  `CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

// takeable «прямо сейчас»: new-очередь, не заблокирована, не в архиве, и это работа с кодом —
// kind='research' исключён тем же условием, что CLAIMABLE_SQL (core/claim.ts), иначе ready
// и claimable расходятся: research отрапортует ready=1, board --ready её покажет, а взять
// агент её всё равно не может — ready перестаёт значить «takeable».
// Один источник правды — используется и как колонка, и как фильтр.
const READY_SQL = `(status = 'new' AND blocked = 0 AND archived_at IS NULL AND kind <> 'research')`;

export function boardData(
  db: Database.Database,
  f: { area?: string; status?: Status; archived?: boolean; track_id?: number;
       ready?: boolean; kind?: Kind } = {},
): Record<Status, TaskListRow[]> {
  const where: string[] = [f.archived ? 'archived_at IS NOT NULL' : 'archived_at IS NULL'];
  const params: unknown[] = [];
  if (f.area) { where.push('area = ?'); params.push(f.area); }
  if (f.kind) { where.push('kind = ?'); params.push(f.kind); }
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
  // path — абсолютный, вычислен здесь (db.name уже под рукой), а не в клиентах: агент открывает
  // вложение через MCP get_task так же, как человек через kdd show — один источник пути.
  files: (FileRow & { path: string })[];
  // Не события агента, а число его прогонов: лента едет отдельной ручкой (инкрементально,
  // по since=<id>), а вкладке нужно лишь знать, будили ли по задаче агента и сколько раз.
  // Сырые события считать бесполезно — «30» не соответствует ничему, что видно глазами.
  agent_runs_total: number;
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
  const agent_runs_total = (db.prepare(
    `SELECT COUNT(*) c FROM agent_events WHERE task_id = ? AND kind = 'run_start'`,
  ).get(id) as { c: number }).c;
  const files = listFiles(db, id).map((f) => ({ ...f, path: filePath(db.name, f) }));
  return { task, criteria, comments, events, links, files, agent_runs_total };
}

export interface TaskDetailCapped {
  task: Task;
  criteria: Criterion[];
  comments: Comment[];
  comments_total: number;
  events: EventRow[];
  events_total: number;
  links: { id: number; title: string; kind: string }[];
  files: (FileRow & { path: string })[];
  files_total: number;
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
    // Вложения режем с НАЧАЛА списка (он упорядочен по id, то есть по времени): первым
    // приложили — первым и показываем. У комментариев обратная политика — там свежий важнее.
    files: d.files.slice(0, CAPS.files).map((f) => ({
      ...f,
      description: f.description === null ? null : capText(f.description, CAPS.fileDescChars),
    })),
    files_total: d.files.length,
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

/**
 * Задачи, где работа выглядит законченной, а статус — нет: все критерии закрыты, задача
 * всё ещё в `in_progress`. `author` — тот, кто поставил ПОСЛЕДНЮЮ галку (формат `authorOf`).
 *
 * Адресат именно он, а не тот, кто перевёл задачу в работу: в работу её чаще ставит человек
 * на доске, а потом просит сделать — по такому признаку напоминание не пришло бы никому.
 * Факт берём из журнала, а не из отдельной колонки: он уже записан и одинаков для всех путей
 * (CLI, MCP, доска).
 *
 * Задача под чужим ai-lease не возвращается: `checkMove` откажет такому актору («lease lost»),
 * и напоминание стоило бы ему хода на выяснение того, что двигать её нельзя. Условие держим
 * в тех же терминах, что и fence — user-held и незанятые задачи не трогаем.
 */
export function unsubmitted(db: Database.Database, author: string): number[] {
  const ids = db.prepare(
    `SELECT id FROM tasks t
      WHERE t.status = 'in_progress' AND t.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM criteria c WHERE c.task_id = t.id)
        AND NOT EXISTS (SELECT 1 FROM criteria c WHERE c.task_id = t.id AND c.checked_at IS NULL)
        AND (t.claimed_by IS NULL OR t.claimed_by NOT LIKE 'ai:%' OR t.claimed_by = ?)
      ORDER BY id`,
  ).all(author) as { id: number }[];
  const lastCheck = db.prepare(
    `SELECT actor_type, actor_id FROM events
      WHERE task_id = ? AND action = 'criterion_checked' ORDER BY id DESC LIMIT 1`,
  );
  return ids
    .filter(({ id }) => {
      const r = lastCheck.get(id) as
        { actor_type: 'user' | 'ai'; actor_id: string | null } | undefined;
      return !!r && authorOf({ type: r.actor_type, id: r.actor_id ?? undefined }) === author;
    })
    .map(({ id }) => id);
}
