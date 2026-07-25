import { describe, it, expect } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, chmodSync, mkdirSync, utimesSync } from 'node:fs';
import lockfile from 'proper-lockfile';
import { openDb, projectToplevelOf } from '@kddkit/core';
import { makeEnv, kdd, BIN } from './run.js';

const TICK_LOCK_STALE = 10 * 60 * 1000; // mirrors index.ts's tick lock staleness window

describe('kdd tick', () => {
  it('spawns a worker for a ready task via KDD_SPAWN_CMD, cwd = toplevel (not .git)', () => {
    const env = makeEnv();
    kdd(env, 'add', 'do-it', '--criterion', 'c');
    kdd(env, 'criteria', 'check', '1', '1');
    const marker = join(dirname(env.KDD_DB!), 'spawned.txt');
    env.KDD_SPAWN_CMD = `printf '%s|%s' "$KDD_TASK_ID" "$PWD" > ${marker}`;
    env.KDD_MAX_WORKERS = '1';
    env.SHELL = '/bin/sh';
    const out = kdd(env, 'tick');
    expect(out).toMatch(/spawned 1/);

    const show = kdd(env, 'show', '1', '--json');
    expect(JSON.parse(show).task.status).toBe('in_progress');

    // detached grandchild finishes shortly after the parent CLI process exits — poll for it
    for (let i = 0; i < 10; i++) {
      try { if (readFileSync(marker, 'utf8').startsWith('1|')) break; } catch { /* not written yet */ }
      execFileSync('sleep', ['0.2']);
    }
    const written = readFileSync(marker, 'utf8');
    expect(written).toMatch(/^1\|/);
    expect(written).not.toContain('/.git');
  });

  it('default spawn pins the worker to process.execPath (not login-shell node)', () => {
    const env = makeEnv();
    kdd(env, 'add', 't', '--criterion', 'c');
    kdd(env, 'criteria', 'check', '1', '1');
    const marker = join(dirname(env.KDD_DB!), 'cmd.txt');
    // фейковый $SHELL: пишет свою -lc-строку ($2) вместо запуска — так виден DEFAULT_SPAWN_CMD
    const fakeShell = join(dirname(env.KDD_DB!), 'shell.sh');
    writeFileSync(fakeShell, `#!/bin/sh\nprintf '%s' "$2" > ${marker}\n`);
    chmodSync(fakeShell, 0o755);
    env.SHELL = fakeShell;
    env.KDD_MAX_WORKERS = '1';
    delete env.KDD_SPAWN_CMD; // именно DEFAULT, не override
    const out = kdd(env, 'tick');
    expect(out).toMatch(/spawned 1/);

    let cmd = '';
    for (let i = 0; i < 10; i++) {
      try { cmd = readFileSync(marker, 'utf8'); if (cmd) break; } catch { /* not written yet */ }
      execFileSync('sleep', ['0.2']);
    }
    expect(cmd).toContain(process.execPath); // node процесса tick, не резолв из login-shell
    expect(cmd).toMatch(/worker "\$KDD_TASK_ID"$/); // и по-прежнему зовёт воркера
  });

  it('overlapping tick is a no-op (lock held)', () => {
    const env = makeEnv();
    const target = join(dirname(env.KDD_DB!), 'tick');
    const release = lockfile.lockSync(target, { stale: TICK_LOCK_STALE, realpath: false });
    try {
      const out = kdd(env, 'tick');
      expect(out).toMatch(/locked/);
    } finally {
      release();
    }
  });

  it('steals a stale lock and proceeds', () => {
    const env = makeEnv();
    kdd(env, 'add', 't', '--criterion', 'c');
    kdd(env, 'criteria', 'check', '1', '1');

    // simulate a crashed tick: lock dir left behind, mtime older than the stale window
    const lockDir = join(dirname(env.KDD_DB!), 'tick.lock');
    mkdirSync(lockDir);
    const staleDate = new Date(Date.now() - TICK_LOCK_STALE - 60 * 1000);
    utimesSync(lockDir, staleDate, staleDate);

    const marker = join(dirname(env.KDD_DB!), 'spawned.txt');
    env.KDD_SPAWN_CMD = `printf '%s' "$KDD_TASK_ID" > ${marker}`;
    env.KDD_MAX_WORKERS = '1';
    env.SHELL = '/bin/sh';
    const out = kdd(env, 'tick');
    expect(out).toMatch(/spawned 1/);
  });

  it('async spawn error (bad $SHELL) does not crash tick', () => {
    const env = makeEnv();
    kdd(env, 'add', 'y', '--criterion', 'c');
    kdd(env, 'criteria', 'check', '1', '1');
    env.SHELL = '/no/such/shell';
    env.KDD_MAX_WORKERS = '1';
    const out = kdd(env, 'tick'); // throws (execFileSync) if the process crashed
    expect(out).toMatch(/^tick:/);
  });

  // Настоящий cwd этого процесса — сам репозиторий kddkit, resolveToplevel() честно
  // резолвит его через git. Такой tick вправе записать результат в meta.
  it('a user-run tick records project_toplevel in meta', () => {
    const env = makeEnv();
    kdd(env, 'tick');
    const db = openDb(env.KDD_DB!);
    expect(projectToplevelOf(db)).not.toBeNull();
  });

  // KDD_TICK_SPAWNED — маркер, который tick-runner.ts ставит на child'а, поднятого
  // планировщиком: его cwd может быть fallback-догадкой (dirname(project_path) для
  // submodule/--separate-git-dir/bare-репо с worktree), а не настоящим toplevel. Если бы
  // такой tick писал meta, неверная догадка становилась бы постоянной без ручного вмешательства.
  it('a scheduler-spawned tick (KDD_TICK_SPAWNED) does not record project_toplevel', () => {
    const env = makeEnv();
    env.KDD_TICK_SPAWNED = '1';
    kdd(env, 'tick');
    const db = openDb(env.KDD_DB!);
    expect(projectToplevelOf(db)).toBeNull();
  });

  it('--watch loops (≥2 passes) and exits 0 on SIGINT', async () => {
    const env = makeEnv(); // пустая доска → каждый проход безвреден (reclaimed 0, spawned 0)
    const child = spawn('node', [BIN, 'tick', '--watch', '--interval', '0.2'],
      { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout!.on('data', (d) => { out += String(d); });
    await new Promise((r) => setTimeout(r, 800)); // ~3 прохода при 0.2s
    child.kill('SIGINT');
    const code: number = await new Promise((r) => child.on('exit', (c) => r(c ?? -1)));
    expect((out.match(/tick: reclaimed/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(out).toMatch(/^\[.+Z\] tick: /m); // watch-строки со штампом
    expect(code).toBe(0);
  });
});
