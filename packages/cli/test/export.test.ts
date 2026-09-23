import { describe, it, expect } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '@kddkit/core';
import { kdd, makeEnv } from './run.js';

describe('export CLI', () => {
  it('prints the versioned snapshot and keeps local provenance out in both modes', () => {
    const env = makeEnv();
    const db = openDb(env.KDD_DB!);
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz';
    db.prepare(`INSERT INTO tasks (id,title,created_at,updated_at)
      VALUES (1,?,100,100)`).run(secret);
    db.prepare(`INSERT INTO events (id,task_id,actor_type,action,detail,created_at)
      VALUES (1,1,'ai','edited',?,101)`).run(JSON.stringify({
        manual_provenance: { client: 'codex', session_id: 'session-142',
          worktree: '/private/tmp/export-private-worktree', branch: 'task/142-json-export',
          head_commit: 'abc123' },
      }));
    db.close();

    const safe = JSON.parse(kdd(env, 'export'));
    expect(Object.keys(safe)).toEqual([
      'schema_version', 'tasks', 'tracks', 'criteria', 'comments',
      'task_links', 'decisions', 'events', 'files',
    ]);
    expect(safe.schema_version).toBe(1);
    expect(safe.tasks[0].title).toBe('[redacted]');
    const sensitive = JSON.parse(kdd(env, 'export', '--include-sensitive'));
    expect(sensitive.tasks[0].title).toBe(secret);
    for (const snapshot of [safe, sensitive]) {
      expect(JSON.stringify(snapshot)).not.toContain('/private/tmp/export-private-worktree');
      expect(JSON.parse(snapshot.events[0].detail).manual_provenance).toEqual({
        client: 'codex', session_id: 'session-142', branch: 'task/142-json-export',
        head_commit: 'abc123',
      });
    }
  });

  it('matches the fixed v1 fixture byte for byte and retains all references', () => {
    const env = makeEnv();
    const db = openDb(env.KDD_DB!);
    db.exec(`
      INSERT INTO tracks (id,name,description,status,created_at)
        VALUES (1,'Continuity',NULL,'active',100);
      INSERT INTO tasks (id,title,body,status,priority,area,position,archived_at,
                         created_at,updated_at,track_id,claimed_by,claim_expires,failed_attempts)
        VALUES (2,'Archived',NULL,'done','medium',NULL,2,150,101,150,NULL,NULL,NULL,0),
               (1,'Current','Board body','in_progress','high','export',1,NULL,100,120,1,
                'user',999,2);
      INSERT INTO criteria (id,task_id,text,checked_at,evidence,checked_by,position,created_at)
        VALUES (1,1,'Export checked',110,'test passed','ai:review',0,102),
               (2,2,'Pending',NULL,NULL,NULL,0,103);
      INSERT INTO comments (id,task_id,author,body,created_at)
        VALUES (1,1,'user','Looks good',111);
      INSERT INTO task_links (from_id,to_id,kind) VALUES (2,1,'precedes');
      INSERT INTO events (id,task_id,actor_type,actor_id,action,detail,created_at,parent_id,type,level)
        VALUES (1,1,'user',NULL,'created',NULL,100,NULL,NULL,'info'),
               (3,NULL,'user',NULL,'legacy',NULL,114,NULL,NULL,'info');
      INSERT INTO files (id,task_id,sha256,ext,original_name,mime_type,size_bytes,description,created_at)
        VALUES (1,1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                'txt','note.txt','text/plain',4,'sample',112),
               (2,2,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                'bin','empty.bin',NULL,0,NULL,115);
    `);
    db.prepare(`INSERT INTO events (id,task_id,actor_type,actor_id,action,detail,
      created_at,parent_id,type,level) VALUES (2,1,'ai','codex:test','edited',?,113,1,NULL,'info')`)
      .run(JSON.stringify({ fields: ['body'], manual_provenance: {
        client: 'codex', session_id: 'session-142',
        worktree: '/private/tmp/export-private-worktree', branch: 'task/142-json-export',
        head_commit: 'abc123',
      } }));
    db.close();
    mkdirSync(env.KDD_DECISIONS_DIR!, { recursive: true });
    writeFileSync(join(env.KDD_DECISIONS_DIR!, '2026-09-23-choice.md'),
      '---\ncreated: 2026-09-23\nstatus: active\nsuperseded_by:\n' +
      'source_tasks: [1, 2]\n---\n# Choice\n\n## Decision\nUse v1\n');
    writeFileSync(join(env.KDD_DECISIONS_DIR!, 'legacy-choice.md'),
      '# Legacy choice\n\n## Decision\nKeep it\n');

    const expected = readFileSync(new URL('./fixtures/export-v1.json', import.meta.url), 'utf8');
    const first = kdd(env, 'export');
    expect(first).toBe(expected);
    expect(kdd(env, 'export')).toBe(first);
    const snapshot = JSON.parse(expected);
    const taskIds = new Set(snapshot.tasks.map((t: { id: number }) => t.id));
    const eventIds = new Set(snapshot.events.map((e: { id: number }) => e.id));
    for (const row of [...snapshot.criteria, ...snapshot.comments, ...snapshot.events,
      ...snapshot.files]) {
      if (row.task_id !== null) expect(taskIds.has(row.task_id)).toBe(true);
    }
    for (const row of snapshot.task_links) {
      expect(taskIds.has(row.from_id)).toBe(true);
      expect(taskIds.has(row.to_id)).toBe(true);
    }
    for (const row of snapshot.events) {
      if (row.parent_id !== null) expect(eventIds.has(row.parent_id)).toBe(true);
    }
    expect(snapshot.decisions[0].source_task_ids).toEqual([1, 2]);
    expect(snapshot.decisions[0].source_task_ids.every((id: number) => taskIds.has(id))).toBe(true);
    expect(snapshot.decisions[1].created).toBeNull();
    expect(snapshot.tasks[1].track_id).toBeNull();
    expect(snapshot.criteria[1]).toMatchObject({
      checked_at: null, evidence: null, checked_by: null,
    });
    expect(snapshot.events[2].task_id).toBeNull();
    expect(snapshot.files[0]).toMatchObject({ sha256: 'a'.repeat(64), size_bytes: 4 });
    expect(snapshot.files[0]).not.toHaveProperty('path');
    expect(snapshot.files[0]).not.toHaveProperty('content');
    expect(snapshot.files[1]).toMatchObject({ mime_type: null, description: null });
    for (const output of [first, kdd(env, 'export', '--include-sensitive')]) {
      for (const privateField of ['claimed_by', 'claim_expires', 'failed_attempts',
        '/private/tmp/export-private-worktree']) expect(output).not.toContain(privateField);
    }
  });
});
