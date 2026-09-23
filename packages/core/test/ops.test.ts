import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { claimTask } from '../src/claim.js';
import { openDb } from '../src/db.js';
import { addTask, appendEvent, editTask, commentTask, moveTask } from '../src/ops.js';

let db: Database.Database;
beforeEach(() => { db = openDb(':memory:', 'p'); });
const user = { type: 'user' as const };
const ai = { type: 'ai' as const, id: 's1' };

describe('addTask', () => {
  it('creates with defaults and logs created event', () => {
    const t = addTask(db, { title: 'Первая' }, user);
    expect(t).toMatchObject({ id: 1, title: 'Первая', status: 'new', priority: 'medium' });
    const ev = db.prepare(`SELECT * FROM events WHERE task_id=1`).all();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ action: 'created', actor_type: 'user' });
  });

  it('rejects bad priority before touching db', () => {
    expect(() => addTask(db, { title: 't', priority: 'nope' as any }, user))
      .toThrow(/invalid priority/);
    expect(db.prepare(`SELECT COUNT(*) c FROM tasks`).get()).toEqual({ c: 0 });
  });
});

describe('editTask', () => {
  it('patches fields, bumps updated_at, logs changed keys', () => {
    addTask(db, { title: 'a' }, user);
    const t = editTask(db, 1, { title: 'b', area: 'договор' }, ai);
    expect(t).toMatchObject({ title: 'b', area: 'договор' });
    const ev: any = db.prepare(
      `SELECT detail, actor_type, actor_id FROM events WHERE action='edited'`).get();
    expect(JSON.parse(ev.detail).fields.sort()).toEqual(['area', 'title']);
    expect(ev).toMatchObject({ actor_type: 'ai', actor_id: 's1' });
  });

  it('unknown id → task #N not found', () => {
    expect(() => editTask(db, 99, { title: 'x' }, user)).toThrow('task #99 not found');
  });
});

describe('commentTask', () => {
  it('stores author-attributed comment + event in one tx', () => {
    addTask(db, { title: 'a' }, user);
    const c = commentTask(db, 1, 'привет', ai);
    expect(c).toMatchObject({ task_id: 1, author: 'ai:s1', body: 'привет' });
    expect(db.prepare(`SELECT COUNT(*) c FROM events WHERE action='commented'`).get())
      .toEqual({ c: 1 });
  });
});

describe('manual mutation provenance', () => {
  it('keeps full session identity separate from actor attribution and preserves event detail', () => {
    const task = addTask(db, { title: 'snapshot' }, user);
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: process.cwd(), encoding: 'utf8',
    }).trim();
    const actor = {
      type: 'ai' as const, id: 'cc:abcdef12',
      manualSession: { client: 'claude' as const, sessionId: 'abcdef12-3456-7890', cwd: process.cwd() },
    };
    const head = git('rev-parse', 'HEAD');
    editTask(db, task.id, { area: 'core' }, actor);
    const row = db.prepare("SELECT actor_id, detail FROM events WHERE action = 'edited'").get() as
      { actor_id: string; detail: string };
    expect(row.actor_id).toBe('cc:abcdef12');
    expect(JSON.parse(row.detail)).toEqual({
      fields: ['area'],
      manual_provenance: {
        client: 'claude',
        session_id: 'abcdef12-3456-7890',
        worktree: git('rev-parse', '--show-toplevel'),
        branch: git('symbolic-ref', '--quiet', '--short', 'HEAD'),
        head_commit: head,
      },
    });
    expect(git('rev-parse', 'HEAD')).toBe(head);
  });

  it('records known context without inventing a session or Git fields', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'kdd-nongit-'));
    try {
      writeFileSync(join(cwd, 'private-session.jsonl'), 'private transcript marker');
      const task = addTask(db, { title: 'no git' }, user);
      commentTask(db, task.id, 'done', {
        type: 'ai', id: 'mcp', manualSession: { client: 'codex', cwd },
      });
      const row = db.prepare("SELECT detail FROM events WHERE action = 'commented'").get() as
        { detail: string };
      expect(JSON.parse(row.detail)).toEqual({ manual_provenance: { client: 'codex' } });
      expect(row.detail).not.toContain('private transcript marker');
      expect(row.detail).not.toContain('private-session.jsonl');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('has no branch on detached HEAD and leaves failed/system events unstamped', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'kdd-detached-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    try {
      git('init', '--quiet');
      git('-c', 'user.name=Test', '-c', 'user.email=test@example.com',
        'commit', '--quiet', '--allow-empty', '-m', 'base');
      git('checkout', '--quiet', '--detach');
      const task = addTask(db, { title: 'detached' }, user);
      const actor = {
        type: 'ai' as const, id: 'codex:one',
        manualSession: { client: 'codex' as const, sessionId: 'one', cwd },
      };
      expect(() => moveTask(db, task.id, 'review', actor)).toThrow();
      expect(claimTask(db, task.id, actor).ok).toBe(false);
      appendEvent(db, task.id, { type: 'ai', id: 'system' }, 'reclaimed');
      editTask(db, task.id, { area: 'detached' }, actor);
      const rows = db.prepare('SELECT action, detail FROM events WHERE task_id = ? ORDER BY id')
        .all(task.id) as { action: string; detail: string | null }[];
      expect(rows[1].action).toBe('claim_rejected');
      expect(JSON.parse(rows[1].detail!)).not.toHaveProperty('manual_provenance');
      expect(rows[2]).toEqual({ action: 'reclaimed', detail: null });
      expect(JSON.parse(rows[3].detail!)).toEqual({
        fields: ['area'],
        manual_provenance: {
          client: 'codex', session_id: 'one',
          worktree: git('rev-parse', '--show-toplevel'), head_commit: git('rev-parse', 'HEAD'),
        },
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
