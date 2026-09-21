import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { addTask, archiveTask } from '../src/ops.js';
import {
  addDecision, slugify, contentHash, renderDecisionMd, parseDecisionMd,
} from '../src/decisions.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'kdd-dec-'));
const user = { type: 'user' as const };

describe('slugify', () => {
  it('lowercases and dashes non-alphanumerics', () => {
    expect(slugify('Use FTS5, not embeddings!')).toBe('use-fts5-not-embeddings');
  });
  it('keeps unicode letters (russian titles)', () => {
    expect(slugify('Использовать FTS5')).toBe('использовать-fts5');
  });
  it('falls back to untitled', () => {
    expect(slugify('!!!')).toBe('untitled');
  });
  it('caps at 60 chars', () => {
    expect(slugify('a'.repeat(100)).length).toBe(60);
  });
});

describe('contentHash', () => {
  it('is stable across CRLF and trailing whitespace', () => {
    expect(contentHash('t', 'a\r\nb\n')).toBe(contentHash('t', 'a\nb'));
  });
  it('differs on content change', () => {
    expect(contentHash('t', 'a')).not.toBe(contentHash('t', 'b'));
  });
});

describe('render + parse roundtrip', () => {
  it('renders all five sections with - for empty ones', () => {
    const md = renderDecisionMd(
      { title: 'use fts5', decision: 'FTS5 BM25', rationale: 'zero deps' }, '2026-07-14');
    expect(md).toContain(
      '---\ncreated: 2026-07-14\nstatus: active\nsuperseded_by:\nsource_tasks: []\n---');
    expect(md).toContain('# use fts5');
    expect(md).toContain('## Decision\nFTS5 BM25');
    expect(md).toContain('## Rationale\nzero deps');
    expect(md).toContain('## Alternatives\n-');
    expect(md).toContain('## Supersedes\n-');
    expect(md).toContain('## Outcome\n-');
  });

  it('round-trips sorted unique source tasks without changing the content hash', () => {
    const sourced = renderDecisionMd(
      { title: 'use fts5', decision: 'FTS5', sourceTasks: [4, 2, 4] }, '2026-07-14');
    const plain = renderDecisionMd({ title: 'use fts5', decision: 'FTS5' }, '2026-07-14');
    expect(sourced).toContain('source_tasks: [2, 4]');
    expect(parseDecisionMd(sourced).sourceTasks).toEqual([2, 4]);
    expect(parseDecisionMd(sourced).hash).toBe(parseDecisionMd(plain).hash);
  });

  it('defaults a missing source_tasks field but rejects a malformed present value', () => {
    expect(parseDecisionMd('# old decision\n\nbody').sourceTasks).toEqual([]);
    const malformed = '---\nsource_tasks: [2,"x"]\n---\n# bad\n\nbody';
    expect(() => parseDecisionMd(malformed)).toThrow(/source_tasks/);
  });

  it('parse extracts frontmatter, title and index body; hash matches render input', () => {
    const md = renderDecisionMd({ title: 'use fts5', decision: 'FTS5' }, '2026-07-14');
    const doc = parseDecisionMd(md);
    expect(doc.title).toBe('use fts5');
    expect(doc.created).toBe('2026-07-14');
    expect(doc.status).toBe('active');
    expect(doc.supersededBy).toBe('');
    expect(doc.indexBody).toContain('FTS5');
    // хэш не зависит от frontmatter: тот же контент, другая дата => тот же хэш
    const md2 = renderDecisionMd({ title: 'use fts5', decision: 'FTS5' }, '2027-01-01');
    expect(parseDecisionMd(md2).hash).toBe(doc.hash);
  });

  it('parses a hand-written file without frontmatter', () => {
    const doc = parseDecisionMd('# manual note\n\nsome context here');
    expect(doc.title).toBe('manual note');
    expect(doc.status).toBe('active');
    expect(doc.indexBody).toBe('some context here');
  });

  it('uses body verbatim when DecisionInput.body is set', () => {
    const md = renderDecisionMd({ title: 't', body: 'free-form **md**' }, '2026-07-14');
    expect(md).toContain('free-form **md**');
    expect(md).not.toContain('## Decision');
  });
});

