import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { KddError } from './errors.js';

export interface DecisionInput {
  title: string;
  decision?: string;
  rationale?: string;
  alternatives?: string;
  outcome?: string;
  supersedes?: string; // slug решения, которое заменяем
  body?: string;       // полное md-тело; взаимоисключимо с секционными флагами
  sourceTasks?: number[];
}

export interface ParsedDecision {
  title: string;
  created: string;
  status: string;        // 'active' | 'superseded' (неизвестные значения проходят как есть)
  supersededBy: string;  // '' если active
  indexBody: string;     // всё ниже строки "# title"
  hash: string;
  sourceTasks: number[];
}

export function slugify(title: string): string {
  const s = title.toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return s || 'untitled';
}

const normalize = (s: string): string => s.replace(/\r\n/g, '\n').trim();

export function contentHash(title: string, body: string): string {
  return createHash('sha256')
    .update(`${normalize(title)}\n${normalize(body)}`)
    .digest('hex');
}

export function normalizeSourceTasks(ids: number[] = []): number[] {
  for (const id of ids) {
    if (!Number.isInteger(id) || id < 1) throw new KddError(`invalid source task id '${id}'`);
  }
  return [...new Set(ids)].sort((a, b) => a - b);
}

function parseSourceTasks(value: string | undefined): number[] {
  if (value === undefined) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new KddError('invalid source_tasks frontmatter'); }
  if (!Array.isArray(parsed)) throw new KddError('invalid source_tasks frontmatter');
  try { return normalizeSourceTasks(parsed as number[]); }
  catch { throw new KddError('invalid source_tasks frontmatter'); }
}

export function renderDecisionBody(input: DecisionInput): string {
  if (input.body !== undefined) return normalize(input.body);
  const sec = (name: string, v?: string) => `## ${name}\n${normalize(v ?? '') || '-'}`;
  return [
    sec('Decision', input.decision),
    sec('Rationale', input.rationale),
    sec('Alternatives', input.alternatives),
    sec('Supersedes', input.supersedes),
    sec('Outcome', input.outcome),
  ].join('\n\n');
}

export function renderDecisionMd(input: DecisionInput, created: string): string {
  const sources = normalizeSourceTasks(input.sourceTasks);
  return `---\ncreated: ${created}\nstatus: active\nsuperseded_by:\n` +
    `source_tasks: [${sources.join(', ')}]\n---\n` +
    `# ${input.title.trim()}\n\n${renderDecisionBody(input)}\n`;
}

export function parseDecisionMd(raw: string): ParsedDecision {
  const text = raw.replace(/\r\n/g, '\n');
  const fm: Record<string, string> = {};
  let rest = text;
  if (text.startsWith('---\n')) {
    const end = text.indexOf('\n---\n', 4);
    if (end !== -1) {
      for (const line of text.slice(4, end).split('\n')) {
        const m = line.match(/^(\w+):\s*(.*)$/);
        if (m) fm[m[1]] = m[2].trim();
      }
      rest = text.slice(end + 5);
    }
  }
  const tm = rest.match(/^# (.+)$/m);
  const title = tm ? tm[1].trim() : '';
  const indexBody = tm
    ? rest.slice(rest.indexOf(tm[0]) + tm[0].length).trim()
    : rest.trim();
  return {
    title,
    created: fm.created ?? '',
    status: fm.status || 'active',
    supersededBy: fm.superseded_by ?? '',
    indexBody,
    hash: contentHash(title, indexBody),
    sourceTasks: parseSourceTasks(fm.source_tasks),
  };
}

function supersede(db: Database.Database, dir: string, oldSlug: string, newSlug: string): void {
  const p = join(dir, `${oldSlug}.md`);
  if (!existsSync(p)) throw new KddError(`decision '${oldSlug}' not found`);
  let raw = readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  if (raw.startsWith('---\n') && /^status:/m.test(raw)) {
    raw = raw
      .replace(/^status:.*$/m, 'status: superseded')
      .replace(/^superseded_by:.*$/m, `superseded_by: ${newSlug}`);
  } else {
    // рукописный файл без frontmatter — добавляем, чтобы sync не потерял флаг
    const doc = parseDecisionMd(raw);
    raw = `---\ncreated: ${doc.created}\nstatus: superseded\nsuperseded_by: ${newSlug}\n---\n${raw}`;
  }
  writeFileSync(p, raw);
  db.prepare(`UPDATE decisions SET superseded_by = ? WHERE slug = ?`).run(newSlug, oldSlug);
}

export function addDecision(
  db: Database.Database, decisionsDir: string, input: DecisionInput,
): { slug: string; path: string; created: boolean } {
  if (!input.title.trim()) throw new KddError('title must not be empty');
  if (input.body !== undefined &&
      [input.decision, input.rationale, input.alternatives, input.outcome]
        .some((v) => v !== undefined)) {
    throw new KddError('--body is mutually exclusive with section flags');
  }
  const sourceTasks = normalizeSourceTasks(input.sourceTasks);
  for (const id of sourceTasks) {
    if (!db.prepare(`SELECT 1 FROM tasks WHERE id = ?`).get(id)) {
      throw new KddError(`task #${id} not found`);
    }
  }
  const body = renderDecisionBody(input);
  const hash = contentHash(input.title, body);
  const provenance = JSON.stringify(sourceTasks);
  let fileDup: { slug: string; path: string } | undefined;
  if (existsSync(decisionsDir)) {
    for (const file of readdirSync(decisionsDir).filter((name) => name.endsWith('.md')).sort()) {
      const path = join(decisionsDir, file);
      const doc = parseDecisionMd(readFileSync(path, 'utf8'));
      if (doc.hash !== hash) continue;
      const slug = file.slice(0, -3);
      if (JSON.stringify(doc.sourceTasks) !== provenance) {
        throw new KddError(`decision '${slug}' provenance mismatch`);
      }
      fileDup ??= { slug, path };
    }
  }
  if (fileDup) return { ...fileDup, created: false };

  const dup = db.prepare(`SELECT slug, path FROM decisions WHERE content_hash = ?`)
    .get(hash) as { slug: string; path: string } | undefined;
  if (dup) {
    const existing = parseDecisionMd(readFileSync(dup.path, 'utf8')).sourceTasks;
    if (JSON.stringify(existing) !== provenance) {
      throw new KddError(`decision '${dup.slug}' provenance mismatch`);
    }
    return { slug: dup.slug, path: dup.path, created: false };
  }

  const date = new Date().toISOString().slice(0, 10);
  const base = `${date}-${slugify(input.title)}`;
  let slug = base;
  const taken = (s: string): boolean =>
    existsSync(join(decisionsDir, `${s}.md`)) ||
    !!db.prepare(`SELECT 1 FROM decisions WHERE slug = ?`).get(s);
  for (let i = 2; taken(slug); i++) slug = `${base}-${i}`;
  const path = join(decisionsDir, `${slug}.md`);

  return db.transaction(() => {
    if (input.supersedes) supersede(db, decisionsDir, input.supersedes, slug);
    mkdirSync(decisionsDir, { recursive: true });
    writeFileSync(path, renderDecisionMd({ ...input, sourceTasks }, date));
    db.prepare(
      `INSERT INTO decisions (slug, title, path, content_hash, created, superseded_by, source_tasks)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).run(slug, input.title.trim(), path, hash, date, provenance);
    db.prepare(
      `INSERT INTO search_index (kind, ref, title, body) VALUES ('decision', ?, ?, ?)`,
    ).run(slug, input.title.trim(), body);
    return { slug, path, created: true };
  })();
}
