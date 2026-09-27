import Database from 'better-sqlite3';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KddError } from './errors.js';
import { initializeProjectStore, canonicalProjectPath, canonicalCommonDir, bindingsOf, projectOf } from './project_store.js';
import { homedir } from 'node:os';
import { MIGRATIONS } from './schema.js';
export { MIGRATIONS } from './schema.js';

export const now = (): number => Math.floor(Date.now() / 1000);

// Копия базы перед миграцией. VACUUM INTO, а не copyFile: она пишет один консистентный файл,
// вобравший незачекпойнченный WAL, — обычное копирование под чужой активной сессией дало бы
// половину транзакции. Своё имя на каждую исходную версию: апгрейд через две версии оставит
// два файла, и откатываться можно на любой. Провал НЕ глотаем: не сумели сохранить копию —
// значит нечем откатиться, а мигрируем мы ровно на этот случай.
function backupBeforeMigrate(db: Database.Database, dbPath: string, from: number): void {
  const backup = `${dbPath}.v${from}.bak`;
  // Пишем в СВОЙ временный файл и переименовываем: одну и ту же доску открывают несколько
  // процессов (сервер UI, `kdd tick`, терминал), и все они после апгрейда мигрируют её
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
    const copy = new Database(tmp, { readonly: true });
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

export function openDb(dbPath: string, projectPath?: string, checkout?: string): Database.Database {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
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
export function checkpointWal(db: Database.Database): void {
  // busy_timeout на время чекпоинта снимаем: TRUNCATE ждёт, пока разойдутся ВСЕ читатели, и с
  // общими 5 секундами выход из UI с тремя живыми воркерами вис бы по пять секунд на каждый
  // проект в пуле. Обрезка — оппортунистическая уборка, а не обязательство: не вышло сейчас —
  // выйдет у того, кто закроется последним.
  try {
    db.pragma('busy_timeout = 0');
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch { /* busy — не повод падать на выходе */ }
  finally { try { db.pragma('busy_timeout = 5000'); } catch { /* уже закрыта */ } }
}

// Закрытие долгоживущего клиента (сервер UI, `kdd tick --watch`, супервизор воркера):
// единственный момент, когда обрезать WAL и дёшево, и заведомо безопасно.
export function closeDb(db: Database.Database): void {
  checkpointWal(db);
  db.close();
}

// Читает project_path напрямую из уже открытой базы — без обхода ~/.kdd через listProjects(),
// который каждому проекту стоит отдельного readonly-подключения ко всем остальным.
export function projectPathOf(db: Database.Database): string | null {
  return (db.prepare(`SELECT value FROM meta WHERE key = 'project_path'`).get() as
    { value: string } | undefined)?.value ?? null;
}

// Рабочее дерево проекта. Хранится отдельно от project_path, потому что project_path — это
// git common-dir, и вывести toplevel из него нельзя: у submodule он лежит в
// <super>/.git/modules/<name>, у `git init --separate-git-dir` — вообще вне репозитория,
// у bare-репо с linked worktree — сам по себе. Пишут те, кто резолвил toplevel из настоящего
// cwd внутри репозитория (`kdd tick`, `kdd ui`); читают те, кому нужен cwd для дочерних
// процессов, но у кого нет своего cwd в проекте (планировщик web-сервера).
export function projectToplevelOf(db: Database.Database): string | null {
  return (db.prepare(`SELECT value FROM meta WHERE key = 'project_toplevel'`).get() as
    { value: string } | undefined)?.value ?? null;
}

export function setProjectToplevel(db: Database.Database, toplevel: string): void {
  const primary = projectOf(db).primary_repo_id;
  if (primary) {
    try {
      const common = canonicalCommonDir(toplevel);
      if (!bindingsOf(db).some(b => b.repo_id === primary && b.kind === 'source' && b.common_dir === common)) return;
    } catch { return; }
  }
  db.transaction(() => {
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('project_toplevel', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(toplevel);
  })();
}
