import { describe, it, expect } from 'vitest';
import { openDb, setAutoTick } from '@kddkit/core';
import { makeEnv, kdd } from './run.js';

// Задача claimable только при наличии хотя бы одного критерия (definition of done),
// поэтому у каждой — `--criterion`.
const twoReadyTasks = (env: NodeJS.ProcessEnv): void => {
  kdd(env, 'add', 'first', '--criterion', 'c');
  kdd(env, 'add', 'second', '--criterion', 'c');
};

describe('kdd tick: max workers', () => {
  it('берёт значение из meta, когда env не выставлен', () => {
    const env = makeEnv();
    twoReadyTasks(env);
    const db = openDb(env.KDD_DB!);
    setAutoTick(db, { maxWorkers: 1 });
    db.close();
    env.KDD_SPAWN_CMD = 'true'; // вместо настоящего воркера — системный /usr/bin/true
    env.SHELL = '/bin/sh';
    delete env.KDD_MAX_WORKERS; // makeEnv наследует process.env: гасим утечку с машины разработчика
    const r = JSON.parse(kdd(env, 'tick', '--json')) as { spawned: number };
    expect(r.spawned).toBe(1);
  });

  it('env перебивает meta', () => {
    const env = makeEnv();
    twoReadyTasks(env);
    const db = openDb(env.KDD_DB!);
    setAutoTick(db, { maxWorkers: 1 });
    db.close();
    env.KDD_SPAWN_CMD = 'true';
    env.SHELL = '/bin/sh';
    env.KDD_MAX_WORKERS = '2';
    const r = JSON.parse(kdd(env, 'tick', '--json')) as { spawned: number };
    expect(r.spawned).toBe(2);
  });
});
