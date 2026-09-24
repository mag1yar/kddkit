import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eligible, noticeOnStartup, readUpdateCache, shouldRefresh } from '../src/update-notifier.js';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
}));

const now = 1_800_000_000_000;
let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kdd-notice-'));
  previousHome = process.env.KDD_HOME;
  process.env.KDD_HOME = home;
  vi.useFakeTimers();
  vi.setSystemTime(now);
  spawnMock.mockReset().mockImplementation(() => ({ on: vi.fn(), unref: vi.fn() }));
});

afterEach(() => {
  vi.useRealTimers();
  if (previousHome === undefined) delete process.env.KDD_HOME;
  else process.env.KDD_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function cache(latest: string | null, checkedAt: number): string {
  const path = join(home, 'update-check.json');
  writeFileSync(path, JSON.stringify({ latest, checkedAt }));
  return path;
}

describe('update notice cache', () => {
  it('reads valid cache and rejects malformed or partial JSON', () => {
    const path = cache('0.9.0', now - 1_000);
    expect(readUpdateCache(path)).toEqual({ latest: '0.9.0', checkedAt: now - 1_000 });
    writeFileSync(path, '{');
    expect(readUpdateCache(path)).toBeNull();
    writeFileSync(path, '{"latest":"0.9.0"}');
    expect(readUpdateCache(path)).toBeNull();
  });

  it('refreshes successful checks after 24 hours and failed checks after five minutes', () => {
    expect(shouldRefresh({ latest: '0.9.0', checkedAt: now - 1_000 }, now)).toBe(false);
    expect(shouldRefresh({ latest: '0.9.0', checkedAt: now - 24 * 60 * 60_000 }, now)).toBe(true);
    expect(shouldRefresh({ latest: null, checkedAt: now - 4 * 60_000 }, now)).toBe(false);
    expect(shouldRefresh({ latest: null, checkedAt: now - 5 * 60_000 }, now)).toBe(true);
    expect(shouldRefresh(null, now)).toBe(true);
  });

  it('prints one stderr line for a newer cached release without spawning', () => {
    cache('0.9.0', now - 1_000);
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    noticeOnStartup(['status'], {});
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith('kdd: v0.9.0 available; run kdd update\n');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('stays quiet for an equal or older cached release', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    cache('0.8.0', now - 1_000);
    noticeOnStartup(['status'], {});
    cache('0.7.0', now - 1_000);
    noticeOnStartup(['status'], {});
    expect(write).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('schedules a detached refresh on a miss and never waits for it', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    noticeOnStartup(['status'], {});
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock.mock.calls[0][0]).toBe(process.execPath);
    expect(spawnMock.mock.calls[0][1][0]).toMatch(/update-check-worker\.js$/);
    expect(spawnMock.mock.calls[0][2]).toMatchObject({ detached: true, stdio: 'ignore' });
    expect(write).not.toHaveBeenCalled();
    expect(existsSync(join(home, 'update-check.json'))).toBe(false);
  });
});

describe('notice eligibility', () => {
  it.each([
    [['show', '1', '--json'], {}],
    [['update'], {}],
    [['worker', '1'], {}],
    [['help', 'status'], {}],
    [['status', '--help'], {}],
    [['--version'], {}],
    [['status'], { CI: '1' }],
    [['status'], { CLAUDECODE: '1' }],
    [['status'], { CODEX_SESSION_ID: 'abc' }],
    [['status'], { KDD_ACTOR: 'ai' }],
    [['status'], { npm_command: 'exec' }],
    [['status'], { NO_UPDATE_NOTIFIER: '1' }],
  ] as const)('skips %j under %j', (argv, env) => {
    expect(eligible([...argv], env)).toBe(false);
  });

  it('allows an ordinary human command', () => {
    expect(eligible(['status'], {})).toBe(true);
  });
});
