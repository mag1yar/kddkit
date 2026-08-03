import { describe, it, expect, beforeEach } from 'vitest';
import { makeEnv, kdd, kddFail } from './run.js';

let env: NodeJS.ProcessEnv;
let ai: NodeJS.ProcessEnv;
beforeEach(() => {
  env = makeEnv();
  ai = { ...env, KDD_ACTOR: 'ai', KDD_SESSION: 's1' };
  kdd(env, 'add', 'Задача один');
  kdd(env, 'add', 'Задача два');
});

describe('move', () => {
  it('moves along matrix; ai skip needs --reason', () => {
    expect(kdd(ai, 'move', '#1', 'in_progress')).toContain('#1 → in_progress');
    const r = kddFail(ai, 'move', '#2', 'done');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('invalid transition');
    expect(kdd(ai, 'move', '#2', 'done', '--reason', 'просьба пользователя'))
      .toContain('#2 → done');
  });
});

describe('edit/comment/block/link/archive', () => {
  it('full verb roundtrip visible in show', () => {
    kdd(env, 'edit', '#1', '--priority', 'urgent', '--area', 'клиент');
    kdd(env, 'comment', '#1', 'первый коммент');
    kdd(env, 'block', '#1', 'жду бэк');
    kdd(env, 'link', '#1', '#2');
    const show = kdd(env, 'show', '#1');
    expect(show).toContain('priority: urgent');
    expect(show).toContain('BLOCKED: жду бэк');
    expect(show).toContain('первый коммент');
    expect(show).toContain('relates_to #2');
    kdd(env, 'unblock', '#1');
    kdd(env, 'archive', '#2');
    expect(kdd(env, 'board')).not.toContain('Задача два');
    expect(kdd(env, 'board', '--archived')).toContain('Задача два');
    kdd(env, 'unarchive', '#2');
    expect(kdd(env, 'board')).toContain('Задача два');
  });
});

describe('status/export/projects', () => {
  it('status shows sections, export dumps json', () => {
    kdd(env, 'move', '#1', 'in_progress');
    const s = kdd(env, 'status');
    expect(s).toContain('in_progress (1)');
    expect(s).toContain('recent:');
    const dump = JSON.parse(kdd(env, 'export'));
    expect(dump.tasks).toHaveLength(2);
    expect(kdd(env, 'projects')).toBeDefined(); // не падает при KDD_DB
  });
});

describe('task kind', () => {
  it('round-trips through add, show and edit', () => {
    const env = makeEnv();
    kdd(env, 'add', 'broken thing', '--kind', 'bug');
    expect(kdd(env, 'show', '1')).toContain('kind: bug');
    kdd(env, 'edit', '1', '--kind', 'chore');
    expect(kdd(env, 'show', '1')).toContain('kind: chore');
  });

  it('rejects a kind outside the vocabulary', () => {
    const env = makeEnv();
    const r = kddFail(env, 'add', 't', '--kind', 'epic');
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/invalid kind/);
  });

  it('marks non-feature rows on the board and stays quiet about feature', () => {
    const env = makeEnv();
    kdd(env, 'add', 'a feature');
    kdd(env, 'add', 'a bug', '--kind', 'bug');
    const board = kdd(env, 'board');
    expect(board).toContain('{bug}');
    expect(board).not.toContain('{feature}');
  });

  it('filters the board by kind', () => {
    const env = makeEnv();
    kdd(env, 'add', 'a feature');
    kdd(env, 'add', 'a bug', '--kind', 'bug');
    const only = kdd(env, 'board', '--kind', 'bug');
    expect(only).toContain('a bug');
    expect(only).not.toContain('a feature');
  });

  // Без этого typo в --kind шёл прямо в WHERE и молча печатал пять пустых колонок с exit 0 —
  // читается как «багов нет», хотя на самом деле опечатка. add с той же опечаткой уже падает.
  it('rejects an unknown --kind on board the same way add does', () => {
    const env = makeEnv();
    const r = kddFail(env, 'board', '--kind', 'bugs');
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/invalid kind/);
  });

  // Форма готовности у бага — воспроизведение, и она должна быть видна в момент заведения.
  it('seeds an empty bug body with the repro skeleton', () => {
    const env = makeEnv();
    kdd(env, 'add', 'a bug', '--kind', 'bug');
    const shown = kdd(env, 'show', '1');
    expect(shown).toContain('## Steps');
    expect(shown).toContain('## Expected');
    expect(shown).toContain('## Actual');
  });

  it('never overwrites a body the author actually wrote', () => {
    const env = makeEnv();
    kdd(env, 'add', 'a bug', '--kind', 'bug', '--body', 'crashes on start');
    const shown = kdd(env, 'show', '1');
    expect(shown).toContain('crashes on start');
    expect(shown).not.toContain('## Steps');
  });

  // Скелет — вещь момента создания. Переклассификация существующей задачи тело не трогает:
  // там уже может быть написанное человеком расследование.
  it('does not seed anything when an existing task is retyped as a bug', () => {
    const env = makeEnv();
    kdd(env, 'add', 'was a feature', '--body', 'original text');
    kdd(env, 'edit', '1', '--kind', 'bug');
    const shown = kdd(env, 'show', '1');
    expect(shown).toContain('original text');
    expect(shown).not.toContain('## Steps');
  });
});