describe('addDecision', () => {
  it('creates a dated md file and a decisions row', () => {
    const db = openDb(':memory:', 'x');
    const dir = tmp();
    const source = addTask(db, { title: 'source' }, user);
    const r = addDecision(db, dir, {
      title: 'use fts5', decision: 'FTS5', rationale: 'deps', sourceTasks: [source.id],
    });
    expect(r.created).toBe(true);
    expect(r.slug).toMatch(/^\d{4}-\d{2}-\d{2}-use-fts5$/);
    expect(existsSync(r.path)).toBe(true);
    expect(readFileSync(r.path, 'utf8')).toContain('## Decision\nFTS5');
    const row = db.prepare(`SELECT * FROM decisions WHERE slug = ?`).get(r.slug) as any;
    expect(row.title).toBe('use fts5');
    expect(row.source_tasks).toBe(`[${source.id}]`);
    const idx = db.prepare(
      `SELECT * FROM search_index WHERE kind='decision' AND ref = ?`).get(r.slug);
    expect(idx).toBeTruthy();
  });

  it('accepts archived source tasks because they still exist', () => {
    const db = openDb(':memory:', 'x');
    const source = addTask(db, { title: 'archived source' }, user);
    archiveTask(db, source.id, user);
    const r = addDecision(db, tmp(), {
      title: 'from history', decision: 'keep it', sourceTasks: [source.id],
    });
    expect(r.created).toBe(true);
  });

  it('validates every source before file, supersede, or database changes', () => {
    const db = openDb(':memory:', 'x');
    const dir = tmp();
    const existing = addTask(db, { title: 'exists' }, user);
    const old = addDecision(db, dir, { title: 'old way', decision: 'x' });

    expect(() => addDecision(db, dir, {
      title: 'new way', decision: 'y', supersedes: old.slug,
      sourceTasks: [existing.id, 999],
    })).toThrow(/task #999 not found/);
    expect(readFileSync(old.path, 'utf8')).toContain('status: active');
    expect(readdirSync(dir)).toEqual([`${old.slug}.md`]);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM decisions`).get()).toEqual({ count: 1 });
  });

  it('same content twice returns created=false and writes nothing new', () => {
    const db = openDb(':memory:', 'x');
    const dir = tmp();
    const a = addDecision(db, dir, { title: 'use fts5', decision: 'FTS5' });
    const b = addDecision(db, dir, { title: 'use fts5', decision: 'FTS5' });
    expect(b.created).toBe(false);
    expect(b.slug).toBe(a.slug);
    expect(readdirSync(dir).length).toBe(1);
  });

  it('compares duplicate provenance as a normalized set', () => {
    const db = openDb(':memory:', 'x');
    const dir = tmp();
    const one = addTask(db, { title: 'one' }, user);
    const two = addTask(db, { title: 'two' }, user);
    const a = addDecision(db, dir, {
      title: 'use fts5', decision: 'FTS5', sourceTasks: [two.id, one.id, two.id],
    });
    const b = addDecision(db, dir, {
      title: 'use fts5', decision: 'FTS5', sourceTasks: [one.id, two.id],
    });
    expect(b).toEqual({ slug: a.slug, path: a.path, created: false });
  });

  it('rejects duplicate content with different provenance without side effects', () => {
    const db = openDb(':memory:', 'x');
    const dir = tmp();
    const one = addTask(db, { title: 'one' }, user);
    const two = addTask(db, { title: 'two' }, user);
    const first = addDecision(db, dir, {
      title: 'use fts5', decision: 'FTS5', sourceTasks: [one.id],
    });
    const before = readFileSync(first.path, 'utf8');

    expect(() => addDecision(db, dir, {
      title: 'use fts5', decision: 'FTS5', sourceTasks: [two.id],
    })).toThrow(/provenance mismatch/);
    expect(readFileSync(first.path, 'utf8')).toBe(before);
    expect(readdirSync(dir)).toEqual([`${first.slug}.md`]);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM decisions`).get()).toEqual({ count: 1 });
  });

  it('checks canonical Markdown for duplicates before it reaches the index', () => {
    const db = openDb(':memory:', 'x');
    const dir = tmp();
    const one = addTask(db, { title: 'one' }, user);
    const two = addTask(db, { title: 'two' }, user);
    writeFileSync(join(dir, 'manual.md'), renderDecisionMd({
      title: 'use fts5', decision: 'FTS5', sourceTasks: [one.id],
    }, '2026-09-20'));

    expect(() => addDecision(db, dir, {
      title: 'use fts5', decision: 'FTS5', sourceTasks: [two.id],
    })).toThrow(/provenance mismatch/);
    expect(readdirSync(dir)).toEqual(['manual.md']);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM decisions`).get()).toEqual({ count: 0 });
  });

  it('same title different content appends -2', () => {
    const db = openDb(':memory:', 'x');
    const dir = tmp();
    const a = addDecision(db, dir, { title: 'use fts5', decision: 'one' });
    const b = addDecision(db, dir, { title: 'use fts5', decision: 'two' });
    expect(b.created).toBe(true);
    expect(b.slug).toBe(`${a.slug}-2`);
  });

  it('supersedes rewrites the old file frontmatter and db row', () => {
    const db = openDb(':memory:', 'x');
    const dir = tmp();
    const old = addDecision(db, dir, { title: 'old way', decision: 'x' });
    const neu = addDecision(db, dir, { title: 'new way', decision: 'y', supersedes: old.slug });
    const oldRaw = readFileSync(old.path, 'utf8');
    expect(oldRaw).toContain('status: superseded');
    expect(oldRaw).toContain(`superseded_by: ${neu.slug}`);
    const row = db.prepare(`SELECT superseded_by FROM decisions WHERE slug = ?`)
      .get(old.slug) as any;
    expect(row.superseded_by).toBe(neu.slug);
  });

  it('does not inherit source tasks when superseding', () => {
    const db = openDb(':memory:', 'x');
    const dir = tmp();
    const source = addTask(db, { title: 'source' }, user);
    const old = addDecision(db, dir, {
      title: 'old way', decision: 'x', sourceTasks: [source.id],
    });
    const neu = addDecision(db, dir, {
      title: 'new way', decision: 'y', supersedes: old.slug,
    });
    expect(parseDecisionMd(readFileSync(neu.path, 'utf8')).sourceTasks).toEqual([]);
  });

  it('supersedes with unknown slug throws and creates nothing', () => {
    const db = openDb(':memory:', 'x');
    const dir = tmp();
    expect(() => addDecision(db, dir, { title: 't', decision: 'd', supersedes: 'nope' }))
      .toThrow(/not found/);
    expect(existsSync(dir) ? readdirSync(dir).length : 0).toBe(0);
  });

  it('body and section flags are mutually exclusive', () => {
    const db = openDb(':memory:', 'x');
    expect(() => addDecision(db, tmp(), { title: 't', body: 'b', decision: 'd' }))
      .toThrow(/mutually exclusive/);
  });

  it('empty title throws', () => {
    const db = openDb(':memory:', 'x');
    expect(() => addDecision(db, tmp(), { title: '  ' })).toThrow(/title/);
  });
});
