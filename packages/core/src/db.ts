import { createRequire } from 'node:module';
import type { DatabaseSyncOptions, StatementResultingChanges } from 'node:sqlite';

// Node 22 печатает ExperimentalWarning при первой загрузке node:sqlite — в stderr каждого
// запуска kdd, MCP и UI. Фильтр ставится ДО загрузки модуля, поэтому node:sqlite берём через
// require, а не статическим import: тот поднялся бы выше фильтра. Глушим только этот warning.
// Две копии core в одном процессе (CLI + бандл плагина) в одном тике: вторая не оборачивает
// фильтр первой — иначе приняла бы его за оригинал, и первая уже не смогла бы вернуть настоящий.
const FILTER = Symbol.for('kddkit.sqliteWarningFilter');
const emit = process.emit;
const ours = (emit as unknown as Record<symbol, unknown>)[FILTER] === true;
const filtered = function (this: NodeJS.Process, name: string | symbol, ...args: unknown[]): boolean {
  const w = args[0] as { name?: unknown; message?: unknown } | undefined;
  if (name === 'warning' && w?.name === 'ExperimentalWarning' && /SQLite/.test(String(w.message))) return false;
  return (emit as (this: NodeJS.Process, ...a: unknown[]) => boolean).call(this, name, ...args);
} as typeof process.emit;
(filtered as unknown as Record<symbol, unknown>)[FILTER] = true;
if (!ours) process.emit = filtered;
// engines is only an npm warning; plugins run whatever node is on PATH. Below 22.16 node:sqlite
// is missing (<22.13) or lacks `timeout`, `isTransaction` — busy timeout 0, nested transactions
// BEGIN inside BEGIN. 23.x is EOL with the same gaps by minor. A plain Error, not KddError:
// this runs at import, and depending on errors.js being evaluated first is an ordering trap.
{
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 16) || major === 23)
    throw new Error(`kddkit needs Node >= 22.16 (running ${process.version})`);
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
// The warning is emitted on process.nextTick, which runs before setImmediate — so by then it has
// been swallowed and the filter can go: a library consumer importing core must not keep a patched
// process.emit for its whole life. Only restore if nobody wrapped emit on top of us meanwhile.
setImmediate(() => { if (process.emit === filtered) process.emit = emit; });

// Row types: callers cast rows in place (`as Task`). node:sqlite types rows as
// Record<string, SQLOutputValue>, which does not cast to interfaces — keep `unknown` like before.
export interface Statement {
  run(...params: unknown[]): StatementResultingChanges;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

function settle<T>(r: T): T {
  if (r && typeof (r as { then?: unknown }).then === 'function')
    throw new TypeError('Transaction function cannot return a promise');
  return r;
}

class Connection extends DatabaseSync {
  #depth = 0;

  // busy_timeout в node:sqlite по умолчанию 0: второй процесс (UI, MCP, терминал) падал бы на
  // первой же чужой записи вместо того, чтобы подождать.
  constructor(path: string, options: DatabaseSyncOptions = {}) {
    super(path, { timeout: 5000, ...options });
    this.#path = path === ':memory:' || path === '' ? path : resolve(path);
  }

