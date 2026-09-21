import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  addCriterion, addTask, appendAgentEvent, attachFile, blockTask, commentTask, linkTasks,
  openDb, setCriterionChecked, taskBrief,
} from '@kddkit/core';
import { renderBrief } from '../src/render.js';
import { kdd, makeEnv } from './run.js';

const user = { type: 'user' as const };

describe('kdd brief', () => {
  it('prints the exact bounded core JSON from a fresh child process', () => {
    const env = makeEnv();
    const db = openDb(env.KDD_DB!, 'brief-cli');
    const task = addTask(db, { title: 'resume', body: 'finish it', area: 'context' }, user);
    const open = addCriterion(db, task.id, 'tests pass', user);
    const proved = addCriterion(db, task.id, 'review evidence', user);
    setCriterionChecked(db, task.id, proved.id, true, user, 'pnpm test');
    commentTask(db, task.id, 'latest context', user);
    blockTask(db, task.id, 'waiting for input', user);
    const linked = addTask(db, { title: 'related work' }, user);
    linkTasks(db, task.id, linked.id, 'relates_to', user);
    const source = join(dirname(env.KDD_DB!), 'artifact.txt');
    writeFileSync(source, 'artifact');
    const file = attachFile(db, env.KDD_DB!, task.id, source, {}, user);
    appendAgentEvent(db, task.id, 'worker-139', 'run_start', {
      detail: { head: 'before-commit', branch: 'master', worktree: '/tmp/worktree' },
    });
    appendAgentEvent(db, task.id, 'worker-139', 'run_end', {
      detail: { head: 'after-commit', session_id: 'session-139' },
    });
    db.close();

    const expectedDb = openDb(env.KDD_DB!, 'brief-cli');
    const expected = taskBrief(expectedDb, env.KDD_DECISIONS_DIR!, task.id);
    expectedDb.close();
    const first = kdd(env, 'brief', String(task.id), '--json').trim();
    const second = kdd(env, 'brief', String(task.id), '--json').trim();

    expect(first).toBe(second);
    expect(JSON.parse(first)).toEqual(expected);
    expect(Buffer.byteLength(first, 'utf8')).toBeLessThanOrEqual(4096);
    expect(JSON.parse(first)).toMatchObject({
      task: { goal: 'finish it', status: 'new', blocked: true, block_reason: 'waiting for input' },
      next_action: { kind: 'resolve_blocker' },
      provenance: {
        worker_id: 'worker-139', session_id: 'session-139', branch: 'master',
        worktree: '/tmp/worktree', before_commit: 'before-commit', after_commit: 'after-commit',
      },
    });
    const parsed = JSON.parse(first);
    expect(parsed.criteria.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: open.id, text: 'tests pass', checked_at: null }),
      expect.objectContaining({ id: proved.id, evidence: 'pnpm test' }),
    ]));
    expect(parsed.comments.items[0].body).toBe('latest context');
    expect(parsed.events.items.length).toBeGreaterThan(0);
    expect(parsed.links.items).toContainEqual(expect.objectContaining({ id: linked.id }));
    expect(parsed.files.items).toContainEqual(expect.objectContaining({ id: file.id }));
  });

  it('renders the supplied brief without fetching or trimming', () => {
    const env = makeEnv();
    const db = openDb(env.KDD_DB!, 'brief-cli');
    const task = addTask(db, { title: 'human resume', body: 'goal' }, user);
    const criterion = addCriterion(db, task.id, 'ship it', user);
    const checked = addCriterion(db, task.id, 'already proved', user);
    const checkedRow = setCriterionChecked(db, task.id, checked.id, true, user, 'proof');
    const brief = taskBrief(db, env.KDD_DECISIONS_DIR!, task.id);
    brief.comments.omitted = 2;
    brief.task.priority = 'urgent';
    brief.task.kind = 'bug';
    brief.task.area = 'context';
    brief.comments.items = [{ id: 41, author: 'user', body: 'history', created_at: 123 }];
    brief.events.items = [{
      id: 42, actor_type: 'ai', actor_id: 'worker', action: 'edited', detail: 'fields',
      created_at: 124,
    }];
    brief.decisions.items = [{
      slug: 'decision-slug', title: 'Decision title', created: '2026-09-21',
      superseded_by: null,
    }];
    brief.next_action = {
      kind: 'complete_criterion', criterion_id: criterion.id, text: 'Complete it.',
    };

    const rendered = renderBrief(brief);

    expect(rendered).toContain('#1 human resume');
    expect(rendered).toContain('status: new');
    expect(rendered).toContain('priority: urgent');
    expect(rendered).toContain('kind: bug');
    expect(rendered).toContain('area: context');
    expect(rendered).toContain('goal: goal');
    expect(rendered).toContain('criteria:');
    expect(rendered).toContain('[ ] 1. ship it');
    expect(rendered).toContain(`[x @${checkedRow.checked_at}] 2. already proved`);
    expect(rendered).toContain('comments:');
    expect(rendered).toContain('[41 @123 user] history');
    expect(rendered).toContain('[42 @124 ai:worker] edited fields');
    expect(rendered).toContain('decision-slug Decision title [created 2026-09-21]');
    expect(rendered).toContain('(+2 omitted)');
    expect(rendered).toContain(`next [complete_criterion criterion #${criterion.id}]: Complete it.`);
    expect(rendered).toContain('budget: 4096 bytes');
  });
});
