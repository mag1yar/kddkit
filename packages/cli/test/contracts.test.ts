import { describe, it, expect, beforeEach } from 'vitest';
import {
  CAPS, addTask, editTask, openDb, taskDetailCapped, type DecisionDetail,
} from '@kddkit/core';
import { makeEnv, kdd } from './run.js';
import { renderDecision, renderShow } from '../src/render.js';

let env: NodeJS.ProcessEnv;
beforeEach(() => { env = makeEnv(); });

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

function seed100(): void {
  // research держим в ротации: это самый длинный маркер {research}, и именно он
  // должен пробивать 2KB-контракт status, если тот в самом деле капнут по строкам.
  for (let i = 0; i < 100; i++) {
    kdd(env, 'add',
      `Задача с достаточно длинным заголовком номер ${i} про справочники и договоры`,
      '--priority', ['low', 'medium', 'high', 'urgent'][i % 4],
      '--area', ['справочники', 'договор', 'клиент'][i % 3],
      '--kind', ['feature', 'bug', 'chore', 'research'][i % 4]);
  }
  for (let i = 1; i <= 30; i++) kdd(env, 'move', `#${i}`, 'in_progress');
  // review — третья секция status; без неё renderStatus только видела in_progress/blocked,
  // и структурный overflow (finding 1, round 2) оставался незамеченным.
  for (let i = 21; i <= 30; i++) kdd(env, 'move', `#${i}`, 'review');
  for (let i = 31; i <= 40; i++) kdd(env, 'block', `#${i}`, 'причина блокировки');
}

