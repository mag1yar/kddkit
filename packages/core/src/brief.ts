import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { CAPS, capText } from './caps.js';
import { parseDecisionMd } from './decisions.js';
import { taskDetail } from './queries.js';
import type { Criterion, ManualProvenance, SessionHandoff } from './types.js';
import type { Kind, Priority, Status } from './state.js';

export interface BriefSection<T> {
  items: T[];
  omitted: number;
}

export type NextAction = {
  kind: 'resolve_blocker' | 'start_work' | 'complete_criterion' | 'submit_review' |
    'await_acceptance' | 'archived' | 'done';
  text: string;
  criterion_id?: number;
};

export interface TaskBrief {
  task: {
    id: number;
    title: string;
    goal: string | null;
    status: Status;
    blocked: boolean;
    block_reason: string | null;
    priority: Priority;
    kind: Kind;
    area: string | null;
    archived_at: number | null;
  };
  criteria: BriefSection<{
    id: number;
    text: string;
    checked_at: number | null;
    evidence?: string;
    checked_by?: string;
  }>;
  comments: BriefSection<{
    id: number;
    author: string;
    body: string;
    created_at: number;
  }>;
  events: BriefSection<{
    id: number;
    actor_type: 'user' | 'ai';
    actor_id?: string;
    action: string;
    detail?: string;
    created_at: number;
  }>;
  links: BriefSection<{ id: number; title: string; kind: string }>;
  decisions: BriefSection<{
    slug: string;
    title: string;
    created: string | null;
    superseded_by: string | null;
  }>;
  files: BriefSection<{
    id: number;
    name: string;
    mime_type: string | null;
    size_bytes: number;
    description: string | null;
    path: string;
  }>;
  manual_provenance?: ManualProvenance;
  handoffs: BriefSection<SessionHandoff>;
  provenance?: {
    worker_id?: string;
    session_id?: string;
    branch?: string;
    worktree?: string;
    before_commit?: string;
    after_commit?: string;
    error?: string;
  };
  worker_provenance_omitted?: boolean;
  next_action: NextAction;
  budget: { max_bytes: 4096 };
}

type Provenance = NonNullable<TaskBrief['provenance']>;
type JsonObject = Record<string, unknown>;

const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function detailObject(detail: string | null): JsonObject {
  if (!detail) return {};
  try {
    const value: unknown = JSON.parse(detail);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as JsonObject
      : {};
  } catch {
    return {};
  }
}

