import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '@kddkit/core';
import { kdd, kddFail, makeEnv } from './run.js';

let env: NodeJS.ProcessEnv;
beforeEach(() => { env = makeEnv(); });

describe('kdd claim', () => {
  it('claims a ready task with a criterion and moves it to in_progress', () => {
    kdd(env, 'add', 'task', '--criterion', 'done');
    const out = kdd(env, 'claim', '1');
    expect(out).toMatch(/#1 claimed/);
    expect(kdd(env, 'show', '1', '--json')).toMatch(/"status":"in_progress"/);
  });

  it('rejects claiming a task with no criteria', () => {
    kdd(env, 'add', 'no-crit');
    const r = kddFail(env, 'claim', '1');
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no acceptance criteria/);
  });

  it('--renew extends a held lease', () => {
    kdd(env, 'add', 'a', '--criterion', 'done');
    kdd(env, 'claim', '1');
    expect(kdd(env, 'claim', '1', '--renew')).toMatch(/#1 renewed/);
    const events = JSON.parse(kdd(env, 'show', '1', '--json')).events;
    expect(events.some((e: { action: string }) => e.action === 'claim_renewed')).toBe(true);
  });

  it('claiming by id takes over an expired lease', () => {
    kdd(env, 'add', 'a', '--criterion', 'done');
    kdd({ ...env, KDD_ACTOR: 'ai', KDD_SESSION: 'other-session' }, 'claim', '1');
    const db = openDb(env.KDD_DB!);
    db.prepare(`UPDATE tasks SET claim_expires = 1 WHERE id = 1`).run();
    db.close();
    expect(kdd(env, 'claim', '1')).toMatch(/#1 claimed/);
  });

  it('claim requires an id', () => {
    const r = kddFail(env, 'claim');
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/missing required argument 'id'/);
  });
});
