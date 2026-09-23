import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { CAPS } from './caps.js';
import { KddError } from './errors.js';
import { parseDecisionMd } from './decisions.js';

export function syncIndex(db: Database.Database, decisionsDir: string): void {
  db.transaction(() => {
    // решения: истина — файловая система
    const files = existsSync(decisionsDir)
      ? readdirSync(decisionsDir).filter((f) => f.endsWith('.md'))
      : [];
    const inDb = new Map(
      (db.prepare(
        `SELECT slug, path, content_hash, created, superseded_by, source_tasks FROM decisions`,
      ).all() as {
        slug: string; path: string; content_hash: string; created: string | null;
        superseded_by: string | null; source_tasks: string;
      }[])
        .map((r) => [r.slug, r]),
    );
    const seen = new Set<string>();
    for (const f of files) {
      const slug = f.slice(0, -3);
      seen.add(slug);
      const path = join(decisionsDir, f);
      const doc = parseDecisionMd(readFileSync(path, 'utf8'));
      const title = doc.title || slug;
      const supersededBy =
        doc.status === 'superseded' ? (doc.supersededBy || '?') : (doc.supersededBy || null);
      const sourceTasks = JSON.stringify(doc.sourceTasks);
      const row = inDb.get(slug);
      if (row && row.content_hash === doc.hash &&
          (row.superseded_by ?? null) === (supersededBy ?? null)) {
        if (row.path !== path || row.source_tasks !== sourceTasks ||
            row.created !== (doc.created || null)) {
          db.prepare(`UPDATE decisions SET path = ?, source_tasks = ?, created = ? WHERE slug = ?`)
            .run(path, sourceTasks, doc.created || null, slug);
        }
        continue;
      }
      db.prepare(`DELETE FROM search_index WHERE kind='decision' AND ref = ?`).run(slug);
      db.prepare(
        `INSERT OR REPLACE INTO decisions
           (slug, title, path, content_hash, created, superseded_by, source_tasks)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(slug, title, path, doc.hash, doc.created || null, supersededBy, sourceTasks);
      db.prepare(
        `INSERT INTO search_index (kind, ref, title, body) VALUES ('decision', ?, ?, ?)`,
      ).run(slug, title, doc.indexBody);
    }
    for (const slug of inDb.keys()) {
      if (seen.has(slug)) continue;
      db.prepare(`DELETE FROM decisions WHERE slug = ?`).run(slug);
      db.prepare(`DELETE FROM search_index WHERE kind='decision' AND ref = ?`).run(slug);
    }

    // задачи: журнал изменений — events
    const last = Number(
      (db.prepare(`SELECT value FROM meta WHERE key='fts_last_event_id'`).get() as
        { value: string } | undefined)?.value ?? '0',
    );
    const max = (db.prepare(`SELECT MAX(id) AS m FROM events`).get() as { m: number | null }).m ?? 0;
    if (max <= last) return;
    const ids = db.prepare(
      `SELECT DISTINCT task_id AS id FROM events WHERE id > ? AND task_id IS NOT NULL`,
    ).all(last) as { id: number }[];
    const getTask = db.prepare(`SELECT * FROM tasks WHERE id = ?`);
    const getComments = db.prepare(`SELECT body FROM comments WHERE task_id = ? ORDER BY id`);
    for (const { id } of ids) {
      db.prepare(`DELETE FROM search_index WHERE kind='task' AND ref = ?`).run(String(id));
      const t = getTask.get(id) as
        { title: string; body: string | null; archived_at: number | null } | undefined;
      if (!t || t.archived_at) continue;
      const body = [t.body ?? '', ...(getComments.all(id) as { body: string }[]).map((c) => c.body)]
        .filter(Boolean).join('\n');
      db.prepare(
        `INSERT INTO search_index (kind, ref, title, body) VALUES ('task', ?, ?, ?)`,
      ).run(String(id), t.title, body);
    }
    db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('fts_last_event_id', ?)`)
      .run(String(max));
  })();
}

export interface RecallHit {
  kind: 'decision' | 'task';
  ref: string;
  title: string;
  snippet: string;
  superseded_by: string; // '' если active
  status: string | null; // статус задачи, null для решений
}

// Свободный текст → консервативный FTS5 MATCH: слова и "фразы", операторы мертвы.
export function sanitizeQuery(q: string): string {
  const parts: string[] = [];
  for (const m of q.matchAll(/"([^"]+)"|[\p{L}\p{N}_][\p{L}\p{N}_.-]*/gu)) {
    const raw = m[1] !== undefined ? m[1].trim() : m[0].replace(/^[._-]+|[._-]+$/g, '');
    if (raw) parts.push(`"${raw.replace(/"/g, '""')}"`);
  }
  if (parts.length === 0) throw new KddError('empty query');
  return parts.join(' ');
}

export function recall(
  db: Database.Database, decisionsDir: string, query: string,
  opts: { k?: number; kind?: 'decision' | 'task' } = {},
): RecallHit[] {
  if (opts.kind && opts.kind !== 'decision' && opts.kind !== 'task') {
    throw new KddError(`invalid kind '${opts.kind}'; allowed: decision, task`);
  }
  const k = opts.k ?? CAPS.recallK;
  if (!Number.isInteger(k) || k < 1 || k > CAPS.recallKMax) {
    throw new KddError(`k must be 1..${CAPS.recallKMax}`);
  }
  syncIndex(db, decisionsDir);
  return db.prepare(`
    SELECT search_index.kind AS kind, search_index.ref AS ref,
      search_index.title AS title,
      snippet(search_index, 3, '', '', '...', ${CAPS.recallSnippetTokens}) AS snippet,
      COALESCE(d.superseded_by, '') AS superseded_by,
      t.status AS status
    FROM search_index
    LEFT JOIN decisions d ON search_index.kind = 'decision' AND d.slug = search_index.ref
    LEFT JOIN tasks t ON search_index.kind = 'task' AND t.id = CAST(search_index.ref AS INTEGER)
    WHERE search_index MATCH @q
      AND (@kind IS NULL OR search_index.kind = @kind)
    ORDER BY (COALESCE(d.superseded_by, '') <> ''),
      bm25(search_index, 0, 0, 3.0, 1.0)
    LIMIT @k
  `).all({
    q: sanitizeQuery(query), kind: opts.kind ?? null, k,
  }) as RecallHit[];
}

export function rebuild(
  db: Database.Database, decisionsDir: string,
): { decisions: number; tasks: number } {
  db.transaction(() => {
    db.exec(`DELETE FROM search_index; DELETE FROM decisions;`);
    db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('fts_last_event_id', '0')`).run();
  })();
  syncIndex(db, decisionsDir);
  return {
    decisions: (db.prepare(`SELECT COUNT(*) c FROM decisions`).get() as { c: number }).c,
    tasks: (db.prepare(`SELECT COUNT(*) c FROM search_index WHERE kind='task'`).get() as
      { c: number }).c,
  };
}
