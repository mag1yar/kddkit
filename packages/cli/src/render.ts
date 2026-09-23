import {
  CAPS, STATUSES, capText as cap, now,
  type AttentionInbox, type Criterion, type DecisionDetail, type EventRow, type RecallHit,
  type Status, type Task, type TaskListRow,
  type ManualProvenance, type SessionHandoff, type TaskBrief, type TaskDetailCapped, type Track,
} from '@kddkit/core';

// «#5 claimed by ai:s1 (expires in 14m)» — human-строка после claim/renew.
export function renderClaim(t: Task, verb: 'claimed' | 'renewed'): string {
  const left = t.claim_expires ? Math.max(0, Math.round((t.claim_expires - now()) / 60)) : 0;
  return `#${t.id} ${verb} by ${t.claimed_by ?? '?'} (expires in ${left}m)`;
}

export function renderAge(epoch: number): string {
  const d = now() - epoch;
  if (d < 3600) return `${Math.max(1, Math.floor(d / 60))}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

// renderStatus передаёт Task[] (без criteria_*), renderBoard — TaskListRow[]; поля опциональны,
// чтобы taskLine обслуживал оба источника без дублирования.
function taskLine(t: Task & { criteria_total?: number; criteria_checked?: number }): string {
  const bits = [`#${t.id}`, cap(t.title, CAPS.titleChars), `[${t.priority}]`];
  if (t.kind !== 'feature') bits.push(`{${t.kind}}`); // дефолт молчит: см. spec task-kind
  if (t.area) bits.push(`@${t.area}`);
  if (t.criteria_total) bits.push(`${t.criteria_checked}/${t.criteria_total}`);
  if (t.blocked) bits.push(`BLOCKED: ${cap(t.block_reason ?? '', CAPS.blockReasonChars)}`);
  return `  ${bits.join(' ')}`;
}

export function renderBoard(b: Record<Status, TaskListRow[]>): string {
  const lines: string[] = [];
  for (const s of STATUSES) {
    lines.push(`${s} (${b[s].length})`);
    const shown = b[s].slice(0, CAPS.boardRows);
    for (const t of shown) lines.push(taskLine(t));
    if (b[s].length > shown.length) {
      lines.push(`  (+${b[s].length - shown.length} more, use --status ${s})`);
    }
  }
  return lines.join('\n');
}

export function renderAttention(inbox: AttentionInbox): string {
  const oneLine = (value: string) => value.replace(/[\r\n]+/g, ' ');
  const lines = inbox.items.map((item) =>
    `#${item.id} [${item.reason}] ${oneLine(item.title)} (${item.status})` +
    `${item.block_reason ? ` — ${oneLine(item.block_reason)}` : ''}`,
  );
  if (lines.length === 0) lines.push('attention: none');
  if (inbox.omitted > 0) lines.push(`(+${inbox.omitted} omitted)`);
  return lines.join('\n');
}

function renderManual(lines: string[], provenance?: ManualProvenance): void {
  if (!provenance) return;
  lines.push('manual provenance:');
  for (const [key, value] of Object.entries(provenance)) lines.push(`  ${key}: ${value}`);
}

function renderHandoffs(lines: string[], handoffs: SessionHandoff[], omitted: number): void {
  if (!handoffs.length && !omitted) return;
  lines.push('handoffs:');
  for (const handoff of handoffs) {
    lines.push(`  ${handoff.from_client}:${handoff.from_session_id} -> ` +
      `${handoff.to_client}:${handoff.to_session_id} (event #${handoff.event_id})`);
  }
  if (omitted) lines.push(`  (+${omitted} omitted)`);
}

