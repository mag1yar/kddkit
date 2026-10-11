import type { Db } from './db.js';
import { now } from './db.js';

export class KddError extends Error {}

export function logError(db: Db, source: string, message: string): void {
  db.prepare(`INSERT INTO errors (source, message, created_at) VALUES (?, ?, ?)`)
    .run(source, message, now());
}
