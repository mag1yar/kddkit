import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAPS, addCriterion, addTask, appendAgentEvent, attachFile, blockTask, capText, commentTask,
  linkTasks, openDb, setCriterionChecked, taskBrief, taskDetail,
} from '../src/index.js';

const user = { type: 'user' as const };
const ai = { type: 'ai' as const, id: 'brief-test' };

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'kdd-brief-'));
  const dbPath = join(root, 'kdd.db');
  const decisionsDir = join(root, 'decisions');
  mkdirSync(decisionsDir);
  return { db: openDb(dbPath, 'brief-test'), dbPath, decisionsDir, root };
}

describe('taskBrief', () => {
  it('projects every section in canonical order without persisting a brief', () => {
    const { db, dbPath, decisionsDir, root } = setup();
    const task = addTask(db, { title: 'resume me', body: 'ship the packet' }, user);
    const open = addCriterion(db, task.id, 'open first', user);
    const proved = addCriterion(db, task.id, 'proved second', user);
    const closed = addCriterion(db, task.id, 'closed third', user);
    setCriterionChecked(db, task.id, closed.id, true, ai);
    setCriterionChecked(db, task.id, proved.id, true, ai, 'pnpm test');
    commentTask(db, task.id, 'older', user);
    commentTask(db, task.id, 'newer', ai);

    const linkedB = addTask(db, { title: 'linked B' }, user);
    const linkedA = addTask(db, { title: 'linked A' }, user);
    linkTasks(db, task.id, linkedB.id, 'relates_to', user);
    linkTasks(db, task.id, linkedB.id, 'blocks', user);
    linkTasks(db, task.id, linkedA.id, 'blocks', user);

    const sourceB = join(root, 'b.txt');
    const sourceA = join(root, 'a.txt');
    writeFileSync(sourceB, 'b');
    writeFileSync(sourceA, 'a');
    const fileB = attachFile(db, dbPath, task.id, sourceB, {}, user);
    const fileA = attachFile(db, dbPath, task.id, sourceA, {}, user);

    writeFileSync(join(decisionsDir, '2026-09-21-zeta.md'),
      '---\ncreated: 2026-09-21\nstatus: active\nsource_tasks: [1]\n---\n' +
      '# zeta\n\n## Decision\nx\n');
    writeFileSync(join(decisionsDir, '2026-09-21-alpha.md'),
      '---\ncreated: 2026-09-21\nstatus: active\nsource_tasks: [1]\n---\n' +
      '# alpha\n\n## Decision\nx\n');
    db.prepare(`UPDATE events SET created_at = 100 WHERE task_id = ?`).run(task.id);

    const storedBefore = db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM search_index) AS search_count,
         (SELECT COUNT(*) FROM decisions) AS decision_count`,
    ).get() as { search_count: number; decision_count: number };
    const first = taskBrief(db, decisionsDir, task.id);
    const second = taskBrief(db, decisionsDir, task.id);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.task).toEqual({
      id: task.id,
      title: 'resume me',
      goal: 'ship the packet',
      status: 'new',
      blocked: false,
      block_reason: null,
      priority: 'medium',
      kind: 'feature',
      area: null,
      archived_at: null,
    });
    expect(first.criteria.items.map((criterion) => criterion.id))
      .toEqual([open.id, proved.id, closed.id]);
    expect(first.criteria.items[0]).not.toHaveProperty('evidence');
    expect(first.criteria.items[0]).not.toHaveProperty('checked_by');
    expect(first.criteria.items[1]).toMatchObject({
      evidence: 'pnpm test', checked_by: 'ai:brief-test',
    });
    expect(first.comments.items.map((comment) => comment.body)).toEqual(['newer', 'older']);
    expect(first.events.items.every((event) => event.action !== 'commented')).toBe(true);
    expect(first.events.items.map((event) => event.id)).toEqual(
      [...first.events.items.map((event) => event.id)].sort((a, b) => b - a),
    );
    expect(first.links.items.map((link) => [link.id, link.kind])).toEqual([
      [linkedB.id, 'blocks'],
      [linkedB.id, 'relates_to'],
      [linkedA.id, 'blocks'],
    ]);
    expect(first.decisions.items.map((decision) => decision.slug)).toEqual([
      '2026-09-21-alpha', '2026-09-21-zeta',
    ]);
    expect(first.files.items.map((file) => file.id)).toEqual([fileB.id, fileA.id]);
    expect(first.files.items.map((file) => file.name)).toEqual(['b.txt', 'a.txt']);
    for (const section of [
      first.criteria, first.comments, first.events, first.links, first.decisions, first.files,
    ]) expect(section.omitted).toBe(0);
    expect(db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM search_index) AS search_count,
         (SELECT COUNT(*) FROM decisions) AS decision_count`,
    ).get()).toEqual(storedBefore);
    expect(db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%brief%'`,
    ).all()).toEqual([]);
  });

  it('honors smaller existing caps for titles and blocker text', () => {
    const { db, decisionsDir } = setup();
    const title = `task ${'t'.repeat(100)}`;
    const blocker = `wait ${'b'.repeat(100)}`;
    const linkedTitle = `linked ${'l'.repeat(100)}`;
    const decisionTitle = `decision ${'d'.repeat(100)}`;
    const task = addTask(db, { title }, user);
    const linked = addTask(db, { title: linkedTitle }, user);
    linkTasks(db, task.id, linked.id, 'relates_to', user);
    blockTask(db, task.id, blocker, user);
    writeFileSync(join(decisionsDir, '2026-09-21-long-title.md'),
      `---\ncreated: 2026-09-21\nstatus: active\nsource_tasks: [${task.id}]\n---\n` +
      `# ${decisionTitle}\n\n## Decision\nx\n`);

    const brief = taskBrief(db, decisionsDir, task.id);

    expect(brief.task.title).toBe(capText(title, CAPS.titleChars));
    expect(brief.task.block_reason).toBe(capText(blocker, CAPS.blockReasonChars));
    expect(brief.links.items[0].title).toBe(capText(linkedTitle, CAPS.titleChars));
    expect(brief.decisions.items[0].title).toBe(capText(decisionTitle, CAPS.titleChars));
  });

  it('reads only the latest run skeleton and its latest following error', () => {
    const { db, decisionsDir } = setup();
    const task = addTask(db, { title: 'run context' }, user);
    appendAgentEvent(db, task.id, 'old-worker', 'run_start', { detail: { head: 'old-a' } });
    appendAgentEvent(db, task.id, 'old-worker', 'error', { detail: { message: 'old error' } });
    appendAgentEvent(db, task.id, 'old-worker', 'run_end', { detail: { head: 'old-b' } });
    appendAgentEvent(db, task.id, 'new-worker', 'run_start', {
      detail: { head: 'new-a', branch: 'task/139', session_id: 'session-2' },
    });
    const insertNoise = db.prepare(
      `INSERT INTO agent_events (task_id, worker_id, kind, detail, created_at)
       VALUES (?, 'new-worker', 'text', 'not-json', 100)`,
    );
    db.transaction(() => {
      for (let i = 0; i < 2_000; i++) insertNoise.run(task.id);
    })();
    appendAgentEvent(db, task.id, 'new-worker', 'error', { detail: { message: 'first error' } });
    appendAgentEvent(db, task.id, 'other-worker', 'error', { detail: { message: 'other error' } });
    appendAgentEvent(db, task.id, 'new-worker', 'error', { detail: { message: 'last error' } });
    appendAgentEvent(db, task.id, 'new-worker', 'run_end', { detail: { head: 'new-b' } });

    expect(taskBrief(db, decisionsDir, task.id).provenance).toEqual({
      worker_id: 'new-worker',
      session_id: 'session-2',
      branch: 'task/139',
      before_commit: 'new-a',
      after_commit: 'new-b',
      error: 'last error',
    });
  });

  it.each([
    { status: 'done', archived: false, blocked: true, open: true, want: 'done' },
    { status: 'in_progress', archived: true, blocked: true, open: true, want: 'archived' },
    { status: 'in_progress', archived: false, blocked: true, open: true, want: 'resolve_blocker' },
    { status: 'backlog', archived: false, blocked: false, open: true, want: 'start_work' },
    { status: 'new', archived: false, blocked: false, open: true, want: 'start_work' },
    { status: 'in_progress', archived: false, blocked: false, open: true,
      want: 'complete_criterion' },
    { status: 'in_progress', archived: false, blocked: false, open: false,
      want: 'submit_review' },
    { status: 'review', archived: false, blocked: false, open: false,
      want: 'await_acceptance' },
  ] as const)('selects $want before lower-priority state', (row) => {
    const { db, decisionsDir } = setup();
    const task = addTask(db, { title: row.want }, user);
    if (row.open) addCriterion(db, task.id, 'still open', user);
    db.prepare(
      `UPDATE tasks SET status = ?, archived_at = ?, blocked = ?, block_reason = ? WHERE id = ?`,
    ).run(row.status, row.archived ? 100 : null, row.blocked ? 1 : 0,
      row.blocked ? 'waiting' : null, task.id);

    const next = taskBrief(db, decisionsDir, task.id).next_action;
    expect(next.kind).toBe(row.want);
    if (row.want === 'complete_criterion') expect(next.criterion_id).toBeDefined();
  });

  it('fits serialized UTF-8 and reports removed comments', () => {
    const { db, decisionsDir } = setup();
    const task = addTask(db, {
      title: `Большая задача ${'😀'.repeat(300)}`,
      body: `цель "\\\n" ${'данные'.repeat(1_000)}`,
    }, user);
    for (let i = 0; i < 80; i++) {
      commentTask(db, task.id, `комментарий ${i} ${'🧪'.repeat(300)}`, user);
    }
    for (let i = 0; i < 20; i++) {
      addCriterion(db, task.id, `критерий ${i} ${'я'.repeat(300)}`, user);
    }

    const brief = taskBrief(db, decisionsDir, task.id);

    expect(CAPS.briefBytes).toBe(4096);
    expect(Buffer.byteLength(JSON.stringify(brief), 'utf8')).toBeLessThanOrEqual(4096);
    expect(brief.comments.items.length + brief.comments.omitted).toBe(80);
    expect(JSON.stringify(brief)).toContain('chars]');
  });

  it('caps the latest error without changing exact provenance fields', () => {
    const { db, decisionsDir } = setup();
    const task = addTask(db, { title: 'provenance budget' }, user);
    const worker = `worker-${'w'.repeat(300)}`;
    const before = 'a'.repeat(80);
    const after = 'b'.repeat(80);
    appendAgentEvent(db, task.id, worker, 'run_start', { detail: { head: before } });
    appendAgentEvent(db, task.id, worker, 'error', {
      detail: { message: `ошибка ${'🔥'.repeat(1_000)}` },
    });
    appendAgentEvent(db, task.id, worker, 'run_end', { detail: { head: after } });

    const brief = taskBrief(db, decisionsDir, task.id);

    expect(brief.provenance).toMatchObject({
      worker_id: worker, before_commit: before, after_commit: after,
    });
    expect(brief.provenance?.error).toContain('chars]');
    expect(Buffer.byteLength(JSON.stringify(brief), 'utf8')).toBeLessThanOrEqual(4096);
  });

  it('sacrifices criteria last and keeps every omitted total honest', () => {
    const { db, dbPath, decisionsDir, root } = setup();
    const task = addTask(db, { title: 'priority budget' }, user);
    const unchecked = Array.from({ length: 30 }, (_, i) =>
      addCriterion(db, task.id, `unchecked ${i} ${'u'.repeat(100)}`, user));
    const evidenced = Array.from({ length: 30 }, (_, i) =>
      addCriterion(db, task.id, `evidenced ${i} ${'e'.repeat(100)}`, user));
    const closed = Array.from({ length: 30 }, (_, i) =>
      addCriterion(db, task.id, `closed ${i} ${'c'.repeat(100)}`, user));
    for (const criterion of evidenced) {
      setCriterionChecked(db, task.id, criterion.id, true, ai, 'verified');
    }
    for (const criterion of closed) setCriterionChecked(db, task.id, criterion.id, true, ai);
    for (let i = 0; i < 30; i++) {
      commentTask(db, task.id, `history ${i} ${'h'.repeat(200)}`, user);
    }
    const relatedCount = 8;
    for (let i = 0; i < relatedCount; i++) {
      const linked = addTask(db, { title: `linked ${i} ${'l'.repeat(80)}` }, user);
      linkTasks(db, task.id, linked.id, `relation-${i}`, user);
      const source = join(root, `artifact-${i}.txt`);
      writeFileSync(source, `artifact ${i}`);
      attachFile(db, dbPath, task.id, source, { description: 'f'.repeat(128) }, user);
      writeFileSync(join(decisionsDir, `2026-09-21-decision-${i}.md`),
        `---\ncreated: 2026-09-21\nstatus: active\nsource_tasks: [${task.id}]\n---\n` +
        `# decision ${i} ${'d'.repeat(80)}\n\n## Decision\nx\n`);
    }

    const full = taskDetail(db, task.id);
    const brief = taskBrief(db, decisionsDir, task.id);
    const rank = (criterion: (typeof brief.criteria.items)[number]) =>
      criterion.checked_at === null ? 0 : criterion.evidence ? 1 : 2;

    expect(brief.comments.items.length + brief.comments.omitted).toBe(full.comments.length);
    expect(brief.events.items.length + brief.events.omitted)
      .toBe(full.events.filter((event) => event.action !== 'commented').length);
    expect(brief.criteria.items.length + brief.criteria.omitted).toBe(90);
    expect(brief.files.items.length + brief.files.omitted).toBe(relatedCount);
    expect(brief.links.items.length + brief.links.omitted).toBe(relatedCount);
    expect(brief.decisions.items.length + brief.decisions.omitted).toBe(relatedCount);
    expect(brief.criteria.omitted).toBeGreaterThan(0);
    expect(brief.events.items).toEqual([]);
    expect(brief.comments.items).toEqual([]);
    expect(brief.files.items).toEqual([]);
    expect(brief.links.items).toEqual([]);
    expect(brief.decisions.items).toEqual([]);
    expect(brief.criteria.items.map(rank)).toEqual([...brief.criteria.items.map(rank)].sort());
    if (brief.criteria.items.some((criterion) => rank(criterion) === 2)) {
      expect(brief.criteria.items.some((criterion) => rank(criterion) === 1)).toBe(true);
      expect(brief.criteria.items.some((criterion) => rank(criterion) === 0)).toBe(true);
    }
    if (brief.criteria.items.some((criterion) => rank(criterion) === 1)) {
      expect(brief.criteria.items.some((criterion) => rank(criterion) === 0)).toBe(true);
    }
  });

  it('returns exact identifiers or removes their whole record', () => {
    const { db, dbPath, decisionsDir, root } = setup();
    const task = addTask(db, { title: 'exact values' }, user);
    const source = join(root, `${'n'.repeat(100)}.txt`);
    writeFileSync(source, 'exact');
    const attached = attachFile(db, dbPath, task.id, source, {}, user);
    const fullPath = taskDetail(db, task.id).files[0].path;
    const actorId = `actor-${'a'.repeat(100)}`;
    addCriterion(db, task.id, 'actor event', { type: 'ai', id: actorId });
    const linked = addTask(db, { title: 'identifier link' }, user);
    const linkKind = `kind-${'k'.repeat(100)}`;
    linkTasks(db, task.id, linked.id, linkKind, user);
    const slug = `decision-${'s'.repeat(100)}`;
    const supersededBy = `replacement-${'r'.repeat(100)}`;
    writeFileSync(join(decisionsDir, `${slug}.md`),
      `---\ncreated: 2026-09-21\nstatus: superseded\nsuperseded_by: ${supersededBy}\n` +
      `source_tasks: [${task.id}]\n---\n# exact decision\n\n## Decision\nx\n`);
    const worker = `worker-${'x'.repeat(100)}`;
    const session = `session-${'i'.repeat(100)}`;
    const branch = `branch-${'b'.repeat(100)}`;
    const worktree = `/tmp/${'w'.repeat(100)}`;
    const before = 'c'.repeat(80);
    const after = 'd'.repeat(80);
    appendAgentEvent(db, task.id, worker, 'run_start', {
      detail: { head: before, session_id: session, branch, worktree },
    });
    appendAgentEvent(db, task.id, worker, 'run_end', { detail: { head: after } });

    const brief = taskBrief(db, decisionsDir, task.id);
    const file = brief.files.items.find((item) => item.id === attached.id);

    expect(file === undefined || file.path === fullPath).toBe(true);
    expect(file === undefined || file.name === attached.original_name).toBe(true);
    const link = brief.links.items.find((item) => item.id === linked.id);
    expect(link === undefined || link.kind === linkKind).toBe(true);
    const decision = brief.decisions.items.find((item) => item.slug === slug);
    expect(decision === undefined || decision.slug === slug).toBe(true);
    expect(decision === undefined || decision.superseded_by === supersededBy).toBe(true);
    const event = brief.events.items.find((item) => item.actor_id === actorId);
    expect(event === undefined || event.actor_id === actorId).toBe(true);
    expect(brief.provenance === undefined || brief.provenance.worker_id === worker).toBe(true);
    expect(brief.provenance === undefined || brief.provenance.session_id === session).toBe(true);
    expect(brief.provenance === undefined || brief.provenance.branch === branch).toBe(true);
    expect(brief.provenance === undefined || brief.provenance.worktree === worktree).toBe(true);
    expect(brief.provenance === undefined || brief.provenance.before_commit === before).toBe(true);
    expect(brief.provenance === undefined || brief.provenance.after_commit === after).toBe(true);
  });
});
