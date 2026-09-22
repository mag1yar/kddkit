import { describe, expect, it } from 'vitest';
import {
  addTask, attentionData, blockTask, moveTask, now, openDb,
  type AttentionInbox,
} from '@kddkit/core';
import { renderAttention } from '../src/render.js';
import { kdd, makeEnv } from './run.js';

const user = { type: 'user' as const };

describe('kdd attention', () => {
  it('prints the core JSON from a fresh child process', () => {
    const env = makeEnv();
    const db = openDb(env.KDD_DB!, 'attention-cli');
    const review = addTask(db, { title: 'review API' }, user);
    moveTask(db, review.id, 'in_progress', user);
    moveTask(db, review.id, 'review', user);
    const task = addTask(db, { title: 'choose API' }, user);
    blockTask(db, task.id, 'needs human: choose API', user);
    const expected = attentionData(db, now());
    db.close();

    expect(expected.items.map(({ reason }) => reason)).toEqual(['needs_input', 'await_acceptance']);
    expect(kdd(env, 'attention', '--json')).toBe(`${JSON.stringify(expected)}\n`);
  });

  it('uses one line per item and stable reason codes', () => {
    const inbox: AttentionInbox = {
      items: [{
        id: 7,
        title: 'choose API',
        status: 'in_progress',
        reason: 'needs_input',
        block_reason: 'needs human: REST or RPC',
        last_activity: 123,
      }],
      omitted: 0,
    };

    expect(renderAttention(inbox)).toBe(
      '#7 [needs_input] choose API (in_progress) — needs human: REST or RPC',
    );
  });

  it('keeps embedded newlines in task text on one human-output line', () => {
    const inbox: AttentionInbox = {
      items: [{
        id: 8,
        title: 'choose\nAPI',
        status: 'new',
        reason: 'needs_input',
        block_reason: 'needs human: REST\r\nor RPC',
        last_activity: 123,
      }],
      omitted: 0,
    };
    expect(renderAttention(inbox)).toBe(
      '#8 [needs_input] choose API (new) — needs human: REST or RPC',
    );
  });

  it('renders empty and omitted states exactly', () => {
    expect(renderAttention({ items: [], omitted: 0 })).toBe('attention: none');
    expect(renderAttention({ items: [], omitted: 2 })).toBe('attention: none\n(+2 omitted)');
  });
});
