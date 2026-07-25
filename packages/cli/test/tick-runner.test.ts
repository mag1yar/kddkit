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
// dieOn — сигнал, на который этот child соглашается умереть; всё, что пришло раньше,
// он игнорирует. Так проверяется, что эскалация настоящая, а не «шлём оба сразу».
function makeHungChild(dieOn = 'SIGTERM') {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; kill: (signal: string) => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const signals: string[] = [];
  child.kill = (signal: string) => {
    signals.push(signal);
    // реальный сигнал асинхронно приводит к 'close' с code=null чуть позже — не синхронно
    if (signal === dieOn) setTimeout(() => child.emit('close', null), 0);
  };
  return { child, signals };
}

describe('createTickRunner', () => {
  it('kills a hung child after the timeout and resolves with an error TickRun', async () => {
    const { child, signals } = makeHungChild();
    const fakeSpawn = ((_cmd: string, _args: string[], _opts: unknown) => child) as
      unknown as typeof spawnProcess;

    const runner = createTickRunner('/fake/index.js', 20, fakeSpawn);
    const result = await runner({ dbPath: '/x/kdd.db', projectPath: '/x/repo', toplevel: null });

    expect(signals.length).toBeGreaterThan(0);
    expect(result.error).toMatch(/timeout/i);
    expect(result).toMatchObject({ reclaimed: 0, spawned: 0, active: 0, reaped: 0 });
  });

  // SIGKILL нельзя перехватить, а proper-lockfile снимает tick.lock через signal-exit.
  // Убитый сразу наглухо child оставил бы лок со свежим mtime, и следующие десять минут
  // и планировщик, и терминальный `kdd tick` получали бы ELOCKED.
  it('asks with SIGTERM first and only then escalates to SIGKILL', async () => {
    const { child, signals } = makeHungChild('SIGKILL'); // SIGTERM игнорирует
    const fakeSpawn = ((_cmd: string, _args: string[], _opts: unknown) => child) as
      unknown as typeof spawnProcess;

    const runner = createTickRunner('/fake/index.js', 10, fakeSpawn, 20);
    const result = await runner({ dbPath: '/x/kdd.db', projectPath: '/x/repo', toplevel: null });

    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(result.error).toMatch(/timeout/i);
  });

  it('a child that exits on SIGTERM is never SIGKILLed', async () => {
    const { child, signals } = makeHungChild('SIGTERM');
    const fakeSpawn = ((_cmd: string, _args: string[], _opts: unknown) => child) as
      unknown as typeof spawnProcess;

    const runner = createTickRunner('/fake/index.js', 10, fakeSpawn, 30);
    await runner({ dbPath: '/x/kdd.db', projectPath: '/x/repo', toplevel: null });
    await new Promise((r) => setTimeout(r, 60)); // переживаем окно эскалации

    expect(signals).toEqual(['SIGTERM']);
  });

  // project_path — это git common-dir: у submodule его родитель — <super>/.git/modules,
  // и тик бежал бы не в том репозитории.
  it('runs the child in the recorded toplevel, falling back to the common-dir parent', async () => {
    const cwds: unknown[] = [];
    const spawns: ReturnType<typeof makeHungChild>[] = [];
    const fakeSpawn = ((_cmd: string, _args: string[], opts: { cwd: string }) => {
      cwds.push(opts.cwd);
      const made = makeHungChild();
      spawns.push(made);
      queueMicrotask(() => made.child.emit('close', 0));
      return made.child;
    }) as unknown as typeof spawnProcess;

    const runner = createTickRunner('/fake/index.js', 5000, fakeSpawn);
    await runner({
      dbPath: '/x/kdd.db', projectPath: '/super/.git/modules/sub', toplevel: '/super/sub',
    });
    await runner({ dbPath: '/x/kdd.db', projectPath: '/repo/.git', toplevel: null });

    expect(cwds).toEqual(['/super/sub', '/repo']);
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
    const resultPromise = runner({ dbPath: '/x/kdd.db', projectPath: '/x/repo', toplevel: null });
    child.stdout.emit('data', Buffer.from(JSON.stringify({ reclaimed: 1, spawned: 0, active: 1, reaped: 0 })));
    child.emit('close', 0);
    const result = await resultPromise;

    expect(killed).toBe(false);
    expect(result).toMatchObject({ reclaimed: 1, spawned: 0, active: 1, reaped: 0 });
  });
});
