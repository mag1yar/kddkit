import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { addDecision } from '../src/decisions.js';
import { recall, rebuild, sanitizeQuery, syncIndex } from '../src/recall.js';
import { addTask, commentTask, archiveTask } from '../src/ops.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'kdd-rec-'));
const user = { type: 'user' } as const;

const idxCount = (db: any, kind: string) =>
  (db.prepare(`SELECT COUNT(*) c FROM search_index WHERE kind = ?`).get(kind) as any).c;

describe('syncIndex — decisions', () => {
  it('indexes an md file dropped into the dir by hand', () => {
    const db = openDb(':memory:', 'x');
    const dir = tmp();
    writeFileSync(join(dir, '2026-07-14-manual.md'),
      '---\ncreated: 2026-07-14\nstatus: active\nsuperseded_by:\n---\n# manual note\n\nponytail wisdom');
    syncIndex(db, dir);
    expect(idxCount(db, 'decision')).toBe(1);
    const row = db.prepare(`SELECT title FROM decisions WHERE slug='2026-07-14-manual'`).get() as any;
    expect(row.title).toBe('manual note');
  });

  it('removes deleted files from the index', () => {
    const db = openDb(':memory:', 'x');
    const dir = tmp();
    const r = addDecision(db, dir, { title: 'temp', decision: 'x' });
    syncIndex(db, dir);
    rmSync(r.path);
    syncIndex(db, dir);
    expect(idxCount(db, 'decision')).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) c FROM decisions`).get()).toEqual({ c: 0 });
  });

  it('reindexes a file edited by hand (hash change)', () => {
    const db = openDb(':memory:', 'x');
    const dir = tmp();
    const r = addDecision(db, dir, { title: 'evolve', decision: 'v1' });
    writeFileSync(r.path,
      '---\ncreated: 2026-07-14\nstatus: active\nsuperseded_by:\n---\n# evolve\n\n## Decision\nv2-zanzibar');
    syncIndex(db, dir);
    const hit = db.prepare(
      `SELECT ref FROM search_index WHERE search_index MATCH '"zanzibar"'`).get() as any;
    expect(hit.ref).toBe(r.slug);
  });

  it('updates source tasks when only provenance changes', () => {
    const db = openDb(':memory:', 'x');
    const dir = tmp();
    const one = addTask(db, { title: 'one' }, user);
    const two = addTask(db, { title: 'two' }, user);
    const r = addDecision(db, dir, {
      title: 'same content', decision: 'unchanged', sourceTasks: [one.id],
    });
    writeFileSync(r.path, readFileSync(r.path, 'utf8')
      .replace(`source_tasks: [${one.id}]`, `source_tasks: [${one.id}, ${two.id}]`));

    syncIndex(db, dir);

    expect(db.prepare(`SELECT source_tasks FROM decisions WHERE slug = ?`).get(r.slug))
      .toEqual({ source_tasks: `[${one.id},${two.id}]` });
  });

  it('missing decisions dir is fine (zero decisions)', () => {
    const db = openDb(':memory:', 'x');
    expect(() => syncIndex(db, join(tmp(), 'nope'))).not.toThrow();
    expect(idxCount(db, 'decision')).toBe(0);
  });
});

describe('syncIndex — tasks via events', () => {
  it('indexes task title, body and comments incrementally', () => {
    const db = openDb(':memory:', 'x');
    const dir = tmp();
    const t = addTask(db, { title: 'wire the flux capacitor', body: 'needs plutonium' }, user);
    syncIndex(db, dir);
    expect(idxCount(db, 'task')).toBe(1);
    commentTask(db, t.id, 'gigawatts confirmed', user);
    syncIndex(db, dir);
    const row = db.prepare(
      `SELECT body FROM search_index WHERE kind='task' AND ref = ?`).get(String(t.id)) as any;
    expect(row.body).toContain('plutonium');
    expect(row.body).toContain('gigawatts');
  });

  it('archived tasks drop out of the index', () => {
    const db = openDb(':memory:', 'x');
    const dir = tmp();
    const t = addTask(db, { title: 'obsolete' }, user);
    syncIndex(db, dir);
    archiveTask(db, t.id, user);
    syncIndex(db, dir);
    expect(idxCount(db, 'task')).toBe(0);
  });

  it('is incremental: second sync with no new events touches nothing', () => {
    const db = openDb(':memory:', 'x');
    const dir = tmp();
    addTask(db, { title: 'once' }, user);
    syncIndex(db, dir);
    const before = db.prepare(`SELECT value FROM meta WHERE key='fts_last_event_id'`).get();
    syncIndex(db, dir);
    expect(db.prepare(`SELECT value FROM meta WHERE key='fts_last_event_id'`).get())
      .toEqual(before);
    expect(idxCount(db, 'task')).toBe(1);
  });
});

describe('recall', () => {
  it('finds a decision immediately after decide, ranked by BM25', () => {
    const db = openDb(':memory:', 'x');
    const dir = tmp();
    addDecision(db, dir, { title: 'use fts5 for recall', decision: 'BM25 wins' });
    addTask(db, { title: 'unrelated chore' }, user);
    const hits = recall(db, dir, 'fts5');
    expect(hits.length).toBe(1);
    expect(hits[0].kind).toBe('decision');
    expect(hits[0].title).toBe('use fts5 for recall');
    expect(hits[0].snippet.length).toBeGreaterThan(0);
  });

  it('finds tasks and reports their status', () => {
    const db = openDb(':memory:', 'x');
    const dir = tmp();
    addTask(db, { title: 'fix flux capacitor' }, user);
    const hits = recall(db, dir, 'capacitor');
    expect(hits[0].kind).toBe('task');
    expect(hits[0].status).toBe('new');
  });

  it('superseded decisions sort after active ones and carry the flag', () => {
    const db = openDb(':memory:', 'x');
    const dir = tmp();
    const old = addDecision(db, dir, { title: 'polling approach', decision: 'poll the api' });
    addDecision(db, dir,
      { title: 'websocket approach', decision: 'poll no more, stream the api', supersedes: old.slug });
    const hits = recall(db, dir, 'api');
    expect(hits.length).toBe(2);
    expect(hits[0].superseded_by).toBe('');
    expect(hits[1].superseded_by).not.toBe('');
  });

  it('kind filter limits results', () => {
    const db = openDb(':memory:', 'x');
    const dir = tmp();
    addDecision(db, dir, { title: 'shared word alpha', decision: 'alpha' });
    addTask(db, { title: 'alpha task' }, user);
    expect(recall(db, dir, 'alpha', { kind: 'decision' }).every((h) => h.kind === 'decision')).toBe(true);
    expect(recall(db, dir, 'alpha', { kind: 'task' }).every((h) => h.kind === 'task')).toBe(true);
  });

  it('k caps the result count', () => {
    const db = openDb(':memory:', 'x');
    const dir = tmp();
    for (let i = 0; i < 5; i++) addTask(db, { title: `omega item ${i}` }, user);
    expect(recall(db, dir, 'omega', { k: 3 }).length).toBe(3);
  });

  it('invalid k throws instead of bypassing the cap', () => {
    const db = openDb(':memory:', 'x');
    const dir = tmp();
    addTask(db, { title: 'omega' }, user);
    for (const k of [-1, 0, 51, 1.5, NaN]) {
      expect(() => recall(db, dir, 'omega', { k })).toThrow(/k must be 1\.\.50/);
    }
  });

  it('raw FTS syntax cannot crash recall', () => {
    const db = openDb(':memory:', 'x');
    const dir = tmp();
    expect(() => recall(db, dir, 'AND OR ("* NEAR')).not.toThrow();
  });

  it('empty query throws KddError', () => {
    const db = openDb(':memory:', 'x');
    expect(() => recall(db, tmp(), '   ')).toThrow(/empty query/);
  });

  it('invalid kind throws KddError', () => {
    const db = openDb(':memory:', 'x');
    expect(() => recall(db, tmp(), 'q', { kind: 'bogus' as any })).toThrow(/kind/);
  });
});

describe('rebuild', () => {
  it('restores the full index from md files after db loss', () => {
    const db1 = openDb(':memory:', 'x');
    const dir = tmp();
    addDecision(db1, dir, { title: 'survives db loss', decision: 'md is truth' });
    addDecision(db1, dir, { title: 'second decision', decision: 'also survives' });
    db1.close();
    const db2 = openDb(':memory:', 'x'); // "потерянная" база: новая пустая
    addTask(db2, { title: 'a task too' }, user);
    const counts = rebuild(db2, dir);
    expect(counts).toEqual({ decisions: 2, tasks: 1 });
    expect(recall(db2, dir, 'survives').length).toBe(2);
  });

  it('restores decision source tasks from markdown', () => {
    const db = openDb(':memory:', 'x');
    const dir = tmp();
    const source = addTask(db, { title: 'source' }, user);
    const decision = addDecision(db, dir, {
      title: 'linked', decision: 'keep provenance', sourceTasks: [source.id],
    });
    db.prepare(`UPDATE decisions SET source_tasks = '[]' WHERE slug = ?`).run(decision.slug);

    rebuild(db, dir);

    expect(db.prepare(`SELECT source_tasks FROM decisions WHERE slug = ?`).get(decision.slug))
      .toEqual({ source_tasks: `[${source.id}]` });
  });
});

describe('sanitizeQuery', () => {
  it('quotes every token', () => {
    expect(sanitizeQuery('hello world')).toBe('"hello" "world"');
  });
  it('preserves quoted phrases', () => {
    expect(sanitizeQuery('say "hi there" now')).toBe('"say" "hi there" "now"');
  });
  it('kills FTS5 operators and survives garbage', () => {
    expect(sanitizeQuery("don't NEAR(x) c++ *")).toBe('"don" "t" "NEAR" "x" "c"');
    expect(sanitizeQuery('foo "unbalanced')).toBe('"foo" "unbalanced"');
    expect(() => sanitizeQuery('*** :^ ()')).toThrow(/empty query/);
  });
});