export function renderShow(d: TaskDetailCapped): string {
  const t = d.task;
  const lines = [
    `#${t.id} ${t.title}`,
    `status: ${t.status}${t.blocked ? ` (BLOCKED: ${t.block_reason})` : ''}` +
      `  kind: ${t.kind}` +
      `  priority: ${t.priority}${t.area ? `  area: ${t.area}` : ''}` +
      `${t.archived_at ? '  ARCHIVED' : ''}`,
  ];
  // Вложения ДО тела: в теле картинка стоит браузерной ссылкой (/api/files/7), и мостик
  // к ней — id из этого списка. Список, прочитанный первым, объясняет ссылку, а не наоборот.
  if (d.files_total) {
    lines.push('', `files (${d.files_total}):`);
    if (d.files.length < d.files_total) {
      lines.push(`  (${d.files_total - d.files.length} more omitted)`);
    }
    for (const f of d.files) {
      lines.push(`  [${f.id}] ${f.original_name} ${f.mime_type ?? 'unknown'} ` +
        `${f.size_bytes}B  ${f.path}`);
      if (f.description) lines.push(`      ${f.description}`);
    }
  }
  if (t.body) lines.push('', t.body);
  if (d.criteria.length) {
    lines.push('', 'criteria:', renderCriteria(d.criteria));
  }
  if (d.links.length) {
    lines.push('', 'links:');
    for (const l of d.links) lines.push(`  ${l.kind} #${l.id} ${cap(l.title, CAPS.titleChars)}`);
  }
  if (d.decisions_total) {
    lines.push('', `decisions (${d.decisions_total}):`);
    if (d.decisions.length < d.decisions_total) {
      lines.push(`  (+${d.decisions_total - d.decisions.length} more omitted)`);
    }
    for (const decision of d.decisions) {
      const superseded = decision.superseded_by
        ? ` [superseded by ${cap(decision.superseded_by, CAPS.titleChars)}]`
        : '';
      lines.push(`  decision ${decision.slug}${superseded} ${decision.title}`);
    }
  }
  if (d.comments_total) {
    lines.push('', `comments (${d.comments_total}):`);
    if (d.comments.length < d.comments_total) {
      lines.push(`  (${d.comments_total - d.comments.length} earlier omitted)`);
    }
    for (const c of d.comments) {
      lines.push(`  [${c.author} ${renderAge(c.created_at)} ago] ${c.body}`);
    }
  }
  if (d.manual_provenance || d.handoffs_total) lines.push('');
  renderManual(lines, d.manual_provenance);
  renderHandoffs(lines, d.handoffs, d.handoffs_total - d.handoffs.length);
  lines.push('', 'history:');
  for (const e of d.events) {
    lines.push(`  ${renderAge(e.created_at)} ago ${e.actor_type} ${e.action}` +
      `${e.detail ? ` ${e.detail}` : ''}`);
  }
  return lines.join('\n');
}

