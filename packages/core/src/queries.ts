import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { CAPS, capText } from './caps.js';
import { authorOf, MAX_FAILED_ATTEMPTS, normalizeSessionId, STATUSES, type Kind, type Status } from './state.js';
import type {
  AttentionInbox, AttentionItem, Comment, Criterion, DecisionDetail, DecisionSummary,
  EventRow, FileRow, ManualProvenance, SessionHandoff, Task, TaskListRow, Track,
} from './types.js';
import { mustGetTask } from './ops.js';
import { listCriteria } from './criteria.js';
import { filePath, listFiles } from './files.js';
import { parseDecisionMd } from './decisions.js';
import { KddError } from './errors.js';
import { syncIndex } from './recall.js';
import { redact } from './agent_events.js';

export const PRIORITY_ORDER =
  `CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

function manualEvent(event: EventRow): ManualProvenance | undefined {
  if (event.actor_type !== 'ai' || !event.detail) return undefined;
  try {
    const detail: unknown = JSON.parse(event.detail);
    if (!detail || typeof detail !== 'object') return undefined;
    const raw = (detail as Record<string, unknown>).manual_provenance;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const p = raw as Record<string, unknown>;
    if (p.client !== 'claude' && p.client !== 'codex') return undefined;
    return {
      client: p.client,
      ...(normalizeSessionId(p.session_id) ? { session_id: p.session_id as string } : {}),
      ...(typeof p.worktree === 'string' ? { worktree: p.worktree } : {}),
      ...(typeof p.branch === 'string' ? { branch: p.branch } : {}),
      ...(typeof p.head_commit === 'string' ? { head_commit: p.head_commit } : {}),
    };
  } catch { return undefined; }
}

function manualHistory(events: EventRow[]): {
  manual_provenance?: ManualProvenance; handoffs: SessionHandoff[];
} {
  let latest: ManualProvenance | undefined;
  let previous: { client: 'claude' | 'codex'; session_id: string } | undefined;
  const handoffs: SessionHandoff[] = [];
  for (const event of [...events].sort((a, b) => a.id - b.id)) {
    const current = manualEvent(event);
    if (!current) continue;
    latest = current;
    if (!current.session_id) continue;
    if (previous && (previous.client !== current.client ||
      previous.session_id !== current.session_id)) {
      handoffs.push({
        from_client: previous.client, from_session_id: previous.session_id,
        to_client: current.client, to_session_id: current.session_id,
        event_id: event.id, at: event.created_at,
      });
    }
    previous = { client: current.client, session_id: current.session_id };
  }
  return { ...(latest ? { manual_provenance: latest } : {}), handoffs };
}

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
  decisions: DecisionSummary[];
  // path — абсолютный, вычислен здесь (db.name уже под рукой), а не в клиентах: агент открывает
  // вложение через MCP get_task так же, как человек через kdd show — один источник пути.
  files: (FileRow & { path: string })[];
  // Не события агента, а число его прогонов: лента едет отдельной ручкой (инкрементально,
  // по since=<id>), а вкладке нужно лишь знать, будили ли по задаче агента и сколько раз.
  // Сырые события считать бесполезно — «30» не соответствует ничему, что видно глазами.
  agent_runs_total: number;
  manual_provenance?: ManualProvenance;
  handoffs: SessionHandoff[];
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
  const decisions = db.prepare(
    `SELECT d.slug, d.title, d.created, d.superseded_by
       FROM decisions d, json_each(d.source_tasks) source
      WHERE CAST(source.value AS INTEGER) = ?
      ORDER BY d.slug`,
  ).all(id) as DecisionSummary[];
  return { task, criteria, comments, events, links, decisions, files, agent_runs_total,
    ...manualHistory(events) };
}

export interface TaskDetailCapped {
  task: Task;
  criteria: Criterion[];
  comments: Comment[];
  comments_total: number;
  events: EventRow[];
  events_total: number;
  links: { id: number; title: string; kind: string }[];
  decisions: DecisionSummary[];
  decisions_total: number;
  files: (FileRow & { path: string })[];
  files_total: number;
  manual_provenance?: ManualProvenance;
  handoffs: SessionHandoff[];
  handoffs_total: number;
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
    decisions: d.decisions.slice(0, CAPS.decisions)
      .map((decision) => ({ ...decision, title: capText(decision.title, CAPS.titleChars) })),
    decisions_total: d.decisions.length,
    // Вложения режем с НАЧАЛА списка (он упорядочен по id, то есть по времени): первым
    // приложили — первым и показываем. У комментариев обратная политика — там свежий важнее.
    files: d.files.slice(0, CAPS.files).map((f) => ({
      ...f,
      description: f.description === null ? null : capText(f.description, CAPS.fileDescChars),
    })),
    files_total: d.files.length,
    ...(d.manual_provenance ? { manual_provenance: d.manual_provenance } : {}),
    handoffs: d.handoffs.slice(-CAPS.events),
    handoffs_total: d.handoffs.length,
  };
}

export function syncedTaskDetail(
  db: Database.Database, decisionsDir: string, id: number, full: true,
): ReturnType<typeof taskDetail>;
export function syncedTaskDetail(
  db: Database.Database, decisionsDir: string, id: number, full?: false,
): TaskDetailCapped;
export function syncedTaskDetail(
  db: Database.Database, decisionsDir: string, id: number, full?: boolean,
): ReturnType<typeof taskDetail> | TaskDetailCapped;
export function syncedTaskDetail(
  db: Database.Database, decisionsDir: string, id: number, full = false,
): ReturnType<typeof taskDetail> | TaskDetailCapped {
  syncIndex(db, decisionsDir);
  return full ? taskDetail(db, id) : taskDetailCapped(db, id);
}

export function decisionDetail(
  db: Database.Database, decisionsDir: string, slug: string,
): DecisionDetail {
  syncIndex(db, decisionsDir);
  const row = db.prepare(
    `SELECT slug, title, path, created, superseded_by FROM decisions WHERE slug = ?`,
  ).get(slug) as (DecisionSummary & { path: string }) | undefined;
  if (!row) throw new KddError(`decision '${slug}' not found`);
  const doc = parseDecisionMd(readFileSync(row.path, 'utf8'));
  return {
    ...row,
    status: doc.status,
    body: doc.indexBody,
    source_tasks: doc.sourceTasks.map((id) => {
      const task = mustGetTask(db, id);
      return { id, title: task.title, status: task.status, archived_at: task.archived_at };
    }),
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

export function attentionData(db: Database.Database, nowSeconds: number): AttentionInbox {
  type Row = AttentionItem & { reason_rank: number; total_count: number };
  const rows = db.prepare(`
    WITH task_facts AS (
      SELECT t.*,
        MAX(t.updated_at, COALESCE(
          (SELECT MAX(e.created_at) FROM events e WHERE e.task_id = t.id), t.updated_at
        )) AS last_activity,
        (SELECT e.type FROM events e
          WHERE e.task_id = t.id AND e.action = 'blocked'
          ORDER BY e.id DESC LIMIT 1) AS latest_blocked_type,
        (SELECT MAX(e.id) FROM events e
          WHERE e.task_id = t.id AND e.action = 'moved'
            AND e.detail LIKE '%"to":"review"%') AS last_review_id
      FROM tasks t
      WHERE t.archived_at IS NULL AND t.status <> 'done'
    ), classified AS (
      SELECT f.*,
        CASE
          WHEN f.blocked = 1 AND (
            substr(f.block_reason, 1, 12) = 'needs human:' OR (
              f.failed_attempts >= @maxFailed AND f.latest_blocked_type = 'claim'
            )
          ) THEN 'needs_input'
          WHEN f.blocked = 0 AND f.status IN ('review', 'in_progress')
            AND f.last_review_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM criteria c
              JOIN events e ON e.task_id = c.task_id
              WHERE c.task_id = f.id AND c.checked_at IS NULL
                AND e.action = 'criterion_unchecked' AND e.id > f.last_review_id
                AND CASE WHEN json_valid(e.detail) THEN
                  json_type(e.detail, '$.id') = 'integer'
                  AND json_extract(e.detail, '$.id') = c.id END
            ) THEN 'review_rework'
          WHEN f.blocked = 0 AND f.status = 'review' THEN 'await_acceptance'
          WHEN f.blocked = 0 AND f.status = 'in_progress'
            AND f.last_activity <= @cutoff THEN 'stale_in_progress'
          ELSE NULL
        END AS reason
      FROM task_facts f
    ), candidates AS (
      SELECT id, title, status, reason, block_reason, last_activity,
        CASE reason
          WHEN 'needs_input' THEN 1
          WHEN 'review_rework' THEN 2
          WHEN 'await_acceptance' THEN 3
          ELSE 4
        END AS reason_rank
      FROM classified WHERE reason IS NOT NULL
    ), counted AS (
      SELECT *, COUNT(*) OVER () AS total_count FROM candidates
    )
    SELECT * FROM counted
    ORDER BY reason_rank, last_activity, id
    LIMIT @limit
  `).all({
    maxFailed: MAX_FAILED_ATTEMPTS,
    cutoff: nowSeconds - 86_400,
    limit: CAPS.attentionRows,
  }) as Row[];

  const total = rows[0]?.total_count ?? 0;
  const items = rows.map(({ reason_rank: _rank, total_count: _total, ...row }) => ({
    ...row,
    title: capText(row.title, CAPS.titleChars),
    block_reason: row.block_reason === null
      ? null
      : capText(row.block_reason, CAPS.blockReasonChars),
  }));
  return { items, omitted: total - items.length };
}

function exportEventDetail(detail: string | null, includeSensitive: boolean): string | null {
  if (detail === null) return null;
  try {
    const decoded = JSON.stringify(JSON.parse(detail)); // validate and expose escaped markers
    let marker = '__KDD_EXPORT_NUMBER_';
    while (detail.includes(marker) || decoded.includes(marker)) marker += '_';
    const numbers: string[] = [];
    const protectedDetail = detail.replace(
      /"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
      (token) => token.startsWith('"') ? token : `"${marker}${numbers.push(token) - 1}__"`,
    );
    const value: unknown = JSON.parse(protectedDetail);
    const restoreNumbers = (json: string): string => json.replace(
      new RegExp(`"${marker}(\\d+)__"`, 'g'), (_match, id: string) => numbers[Number(id)],
    );
    let changed = false;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const provenance = (value as Record<string, unknown>).manual_provenance;
      if (provenance && typeof provenance === 'object' && !Array.isArray(provenance)
          && Object.hasOwn(provenance, 'worktree')) {
        delete (provenance as Record<string, unknown>).worktree;
        changed = true;
      }
    }
    if (includeSensitive) return changed ? restoreNumbers(JSON.stringify(value)) : detail;
    const redacted = JSON.stringify(value, (_key, text) => {
      if (typeof text !== 'string') return text;
      const safe = redact(text);
      if (safe !== text) changed = true;
      return safe;
    });
    return changed ? restoreNumbers(redacted) : detail;
  } catch { return includeSensitive ? detail : redact(detail); }
}

export function exportBoard(
  db: Database.Database, decisionsDir: string, opts: { includeSensitive?: boolean } = {},
) {
  syncIndex(db, decisionsDir);
  return db.transaction(() => {
    const tasks = db.prepare(`SELECT id,title,body,status,blocked,block_reason,priority,area,kind,
      track_id,position,archived_at,created_at,updated_at FROM tasks ORDER BY id`).all() as
      Omit<Task, 'claimed_by' | 'claim_expires' | 'failed_attempts'>[];
    const tracks = db.prepare(`SELECT id,name,description,status,created_at FROM tracks ORDER BY id`).all() as Track[];
    const criteria = db.prepare(`SELECT id,task_id,text,checked_at,evidence,checked_by,position,
      created_at FROM criteria ORDER BY id`).all() as Criterion[];
    const comments = db.prepare(`SELECT id,task_id,author,body,created_at FROM comments ORDER BY id`).all() as Comment[];
    const task_links = db.prepare(`SELECT from_id,to_id,kind FROM task_links
      ORDER BY from_id,to_id,kind`).all() as { from_id: number; to_id: number; kind: string }[];
    const decisions = (db.prepare(`SELECT d.slug,d.title,d.created,d.superseded_by,
      d.source_tasks,s.body FROM decisions d LEFT JOIN search_index s
      ON s.kind='decision' AND s.ref=d.slug ORDER BY d.slug`).all() as {
      slug: string; title: string; created: string | null; superseded_by: string | null;
      source_tasks: string; body: string | null;
    }[]).map(({ source_tasks, body, ...row }) => {
      if (body === null) throw new KddError(`decision '${row.slug}' has no indexed body`);
      return { ...row, source_task_ids: JSON.parse(source_tasks) as number[], body };
    });
    const events = (db.prepare(`SELECT id,task_id,actor_type,actor_id,action,detail,
      created_at,parent_id,type,level FROM events ORDER BY id`).all() as EventRow[])
      .map((row) => ({ ...row, detail: exportEventDetail(row.detail, !!opts.includeSensitive) }));
    const files = db.prepare(`SELECT id,task_id,sha256,ext,original_name,mime_type,
      size_bytes,description,created_at FROM files ORDER BY id`).all() as FileRow[];
    const snapshot = { schema_version: 1 as const, tasks, tracks, criteria, comments,
      task_links, decisions, events, files };
    return opts.includeSensitive ? snapshot : JSON.parse(JSON.stringify(snapshot,
      (_key, value) => typeof value === 'string' ? redact(value) : value)) as typeof snapshot;
  })();
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
