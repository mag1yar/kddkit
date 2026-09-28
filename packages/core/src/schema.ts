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
  `
  -- Текущий verification snapshot критерия. История остаётся в events; эти nullable-поля
  -- нужны только для быстрого чтения актуального evidence и автора. Старые criteria валидны.
  ALTER TABLE criteria ADD COLUMN evidence TEXT;
  ALTER TABLE criteria ADD COLUMN checked_by TEXT;
  `,
  `
  -- Канон provenance живёт во frontmatter decision Markdown. Эта JSON-колонка — только
  -- rebuildable индекс для обратного запроса task -> decisions.
  ALTER TABLE decisions ADD COLUMN source_tasks TEXT NOT NULL DEFAULT '[]';
  `,
  `
  CREATE TABLE repositories (
    repo_id TEXT PRIMARY KEY CHECK(length(repo_id) = 32 AND repo_id NOT GLOB '*[^0-9a-f]*'),
    purpose TEXT NOT NULL CHECK(length(trim(purpose)) > 0),
    access TEXT NOT NULL CHECK(access IN ('context_only','implementation')),
    remote TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE project (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    project_id TEXT NOT NULL UNIQUE CHECK(length(project_id) = 32 AND project_id NOT GLOB '*[^0-9a-f]*'),
    primary_repo_id TEXT REFERENCES repositories(repo_id),
    legacy_decisions_dir TEXT,
    autonomy_enabled INTEGER NOT NULL DEFAULT 0 CHECK(autonomy_enabled IN (0,1)),
    default_execution_mode TEXT NOT NULL DEFAULT 'manual' CHECK(default_execution_mode IN ('manual','orchestrated')),
    created_at INTEGER NOT NULL
  );
  INSERT INTO project(singleton,project_id,created_at)
    VALUES(1,lower(hex(randomblob(16))),CAST(strftime('%s','now') AS INTEGER));
  CREATE TABLE repository_bindings (
    common_dir TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repositories(repo_id),
    checkout_path TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('source','managed')),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_repository_bindings_repo ON repository_bindings(repo_id);
  `,
  `
  CREATE TABLE managed_task_policy (
    task_id INTEGER PRIMARY KEY REFERENCES tasks(id),
    created_at INTEGER NOT NULL,
    source TEXT NOT NULL
  );
  CREATE TABLE run_authorities (
    authority_id TEXT PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    work_item_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation > 0),
    expires_at REAL NOT NULL,
    revoked_at INTEGER,
    token_hash TEXT NOT NULL UNIQUE,
    grant_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(task_id,work_item_id,generation)
  );
  CREATE UNIQUE INDEX idx_run_authorities_current ON run_authorities(task_id,work_item_id)
    WHERE revoked_at IS NULL;
  `,
];
