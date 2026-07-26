import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { openDb } from '@kddkit/core';
import { workerAlive, workerTag } from '../src/procs.js';
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

  it('--next picks the top task; prints a notice when the queue is empty', () => {
    kdd(env, 'add', 'a', '--criterion', 'done');
    expect(kdd(env, 'claim', '--next')).toMatch(/#1 claimed/);
    expect(kdd(env, 'claim', '--next')).toMatch(/no ready task/); // exit 0, informational
  });

  it('--renew extends a held lease', () => {
    kdd(env, 'add', 'a', '--criterion', 'done');
    kdd(env, 'claim', '1');
    expect(kdd(env, 'claim', '1', '--renew')).toMatch(/#1 renewed/);
  });

  // Core отказывается реклеймить tick-lease без killer'а. То, что CLI такую задачу всё же
  // забирает (воркера в `ps` нет -> killWorker='absent'), и доказывает, что killer прокинут.
  const expiredTickLease = (): void => {
    kdd(env, 'add', 'a', '--criterion', 'done');
    kdd({ ...env, KDD_ACTOR: 'ai', KDD_SESSION: 'tick:1-0' }, 'claim', '1');
    const db = openDb(env.KDD_DB!);
    db.prepare(`UPDATE tasks SET claim_expires = 1 WHERE id = 1`).run();
    db.close();
  };

  it('--next takes over an expired tick lease whose worker is gone', () => {
    expiredTickLease();
    expect(kdd(env, 'claim', '--next')).toMatch(/#1 claimed/);
  });

  it('claiming by id takes over an expired tick lease whose worker is gone', () => {
    expiredTickLease();
    expect(kdd(env, 'claim', '1')).toMatch(/#1 claimed/);
  });

  // A2 целиком: человек, забирающий задачу у истёкшего tick-лиза, обязан сначала остановить
  // её воркера. Иначе живой агент продолжает править ту же worktree и ту же ветку.
  it('--next kills the live worker of the lease it takes over', () => {
    expiredTickLease();
    const tag = workerTag(1, env.KDD_DB!);
    // стенд-воркер: метка в argv — ровно то, по чему его находит procs.findWorker
    const fake = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', tag],
      { detached: true, stdio: 'ignore' });
    fake.unref();
    try {
      for (let i = 0; i < 50 && !workerAlive(tag); i++) execFileSync('sleep', ['0.1']);
      expect(workerAlive(tag)).toBe(true);
      expect(kdd(env, 'claim', '--next')).toMatch(/#1 claimed/);
      expect(workerAlive(tag)).toBe(false);
    } finally {
      try { process.kill(-(fake.pid as number), 'SIGKILL'); } catch { /* уже мёртв */ }
    }
  }, 30_000);
});
