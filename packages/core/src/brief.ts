import { canSyncLegacyDecisions } from './project_store.js';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
    parent_id: number | null;
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
  next_action: NextAction;
  budget: { max_bytes: 4096 };
}

const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function readTaskDecisions(
  db: Database.Database, decisionsDir: string, taskId: number,
): TaskBrief['decisions']['items'] {
  if (!canSyncLegacyDecisions(db, decisionsDir)) {
    return (db.prepare('SELECT slug,title,created,superseded_by,source_tasks FROM decisions ORDER BY slug')
      .all() as { slug: string; title: string; created: string | null; superseded_by: string | null; source_tasks: string }[])
      .filter(row => (JSON.parse(row.source_tasks) as number[]).includes(taskId))
      .map(({ source_tasks, ...row }) => ({ ...row, title: capText(row.title, CAPS.titleChars) }));
  }
  if (!existsSync(decisionsDir)) return [];
  return readdirSync(decisionsDir).filter((file) => file.endsWith('.md')).flatMap((file) => {
    const slug = file.slice(0, -3);
    if (!canSyncLegacyDecisions(db, dirname(realpathSync(join(decisionsDir,file))))) return [];
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

function fitBrief(brief: TaskBrief, sources: ScalarSources): TaskBrief {
  if (briefBytes(brief) <= CAPS.briefBytes) return brief;

  drain(brief, brief.events);
  drain(brief, brief.comments);
  drain(brief, brief.files);
  drain(brief, brief.links);
  drain(brief, brief.decisions);
  drain(brief, brief.handoffs);

  for (const field of ['worktree', 'branch'] as const) {
    if (briefBytes(brief) > CAPS.briefBytes && brief.manual_provenance?.[field]) delete brief.manual_provenance[field];
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
      parent_id: detail.task.parent_id,
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
      items: readTaskDecisions(db, decisionsDir, id)
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
    next_action: action,
    budget: { max_bytes: CAPS.briefBytes },
  };
  return fitBrief(brief, {
    block_reason: detail.task.block_reason,
    goal: detail.task.body,
    next_action: actionSource,
    area: detail.task.area,
    title: detail.task.title,
  });
}