function stringField(key: string, ...objects: JsonObject[]): string | undefined {
  for (const object of objects) {
    const value = object[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function readRunProvenance(db: Database.Database, taskId: number): Provenance | undefined {
  const row = db.prepare(
    `WITH latest_start AS (
       SELECT id, worker_id, detail
         FROM agent_events
        WHERE task_id = ? AND kind = 'run_start'
        ORDER BY id DESC
        LIMIT 1
     )
     SELECT s.worker_id,
            s.detail AS start_detail,
            (SELECT ae.detail FROM agent_events ae
              WHERE ae.task_id = ? AND ae.worker_id = s.worker_id
                AND ae.kind = 'run_end' AND ae.id > s.id
              ORDER BY ae.id ASC LIMIT 1) AS end_detail,
            (SELECT ae.detail FROM agent_events ae
              WHERE ae.task_id = ? AND ae.worker_id = s.worker_id
                AND ae.kind = 'error' AND ae.id > s.id
              ORDER BY ae.id DESC LIMIT 1) AS error_detail
       FROM latest_start s`,
  ).get(taskId, taskId, taskId) as {
    worker_id: string;
    start_detail: string | null;
    end_detail: string | null;
    error_detail: string | null;
  } | undefined;
  if (!row) return undefined;

  const start = detailObject(row.start_detail);
  const end = detailObject(row.end_detail);
  const error = detailObject(row.error_detail);
  const provenance: Provenance = { worker_id: row.worker_id };
  const sessionId = stringField('session_id', start, end, error);
  const branch = stringField('branch', start, end, error);
  const worktree = stringField('worktree', start, end, error);
  const beforeCommit = stringField('head', start);
  const afterCommit = stringField('head', end);
  const message = stringField('message', error);
  if (sessionId !== undefined) provenance.session_id = sessionId;
  if (branch !== undefined) provenance.branch = branch;
  if (worktree !== undefined) provenance.worktree = worktree;
  if (beforeCommit !== undefined) provenance.before_commit = beforeCommit;
  if (afterCommit !== undefined) provenance.after_commit = afterCommit;
  if (message !== undefined) provenance.error = message;
  return provenance;
}

function readTaskDecisions(
  decisionsDir: string, taskId: number,
): TaskBrief['decisions']['items'] {
  if (!existsSync(decisionsDir)) return [];
  return readdirSync(decisionsDir).filter((file) => file.endsWith('.md')).flatMap((file) => {
    const slug = file.slice(0, -3);
    const decision = parseDecisionMd(readFileSync(join(decisionsDir, file), 'utf8'));
    if (!decision.sourceTasks.includes(taskId)) return [];
    return [{
      slug,
      title: capText(decision.title || slug, CAPS.titleChars),
      created: decision.created || null,
      superseded_by: decision.status === 'superseded'
        ? decision.supersededBy || '?'
        : decision.supersededBy || null,
    }];
  });
}

function nextAction(
  task: TaskBrief['task'], criteria: TaskBrief['criteria']['items'],
): NextAction {
  if (task.status === 'done') return { kind: 'done', text: 'Task is done; no action remains.' };
  if (task.archived_at !== null) {
    return { kind: 'archived', text: 'Task is archived; no action remains.' };
  }
  if (task.blocked) {
    return {
      kind: 'resolve_blocker',
      text: task.block_reason ? `Resolve blocker: ${task.block_reason}` : 'Resolve the task blocker.',
    };
  }
  if (task.status === 'backlog') {
    return { kind: 'start_work', text: 'Move the task to new and start work.' };
  }
  if (task.status === 'new') return { kind: 'start_work', text: 'Start work on the task.' };
  const open = criteria.find((criterion) => criterion.checked_at === null);
  if (open) {
    return {
      kind: 'complete_criterion',
      criterion_id: open.id,
      text: `Complete criterion #${open.id}: ${open.text}`,
    };
  }
  if (task.status !== 'review') {
    return { kind: 'submit_review', text: 'Submit the task to review.' };
  }
  return { kind: 'await_acceptance', text: 'Await human acceptance or requested changes.' };
}

interface ScalarSources {
  block_reason: string | null;
  goal: string | null;
  next_action: string;
  area: string | null;
  title: string;
}

const briefBytes = (brief: TaskBrief): number =>
  Buffer.byteLength(JSON.stringify(brief), 'utf8');

function omitLastItem<T>(section: BriefSection<T>): boolean {
  if (section.items.length === 0) return false;
  section.items.pop();
  section.omitted += 1;
  return true;
}

function drain<T>(brief: TaskBrief, section: BriefSection<T>): void {
  while (briefBytes(brief) > CAPS.briefBytes && omitLastItem(section)) {
    /* measure after every item */
  }
}

function fitBrief(brief: TaskBrief, sources: ScalarSources, errorSource?: string): TaskBrief {
  if (briefBytes(brief) <= CAPS.briefBytes) return brief;

  drain(brief, brief.events);
  drain(brief, brief.comments);
  drain(brief, brief.files);
  drain(brief, brief.links);
  drain(brief, brief.decisions);
  drain(brief, brief.handoffs);

  if (briefBytes(brief) > CAPS.briefBytes && brief.provenance?.error && errorSource) {
    for (const cap of [128, 64, 32, 16]) {
      brief.provenance.error = capText(errorSource, cap);
      if (briefBytes(brief) <= CAPS.briefBytes) return brief;
    }
    delete brief.provenance.error;
  }
  for (const source of [brief.manual_provenance, brief.provenance]) {
    for (const field of ['worktree', 'branch'] as const) {
      if (briefBytes(brief) > CAPS.briefBytes && source?.[field]) delete source[field];
    }
  }

  const caps: Record<keyof ScalarSources, number> = {
    block_reason: CAPS.blockReasonChars,
    goal: 512,
    next_action: 128,
    area: 128,
    title: CAPS.titleChars,
  };
  const tighten = (key: keyof ScalarSources): void => {
    if (sources[key] === null) { caps[key] = 16; return; }
    if (caps[key] <= 16) return;
    caps[key] = Math.max(16, Math.floor(caps[key] / 2));
    const value = capText(sources[key] as string, caps[key]);
    if (key === 'next_action') brief.next_action.text = value;
    else if (key === 'block_reason') brief.task.block_reason = value;
    else if (key === 'goal') brief.task.goal = value;
    else if (key === 'area') brief.task.area = value;
    else brief.task.title = value;
  };
  while (briefBytes(brief) > CAPS.briefBytes && Object.values(caps).some((cap) => cap > 16)) {
    for (const key of ['block_reason', 'goal', 'next_action', 'area', 'title'] as const) {
      tighten(key);
      if (briefBytes(brief) <= CAPS.briefBytes) return brief;
    }
  }

  while (briefBytes(brief) > CAPS.briefBytes &&
    brief.criteria.items.at(-1)?.checked_at !== null &&
    brief.criteria.items.length > 0) {
    omitLastItem(brief.criteria);
  }
  if (briefBytes(brief) > CAPS.briefBytes && brief.provenance) {
    delete brief.provenance;
    brief.worker_provenance_omitted = true;
  }
  drain(brief, brief.criteria);
  if (briefBytes(brief) > CAPS.briefBytes) {
    throw new Error('task brief cannot fit the 4096-byte JSON budget');
  }
  return brief;
}

export function taskBrief(
  db: Database.Database, decisionsDir: string, id: number,
): TaskBrief {
  const detail = taskDetail(db, id);
  const criteria = [...detail.criteria].sort((a, b) => {
    const rank = (criterion: Criterion): number =>
      criterion.checked_at === null ? 0 : criterion.evidence ? 1 : 2;
    return rank(a) - rank(b) || a.position - b.position || a.id - b.id;
  });
  const provenance = readRunProvenance(db, id);
  const errorSource = provenance?.error;
  if (provenance?.error) provenance.error = capText(provenance.error, 256);
  const task: TaskBrief['task'] = {
      id: detail.task.id,
      title: capText(detail.task.title, CAPS.titleChars),
      goal: detail.task.body === null ? null : capText(detail.task.body, 512),
      status: detail.task.status,
      blocked: !!detail.task.blocked,
      block_reason: detail.task.block_reason === null
        ? null : capText(detail.task.block_reason, CAPS.blockReasonChars),
      priority: detail.task.priority,
      kind: detail.task.kind,
      area: detail.task.area === null ? null : capText(detail.task.area, 128),
      archived_at: detail.task.archived_at,
  };
  const projectedCriteria: TaskBrief['criteria'] = {
      items: criteria.map((criterion) => ({
        id: criterion.id,
        text: capText(criterion.text, 128),
        checked_at: criterion.checked_at,
        ...(criterion.evidence ? { evidence: capText(criterion.evidence, 128) } : {}),
        ...(criterion.checked_by ? { checked_by: criterion.checked_by } : {}),
      })),
      omitted: 0,
  };
  const action = nextAction(task, projectedCriteria.items);
  const actionSource = action.text;
  action.text = capText(action.text, 128);
  const brief: TaskBrief = {
    task,
    criteria: projectedCriteria,
    comments: {
      items: detail.comments.map((comment) => ({
        id: comment.id,
        author: comment.author,
        body: capText(comment.body, 256),
        created_at: comment.created_at,
      })).sort((a, b) => b.created_at - a.created_at || b.id - a.id),
      omitted: 0,
    },
    events: {
      items: detail.events.filter((event) => event.action !== 'commented').map((event) => ({
        id: event.id,
        actor_type: event.actor_type,
        ...(event.actor_id ? { actor_id: event.actor_id } : {}),
        action: event.action,
        ...(event.detail ? { detail: capText(event.detail, 256) } : {}),
        created_at: event.created_at,
      })).sort((a, b) => b.created_at - a.created_at || b.id - a.id),
      omitted: 0,
    },
    links: {
      items: detail.links.map((link) => ({ ...link, title: capText(link.title, CAPS.titleChars) }))
        .sort((a, b) => a.id - b.id || lexical(a.kind, b.kind)),
      omitted: 0,
    },
    decisions: {
      items: readTaskDecisions(decisionsDir, id)
        .sort((a, b) => lexical(a.slug, b.slug)),
      omitted: 0,
    },
    files: {
      items: detail.files.map((file) => ({
        id: file.id,
        name: file.original_name,
        mime_type: file.mime_type,
        size_bytes: file.size_bytes,
        description: file.description === null ? null : capText(file.description, 128),
        path: file.path,
      })).sort((a, b) => a.id - b.id),
      omitted: 0,
    },
    ...(detail.manual_provenance ? { manual_provenance: detail.manual_provenance } : {}),
    handoffs: {
      items: detail.handoffs.slice(-3).reverse(),
      omitted: Math.max(0, detail.handoffs.length - 3),
    },
    ...(provenance ? { provenance } : {}),
    next_action: action,
    budget: { max_bytes: CAPS.briefBytes },
  };
  return fitBrief(brief, {
    block_reason: detail.task.block_reason,
    goal: detail.task.body,
    next_action: actionSource,
    area: detail.task.area,
    title: detail.task.title,
  }, errorSource);
}