export function renderBrief(brief: TaskBrief): string {
  const { task } = brief;
  const lines = [
    `#${task.id} ${task.title}`,
    `status: ${task.status}${task.blocked ? ' BLOCKED' : ''}` +
      `${task.archived_at !== null ? ` ARCHIVED @${task.archived_at}` : ''}`,
    `priority: ${task.priority}`,
    `kind: ${task.kind}`,
    `area: ${task.area ?? 'none'}`,
  ];
  if (task.block_reason) lines.push(`blocker: ${task.block_reason}`);
  if (task.goal) lines.push(`goal: ${task.goal}`);

  if (brief.criteria.items.length || brief.criteria.omitted) {
    lines.push('criteria:');
    for (const criterion of brief.criteria.items) {
      const checked = criterion.checked_at === null ? ' ' : `x @${criterion.checked_at}`;
      lines.push(`  [${checked}] ${criterion.id}. ${criterion.text}`);
      if (criterion.evidence) lines.push(`      evidence: ${criterion.evidence}`);
      if (criterion.checked_by) lines.push(`      checked by: ${criterion.checked_by}`);
    }
    if (brief.criteria.omitted) lines.push(`  (+${brief.criteria.omitted} omitted)`);
  }
  if (brief.comments.items.length || brief.comments.omitted) {
    lines.push('comments:');
    for (const comment of brief.comments.items) {
      lines.push(`  [${comment.id} @${comment.created_at} ${comment.author}] ${comment.body}`);
    }
    if (brief.comments.omitted) lines.push(`  (+${brief.comments.omitted} omitted)`);
  }
  if (brief.events.items.length || brief.events.omitted) {
    lines.push('events:');
    for (const event of brief.events.items) {
      lines.push(`  [${event.id} @${event.created_at} ${event.actor_type}` +
        `${event.actor_id ? `:${event.actor_id}` : ''}] ${event.action}` +
        `${event.detail ? ` ${event.detail}` : ''}`);
    }
    if (brief.events.omitted) lines.push(`  (+${brief.events.omitted} omitted)`);
  }
  if (brief.links.items.length || brief.links.omitted) {
    lines.push('links:');
    for (const link of brief.links.items) lines.push(`  ${link.kind} #${link.id} ${link.title}`);
    if (brief.links.omitted) lines.push(`  (+${brief.links.omitted} omitted)`);
  }
  if (brief.decisions.items.length || brief.decisions.omitted) {
    lines.push('decisions:');
    for (const decision of brief.decisions.items) {
      lines.push(`  ${decision.slug} ${decision.title}` +
        `${decision.created ? ` [created ${decision.created}]` : ''}` +
        `${decision.superseded_by ? ` [superseded by ${decision.superseded_by}]` : ''}`);
    }
    if (brief.decisions.omitted) lines.push(`  (+${brief.decisions.omitted} omitted)`);
  }
  if (brief.files.items.length || brief.files.omitted) {
    lines.push('files:');
    for (const file of brief.files.items) {
      lines.push(`  [${file.id}] ${file.name} ${file.mime_type ?? 'unknown'} ${file.size_bytes}B ${file.path}`);
      if (file.description) lines.push(`      ${file.description}`);
    }
    if (brief.files.omitted) lines.push(`  (+${brief.files.omitted} omitted)`);
  }
  renderManual(lines, brief.manual_provenance);
  renderHandoffs(lines, brief.handoffs.items, brief.handoffs.omitted);
  if (brief.provenance) {
    lines.push('worker provenance:');
    for (const [key, value] of Object.entries(brief.provenance)) lines.push(`  ${key}: ${value}`);
  }
  if (brief.worker_provenance_omitted) lines.push('worker provenance omitted');
  const criterion = brief.next_action.criterion_id === undefined
    ? ''
    : ` criterion #${brief.next_action.criterion_id}`;
  lines.push(`next [${brief.next_action.kind}${criterion}]: ${brief.next_action.text}`);
  lines.push(`budget: ${brief.budget.max_bytes} bytes`);
  return lines.join('\n');
}

export function renderDecision(d: DecisionDetail): string {
  const lines = [
    cap(d.title, CAPS.titleChars),
    `slug: ${d.slug}  status: ${cap(d.status, CAPS.titleChars)}`,
    `path: ${d.path}`,
  ];
  const sources = d.source_tasks.slice(0, CAPS.decisionSources);
  lines.push('', `source tasks (${d.source_tasks.length}):`);
  if (sources.length < d.source_tasks.length) {
    lines.push(`  (+${d.source_tasks.length - sources.length} more omitted)`);
  }
  for (const task of sources) {
    lines.push(`  #${task.id} [${task.status}] ${cap(task.title, CAPS.titleChars)}` +
      `${task.archived_at ? ' ARCHIVED' : ''}`);
  }
  if (d.body) lines.push('', cap(d.body, CAPS.bodyChars));
  return lines.join('\n');
}

export function renderCriteria(cs: Criterion[]): string {
  if (cs.length === 0) return 'no criteria';
  // id в строке — чтобы агент мог check/uncheck без --json
  return cs.flatMap((c) => {
    const lines = [`  [${c.checked_at ? 'x' : ' '}] ${c.id}. ${c.text}`];
    if (c.evidence) lines.push(`      evidence: ${c.evidence}`);
    if (c.checked_at && c.checked_by) {
      lines.push(`      checked by ${c.checked_by} ${renderAge(c.checked_at)} ago`);
    }
    return lines;
  }).join('\n');
}

