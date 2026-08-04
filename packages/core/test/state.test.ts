import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { agentId, checkMove, STATUSES, type Actor, type Status } from '../src/state.js';

const ADJACENT: Record<Status, Status[]> = {
  backlog: ['new'],
  new: ['backlog', 'in_progress'],
  in_progress: ['new', 'review'],
  review: ['in_progress', 'done'],
  done: ['review'],
};

describe('checkMove', () => {
  it('user may make any transition', () => {
    for (const from of STATUSES) for (const to of STATUSES) {
      if (from === to) continue;
      expect(checkMove(from, to, { type: 'user' }).ok).toBe(true);
    }
  });

  it('ai follows the matrix', () => {
    for (const from of STATUSES) for (const to of STATUSES) {
      if (from === to) continue;
      const res = checkMove(from, to, { type: 'ai' });
      expect(res.ok).toBe(ADJACENT[from].includes(to));
    }
  });

  it('ai may skip with a reason', () => {
    expect(checkMove('new', 'done', { type: 'ai' }, 'пропустили по просьбе пользователя').ok)
      .toBe(true);
  });

  it('same-status move is rejected for everyone', () => {
    const res = checkMove('new', 'new', { type: 'user' });
    expect(res).toEqual({ ok: false, error: 'task is already in new' });
  });

  it('ai skip without reason returns actionable error', () => {
    const res = checkMove('new', 'done', { type: 'ai' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe(
      'invalid transition new → done for ai; allowed: backlog, in_progress; pass a reason if the user requested a skip');
  });

  it('ai cannot move to review with unchecked criteria', () => {
    const res = checkMove('in_progress', 'review', { type: 'ai' }, undefined, 2);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/2 unchecked acceptance criteria/);
    // все отмечены → пропускает
    expect(checkMove('in_progress', 'review', { type: 'ai' }, undefined, 0).ok).toBe(true);
    // reason обходит гейт
    expect(checkMove('in_progress', 'review', { type: 'ai' }, 'user asked', 2).ok).toBe(true);
    // user не ограничен
    expect(checkMove('in_progress', 'review', { type: 'user' }, undefined, 2).ok).toBe(true);
    // гейт только на review — другие переходы не трогает
    expect(checkMove('new', 'in_progress', { type: 'ai' }, undefined, 2).ok).toBe(true);
  });

  // #117: review имеет смысл, только если принимает не тот, кто сдавал.
  describe('review → done', () => {
    const ai: Actor = { type: 'ai', id: 's1' };
    const done = (submittedBy: string | null, actor = ai, reason?: string) =>
      checkMove('review', 'done', actor, reason, 0, null, submittedBy);

    it('the actor who submitted does not accept on its own', () => {
      const res = done('ai:s1');
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/submitted this task for review yourself/);
    });

    // Гейт против молчаливого самозакрытия, не против просьбы: «закрой» словом должно работать.
    it('a reason opens it — the user asked out loud', () => {
      expect(done('ai:s1', ai, 'пользователь попросил закрыть').ok).toBe(true);
    });

    it('another actor accepts: a human, a second session', () => {
      expect(done('ai:s1', { type: 'user' }).ok).toBe(true);
      expect(done('ai:s1', { type: 'ai', id: 's2' }).ok).toBe(true);
      expect(done('user').ok).toBe(true);
    });

    it('an unknown submitter does not block', () => {
      expect(done(null).ok).toBe(true);
    });
  });
});

// Один агент — один автор, каким бы путём он ни писал (CLI, MCP). Разъехавшиеся id ломают сразу
// два правила: гейт самоприёмки обходится сменой транспорта, а fence по lease путает сессии.
describe('agentId', () => {
  const KEYS = ['KDD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID'] as const;
  const saved = {} as Record<string, string | undefined>;
  beforeEach(() => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it('KDD_SESSION wins: tick/worker подставляют его сами', () => {
    process.env.KDD_SESSION = 'tick:1-0';
    process.env.CLAUDE_CODE_SESSION_ID = 'abcdef12-3456';
    expect(agentId()).toBe('tick:1-0');
  });

  it('иначе короткий id сессии Claude Code', () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'abcdef12-3456-7890';
    expect(agentId()).toBe('cc:abcdef12');
  });

  it('без id сессии — pid: безымянный ai:? неотличим от другого такого же', () => {
    process.env.CLAUDE_PID = '41557';
    expect(agentId()).toBe('cc:pid-41557');
  });

  it('вне сессии — undefined', () => {
    expect(agentId()).toBeUndefined();
  });
});
