import Database from 'better-sqlite3';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { KddError } from './errors.js';

export const now = (): number => Math.floor(Date.now() / 1000);

export const MIGRATIONS: string[] = [
  `
  CREATE TABLE tasks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT NOT NULL,
    body         TEXT,
    status       TEXT NOT NULL DEFAULT 'new'
                 CHECK (status IN ('backlog','new','in_progress','review','done')),
    blocked      INTEGER NOT NULL DEFAULT 0,
    block_reason TEXT,
    priority     TEXT NOT NULL DEFAULT 'medium'
                 CHECK (priority IN ('low','medium','high','urgent')),
    area         TEXT,
    position     INTEGER NOT NULL DEFAULT 0,
    archived_at  INTEGER,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  CREATE TABLE comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER NOT NULL REFERENCES tasks(id),
    author     TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE task_links (
    from_id INTEGER NOT NULL REFERENCES tasks(id),
    to_id   INTEGER NOT NULL REFERENCES tasks(id),
    kind    TEXT NOT NULL DEFAULT 'relates_to',
    PRIMARY KEY (from_id, to_id, kind)
  );
  CREATE TABLE events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER REFERENCES tasks(id),
    actor_type TEXT NOT NULL CHECK (actor_type IN ('user','ai')),
    actor_id   TEXT,
    action     TEXT NOT NULL CHECK (action IN
               ('created','moved','edited','commented','blocked','unblocked','linked','archived','unarchived')),
    detail     TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT, message TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE INDEX idx_tasks_status ON tasks(status);
  CREATE INDEX idx_comments_task ON comments(task_id, created_at);
  CREATE INDEX idx_events_task ON events(task_id, created_at);
  `,
  `
  CREATE TABLE decisions (
    slug          TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    path          TEXT NOT NULL,
    content_hash  TEXT NOT NULL,
    created       TEXT,
    superseded_by TEXT
  );
  CREATE INDEX idx_decisions_hash ON decisions(content_hash);
  CREATE VIRTUAL TABLE search_index USING fts5(
    kind UNINDEXED,
    ref UNINDEXED,
    title,
    body,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  INSERT OR IGNORE INTO meta (key, value) VALUES ('fts_last_event_id', '0');
  `,
  `
  CREATE TABLE tracks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    description TEXT,
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','done')),
    created_at  INTEGER NOT NULL
  );
  ALTER TABLE tasks ADD COLUMN track_id INTEGER REFERENCES tracks(id);
  CREATE INDEX idx_tasks_track ON tasks(track_id);
  `,
  `
  CREATE TABLE criteria (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER NOT NULL REFERENCES tasks(id),
    text       TEXT NOT NULL,
    checked_at INTEGER,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_criteria_task ON criteria(task_id, position);
  -- пересборка events: снят CHECK с action — словарь открытый (criterion_*, дальше claim/verify)
  CREATE TABLE events_new (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER REFERENCES tasks(id),
    actor_type TEXT NOT NULL CHECK (actor_type IN ('user','ai')),
    actor_id   TEXT,
    action     TEXT NOT NULL,
    detail     TEXT,
    created_at INTEGER NOT NULL
  );
  INSERT INTO events_new SELECT * FROM events;
  DROP TABLE events;
  ALTER TABLE events_new RENAME TO events;
  CREATE INDEX idx_events_task ON events(task_id, created_at);
  `,
  `
  -- иерархия и типизация событий (observability агентов); старые строки: NULL/NULL/'info'
  ALTER TABLE events ADD COLUMN parent_id INTEGER REFERENCES events(id);
  ALTER TABLE events ADD COLUMN type TEXT;
  ALTER TABLE events ADD COLUMN level TEXT NOT NULL DEFAULT 'info';
  `,
  `
  -- claim-протокол: агент берёт задачу атомарно (CAS), lease с TTL.
  -- Инвариант: claimed_by IS NOT NULL <=> status='in_progress'. Старые задачи: NULL.
  ALTER TABLE tasks ADD COLUMN claimed_by TEXT;
  ALTER TABLE tasks ADD COLUMN claim_expires INTEGER;
  `,
  `
  -- driver-слайс: счётчик неудачных попыток агента (spawn-fail + непродуктивный reclaim).
  -- reset при достижении review; при K попыток задача авто-блокируется. Старые задачи: 0.
  ALTER TABLE tasks ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Tier1 feed: поток активности воркера (текст, tool-вызовы) отдельно от audit-events.
  -- Изолирован намеренно: get_task/status/MCP его НЕ читают — иначе поток забьёт LLM-контекст.
  CREATE TABLE agent_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER NOT NULL REFERENCES tasks(id),
    worker_id  TEXT NOT NULL,
    kind       TEXT NOT NULL,
    name       TEXT,
    detail     TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_agent_events_task ON agent_events(task_id, id);
  `,
  `
  -- Тип работы. Дефолт 'feature' МОЛЧАЛИВЫЙ: карточка его не рисует, поэтому
  -- задачи, заведённые до этой миграции, не начинают утверждать «это фича». NOT NULL, а не
  -- nullable: к типу привязано поведение (claim, промпт, тип коммита), и NULL-ветка в каждом
  -- потребителе была бы ценой без выгоды.
  ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'feature'
    CHECK (kind IN ('feature','bug','chore','research'));
  `,
  `
  -- Вложения. Строка на СВЯЗКУ задача+файл, а не на файл: описание принадлежит связке —
  -- одна и та же схема на двух задачах описывается по-разному. Дедуп при этом остаётся,
  -- он на уровне байтов: имя файла на диске — sha256 содержимого.
  CREATE TABLE files (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    sha256 TEXT NOT NULL,
    ext TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER NOT NULL,
    description TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(task_id, sha256)
  );
  CREATE INDEX idx_files_task_id ON files(task_id);
  CREATE INDEX idx_files_sha256 ON files(sha256);
  `,
];

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

export function openDb(dbPath: string, projectPath?: string): Database.Database {
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
      db.exec(MIGRATIONS[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
  if (from === 0 && projectPath) {
    db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('project_path', ?)`)
      .run(projectPath);
  }
  return db;
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
  db.transaction(() => {
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('project_toplevel', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(toplevel);
  })();
}