export function renderRecall(hits: RecallHit[]): string {
  if (hits.length === 0) return 'no results';
  const line = (h: RecallHit): string => {
    const snip = h.snippet.replace(/\s+/g, ' ').trim();
    if (h.kind === 'decision') {
      const tag = h.superseded_by ? ` [superseded by ${h.superseded_by}]` : '';
      return `decision ${h.ref}${tag} ${cap(h.title, CAPS.recallTitleChars)} — ${snip}`;
    }
    return `task #${h.ref} [${h.status ?? '?'}] ${cap(h.title, CAPS.recallTitleChars)} — ${snip}`;
  };
  const all = hits.map(line);
  const shown = [...all];
  while (shown.length > 1 &&
         Buffer.byteLength(shown.join('\n'), 'utf8') > CAPS.recallBytes - 32) {
    shown.pop();
  }
  if (shown.length < all.length) shown.push(`(+${all.length - shown.length} more, use -k)`);
  return shown.join('\n');
}

export function renderTracks(ts: (Track & { open_tasks: number })[]): string {
  if (ts.length === 0) return 'no tracks';
  return ts.map((t) => {
    const head = `#${t.id} ${t.name} (${t.open_tasks})${t.status === 'done' ? ' DONE' : ''}`;
    return t.description ? `${head}\n  ${cap(t.description, CAPS.trackDescChars)}` : head;
  }).join('\n');
}

// Строки статуса не bounded by row count: {kind}-маркер и BLOCKED: reason растягивают одну
// строку сильнее, чем statusRows режет их число. Поэтому, как renderRecall с recallBytes,
// после сборки режем с конца по байтовому бюджету — и, в отличие от renderRecall, режем
// по секциям, чтобы каждое "(+N more)" оставалось правдой, а не молчаливой недостачей.
export function renderStatus(d: {
  in_progress: Task[]; review: Task[]; blocked: Task[]; recent: EventRow[];
}): string {
  const mkSection = (name: string, ts: Task[]) => ({
    header: `${name} (${ts.length})`,
    total: ts.length,
    rows: ts.slice(0, CAPS.statusRows).map(taskLine),
  });
  // Порядок = порядок вывода, важно для "снизу вверх" при урезании.
  const sections = [
    mkSection('in_progress', d.in_progress),
    mkSection('review', d.review),
    mkSection('blocked', d.blocked),
  ];
  const recent = d.recent.map((e) =>
    `  ${renderAge(e.created_at)} ago ${e.actor_type} ${e.action} #${e.task_id ?? '-'}`);
  let recentHidden = 0;

  const render = (): string => {
    const lines: string[] = [];
    for (const s of sections) {
      lines.push(s.header, ...s.rows);
      const hidden = s.total - s.rows.length;
      if (hidden > 0) lines.push(`  (+${hidden} more)`);
    }
    lines.push('recent:', ...recent);
    if (recentHidden > 0) lines.push(`  (+${recentHidden} more, see kdd show <id> for history)`);
    return lines.join('\n');
  };

  // Наименее ценное первым: recent — уже прошлое, не блокирует работу; затем строки секций
  // снизу вверх (blocked -> review -> in_progress) — то, ради чего скорее всего открыли status,
  // остаётся видно дольше всего.
  while (Buffer.byteLength(render(), 'utf8') > CAPS.statusBytes) {
    if (recent.length > 0) { recent.pop(); recentHidden++; continue; }
    const s = [...sections].reverse().find((s) => s.rows.length > 0);
    if (!s) break; // резать больше нечего — отдаём как есть, дальше только заголовки и маркеры
    s.rows.pop();
  }
  return render();
}
