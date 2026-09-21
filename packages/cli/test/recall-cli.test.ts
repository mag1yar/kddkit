import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { makeEnv, kdd } from './run.js';
import { kddFail } from './run.js';

describe('kdd decide', () => {
  it('creates a decision and prints the slug', { timeout: 60_000 }, () => {
    const env = makeEnv();
    const out = kdd(env, 'decide', 'use fts5', '--decision', 'BM25', '--rationale', 'zero deps');
    expect(out).toMatch(/^decided: \d{4}-\d{2}-\d{2}-use-fts5/);
    expect(readdirSync(env.KDD_DECISIONS_DIR!).length).toBe(1);
  });

  it('same content twice prints already recorded', { timeout: 60_000 }, () => {
    const env = makeEnv();
    kdd(env, 'decide', 'use fts5', '--decision', 'BM25');
    const out = kdd(env, 'decide', 'use fts5', '--decision', 'BM25');
    expect(out).toMatch(/^already recorded: /);
    expect(readdirSync(env.KDD_DECISIONS_DIR!).length).toBe(1);
  });

  it('--json returns slug and created flag', { timeout: 60_000 }, () => {
    const env = makeEnv();
    const r = JSON.parse(kdd(env, 'decide', 't', '--decision', 'd', '--json'));
    expect(r.created).toBe(true);
    expect(r.slug).toContain('-t');
  });

  it('shows the source tasks section when provenance is empty', { timeout: 60_000 }, () => {
    const env = makeEnv();
    const created = JSON.parse(kdd(env, 'decide', 'no sources', '--decision', 'x', '--json'));

    expect(kdd(env, 'decision', created.slug)).toContain('source tasks (0):');
  });

  it('records repeatable source tasks and exposes both detail directions', { timeout: 60_000 }, () => {
    const env = makeEnv();
    const one = JSON.parse(kdd(env, 'add', 'first source', '--json'));
    const two = JSON.parse(kdd(env, 'add', 'second source', '--json'));
    const created = JSON.parse(kdd(env, 'decide', 'linked choice', '--decision', 'x',
      '--source-task', String(two.id), '--source-task', String(one.id), '--json'));

    const detail = JSON.parse(kdd(env, 'decision', created.slug, '--json'));
    expect(detail.source_tasks.map((t: { id: number }) => t.id)).toEqual([one.id, two.id]);
    expect(kdd(env, 'decision', created.slug)).toContain('source tasks (2):');

    expect(JSON.parse(kdd(env, 'show', String(one.id), '--json')).decisions[0].slug)
      .toBe(created.slug);
    expect(kdd(env, 'show', String(two.id))).toContain(`decision ${created.slug}`);
  });

  it('rejects an unknown source before creating a decision file', { timeout: 60_000 }, () => {
    const env = makeEnv();
    const failed = kddFail(env, 'decide', 'invalid source', '--decision', 'x',
      '--source-task', '999');
    expect(failed.stderr).toContain('task #999 not found');
    expect(existsSync(env.KDD_DECISIONS_DIR!)).toBe(false);
  });
});

describe('kdd recall / rebuild', () => {
  it('decide then recall roundtrip', { timeout: 60_000 }, () => {
    const env = makeEnv();
    kdd(env, 'decide', 'use fts5 everywhere', '--decision', 'BM25 ranking wins');
    const out = kdd(env, 'recall', 'fts5');
    expect(out).toMatch(/^decision \S+ use fts5 everywhere — /m);
  });

  it('recall finds tasks with status', { timeout: 60_000 }, () => {
    const env = makeEnv();
    kdd(env, 'add', 'fix flux capacitor');
    const out = kdd(env, 'recall', 'capacitor');
    expect(out).toMatch(/^task #1 \[new\] fix flux capacitor — /m);
  });

  it('no hits prints no results with exit 0', { timeout: 60_000 }, () => {
    const env = makeEnv();
    expect(kdd(env, 'recall', 'zanzibar').trim()).toBe('no results');
  });

  it('rebuild restores decisions after db deletion', { timeout: 60_000 }, () => {
    const env = makeEnv();
    kdd(env, 'decide', 'survives loss', '--decision', 'md is the truth');
    rmSync(env.KDD_DB!);
    const out = kdd(env, 'rebuild');
    expect(out.trim()).toBe('rebuilt: 1 decisions, 0 tasks indexed');
    expect(kdd(env, 'recall', 'survives')).toContain('survives loss');
  });
});
