import type Database from 'better-sqlite3';
import { KddError } from './errors.js';
import { MIGRATIONS } from './schema.js';
import { projectOf } from './project_store.js';

export interface ControllerHandle { readonly kind: 'controller' }
const controllers = new WeakMap<object, Database.Database>();
export function controllerDb(handle: ControllerHandle): Database.Database {
  const db = typeof handle === 'object' && handle !== null ? controllers.get(handle) : undefined;
  if (!db?.open || db.pragma('user_version', { simple: true }) !== MIGRATIONS.length) {
    throw new KddError('controller authority denied');
  }
  return db;
}
export function openController(db: Database.Database): ControllerHandle {
  if (!db.open || db.pragma('user_version', { simple: true }) !== MIGRATIONS.length) {
    throw new KddError('controller authority denied');
  }
  projectOf(db);
  const handle = Object.freeze({ kind: 'controller' as const });
  controllers.set(handle, db);
  return handle;
}
