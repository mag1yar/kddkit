import { describe, it, expect } from 'vitest';
import { parseTickOutput } from '../src/tick-output.js';

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