  // Absolute (a relative KDD_DB would otherwise give relative attachment paths) but with symlinks
  // kept — not location(): that resolves them (a symlinked KDD_DB would put attachments next to the
  // target, while the CLI uses the link) and throws after close().
  readonly #path: string;
  get name(): string { return this.#path; }
  get memory(): boolean { return this.#path === ':memory:' || this.#path === ''; }

  pragma(sql: string, options?: { simple?: boolean }): unknown {
    const stmt = super.prepare(`PRAGMA ${sql}`);
    if (!options?.simple) return stmt.all();
    const row = stmt.get();
    return row === undefined ? undefined : Object.values(row)[0];
  }

  // Plain call is IMMEDIATE: almost every transaction here reads then writes (checkMove, CAS,
  // supersede), and a DEFERRED one that upgrades to a write after another connection committed
  // fails SQLITE_BUSY at once, bypassing busy_timeout. Taking the write lock up front makes it wait
  // instead. `.immediate()` is the same, kept for existing call sites; read-only snapshots use
  // `.deferred()` so they never queue behind a writer.
  transaction<T>(fn: () => T): (() => T) & { immediate: () => T; deferred: () => T } {
    const immediate = () => this.#run(fn, 'BEGIN IMMEDIATE');
    return Object.assign(immediate, { immediate, deferred: () => this.#run(fn, 'BEGIN') });
  }

  // Inside an open transaction every form becomes a savepoint: the outer lock mode already holds.
  #run<T>(fn: () => T, begin: string): T {
    if (this.isTransaction) {
      const sp = `kdd_sp_${++this.#depth}`;
      this.exec(`SAVEPOINT ${sp}`);
      try {
        const r = settle(fn());
        this.exec(`RELEASE ${sp}`);
        return r;
      } catch (e) {
        try { this.exec(`ROLLBACK TO ${sp}`); this.exec(`RELEASE ${sp}`); } catch { /* outer already rolled back */ }
        throw e;
      } finally { this.#depth--; }
    }
    this.exec(begin);
    try {
      const r = settle(fn());
      this.exec('COMMIT');
      return r;
    } catch (e) {
      // SQLite may have rolled back on its own (e.g. a constraint with ON CONFLICT ROLLBACK).
      if (this.isTransaction) try { this.exec('ROLLBACK'); } catch { /* keep the original error */ }
      throw e;
    }
  }

  close(): void { if (this.isOpen) super.close(); }
}

export type Db = Omit<Connection, 'prepare'> & { prepare(sql: string): Statement };
export const Db = Connection as unknown as new (path: string, options?: DatabaseSyncOptions) => Db;

import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { KddError } from './errors.js';
import { initializeProjectStore, canonicalProjectPath, canonicalCommonDir, primarySource, projectOf } from './project_store.js';
import { homedir } from 'node:os';
import { MIGRATIONS } from './schema.js';
export { MIGRATIONS } from './schema.js';

export const now = (): number => Math.floor(Date.now() / 1000);

// Копия базы перед миграцией. VACUUM INTO, а не copyFile: она пишет один консистентный файл,
// вобравший незачекпойнченный WAL, — обычное копирование под чужой активной сессией дало бы
// половину транзакции. Своё имя на каждую исходную версию: апгрейд через две версии оставит
// два файла, и откатываться можно на любой. Провал НЕ глотаем: не сумели сохранить копию —
// значит нечем откатиться, а мигрируем мы ровно на этот случай.
function backupBeforeMigrate(db: Db, dbPath: string, from: number): void {
  const backup = `${dbPath}.v${from}.bak`;
  // Пишем в СВОЙ временный файл и переименовываем: одну и ту же доску открывают несколько
  // процессов (сервер UI, MCP, терминал), и все они после апгрейда мигрируют её
  // наперегонки. С общим именем один сносил бы файл, который другой ещё пишет, — копия
  // исчезала бы ровно тогда, когда она нужна. rename атомарен, tmp у каждого свой.
  const tmp = `${backup}.${process.pid}.tmp`;
  const q = (p: string): string => p.replace(/'/g, "''");
  try {
    rmSync(tmp, { force: true }); // хвост от процесса с тем же pid, умершего на этом месте
    db.exec(`VACUUM INTO '${q(tmp)}'`);
    // Сосед мог обогнать нас и домигрировать доску, пока шёл VACUUM: тогда в копии лежит уже
    // НОВАЯ схема, и класть её под именем v${from} нельзя — человек, откатываясь, получил бы
    // ровно ту версию, от которой убегал.
    const copy = new Db(tmp, { readOnly: true });
    const copied = copy.pragma('user_version', { simple: true }) as number;
    copy.close();
    if (copied !== from) { rmSync(tmp, { force: true }); return; }
    renameSync(tmp, backup);
  } catch (e) {
    rmSync(tmp, { force: true });
    db.close();
    throw new KddError(
      `cannot back up the board before migrating it to v${MIGRATIONS.length}: ` +
      `${e instanceof Error ? e.message : String(e)} (wanted ${backup})`);
  }
}

export function openDb(dbPath: string, projectPath?: string, checkout?: string): Db {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Db(dbPath);
  db.pragma('journal_mode = WAL');
  // WAL + NORMAL survives app crashes (only an OS crash may drop the last commits); the previous
  // driver build defaulted to it, and FULL would fsync on every commit.
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  const from = db.pragma('user_version', { simple: true }) as number;
  // База из будущего: цикл ниже просто не выполнился бы, и kdd молча работал бы на схеме,
  // которой не знает — колонки, CHECK'и и инварианты мимо него. Одна база на все worktree
  // проекта, а версий kdd в жизни человека сразу несколько (глобальная, npx-кэш, плагин,
  // pnpm dev:cli, откат после неудачного релиза) — так что это не теория. Тихая порча данных
  // дороже любого отказа: падаем.
  if (from > MIGRATIONS.length) {
    db.close();
    throw new KddError(
      `board at ${dbPath} has schema v${from}, this kdd only knows v${MIGRATIONS.length} — ` +
      `update kdd (npm i -g @kddkit/cli), or run the version that created it`);
  }
  // from === 0 — пустой файл, терять нечего.
  if (from > 0 && from < MIGRATIONS.length && dbPath !== ':memory:') {
    backupBeforeMigrate(db, dbPath, from);
  }
  for (let i = from; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      const current = db.pragma('user_version', { simple: true }) as number;
      if (current > MIGRATIONS.length) throw new KddError('board schema changed to an unknown version during migration');
      if (current > i) return;
      db.exec(MIGRATIONS[i]);
      db.pragma(`user_version = ${i + 1}`);
    }).immediate();
  }
  if (from === 0 && projectPath) {
    db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('project_path', ?)`)
      .run(projectPath);
  }
  const configuredDecisions = process.env.KDD_DECISIONS_DIR;
  if (from === 0 && configuredDecisions) {
    db.transaction(() => db.prepare('UPDATE project SET legacy_decisions_dir=? WHERE singleton=1')
      .run(canonicalProjectPath(configuredDecisions)))();
  }
  try {
    initializeProjectStore(db, dbPath, process.env.KDD_HOME ?? join(homedir(), '.kdd'), projectPath, checkout,
      { legacyUpgrade: from > 0 && from < 13, configuredDecisions: from < 13 ? configuredDecisions : undefined });
    return db;
  } catch (e) { db.close(); throw e; }
}

// Слить WAL в базу и обрезать сам файл. Авточекпоинт (PASSIVE) переиспользует место внутри
// WAL, но НИКОГДА не уменьшает файл: у доски этого репо было 1.1M базы при 4.6M WAL, а у
// пустой — 4K базы при 1.8M. Отсюда же второе: `cp kdd.db` без `-wal` копирует не всё —
// после чекпоинта копия хотя бы полная. Занятость (чужой ридер в этот момент) — не ошибка:
// файл подрежет следующий, кто закроется последним.
export function checkpointWal(db: Db): void {
  // busy_timeout на время чекпоинта снимаем: TRUNCATE ждёт, пока разойдутся ВСЕ читатели, и с
  // общими 5 секундами выход из UI с тремя живыми сессиями вис бы по пять секунд на каждый
  // проект в пуле. Обрезка — оппортунистическая уборка, а не обязательство: не вышло сейчас —
  // выйдет у того, кто закроется последним.
  let timeout: unknown;
  try {
    timeout = db.pragma('busy_timeout', { simple: true });
    db.pragma('busy_timeout = 0');
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch { /* busy — не повод падать на выходе */ }
  finally { if (typeof timeout === 'number') try { db.pragma(`busy_timeout = ${timeout}`); } catch { /* уже закрыта */ } }
}

// Закрытие долгоживущего клиента (сервер UI, MCP):
// единственный момент, когда обрезать WAL и дёшево, и заведомо безопасно.
export function closeDb(db: Db): void {
  checkpointWal(db);
  db.close();
}

// Рабочее дерево проекта. Хранится отдельно от project_path, потому что project_path — это
// git common-dir, и вывести toplevel из него нельзя: у submodule он лежит в
// <super>/.git/modules/<name>, у `git init --separate-git-dir` — вообще вне репозитория,
// у bare-репо с linked worktree — сам по себе. Пишет `kdd ui`, резолвивший toplevel из настоящего
// cwd внутри репозитория; читает инициализация стора (первый binding источника), rebind переносит.
export function setProjectToplevel(db: Db, toplevel: string): void {
  const primary = projectOf(db).primary_repo_id;
  if (primary) {
    try {
      const common = canonicalCommonDir(toplevel);
      if (primarySource(db)?.common_dir !== common) return;
    } catch { return; }
  }
  db.transaction(() => {
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('project_toplevel', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(toplevel);
  })();
}
