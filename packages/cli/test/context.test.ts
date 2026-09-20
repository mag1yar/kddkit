import { afterEach, describe, expect, it } from 'vitest';
import { getActor } from '../src/context.js';

const keys = ['KDD_ACTOR', 'CLAUDECODE', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID'] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
});

describe('getActor', () => {
  it('keeps ordinary and explicitly-user shells human', () => {
    for (const key of keys) delete process.env[key];
    expect(getActor()).toEqual({ type: 'user' });
    process.env.KDD_ACTOR = 'user';
    process.env.CODEX_SESSION_ID = 'codex-session';
    expect(getActor()).toEqual({ type: 'user' });
  });

  it('recognizes explicit, Claude, and Codex AI contexts', () => {
    for (const key of keys) delete process.env[key];
    process.env.KDD_ACTOR = 'ai';
    expect(getActor().type).toBe('ai');
    delete process.env.KDD_ACTOR;
    process.env.CLAUDECODE = '1';
    expect(getActor().type).toBe('ai');
    delete process.env.CLAUDECODE;
    process.env.CODEX_THREAD_ID = 'codex-thread';
    expect(getActor()).toEqual({ type: 'ai', id: 'codex:codex-thread' });
  });
});