describe('output contracts (CLI-05)', () => {
  it('shows latest manual provenance and known handoffs', () => {
    const db = openDb(':memory:', 'x');
    const task = addTask(db, { title: 'manual' }, { type: 'user' });
    const actor = (sessionId: string) => ({
      type: 'ai' as const, id: 'transport',
      manualSession: { client: 'codex' as const, sessionId, cwd: '/not-a-repo' },
    });
    editTask(db, task.id, { area: 'one' }, actor('session-a'));
    editTask(db, task.id, { area: 'two' }, actor('session-b'));
    const out = renderShow(taskDetailCapped(db, task.id));
    expect(out).toContain('manual provenance:');
    expect(out).toContain('session_id: session-b');
    expect(out).toContain('codex:session-a -> codex:session-b');
  });
  it('caps task backlinks and reports their total', () => {
    const db = openDb(':memory:', 'x');
    const task = addTask(db, { title: 'source' }, { type: 'user' });
    const insert = db.prepare(
      `INSERT INTO decisions
         (slug, title, path, content_hash, created, superseded_by, source_tasks)
       VALUES (?, ?, ?, ?, ?, NULL, '[1]')`,
    );
    for (let i = 0; i < 21; i++) {
      insert.run(`decision-${String(i).padStart(2, '0')}`, `decision ${i}`,
        `/tmp/decision-${i}.md`, `hash-${i}`, '2026-09-20');
    }

    const out = renderShow(taskDetailCapped(db, task.id));
    expect(out).toContain('decisions (21):');
    expect(out).toContain('(+1 more omitted)');
    expect(out.match(/^  decision /gm)).toHaveLength(20);
  });

  it('caps decision sources and Markdown body with visible totals', () => {
    const detail: DecisionDetail = {
      slug: 'large', title: 'large', path: '/tmp/large.md', created: '2026-09-20',
      superseded_by: null, status: 'active', body: 'x'.repeat(CAPS.bodyChars + 100),
      source_tasks: Array.from({ length: 21 }, (_, i) => ({
        id: i + 1, title: `source ${i + 1}`, status: 'new', archived_at: null,
      })),
    };

    const out = renderDecision(detail);
    expect(out).toContain('source tasks (21):');
    expect(out).toContain('(+1 more omitted)');
    expect(out.match(/^  #\d+/gm)).toHaveLength(20);
    expect(out).toContain('chars]');
  });

  it('caps frontmatter-backed decision metadata', () => {
    const db = openDb(':memory:', 'x');
    const task = addTask(db, { title: 'source' }, { type: 'user' });
    const supersededBy = 's'.repeat(100);
    db.prepare(
      `INSERT INTO decisions
         (slug, title, path, content_hash, created, superseded_by, source_tasks)
       VALUES ('choice', 'choice', '/tmp/choice.md', 'hash', '2026-09-20', ?, '[1]')`,
    ).run(supersededBy);

    const show = renderShow(taskDetailCapped(db, task.id));
    expect(show).toContain(`[superseded by ${'s'.repeat(50)}… [+50 chars]]`);
    expect(show).not.toContain(supersededBy);

    const status = 'x'.repeat(100);
    const decision = renderDecision({
      slug: 'choice', title: 'choice', path: '/tmp/choice.md', created: '2026-09-20',
      superseded_by: null, status, body: '', source_tasks: [],
    });
    expect(decision).toContain(`status: ${'x'.repeat(50)}… [+50 chars]`);
    expect(decision).not.toContain(status);
  });

  it('status ≤ 2KB on a 100-task board', () => {
    seed100();
    const s = kdd(env, 'status');
    expect(Buffer.byteLength(s, 'utf8')).toBeLessThanOrEqual(2048);
    expect(EMOJI.test(s)).toBe(false);
  }, 60_000);

  // Round 2 on finding 1: statusRows is not what bounds status — a single row (long Cyrillic
  // title + {research} + BLOCKED: long reason) can outweigh the row-count cap entirely, on its
  // own. This pins the structural fix in renderStatus (trim-from-end, like renderRecall), not
  // an arithmetic row count: it must fail if the trimming logic is removed/reverted.
  it('status trims structurally when rows are individually oversized, and says so', () => {
    const title = 'Очень длинный подробный заголовок задачи для проверки байтового бюджета выдачи';
    const reason = 'Очень длинная и подробная причина блокировки для проверки байтового бюджета выдачи статуса';
    for (let i = 0; i < 20; i++) {
      kdd(env, 'add', `${title} номер ${i}`,
        '--priority', 'urgent', '--kind', 'research', '--area', 'справочники',
        '--criterion', 'done when done');
    }
    for (let i = 1; i <= 15; i++) kdd(env, 'move', `#${i}`, 'in_progress');
    for (let i = 6; i <= 15; i++) kdd(env, 'move', `#${i}`, 'review'); // 5 in_progress, 10 review
    for (let i = 16; i <= 20; i++) kdd(env, 'block', `#${i}`, reason); // 5 blocked
    const s = kdd(env, 'status');
    expect(Buffer.byteLength(s, 'utf8')).toBeLessThanOrEqual(CAPS.statusBytes);
    expect(s).toMatch(/\(\+\d+ more/); // не молчим о том, что урезали
  }, 60_000);

  it('board ≤ 4KB on a 100-task board', () => {
    seed100();
    const b = kdd(env, 'board');
    expect(Buffer.byteLength(b, 'utf8')).toBeLessThanOrEqual(4096);
    expect(EMOJI.test(b)).toBe(false);
  }, 60_000);

  it('show caps a 100KB body visibly', async () => {
    // 100KB аргументом не лезет в Windows-лимит командной строки — через --body-file
    const { writeFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const bodyFile = join(dirname(env.KDD_DB!), 'body.md');
    writeFileSync(bodyFile, 'x'.repeat(100_000));
    kdd(env, 'add', 'жирная', '--body-file', bodyFile);
    const s = kdd(env, 'show', '#1');
    expect(Buffer.byteLength(s, 'utf8')).toBeLessThanOrEqual(16_384);
    expect(s).toContain('chars]');
  });

  it('recall output stays under 4KB even with many fat hits', { timeout: 60_000 }, () => {
    for (let i = 0; i < 30; i++) {
      kdd(env, 'add', `omega search target ${i} ${'lorem ipsum dolor '.repeat(10)}`,
        '--body', `omega body ${i} ${'consectetur adipiscing elit sed do '.repeat(5)}`);
    }
    const out = kdd(env, 'recall', 'omega', '-k', '30');
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(4096);
    expect(out).toMatch(/\(\+\d+ more, use -k\)/);
    expect(EMOJI.test(out)).toBe(false);
  });
});
