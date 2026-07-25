import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type { spawn as spawnProcess } from 'node:child_process';
import { parseTickOutput } from '../src/tick-output.js';
import { createTickRunner } from '../src/tick-runner.js';

describe('parseTickOutput', () => {
  it('normal result object', () => {
    const r = parseTickOutput(
      JSON.stringify({ reclaimed: 1, spawned: 2, active: 3, reaped: 4 }), '', 0, 100);
    expect(r).toEqual({ at: 100, reclaimed: 1, spawned: 2, active: 3, reaped: 4 });
  });

  it('{"skipped":true} → skipped, not an error (a held lock is not a failure)', () => {
    const r = parseTickOutput(JSON.stringify({ skipped: true }), '', 0, 100);
    expect(r).toEqual({ at: 100, reclaimed: 0, spawned: 0, active: 0, reaped: 0, skipped: true });
  });

  it('output that is not JSON at all → error, code 0', () => {
    const r = parseTickOutput('not json', '', 0, 100);
    expect(r.error).toMatch(/unparsable tick output/);
    expect(r).toMatchObject({ at: 100, reclaimed: 0, spawned: 0, active: 0, reaped: 0 });
  });

  it('output that is the literal null → error, not a crash on r.skipped', () => {
    const r = parseTickOutput('null', '', 0, 100);
    expect(r.error).toMatch(/unparsable tick output/);
  });

  it('valid JSON but an array → error, not treated as a result object', () => {
    const r = parseTickOutput('[1,2,3]', '', 0, 100);
    expect(r.error).toMatch(/unparsable tick output/);
  });

  it('valid JSON but a string → error, not treated as a result object', () => {
    const r = parseTickOutput('"hello"', '', 0, 100);
    expect(r.error).toMatch(/unparsable tick output/);
  });

  it('non-zero exit, stdout carries {"error":"..."} → uses stdout error over stderr/code', () => {
    const r = parseTickOutput(
      JSON.stringify({ error: 'KDD_MAX_WORKERS must be a positive integer' }),
      'some unrelated stderr noise', 1, 100);
    expect(r.error).toBe('KDD_MAX_WORKERS must be a positive integer');
  });

  it('non-zero exit, only stderr → uses trimmed stderr', () => {
    const r = parseTickOutput('', '  boom  \n', 1, 100);
    expect(r.error).toBe('boom');
  });

  it('non-zero exit, neither stdout error nor stderr → falls back to exit-code message', () => {
    const r = parseTickOutput('', '', 1, 100);
    expect(r.error).toBe('kdd tick exited with code 1');
  });

  it('missing numeric fields default to 0', () => {
    const r = parseTickOutput('{}', '', 0, 100);
    expect(r).toEqual({ at: 100, reclaimed: 0, spawned: 0, active: 0, reaped: 0 });
  });

  it('at is passed through in seconds, not derived internally', () => {
    const r = parseTickOutput('{}', '', 0, 1700000000);
    expect(r.at).toBe(1700000000);
  });
});

// Фейковый child_process: никогда сам не эмиттит close/error, пока его явно не kill()-нут —
// имитирует зависший `git worktree remove --force` внутри sweepWorktrees на упавшей сетевой
// mount. Не мок-библиотека, обычный EventEmitter, тот же приём, что spawn: SpawnFn в core/driver.
function makeHungChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; kill: (signal: string) => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let killed = false;
  child.kill = () => {
    killed = true;
    // реальный SIGKILL асинхронно приводит к 'close' с code=null чуть позже — не синхронно
    setTimeout(() => child.emit('close', null), 0);
  };
  return { child, wasKilled: () => killed };
}

describe('createTickRunner', () => {
  it('kills a hung child after the timeout and resolves with an error TickRun', async () => {
    const { child, wasKilled } = makeHungChild();
    const fakeSpawn = ((_cmd: string, _args: string[], _opts: unknown) => child) as
      unknown as typeof spawnProcess;

    const runner = createTickRunner('/fake/index.js', 20, fakeSpawn);
    const result = await runner({ dbPath: '/x/kdd.db', projectPath: '/x/repo' });

    expect(wasKilled()).toBe(true);
    expect(result.error).toMatch(/timeout/i);
    expect(result).toMatchObject({ reclaimed: 0, spawned: 0, active: 0, reaped: 0 });
  });

  it('a child that closes before the timeout is not killed', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter; stderr: EventEmitter; kill: (signal: string) => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let killed = false;
    child.kill = () => { killed = true; };
    const fakeSpawn = ((_cmd: string, _args: string[], _opts: unknown) => child) as
      unknown as typeof spawnProcess;

    const runner = createTickRunner('/fake/index.js', 5000, fakeSpawn);
    const resultPromise = runner({ dbPath: '/x/kdd.db', projectPath: '/x/repo' });
    child.stdout.emit('data', Buffer.from(JSON.stringify({ reclaimed: 1, spawned: 0, active: 1, reaped: 0 })));
    child.emit('close', 0);
    const result = await resultPromise;

    expect(killed).toBe(false);
    expect(result).toMatchObject({ reclaimed: 1, spawned: 0, active: 1, reaped: 0 });
  });
});
