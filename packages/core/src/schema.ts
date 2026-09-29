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
  // v15: task membership, immutable execution contracts and fenced ownership.
  `
ALTER TABLE tasks ADD COLUMN parent_id INTEGER REFERENCES tasks(id);
ALTER TABLE tasks ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'manual'
  CHECK(execution_mode IN ('manual','orchestrated'));
CREATE INDEX idx_tasks_parent ON tasks(parent_id);
CREATE TRIGGER task_parent_insert BEFORE INSERT ON tasks WHEN NEW.parent_id IS NOT NULL BEGIN
  SELECT CASE WHEN NEW.parent_id=NEW.id OR NOT EXISTS
    (SELECT 1 FROM tasks WHERE id=NEW.parent_id AND parent_id IS NULL)
    THEN RAISE(ABORT,'invalid root parent') END;
END;
CREATE TRIGGER task_parent_update BEFORE UPDATE OF parent_id ON tasks
WHEN NEW.parent_id IS NOT OLD.parent_id BEGIN
  SELECT CASE WHEN NEW.parent_id IS NOT NULL AND
    (NEW.parent_id=NEW.id OR NOT EXISTS
      (SELECT 1 FROM tasks WHERE id=NEW.parent_id AND parent_id IS NULL)
      OR EXISTS (SELECT 1 FROM tasks WHERE parent_id=OLD.id))
    THEN RAISE(ABORT,'invalid root parent') END;
END;
CREATE TABLE work_items (
  id TEXT PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id),
  current_revision INTEGER NOT NULL CHECK(typeof(current_revision)='integer' AND current_revision BETWEEN 1 AND 9007199254740991),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN
    ('pending','ready','running','waiting_input','retry_wait','completed','failed','cancelled')),
  fence INTEGER NOT NULL DEFAULT 0 CHECK(typeof(fence)='integer' AND fence BETWEEN 0 AND 9007199254740991),
  created_at INTEGER NOT NULL,
  FOREIGN KEY(id,current_revision) REFERENCES work_item_revisions(work_item_id,revision) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX idx_work_items_task ON work_items(task_id);
CREATE TABLE work_item_revisions (
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
  definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
  inputs_json TEXT NOT NULL CHECK(json_valid(inputs_json)),
  inputs_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(work_item_id,revision)
);
CREATE TABLE work_item_dependencies (
  consumer_id TEXT NOT NULL, consumer_revision INTEGER NOT NULL,
  edge_key TEXT NOT NULL, producer_id TEXT NOT NULL, producer_revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('contract','code','merged','readiness')),
  output_key TEXT NOT NULL, binding_json TEXT NOT NULL CHECK(json_valid(binding_json)),
  pinned_result_id TEXT REFERENCES work_item_results(id),
  PRIMARY KEY(consumer_id,consumer_revision,edge_key), CHECK(consumer_id<>producer_id),
  FOREIGN KEY(consumer_id,consumer_revision) REFERENCES work_item_revisions(work_item_id,revision),
  FOREIGN KEY(producer_id,producer_revision) REFERENCES work_item_revisions(work_item_id,revision)
);
CREATE INDEX idx_work_item_dependencies_producer ON work_item_dependencies(producer_id);
CREATE TABLE work_item_results (
  id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, command_hash TEXT NOT NULL,
  producer_id TEXT NOT NULL, producer_revision INTEGER NOT NULL, output_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('contract','code','merged','readiness')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  source_json TEXT NOT NULL CHECK(json_valid(source_json)), created_at INTEGER NOT NULL,
  invalidated_at INTEGER, invalidation_reason TEXT,
  successor_id TEXT REFERENCES work_item_results(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(producer_id,producer_revision) REFERENCES work_item_revisions(work_item_id,revision)
);
CREATE UNIQUE INDEX idx_work_item_results_current
  ON work_item_results(producer_id,producer_revision,output_key) WHERE invalidated_at IS NULL;
CREATE TABLE work_item_owners (
  work_item_id TEXT NOT NULL, fence INTEGER NOT NULL
    CHECK(typeof(fence)='integer' AND fence BETWEEN 1 AND 9007199254740991),
  revision INTEGER NOT NULL, owner_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('manual','orchestrated')),
  write_access INTEGER NOT NULL CHECK(write_access IN (0,1)),
  inputs_json TEXT NOT NULL CHECK(json_valid(inputs_json)),
  launch_id TEXT, launch_json TEXT CHECK(launch_json IS NULL OR json_valid(launch_json)),
  created_at INTEGER NOT NULL, released_at INTEGER, release_handoff_id TEXT REFERENCES execution_handoffs(id),
  PRIMARY KEY(work_item_id,fence),
  FOREIGN KEY(work_item_id,revision) REFERENCES work_item_revisions(work_item_id,revision),
  CHECK((launch_id IS NULL)=(launch_json IS NULL)),
  CHECK((released_at IS NULL)=(release_handoff_id IS NULL))
);
CREATE UNIQUE INDEX idx_work_item_owners_live ON work_item_owners(work_item_id) WHERE released_at IS NULL;
CREATE TABLE execution_handoffs (
  id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, task_id INTEGER NOT NULL REFERENCES tasks(id),
  expected_mode TEXT NOT NULL CHECK(expected_mode IN ('manual','orchestrated')),
  target_mode TEXT NOT NULL CHECK(target_mode IN ('manual','orchestrated')),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), created_at INTEGER NOT NULL,
  completed_at INTEGER, receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
  CHECK((completed_at IS NULL)=(receipt_json IS NULL))
);
CREATE UNIQUE INDEX idx_execution_handoffs_live ON execution_handoffs(task_id) WHERE completed_at IS NULL;
CREATE TRIGGER work_item_revisions_immutable_update BEFORE UPDATE ON work_item_revisions
BEGIN SELECT RAISE(ABORT,'immutable work item revision'); END;
CREATE TRIGGER work_item_revisions_immutable_delete BEFORE DELETE ON work_item_revisions
BEGIN SELECT RAISE(ABORT,'immutable work item revision'); END;
CREATE TRIGGER work_item_dependencies_immutable BEFORE UPDATE OF
  consumer_id,consumer_revision,edge_key,producer_id,producer_revision,kind,output_key,binding_json
  ON work_item_dependencies BEGIN SELECT RAISE(ABORT,'immutable dependency'); END;
CREATE TRIGGER work_item_dependencies_no_delete BEFORE DELETE ON work_item_dependencies
BEGIN SELECT RAISE(ABORT,'immutable dependency'); END;
CREATE TRIGGER work_item_dependencies_pin BEFORE UPDATE OF pinned_result_id ON work_item_dependencies
WHEN OLD.pinned_result_id IS NOT NULL AND NEW.pinned_result_id IS NOT OLD.pinned_result_id
BEGIN SELECT RAISE(ABORT,'dependency result already pinned'); END;
CREATE TRIGGER work_item_results_immutable BEFORE UPDATE OF
  id,command_id,command_hash,producer_id,producer_revision,output_key,kind,payload_json,source_json,created_at
  ON work_item_results BEGIN SELECT RAISE(ABORT,'immutable result payload'); END;
CREATE TRIGGER work_item_results_no_delete BEFORE DELETE ON work_item_results
BEGIN SELECT RAISE(ABORT,'immutable result payload'); END;
CREATE TRIGGER work_item_results_no_revalidate BEFORE UPDATE OF invalidated_at,invalidation_reason,successor_id
  ON work_item_results WHEN OLD.invalidated_at IS NOT NULL AND
    (NEW.invalidated_at IS NOT OLD.invalidated_at OR NEW.invalidation_reason IS NOT OLD.invalidation_reason
      OR NEW.successor_id IS NOT OLD.successor_id)
BEGIN SELECT RAISE(ABORT,'result invalidation is final'); END;
  `,
  // v16: operational memory is independent of the legacy decision index.
  `
CREATE TABLE memory_entries (
  id TEXT PRIMARY KEY CHECK(length(id)=32 AND id NOT GLOB '*[^0-9a-f]*'),
  task_id INTEGER REFERENCES tasks(id), repo_id TEXT REFERENCES repositories(repo_id),
  applicable_commit TEXT CHECK(applicable_commit IS NULL OR
    (length(applicable_commit) IN (40,64) AND applicable_commit NOT GLOB '*[^0-9a-f]*')),
  import_key TEXT UNIQUE CHECK(import_key IS NULL OR (length(import_key)=64 AND import_key NOT GLOB '*[^0-9a-f]*')),
  current_revision INTEGER NOT NULL CHECK(typeof(current_revision)='integer' AND current_revision BETWEEN 1 AND 9007199254740991),
  created_at INTEGER NOT NULL, CHECK(applicable_commit IS NULL OR repo_id IS NOT NULL),
  FOREIGN KEY(id,current_revision) REFERENCES memory_revisions(entry_id,revision) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE memory_revisions (
  entry_id TEXT NOT NULL REFERENCES memory_entries(id),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
  predecessor INTEGER,
  kind TEXT NOT NULL CHECK(kind IN ('fact','decision','rule','candidate')),
  status TEXT NOT NULL CHECK(status IN ('active','withdrawn')),
  title TEXT NOT NULL, body TEXT NOT NULL,
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  author_json TEXT NOT NULL CHECK(json_valid(author_json)),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json)='array'),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  command_id TEXT NOT NULL UNIQUE CHECK(length(trim(command_id))>0),
  command_hash TEXT NOT NULL CHECK(length(command_hash)=64 AND command_hash NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(entry_id,revision),
  CHECK((revision=1 AND predecessor IS NULL) OR (revision>1 AND predecessor=revision-1)),
  FOREIGN KEY(entry_id,predecessor) REFERENCES memory_revisions(entry_id,revision) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX idx_memory_scope ON memory_entries(task_id,repo_id,applicable_commit);
CREATE UNIQUE INDEX idx_memory_import_commands ON events(json_extract(detail,'$.commandId')) WHERE action='memory_import_replay';
CREATE TRIGGER memory_revisions_immutable_update BEFORE UPDATE ON memory_revisions
BEGIN SELECT RAISE(ABORT,'immutable memory revision'); END;
CREATE TRIGGER memory_revisions_immutable_delete BEFORE DELETE ON memory_revisions
BEGIN SELECT RAISE(ABORT,'immutable memory revision'); END;
CREATE TRIGGER memory_entries_immutable BEFORE UPDATE OF id,task_id,repo_id,applicable_commit,import_key,created_at ON memory_entries
BEGIN SELECT RAISE(ABORT,'immutable memory identity'); END;
CREATE TRIGGER memory_entries_no_delete BEFORE DELETE ON memory_entries
BEGIN SELECT RAISE(ABORT,'immutable memory identity'); END;
CREATE TRIGGER memory_entries_current BEFORE UPDATE OF current_revision ON memory_entries
WHEN NEW.current_revision<>OLD.current_revision+1
BEGIN SELECT RAISE(ABORT,'memory revision must advance once'); END;
  `,
];
