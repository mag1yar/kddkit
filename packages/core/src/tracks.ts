import { assertLegacyTaskMutation } from './authority.js';
import type Database from 'better-sqlite3';
import { now } from './db.js';
import { KddError } from './errors.js';
import type { Track } from './types.js';

// Track — ненормированная по времени группа задач ("use when…" в description
// служит роутером: Claude читает и решает, к какому track-у относится задача).
// Несколько active одновременно; complete не трогает задачи, память остаётся.

export function mustGetTrack(db: Database.Database, id: number): Track {
  const t = db.prepare(`SELECT * FROM tracks WHERE id = ?`).get(id) as Track | undefined;
  if (!t) throw new KddError(`track #${id} not found`);
  return t;
}

export function createTrack(
  db: Database.Database, input: { name: string; description?: string },
): Track {
  const name = input.name.trim();
  if (!name) throw new KddError('track name must not be empty');
  try {
    const r = db.prepare(
      `INSERT INTO tracks (name, description, created_at) VALUES (?, ?, ?)`,
    ).run(name, input.description ?? null, now());
    return mustGetTrack(db, Number(r.lastInsertRowid));
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw new KddError(`track '${name}' already exists`);
    throw e;
  }
}

export function editTrack(
  db: Database.Database, id: number,
  patch: { name?: string; description?: string; status?: 'active' | 'done' },
): Track {
  if (patch.status && patch.status !== 'active' && patch.status !== 'done') {
    throw new KddError(`invalid status '${patch.status}'; allowed: active, done`);
  }
  const fields = (Object.keys(patch) as (keyof typeof patch)[]).filter((k) => patch[k] !== undefined);
  if (fields.length === 0) throw new KddError('nothing to edit');
  mustGetTrack(db, id);
  try {
    db.prepare(`UPDATE tracks SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`)
      .run(...fields.map((f) => patch[f]), id);
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw new KddError(`track '${patch.name}' already exists`);
    throw e;
  }
  return mustGetTrack(db, id);
}

// Удаление track-а: задачи не трогаем (память остаётся), лишь отцепляем track_id.
export function deleteTrack(db: Database.Database, id: number): void {
  mustGetTrack(db, id);
  db.transaction(() => {
    const ids = (db.prepare('SELECT id FROM tasks WHERE track_id=?').all(id) as { id: number }[]).map(task => task.id);
    assertLegacyTaskMutation(db, ids);
    db.prepare(`UPDATE tasks SET track_id = NULL WHERE track_id = ?`).run(id);
    db.prepare(`DELETE FROM tracks WHERE id = ?`).run(id);
  }).immediate();
}

// Track-и с числом открытых (не archived, не done) задач — для CLI/UI/orientation.
export function listTracks(
  db: Database.Database, opts: { status?: 'active' | 'done' } = {},
): (Track & { open_tasks: number })[] {
  const where = opts.status ? `WHERE tr.status = @status` : '';
  return db.prepare(
    `SELECT tr.*, COUNT(t.id) AS open_tasks
     FROM tracks tr
     LEFT JOIN tasks t ON t.track_id = tr.id AND t.archived_at IS NULL AND t.status <> 'done'
     ${where}
     GROUP BY tr.id ORDER BY tr.status, tr.name`,
  ).all({ status: opts.status ?? null }) as (Track & { open_tasks: number })[];
}
