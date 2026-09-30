// src/caps.ts
var CAPS = {
  briefBytes: 4096,
  // JSON/MCP payload для детерминированного resume-пакета
  boardRows: 8,
  // строк на колонку в CLI board (контракт ≤4KB, cyrillic ×2 байта)
  listRows: 20,
  // строк на колонку в MCP list_tasks (Claude, без байт-бюджета)
  attentionRows: 20,
  statusRows: 5,
  // строк на секцию kdd status
  statusBytes: 2048,
  // бюджет текстовой выдачи kdd status — контракт, structural cap в
  // renderStatus (как recallBytes в renderRecall): строк не хватает
  // как замера, заголовок/kind-маркер/blocked-reason не bounded by row count
  statusEvents: 5,
  // recent-событий в statusDigest
  titleChars: 50,
  blockReasonChars: 40,
  bodyChars: 8192,
  // тело задачи в show/get_task
  comments: 20,
  // последних комментов в show/get_task
  commentChars: 500,
  events: 10,
  // последних событий в show/get_task
  files: 20,
  // вложений в show/get_task
  decisions: 20,
  // связанных решений в show/get_task
  decisionSources: 20,
  // исходных задач в kdd decision
  fileDescChars: 200,
  // описание вложения в show/get_task
  fileNameChars: 100,
  // original_name — с клиентского multipart-имени, режем на записи
  recallK: 10,
  // дефолтный top-k
  recallKMax: 50,
  // потолок k — больше не отдаём никому
  recallSnippetTokens: 12,
  recallBytes: 4096,
  // бюджет текстовой выдачи kdd recall
  recallTitleChars: 60,
  trackDescChars: 200,
  // Единственные капы на ЗАПИСЬ. Всё выше режет выдачу — эти режут то, что вообще ложится в базу:
  // фид воркера принимает сырой ввод/вывод инструментов, и один `Read` большого файла кладёт
  // сотни КБ одной строкой в базу, которую шарят все worktree проекта.
  fileBytes: 20 * 1024 * 1024,
  // потолок вложения: доска личная, но 20 MB картинки хватает всем
  skillFileBytes: 1024 * 1024,
  skillFileCount: 128,
  skillTotalBytes: 8 * 1024 * 1024,
  agentFieldChars: 4096,
  // строковый лист в detail (вывод тула, аргумент, текст ответа)
  agentDetailItems: 64,
  // элементов массива в detail — content-блоков у тула бывает много
  agentDetailBytes: 65536,
  // весь detail после капа листьев; выше — пишем только размер
  agentEventDays: 7,
  // столько живёт подробный фид завершённой задачи (см. pruneAgentEvents)
  agentPruneBatch: 5e3
  // строк за один проход ротации: DELETE держит write-lock, рядом пишут воркеры
};
function capText(s, n) {
  if (s.length <= n) return s;
  const cut = n - ((s.charCodeAt(n - 1) & 64512) === 55296 ? 1 : 0);
  return `${s.slice(0, cut)}\u2026 [+${s.length - cut} chars]`;
}

// src/db.ts
import Database2 from "better-sqlite3";
import { mkdirSync as mkdirSync2, renameSync as renameSync2, rmSync as rmSync2 } from "fs";
import { dirname as dirname2, join as join2 } from "path";

// src/errors.ts
var KddError = class extends Error {
};
function logError(db, source, message) {
  db.prepare(`INSERT INTO errors (source, message, created_at) VALUES (?, ?, ?)`).run(source, message, now());
}

// src/project_store.ts
import Database from "better-sqlite3";
import { execFileSync } from "child_process";
import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";

// src/schema.ts
var MIGRATIONS = [
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
  -- \u043F\u0435\u0440\u0435\u0441\u0431\u043E\u0440\u043A\u0430 events: \u0441\u043D\u044F\u0442 CHECK \u0441 action \u2014 \u0441\u043B\u043E\u0432\u0430\u0440\u044C \u043E\u0442\u043A\u0440\u044B\u0442\u044B\u0439 (criterion_*, \u0434\u0430\u043B\u044C\u0448\u0435 claim/verify)
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
  -- \u0438\u0435\u0440\u0430\u0440\u0445\u0438\u044F \u0438 \u0442\u0438\u043F\u0438\u0437\u0430\u0446\u0438\u044F \u0441\u043E\u0431\u044B\u0442\u0438\u0439 (observability \u0430\u0433\u0435\u043D\u0442\u043E\u0432); \u0441\u0442\u0430\u0440\u044B\u0435 \u0441\u0442\u0440\u043E\u043A\u0438: NULL/NULL/'info'
  ALTER TABLE events ADD COLUMN parent_id INTEGER REFERENCES events(id);
  ALTER TABLE events ADD COLUMN type TEXT;
  ALTER TABLE events ADD COLUMN level TEXT NOT NULL DEFAULT 'info';
  `,
  `
  -- claim-\u043F\u0440\u043E\u0442\u043E\u043A\u043E\u043B: \u0430\u0433\u0435\u043D\u0442 \u0431\u0435\u0440\u0451\u0442 \u0437\u0430\u0434\u0430\u0447\u0443 \u0430\u0442\u043E\u043C\u0430\u0440\u043D\u043E (CAS), lease \u0441 TTL.
  -- \u0418\u043D\u0432\u0430\u0440\u0438\u0430\u043D\u0442: claimed_by IS NOT NULL <=> status='in_progress'. \u0421\u0442\u0430\u0440\u044B\u0435 \u0437\u0430\u0434\u0430\u0447\u0438: NULL.
  ALTER TABLE tasks ADD COLUMN claimed_by TEXT;
  ALTER TABLE tasks ADD COLUMN claim_expires INTEGER;
  `,
  `
  -- driver-\u0441\u043B\u0430\u0439\u0441: \u0441\u0447\u0451\u0442\u0447\u0438\u043A \u043D\u0435\u0443\u0434\u0430\u0447\u043D\u044B\u0445 \u043F\u043E\u043F\u044B\u0442\u043E\u043A \u0430\u0433\u0435\u043D\u0442\u0430 (spawn-fail + \u043D\u0435\u043F\u0440\u043E\u0434\u0443\u043A\u0442\u0438\u0432\u043D\u044B\u0439 reclaim).
  -- reset \u043F\u0440\u0438 \u0434\u043E\u0441\u0442\u0438\u0436\u0435\u043D\u0438\u0438 review; \u043F\u0440\u0438 K \u043F\u043E\u043F\u044B\u0442\u043E\u043A \u0437\u0430\u0434\u0430\u0447\u0430 \u0430\u0432\u0442\u043E-\u0431\u043B\u043E\u043A\u0438\u0440\u0443\u0435\u0442\u0441\u044F. \u0421\u0442\u0430\u0440\u044B\u0435 \u0437\u0430\u0434\u0430\u0447\u0438: 0.
  ALTER TABLE tasks ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Tier1 feed: \u043F\u043E\u0442\u043E\u043A \u0430\u043A\u0442\u0438\u0432\u043D\u043E\u0441\u0442\u0438 \u0432\u043E\u0440\u043A\u0435\u0440\u0430 (\u0442\u0435\u043A\u0441\u0442, tool-\u0432\u044B\u0437\u043E\u0432\u044B) \u043E\u0442\u0434\u0435\u043B\u044C\u043D\u043E \u043E\u0442 audit-events.
  -- \u0418\u0437\u043E\u043B\u0438\u0440\u043E\u0432\u0430\u043D \u043D\u0430\u043C\u0435\u0440\u0435\u043D\u043D\u043E: get_task/status/MCP \u0435\u0433\u043E \u041D\u0415 \u0447\u0438\u0442\u0430\u044E\u0442 \u2014 \u0438\u043D\u0430\u0447\u0435 \u043F\u043E\u0442\u043E\u043A \u0437\u0430\u0431\u044C\u0451\u0442 LLM-\u043A\u043E\u043D\u0442\u0435\u043A\u0441\u0442.
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
  -- \u0422\u0438\u043F \u0440\u0430\u0431\u043E\u0442\u044B. \u0414\u0435\u0444\u043E\u043B\u0442 'feature' \u041C\u041E\u041B\u0427\u0410\u041B\u0418\u0412\u042B\u0419: \u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0430 \u0435\u0433\u043E \u043D\u0435 \u0440\u0438\u0441\u0443\u0435\u0442, \u043F\u043E\u044D\u0442\u043E\u043C\u0443
  -- \u0437\u0430\u0434\u0430\u0447\u0438, \u0437\u0430\u0432\u0435\u0434\u0451\u043D\u043D\u044B\u0435 \u0434\u043E \u044D\u0442\u043E\u0439 \u043C\u0438\u0433\u0440\u0430\u0446\u0438\u0438, \u043D\u0435 \u043D\u0430\u0447\u0438\u043D\u0430\u044E\u0442 \u0443\u0442\u0432\u0435\u0440\u0436\u0434\u0430\u0442\u044C \xAB\u044D\u0442\u043E \u0444\u0438\u0447\u0430\xBB. NOT NULL, \u0430 \u043D\u0435
  -- nullable: \u043A \u0442\u0438\u043F\u0443 \u043F\u0440\u0438\u0432\u044F\u0437\u0430\u043D\u043E \u043F\u043E\u0432\u0435\u0434\u0435\u043D\u0438\u0435 (claim, \u043F\u0440\u043E\u043C\u043F\u0442, \u0442\u0438\u043F \u043A\u043E\u043C\u043C\u0438\u0442\u0430), \u0438 NULL-\u0432\u0435\u0442\u043A\u0430 \u0432 \u043A\u0430\u0436\u0434\u043E\u043C
  -- \u043F\u043E\u0442\u0440\u0435\u0431\u0438\u0442\u0435\u043B\u0435 \u0431\u044B\u043B\u0430 \u0431\u044B \u0446\u0435\u043D\u043E\u0439 \u0431\u0435\u0437 \u0432\u044B\u0433\u043E\u0434\u044B.
  ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'feature'
    CHECK (kind IN ('feature','bug','chore','research'));
  `,
  `
  -- \u0412\u043B\u043E\u0436\u0435\u043D\u0438\u044F. \u0421\u0442\u0440\u043E\u043A\u0430 \u043D\u0430 \u0421\u0412\u042F\u0417\u041A\u0423 \u0437\u0430\u0434\u0430\u0447\u0430+\u0444\u0430\u0439\u043B, \u0430 \u043D\u0435 \u043D\u0430 \u0444\u0430\u0439\u043B: \u043E\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u043F\u0440\u0438\u043D\u0430\u0434\u043B\u0435\u0436\u0438\u0442 \u0441\u0432\u044F\u0437\u043A\u0435 \u2014
  -- \u043E\u0434\u043D\u0430 \u0438 \u0442\u0430 \u0436\u0435 \u0441\u0445\u0435\u043C\u0430 \u043D\u0430 \u0434\u0432\u0443\u0445 \u0437\u0430\u0434\u0430\u0447\u0430\u0445 \u043E\u043F\u0438\u0441\u044B\u0432\u0430\u0435\u0442\u0441\u044F \u043F\u043E-\u0440\u0430\u0437\u043D\u043E\u043C\u0443. \u0414\u0435\u0434\u0443\u043F \u043F\u0440\u0438 \u044D\u0442\u043E\u043C \u043E\u0441\u0442\u0430\u0451\u0442\u0441\u044F,
  -- \u043E\u043D \u043D\u0430 \u0443\u0440\u043E\u0432\u043D\u0435 \u0431\u0430\u0439\u0442\u043E\u0432: \u0438\u043C\u044F \u0444\u0430\u0439\u043B\u0430 \u043D\u0430 \u0434\u0438\u0441\u043A\u0435 \u2014 sha256 \u0441\u043E\u0434\u0435\u0440\u0436\u0438\u043C\u043E\u0433\u043E.
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
  -- \u0422\u0435\u043A\u0443\u0449\u0438\u0439 verification snapshot \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u044F. \u0418\u0441\u0442\u043E\u0440\u0438\u044F \u043E\u0441\u0442\u0430\u0451\u0442\u0441\u044F \u0432 events; \u044D\u0442\u0438 nullable-\u043F\u043E\u043B\u044F
  -- \u043D\u0443\u0436\u043D\u044B \u0442\u043E\u043B\u044C\u043A\u043E \u0434\u043B\u044F \u0431\u044B\u0441\u0442\u0440\u043E\u0433\u043E \u0447\u0442\u0435\u043D\u0438\u044F \u0430\u043A\u0442\u0443\u0430\u043B\u044C\u043D\u043E\u0433\u043E evidence \u0438 \u0430\u0432\u0442\u043E\u0440\u0430. \u0421\u0442\u0430\u0440\u044B\u0435 criteria \u0432\u0430\u043B\u0438\u0434\u043D\u044B.
  ALTER TABLE criteria ADD COLUMN evidence TEXT;
  ALTER TABLE criteria ADD COLUMN checked_by TEXT;
  `,
  `
  -- \u041A\u0430\u043D\u043E\u043D provenance \u0436\u0438\u0432\u0451\u0442 \u0432\u043E frontmatter decision Markdown. \u042D\u0442\u0430 JSON-\u043A\u043E\u043B\u043E\u043D\u043A\u0430 \u2014 \u0442\u043E\u043B\u044C\u043A\u043E
  -- rebuildable \u0438\u043D\u0434\u0435\u043A\u0441 \u0434\u043B\u044F \u043E\u0431\u0440\u0430\u0442\u043D\u043E\u0433\u043E \u0437\u0430\u043F\u0440\u043E\u0441\u0430 task -> decisions.
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
  // v17: immutable inputs belonging to one authority generation.
  `
CREATE TABLE run_input_snapshots (
  authority_id TEXT PRIMARY KEY REFERENCES run_authorities(authority_id),
  input_hash TEXT NOT NULL CHECK(length(input_hash)=64 AND input_hash NOT GLOB '*[^0-9a-f]*'),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at INTEGER NOT NULL
);
CREATE TRIGGER run_input_snapshots_immutable_update BEFORE UPDATE ON run_input_snapshots
BEGIN SELECT RAISE(ABORT,'immutable run input snapshot'); END;
CREATE TRIGGER run_input_snapshots_immutable_delete BEFORE DELETE ON run_input_snapshots
BEGIN SELECT RAISE(ABORT,'immutable run input snapshot'); END;
  `,
  // v18: immutable role revisions and pinned skill bytes live in the project store.
  `
CREATE TABLE role_profiles (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
  current_revision INTEGER NOT NULL CHECK(typeof(current_revision)='integer' AND current_revision > 0),
  revoked_at INTEGER CHECK(revoked_at IS NULL OR (typeof(revoked_at)='integer' AND revoked_at > 0))
);
CREATE TABLE role_revisions (
  role_id TEXT NOT NULL REFERENCES role_profiles(id),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision > 0),
  definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
  hash TEXT NOT NULL CHECK(length(hash)=64 AND hash NOT GLOB '*[^0-9a-f]*'),
  manifest_hash TEXT NOT NULL CHECK(length(manifest_hash)=64 AND manifest_hash NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL,
  command_id TEXT NOT NULL UNIQUE CHECK(length(trim(command_id))>0),
  command_hash TEXT NOT NULL CHECK(length(command_hash)=64 AND command_hash NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY(role_id, revision)
);
CREATE TABLE role_skill_files (
  role_id TEXT NOT NULL, revision INTEGER NOT NULL,
  skill_name TEXT NOT NULL, relative_path TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  mime TEXT NOT NULL, bytes BLOB NOT NULL CHECK(length(bytes)<=1048576),
  PRIMARY KEY(role_id,revision,skill_name,relative_path),
  FOREIGN KEY(role_id,revision) REFERENCES role_revisions(role_id,revision)
);
CREATE TRIGGER role_profiles_immutable BEFORE UPDATE OF id,project_id,name ON role_profiles
BEGIN SELECT RAISE(ABORT,'immutable role identity'); END;
CREATE TRIGGER role_profiles_no_delete BEFORE DELETE ON role_profiles
BEGIN SELECT RAISE(ABORT,'immutable role identity'); END;
CREATE TRIGGER role_profiles_current BEFORE UPDATE OF current_revision ON role_profiles
WHEN NEW.current_revision<>OLD.current_revision+1
BEGIN SELECT RAISE(ABORT,'role revision must advance once'); END;
CREATE TRIGGER role_profiles_no_unrevoke BEFORE UPDATE OF revoked_at ON role_profiles
WHEN OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at
BEGIN SELECT RAISE(ABORT,'role revocation is final'); END;
CREATE TRIGGER role_revisions_immutable_update BEFORE UPDATE ON role_revisions
BEGIN SELECT RAISE(ABORT,'immutable role revision'); END;
CREATE TRIGGER role_revisions_immutable_delete BEFORE DELETE ON role_revisions
BEGIN SELECT RAISE(ABORT,'immutable role revision'); END;
CREATE TRIGGER role_skill_files_immutable_update BEFORE UPDATE ON role_skill_files
BEGIN SELECT RAISE(ABORT,'immutable skill file'); END;
CREATE TRIGGER role_skill_files_immutable_delete BEFORE DELETE ON role_skill_files
BEGIN SELECT RAISE(ABORT,'immutable skill file'); END;
  `
];

// src/project_store.ts
function projectOf(db) {
  const row = db.prepare("SELECT project_id,primary_repo_id,legacy_decisions_dir,autonomy_enabled,default_execution_mode,created_at FROM project WHERE singleton=1").get();
  return { ...row, autonomy_enabled: row.autonomy_enabled === 1 };
}
function repositoriesOf(db) {
  return db.prepare("SELECT * FROM repositories ORDER BY repo_id").all();
}
function bindingsOf(db) {
  return db.prepare("SELECT * FROM repository_bindings ORDER BY common_dir").all();
}
var time = () => Math.floor(Date.now() / 1e3);
var id = () => randomBytes(16).toString("hex");
function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
function canonicalCommonDir(cwd) {
  try {
    return realpathSync(git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  } catch {
    throw new KddError(`not in a git repository: ${cwd}`);
  }
}
function canonicalProjectPath(path) {
  path = resolve(path);
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(resolve(path));
  return parent === resolve(path) ? resolve(path) : join(canonicalProjectPath(parent), path.slice(dirname(path).length + 1));
}
function worktrees(common) {
  return git(common, ["--git-dir", common, "worktree", "list", "--porcelain"]).split(/\r?\n\r?\n/).filter((block) => !/^bare$/m.test(block)).flatMap((block) => block.match(/^worktree (.+)$/m)?.[1] ?? []).filter((path) => {
    try {
      return existsSync(path) && canonicalCommonDir(path) === common && realpathSync(git(path, ["rev-parse", "--show-toplevel"])) === realpathSync(path);
    } catch {
      return false;
    }
  });
}
function withRegistry(home, fn) {
  mkdirSync(home, { recursive: true });
  const db = new Database(join(home, "registry.db"));
  try {
    db.pragma("busy_timeout = 5000");
    const version = db.pragma("user_version", { simple: true });
    if (version > 1) throw new KddError(`registry has unknown schema version ${version}`);
    db.transaction(() => {
      if (db.pragma("user_version", { simple: true }) === 0) {
        db.exec(`CREATE TABLE bindings(common_dir TEXT PRIMARY KEY, db_path TEXT NOT NULL, project_id TEXT NOT NULL, repo_id TEXT NOT NULL); PRAGMA user_version = 1`);
      }
    }).immediate();
    return fn(db);
  } finally {
    db.close();
  }
}
function readonly(path, fn) {
  if (!existsSync(path)) throw new KddError(`project store is missing: ${path}`);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const version = db.pragma("user_version", { simple: true });
    if (version < 1 || version > MIGRATIONS.length) throw new KddError(`unknown project schema version ${version}: ${path}`);
    return fn(db, version);
  } finally {
    db.close();
  }
}
function storePaths(home) {
  if (!existsSync(home)) return [];
  const paths = readdirSync(home, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(home, e.name, "kdd.db")).filter((path) => existsSync(path));
  const catalog = join(home, "project-stores");
  if (existsSync(catalog)) for (const name of readdirSync(catalog).filter((n) => n.endsWith(".json"))) {
    const record = JSON.parse(readFileSync(join(catalog, name), "utf8"));
    if (!/^[0-9a-f]{32}\.json$/.test(name) || record.project_id !== name.slice(0, -5) || typeof record.db_path !== "string" || resolve(record.db_path) !== record.db_path) throw new KddError("invalid project store catalog");
    readonly(record.db_path, (db, version) => {
      if (version < 13 || projectOf(db).project_id !== record.project_id) throw new KddError("project store catalog identity mismatch");
    });
    paths.push(record.db_path);
  }
  return [...new Set(paths.map((path) => resolve(path)))];
}
function catalogStore(db, dbPath, home) {
  if (canonicalProjectPath(dirname(dirname(dbPath))) === canonicalProjectPath(home) && dbPath.endsWith("/kdd.db")) return;
  const projectId = projectOf(db).project_id;
  const dir = join(home, "project-stores");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${projectId}.json`);
  const record = JSON.stringify({ db_path: resolve(dbPath), project_id: projectId });
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== record) throw new KddError("project store location conflict");
    return;
  }
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, record, { mode: 384 });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}
function meta(db, key) {
  return db.prepare("SELECT value FROM meta WHERE key=?").get(key)?.value;
}
function discover(common, home) {
  const matches = storePaths(home).flatMap((path) => readonly(path, (db, version) => {
    if (version >= 13) {
      const binding = bindingsOf(db).find((b) => b.common_dir === common);
      if (binding) return [{ dbPath: path, projectPath: common, locator: {
        common_dir: common,
        db_path: resolve(path),
        project_id: projectOf(db).project_id,
        repo_id: binding.repo_id
      } }];
    }
    const source = meta(db, "project_path");
    try {
      return source && existsSync(source) && canonicalCommonDir(source) === common ? [{ dbPath: path, projectPath: source }] : [];
    } catch {
      return [];
    }
  }));
  if (matches.length > 1) throw new KddError(`conflicting project stores for ${common}`);
  return matches[0];
}
function validateLocator(row) {
  readonly(row.db_path, (db, version) => {
    const binding = version >= 13 ? bindingsOf(db).find((b) => b.common_dir === row.common_dir) : void 0;
    if (!binding || binding.repo_id !== row.repo_id || projectOf(db).project_id !== row.project_id) {
      throw new KddError(`stale or mismatched registry binding for ${row.common_dir}; repeat explicit binding/rebind`);
    }
  });
}
function putLocator(registry, row) {
  registry.prepare("INSERT INTO bindings(common_dir,db_path,project_id,repo_id) VALUES(@common_dir,@db_path,@project_id,@repo_id) ON CONFLICT(common_dir) DO UPDATE SET db_path=excluded.db_path,project_id=excluded.project_id,repo_id=excluded.repo_id").run(row);
}
function lookupProjectStore(commonDir, home) {
  return withRegistry(home, (registry) => registry.transaction(() => {
    const row = registry.prepare("SELECT * FROM bindings WHERE common_dir=?").get(commonDir);
    if (row) {
      validateLocator(row);
      return { dbPath: row.db_path, projectPath: commonDir };
    }
    const found = discover(commonDir, home);
    if (found?.locator) putLocator(registry, found.locator);
    return found ? { dbPath: found.dbPath, projectPath: found.projectPath } : void 0;
  }).immediate());
}
function initializeProjectStore(db, dbPath, home, projectPath, checkout = process.cwd(), options = {}) {
  if (dbPath === ":memory:") return;
  const savedSource = meta(db, "project_path");
  const source = savedSource ?? projectPath;
  if (!source || !existsSync(source)) return;
  let common;
  let paths;
  try {
    common = savedSource && (options.legacyUpgrade || projectOf(db).primary_repo_id) ? canonicalCommonDir(savedSource) : realpathSync(source);
    paths = worktrees(common).map((path) => realpathSync(path));
  } catch {
    return;
  }
  let sourceCaller = false;
  try {
    if (canonicalCommonDir(checkout) === common) {
      sourceCaller = true;
      paths = [realpathSync(git(checkout, ["rev-parse", "--show-toplevel"])), ...paths];
    }
  } catch {
  }
  const toplevel = meta(db, "project_toplevel");
  if (toplevel) {
    try {
      if (canonicalCommonDir(toplevel) === common) paths.unshift(realpathSync(toplevel));
    } catch {
    }
  }
  if (!paths.length) return;
  withRegistry(home, (registry) => registry.transaction(() => {
    catalogStore(db, dbPath, home);
    const found = registry.prepare("SELECT * FROM bindings WHERE common_dir=?").get(common);
    if (found && (found.project_id !== projectOf(db).project_id || resolve(found.db_path) !== resolve(dbPath))) {
      throw new KddError(`registry binding conflict for ${common}`);
    }
    const other = discover(common, home);
    if (other && resolve(other.dbPath) !== resolve(dbPath)) throw new KddError(`project store conflict for ${common}`);
    db.transaction(() => {
      const project = projectOf(db);
      if (project.primary_repo_id) return;
      let decisionsDir = project.legacy_decisions_dir;
      if (!decisionsDir) {
        const cachedPaths = db.prepare("SELECT path FROM decisions").all().map((row) => resolve(dirname(row.path)));
        const cachedDirs = new Set(cachedPaths.map(canonicalProjectPath));
        const cachedDefault = cachedPaths.some((dir) => basename(dir) === "decisions" && basename(dirname(dir)) === ".planning" && paths.includes(canonicalProjectPath(dirname(dirname(dir)))));
        if (cachedDirs.size === 1 && !cachedDefault) decisionsDir = [...cachedDirs][0];
        if (!decisionsDir && sourceCaller && options.configuredDecisions) decisionsDir = canonicalProjectPath(options.configuredDecisions);
      }
      const repoId = id();
      db.prepare("INSERT INTO repositories VALUES(?,?,?,NULL,?)").run(repoId, "primary", "implementation", time());
      db.prepare("INSERT INTO repository_bindings VALUES(?,?,?,?,?)").run(common, repoId, paths[0], "source", time());
      db.prepare("UPDATE project SET primary_repo_id=?,legacy_decisions_dir=? WHERE singleton=1").run(repoId, decisionsDir ?? join(paths[0], ".planning", "decisions"));
    }).immediate();
    const binding = bindingsOf(db).find((b) => b.common_dir === common);
    if (binding) putLocator(registry, { common_dir: common, db_path: resolve(dbPath), project_id: projectOf(db).project_id, repo_id: binding.repo_id });
  }).immediate());
}
function listProjectCheckouts(home) {
  return [...new Set(storePaths(home).flatMap((path) => readonly(path, (db, version) => {
    const bindings = version >= 13 ? bindingsOf(db) : [];
    const commons = version >= 13 ? bindings.map((b) => b.common_dir) : [meta(db, "project_path")].filter((p) => !!p);
    const checkoutPaths = bindings.flatMap((b) => {
      try {
        return canonicalCommonDir(b.checkout_path) === b.common_dir ? [realpathSync(b.checkout_path)] : [];
      } catch {
        return [];
      }
    });
    return [...checkoutPaths, ...commons.filter((p) => existsSync(p)).flatMap((common) => worktrees(realpathSync(common)))];
  })))];
}
function audit(db, actor, action, detail) {
  db.prepare("INSERT INTO events(task_id,actor_type,actor_id,action,detail,created_at) VALUES(NULL,?,?,?,?,?)").run(actor.type, actor.type === "ai" ? actor.id ?? null : null, action, JSON.stringify(detail), time());
}
function assertAvailable(registry, common, home, dbPath, projectId, repoId) {
  const row = registry.prepare("SELECT * FROM bindings WHERE common_dir=?").get(common);
  if (row && (row.project_id !== projectId || resolve(row.db_path) !== resolve(dbPath) || repoId && row.repo_id !== repoId)) {
    throw new KddError(`repository binding conflict for ${common}`);
  }
  const found = discover(common, home);
  if (found && (resolve(found.dbPath) !== resolve(dbPath) || repoId && found.locator && found.locator.repo_id !== repoId)) {
    throw new KddError(`project store conflict for ${common}`);
  }
}
function checkoutBinding(cwd, repoId, kind) {
  return {
    common_dir: canonicalCommonDir(cwd),
    repo_id: repoId,
    checkout_path: realpathSync(git(cwd, ["rev-parse", "--show-toplevel"])),
    kind,
    created_at: time()
  };
}
function insertBinding(db, binding) {
  db.prepare("INSERT INTO repository_bindings VALUES(@common_dir,@repo_id,@checkout_path,@kind,@created_at)").run(binding);
}
function locateBinding(registry, db, dbPath, binding) {
  putLocator(registry, {
    common_dir: binding.common_dir,
    db_path: resolve(dbPath),
    project_id: projectOf(db).project_id,
    repo_id: binding.repo_id
  });
}
function bindRepository(db, dbPath, home, input, actor) {
  if (!/^[0-9a-f]{32}$/.test(input.repoId) || !repositoriesOf(db).some((r) => r.repo_id === input.repoId)) throw new KddError("unknown repository id");
  if (!["source", "managed"].includes(input.kind)) throw new KddError("invalid binding kind");
  const binding = checkoutBinding(input.cwd, input.repoId, input.kind);
  return withRegistry(home, (registry) => registry.transaction(() => {
    assertAvailable(registry, binding.common_dir, home, dbPath, projectOf(db).project_id, input.repoId);
    const existing = bindingsOf(db).find((b) => b.common_dir === binding.common_dir);
    if (existing && (existing.repo_id !== input.repoId || existing.kind !== input.kind)) throw new KddError("repository binding conflict");
    if (input.kind === "source" && bindingsOf(db).some((b) => b.repo_id === input.repoId && b.kind === "source" && b.common_dir !== binding.common_dir)) {
      throw new KddError("repository already has a source; use rebind to move it");
    }
    const result2 = existing ?? db.transaction(() => {
      insertBinding(db, binding);
      audit(db, actor, "repository_bound", binding);
      return binding;
    }).immediate();
    locateBinding(registry, db, dbPath, result2);
    return result2;
  }).immediate());
}
function addRepository(db, dbPath, home, input, actor) {
  if (!input.purpose?.trim()) throw new KddError("repository purpose must not be empty");
  if (!["context_only", "implementation"].includes(input.access)) throw new KddError("invalid repository access");
  if (!projectOf(db).primary_repo_id) throw new KddError("restore the primary source before adding a repository");
  const binding = checkoutBinding(input.cwd, id(), "source");
  return withRegistry(home, (registry) => registry.transaction(() => {
    assertAvailable(registry, binding.common_dir, home, dbPath, projectOf(db).project_id);
    const existing = bindingsOf(db).find((b) => b.common_dir === binding.common_dir);
    const repository = existing ? repositoriesOf(db).find((r) => r.repo_id === existing.repo_id) : {
      repo_id: binding.repo_id,
      purpose: input.purpose.trim(),
      access: input.access,
      remote: null,
      created_at: time()
    };
    if (existing && (repository.purpose !== input.purpose.trim() || repository.access !== input.access)) throw new KddError("repository binding conflict");
    if (!existing) db.transaction(() => {
      db.prepare("INSERT INTO repositories VALUES(@repo_id,@purpose,@access,@remote,@created_at)").run(repository);
      insertBinding(db, binding);
      audit(db, actor, "repository_added", { repository, binding });
    }).immediate();
    locateBinding(registry, db, dbPath, existing ?? binding);
    return { repository, binding: existing ?? binding };
  }).immediate());
}
function rebindRepository(db, dbPath, home, input, actor) {
  const oldPath = canonicalProjectPath(input.fromCommonDir);
  const newCommon = canonicalCommonDir(input.cwd);
  return withRegistry(home, (registry) => registry.transaction(() => {
    const project = projectOf(db);
    let previous = bindingsOf(db).find((b) => b.common_dir === oldPath);
    const existing = bindingsOf(db).find((b) => b.common_dir === newCommon);
    const history = db.prepare("SELECT detail FROM events WHERE action='repository_rebound' AND json_valid(detail) ORDER BY id DESC").all();
    const repeated = !previous && existing && history.some((e) => {
      const change = JSON.parse(e.detail);
      return change.from_common_dir === oldPath && change.binding.common_dir === newCommon && change.binding.repo_id === existing.repo_id;
    });
    if (!previous && !repeated && (project.primary_repo_id || canonicalProjectPath(meta(db, "project_path") ?? "") !== oldPath)) throw new KddError("unknown original source binding");
    const oldRow = registry.prepare("SELECT * FROM bindings WHERE common_dir=?").get(oldPath);
    if (oldRow && (oldRow.project_id !== project.project_id || resolve(oldRow.db_path) !== resolve(dbPath))) throw new KddError("repository binding conflict");
    const repoId = previous?.repo_id ?? existing?.repo_id ?? id();
    assertAvailable(registry, newCommon, home, dbPath, project.project_id, repoId);
    if (existing && !repeated && previous?.common_dir !== existing.common_dir) throw new KddError("repository binding conflict");
    const binding = repeated ? existing : checkoutBinding(input.cwd, repoId, previous?.kind ?? "source");
    catalogStore(db, dbPath, home);
    if (!repeated && oldPath !== newCommon) db.transaction(() => {
      if (!previous) {
        db.prepare("INSERT INTO repositories VALUES(?,?,?,NULL,?)").run(repoId, "primary", "implementation", time());
        db.prepare("UPDATE project SET primary_repo_id=? WHERE singleton=1").run(repoId);
      } else db.prepare("DELETE FROM repository_bindings WHERE common_dir=?").run(oldPath);
      insertBinding(db, binding);
      if (previous?.kind === "source" && project.primary_repo_id === repoId || !project.primary_repo_id) {
        const oldDefault = previous ? join(previous.checkout_path, ".planning", "decisions") : null;
        if (!project.legacy_decisions_dir || project.legacy_decisions_dir === oldDefault) {
          db.prepare("UPDATE project SET legacy_decisions_dir=? WHERE singleton=1").run(join(binding.checkout_path, ".planning", "decisions"));
        }
        db.prepare("INSERT INTO meta(key,value) VALUES('project_path',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(newCommon);
        if (meta(db, "project_toplevel")) db.prepare("UPDATE meta SET value=? WHERE key='project_toplevel'").run(binding.checkout_path);
      }
      audit(db, actor, "repository_rebound", { from_common_dir: oldPath, binding });
    }).immediate();
    if (oldPath !== newCommon) registry.prepare("DELETE FROM bindings WHERE common_dir=?").run(oldPath);
    locateBinding(registry, db, dbPath, binding);
    return binding;
  }).immediate());
}
function canSyncLegacyDecisions(db, decisionsDir) {
  const project = projectOf(db);
  if (!project.primary_repo_id && db.memory) return true;
  const bindings = bindingsOf(db);
  const source = bindings.find((b) => b.repo_id === project.primary_repo_id && b.kind === "source");
  if (project.primary_repo_id && (!source || !existsSync(source.common_dir))) return false;
  const path = canonicalProjectPath(decisionsDir);
  if (project.legacy_decisions_dir && (!source || resolve(project.legacy_decisions_dir) !== join(source.checkout_path, ".planning", "decisions"))) {
    return path === resolve(project.legacy_decisions_dir);
  }
  if (!project.primary_repo_id) return false;
  let ancestor = path;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  try {
    const common = canonicalCommonDir(ancestor);
    return bindings.some((b) => b.repo_id === project.primary_repo_id && b.kind === "source" && b.common_dir === common);
  } catch {
    return false;
  }
}
function assertLegacyDecisionSource(db, decisionsDir) {
  if (!canSyncLegacyDecisions(db, decisionsDir)) throw new KddError("legacy decisions require the primary project source; foreign repositories may read the shared index");
}

// src/db.ts
import { homedir } from "os";
var now = () => Math.floor(Date.now() / 1e3);
function backupBeforeMigrate(db, dbPath, from) {
  const backup = `${dbPath}.v${from}.bak`;
  const tmp = `${backup}.${process.pid}.tmp`;
  const q = (p) => p.replace(/'/g, "''");
  try {
    rmSync2(tmp, { force: true });
    db.exec(`VACUUM INTO '${q(tmp)}'`);
    const copy = new Database2(tmp, { readonly: true });
    const copied = copy.pragma("user_version", { simple: true });
    copy.close();
    if (copied !== from) {
      rmSync2(tmp, { force: true });
      return;
    }
    renameSync2(tmp, backup);
  } catch (e) {
    rmSync2(tmp, { force: true });
    db.close();
    throw new KddError(
      `cannot back up the board before migrating it to v${MIGRATIONS.length}: ${e instanceof Error ? e.message : String(e)} (wanted ${backup})`
    );
  }
}
function openDb(dbPath, projectPath, checkout) {
  if (dbPath !== ":memory:") mkdirSync2(dirname2(dbPath), { recursive: true });
  const db = new Database2(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  const from = db.pragma("user_version", { simple: true });
  if (from > MIGRATIONS.length) {
    db.close();
    throw new KddError(
      `board at ${dbPath} has schema v${from}, this kdd only knows v${MIGRATIONS.length} \u2014 update kdd (npm i -g @kddkit/cli), or run the version that created it`
    );
  }
  if (from > 0 && from < MIGRATIONS.length && dbPath !== ":memory:") {
    backupBeforeMigrate(db, dbPath, from);
  }
  for (let i = from; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      const current = db.pragma("user_version", { simple: true });
      if (current > MIGRATIONS.length) throw new KddError("board schema changed to an unknown version during migration");
      if (current > i) return;
      db.exec(MIGRATIONS[i]);
      db.pragma(`user_version = ${i + 1}`);
    }).immediate();
  }
  if (from === 0 && projectPath) {
    db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('project_path', ?)`).run(projectPath);
  }
  const configuredDecisions = process.env.KDD_DECISIONS_DIR;
  if (from === 0 && configuredDecisions) {
    db.transaction(() => db.prepare("UPDATE project SET legacy_decisions_dir=? WHERE singleton=1").run(canonicalProjectPath(configuredDecisions)))();
  }
  try {
    initializeProjectStore(
      db,
      dbPath,
      process.env.KDD_HOME ?? join2(homedir(), ".kdd"),
      projectPath,
      checkout,
      { legacyUpgrade: from > 0 && from < 13, configuredDecisions: from < 13 ? configuredDecisions : void 0 }
    );
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}
function checkpointWal(db) {
  try {
    db.pragma("busy_timeout = 0");
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
  } finally {
    try {
      db.pragma("busy_timeout = 5000");
    } catch {
    }
  }
}
function closeDb(db) {
  checkpointWal(db);
  db.close();
}
function projectPathOf(db) {
  return db.prepare(`SELECT value FROM meta WHERE key = 'project_path'`).get()?.value ?? null;
}
function projectToplevelOf(db) {
  return db.prepare(`SELECT value FROM meta WHERE key = 'project_toplevel'`).get()?.value ?? null;
}
function setProjectToplevel(db, toplevel) {
  const primary = projectOf(db).primary_repo_id;
  if (primary) {
    try {
      const common = canonicalCommonDir(toplevel);
      if (!bindingsOf(db).some((b) => b.repo_id === primary && b.kind === "source" && b.common_dir === common)) return;
    } catch {
      return;
    }
  }
  db.transaction(() => {
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('project_toplevel', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(toplevel);
  })();
}

// src/paths.ts
import { execFileSync as execFileSync2 } from "child_process";
import { createHash } from "crypto";
import { existsSync as existsSync2, readdirSync as readdirSync2 } from "fs";
import { homedir as homedir2 } from "os";
import { join as join3, resolve as resolve2 } from "path";
import Database3 from "better-sqlite3";
import { realpathSync as realpathSync2 } from "fs";
var kddHome = () => process.env.KDD_HOME ?? join3(homedir2(), ".kdd");
var storeIdentity = () => createHash("sha256").update(resolve2(kddHome())).update("\0").update(process.env.KDD_DB ? resolve2(process.env.KDD_DB) : "").digest("hex").slice(0, 16);
function resolveDbPath(cwd = process.cwd()) {
  if (process.env.KDD_DB) return { dbPath: process.env.KDD_DB, projectPath: cwd };
  let common;
  try {
    common = execFileSync2(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
  } catch {
    throw new KddError("not in a git repository (kdd resolves its store via git)");
  }
  const registered2 = lookupProjectStore(realpathSync2(common), kddHome());
  if (registered2) return registered2;
  const hash2 = createHash("sha256").update(common).digest("hex").slice(0, 16);
  return { dbPath: join3(kddHome(), hash2, "kdd.db"), projectPath: common };
}
function resolveDecisionsDir(cwd = process.cwd()) {
  if (process.env.KDD_DECISIONS_DIR) return process.env.KDD_DECISIONS_DIR;
  let top;
  try {
    top = execFileSync2(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
  } catch {
    throw new KddError("not in a git repository (kdd resolves .planning via git)");
  }
  return join3(top, ".planning", "decisions");
}
function resolveToplevel(cwd = process.cwd()) {
  if (process.env.KDD_TOPLEVEL) return process.env.KDD_TOPLEVEL;
  try {
    return execFileSync2(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
  } catch {
    throw new KddError("not in a git repository (kdd tick resolves worker cwd via git)");
  }
}
function listProjects() {
  const home = kddHome();
  if (!existsSync2(home)) return [];
  const out = [];
  for (const entry of readdirSync2(home, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dbPath = join3(home, entry.name, "kdd.db");
    if (!existsSync2(dbPath)) continue;
    try {
      const db = new Database3(dbPath, { readonly: true });
      const rows = db.prepare(
        `SELECT key, value FROM meta WHERE key IN ('project_path','autotick_enabled')`
      ).all();
      db.close();
      const meta2 = new Map(rows.map((r) => [r.key, r.value]));
      out.push({
        dbPath,
        projectPath: meta2.get("project_path") ?? "(unknown)",
        autoTickEnabled: meta2.get("autotick_enabled") === "1"
      });
    } catch {
    }
  }
  return out;
}

// src/state.ts
var STATUSES = ["backlog", "new", "in_progress", "review", "done"];
var MAX_FAILED_ATTEMPTS = 3;
var PRIORITIES = ["low", "medium", "high", "urgent"];
var KINDS = ["feature", "bug", "chore", "research"];
function normalizeSessionId(raw) {
  return typeof raw === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(raw) ? raw : void 0;
}
function manualSessionFromEnv(cwd = process.cwd()) {
  const e = process.env;
  if (e.KDD_SESSION) return void 0;
  if (e.CLAUDECODE === "1" || e.CLAUDE_CODE_SESSION_ID) {
    return { client: "claude", sessionId: normalizeSessionId(e.CLAUDE_CODE_SESSION_ID), cwd };
  }
  if (e.CODEX_SESSION_ID || e.CODEX_THREAD_ID) {
    return {
      client: "codex",
      sessionId: normalizeSessionId(e.CODEX_SESSION_ID) ?? normalizeSessionId(e.CODEX_THREAD_ID),
      cwd
    };
  }
  return void 0;
}
var TRANSITIONS = {
  backlog: ["new"],
  new: ["backlog", "in_progress"],
  in_progress: ["new", "review"],
  review: ["in_progress", "done"],
  done: ["review"]
};
var authorOf = (a) => a.type === "ai" ? `ai:${a.id ?? "?"}` : "user";
function agentId() {
  const e = process.env;
  const cc = e.CLAUDE_CODE_SESSION_ID ? `cc:${e.CLAUDE_CODE_SESSION_ID.slice(0, 8)}` : void 0;
  const codex = e.CODEX_SESSION_ID || e.CODEX_THREAD_ID;
  return e.KDD_SESSION || cc || (e.CLAUDE_PID ? `cc:pid-${e.CLAUDE_PID}` : void 0) || (codex ? `codex:${codex}` : void 0);
}
function checkMove(from, to, actor, reason, openCriteria2 = 0, claimedBy = null, submittedBy2 = null) {
  if (from === to) return { ok: false, error: `task is already in ${to}` };
  if (actor.type === "user") return { ok: true };
  if (reason) return { ok: true };
  if (from === "review" && to === "done" && submittedBy2 === authorOf(actor)) {
    return {
      ok: false,
      error: `you submitted this task for review yourself; accepting it is someone else's call \u2014 ask the user, and pass a reason if they told you to close it`
    };
  }
  if (from === "in_progress" && claimedBy?.startsWith("ai:") && claimedBy !== `ai:${actor.id ?? "?"}`) {
    return {
      ok: false,
      error: `lease lost (held by ${claimedBy}); you no longer own this task \u2014 stop work`
    };
  }
  if (!TRANSITIONS[from].includes(to)) {
    return {
      ok: false,
      error: `invalid transition ${from} \u2192 ${to} for ai; allowed: ${TRANSITIONS[from].join(", ")}; pass a reason if the user requested a skip`
    };
  }
  if (to === "review" && openCriteria2 > 0) {
    return {
      ok: false,
      error: `cannot move to review: ${openCriteria2} unchecked acceptance criteria; check them (kdd criteria check) or pass a reason if the user asked to skip`
    };
  }
  return { ok: true };
}

// src/controller.ts
var controllers = /* @__PURE__ */ new WeakMap();
function controllerDb(handle) {
  const db = typeof handle === "object" && handle !== null ? controllers.get(handle) : void 0;
  if (!db?.open || db.pragma("user_version", { simple: true }) !== MIGRATIONS.length) {
    throw new KddError("controller authority denied");
  }
  return db;
}
function openController(db) {
  if (!db.open || db.pragma("user_version", { simple: true }) !== MIGRATIONS.length) {
    throw new KddError("controller authority denied");
  }
  projectOf(db);
  const handle = Object.freeze({ kind: "controller" });
  controllers.set(handle, db);
  return handle;
}

// src/execution.ts
import { createHash as createHash10, randomBytes as randomBytes2 } from "crypto";

// src/execution_results.ts
import { createHash as createHash2 } from "crypto";
import { readFileSync as readFileSync2, statSync } from "fs";
import { isAbsolute } from "path";
var terminal = (item) => ["completed", "failed", "cancelled"].includes(item.state);
function rowResult(db, id2) {
  text(id2);
  const row = db.prepare("SELECT * FROM work_item_results WHERE id=?").get(id2);
  if (!row) throw new KddError("result not found");
  const metadata = JSON.parse(row.source_json);
  return {
    id: row.id,
    commandId: row.command_id,
    binding: metadata.binding,
    payload: JSON.parse(row.payload_json),
    source: metadata.source,
    inputResults: metadata.inputResults,
    invalidatedAt: row.invalidated_at,
    invalidationReason: row.invalidation_reason,
    successorId: row.successor_id
  };
}
function result(handle, resultId) {
  return rowResult(controllerDb(handle), resultId);
}
function checkPayload(db, payload) {
  dependencyKind(payload?.kind);
  const fields = {
    contract: ["head", "artifact"],
    code: ["head", "proofRef"],
    merged: ["head", "target", "baseHead", "acceptedResultId", "userRef", "receiptRef"],
    readiness: ["resourceId", "configHash", "consumerScope", "capabilities", "userRef", "probeRef", "observedAt", "expiresAt"]
  }[payload.kind];
  shape(payload, ["kind", "repoId", "version", "checkRefs", ...fields]);
  checkRepo(db, payload.repoId);
  text(payload.version);
  strings(payload.checkRefs);
  if (payload.kind === "contract") {
    if (payload.head !== null) text(payload.head);
    shape(payload.artifact, ["path", "sha256"]);
    text(payload.artifact.path);
    if (!isAbsolute(payload.artifact.path) || !/^[a-f0-9]{64}$/.test(payload.artifact.sha256)) throw new KddError("invalid artifact");
  } else if (payload.kind === "code" || payload.kind === "merged") {
    if (payload.repoId === null) throw new KddError("result requires repository");
    text(payload.head);
    if (payload.kind === "code") text(payload.proofRef);
    else {
      text(payload.target);
      text(payload.baseHead);
      text(payload.acceptedResultId);
      text(payload.userRef);
      text(payload.receiptRef);
    }
  } else {
    text(payload.resourceId);
    text(payload.configHash);
    text(payload.consumerScope);
    strings(payload.capabilities);
    text(payload.userRef);
    text(payload.probeRef);
    if (!Number.isFinite(payload.observedAt) || payload.observedAt < 0 || payload.observedAt > now() || payload.expiresAt !== null && (!Number.isFinite(payload.expiresAt) || payload.expiresAt <= payload.observedAt)) throw new KddError("invalid readiness time");
  }
}
function checkResultSource(db, item, source) {
  shape(source, source?.kind === "manual" ? ["kind", "sourceTask", "instructionRef"] : ["kind", "owner", "instructionRef"], source?.kind === "owned" ? ["authority"] : []);
  text(source.instructionRef);
  assertNoHandoff(db, item.task.taskId);
  if (source.kind === "manual") {
    scopedTask(db, source.sourceTask);
    if (source.sourceTask.taskId !== item.task.taskId) throw new KddError("result source task mismatch");
    if (db.prepare("SELECT 1 FROM work_item_owners WHERE work_item_id=? AND released_at IS NULL").get(item.ref.workItemId)) throw new KddError("owned work requires ownership fence");
  } else if (source.kind === "owned") {
    const owner = liveOwner(db, source.owner);
    if (owner.work_item_id !== item.ref.workItemId || owner.revision !== item.revision) throw new KddError("source ownership mismatch");
    if (source.authority !== void 0) {
      checkAuthority(db, item.task, source.authority);
      if (source.authority.workItemId !== item.ref.workItemId) throw new KddError("source authority mismatch");
      const grant = JSON.parse(db.prepare("SELECT grant_json FROM run_authorities WHERE authority_id=?").get(source.authority.authorityId).grant_json);
      if (canonical(grant.ownership) !== canonical(source.owner)) throw new KddError("source authority ownership mismatch");
    }
  } else throw new KddError("invalid result source");
}
function pass(observers, request, fresh = false) {
  try {
    const expected = canonical(request), time2 = now(), observed = observers.observe?.(request);
    if (!observed) return false;
    shape(observed, ["request", "verdict", "origin", "observedAt", "expiresAt"]);
    const origin = request.kind === "merge_acceptance" || request.kind === "readiness_confirmation" ? "user" : "host";
    return canonical(observed.request) === expected && observed.verdict === "pass" && observed.origin === origin && Number.isFinite(observed.observedAt) && observed.observedAt >= 0 && observed.observedAt <= now() && (!fresh || observed.observedAt >= time2) && (observed.expiresAt === null || Number.isFinite(observed.expiresAt) && observed.expiresAt > now() && observed.expiresAt > observed.observedAt);
  } catch {
    return false;
  }
}
function validateResult(db, record, required, observers, path, candidate = false, currentOnly = false) {
  const key = record.id;
  if (path.has(key)) return "stale_revision";
  path.add(key);
  try {
    const item = scopedWorkItem(db, record.binding.producer), payload = record.payload, binding = record.binding;
    if (record.invalidatedAt !== null || item.revision !== binding.producerRevision || item.inputsHash !== binding.inputsHash || !inputsCurrent(db, item)) return "stale_revision";
    if (item.state === "failed" || item.state === "cancelled") return item.state;
    const output = item.definition.outputs.find((o) => o.key === binding.outputKey);
    if (!output || output.kind !== binding.kind || output.version !== binding.version || item.definition.repoId !== binding.repoId || payload.kind !== binding.kind || payload.repoId !== binding.repoId || payload.version !== binding.version) return "scope_mismatch";
    if (required && (required.kind !== payload.kind || required.repoId !== payload.repoId || required.version !== payload.version)) return "scope_mismatch";
    checkPayload(db, payload);
    if (!candidate) {
      const row = db.prepare("SELECT source_json FROM work_item_results WHERE id=?").get(record.id);
      if (!row) return "stale_revision";
      const meta2 = JSON.parse(row.source_json);
      if (meta2.fence !== item.fence) return "stale_revision";
      if (record.source.kind === "owned") {
        const owner = db.prepare("SELECT inputs_json FROM work_item_owners WHERE work_item_id=? AND fence=? AND revision=? AND owner_id=?").get(item.ref.workItemId, record.source.owner.fence, record.source.owner.revision, record.source.owner.ownerId);
        if (!owner || record.source.owner.fence !== item.fence || JSON.parse(owner.inputs_json).inputsHash !== item.inputsHash) return "stale_revision";
      }
    }
    for (const dep of item.dependencies) {
      const pin2 = record.inputResults.find((p) => p.edgeKey === dep.key);
      if (!pin2 || dep.resultId !== pin2.resultId) return "stale_revision";
      const reason = validateEdge(db, dep, observers, path, pin2.resultId, currentOnly).reason;
      if (reason) return reason;
    }
    if (record.inputResults.length !== item.dependencies.length) return "stale_revision";
    if (output.checkRefs.some((ref) => !payload.checkRefs.includes(ref))) return "checks_not_passed";
    const payloadHash = digest(payload);
    if (!currentOnly) {
      for (const ref of payload.checkRefs) if (!pass(observers, { kind: "check", ref, binding, payloadHash })) return "checks_not_passed";
    }
    switch (payload.kind) {
      case "contract": {
        if (!statSync(payload.artifact.path).isFile() || createHash2("sha256").update(readFileSync2(payload.artifact.path)).digest("hex") !== payload.artifact.sha256) return "stale_revision";
        return null;
      }
      case "code":
        if (currentOnly) return null;
        if (!pass(observers, { kind: "code_result", ref: payload.proofRef, binding, head: payload.head })) return "checks_not_passed";
        return required?.kind === "code" && !pass(observers, { kind: "code_in_base", ref: payload.proofRef, binding, head: payload.head, baseHead: required.baseHead }) ? "base_missing_code" : null;
      case "merged": {
        const accepted = rowResult(db, payload.acceptedResultId), producer = scopedWorkItem(db, accepted.binding.producer);
        if (accepted.payload.kind !== "code" || accepted.payload.repoId !== payload.repoId || accepted.payload.head !== payload.head || producer.state !== "completed" || validateResult(db, accepted, null, observers, path, false, currentOnly)) return "merge_not_succeeded";
        if (required?.kind === "merged" && (required.target !== payload.target || required.baseHead !== payload.baseHead)) return "scope_mismatch";
        const common = { binding, acceptedResultId: payload.acceptedResultId };
        return currentOnly || pass(observers, { kind: "merge_acceptance", ref: payload.userRef, ...common }) && pass(observers, { kind: "merge_receipt", ref: payload.receiptRef, ...common, target: payload.target, baseHead: payload.baseHead, head: payload.head }) ? null : "merge_not_succeeded";
      }
      case "readiness": {
        if (payload.expiresAt !== null && payload.expiresAt <= now()) return "readiness_expired";
        if (required?.kind === "readiness" && (required.resourceId !== payload.resourceId || required.configHash !== payload.configHash || required.consumerScope !== payload.consumerScope || canonical([...required.capabilities].sort()) !== canonical([...payload.capabilities].sort()))) return "scope_mismatch";
        if (currentOnly) return null;
        if (!pass(observers, { kind: "readiness_confirmation", ref: payload.userRef, binding, resourceId: payload.resourceId })) return "readiness_unconfirmed";
        return pass(observers, {
          kind: "readiness_probe",
          ref: payload.probeRef,
          binding,
          resourceId: payload.resourceId,
          configHash: payload.configHash,
          consumerScope: payload.consumerScope,
          capabilities: payload.capabilities
        }, true) ? null : "readiness_unverified";
      }
    }
  } catch {
    return "stale_revision";
  } finally {
    path.delete(key);
  }
}
function validateEdge(db, dep, observers, path, explicitId, currentOnly = false) {
  const producer = scopedWorkItem(db, dep.producer);
  const id2 = explicitId ?? dep.resultId ?? db.prepare("SELECT id FROM work_item_results WHERE producer_id=? AND producer_revision=? AND output_key=? AND invalidated_at IS NULL").get(dep.producer.workItemId, dep.producerRevision, dep.outputKey)?.id ?? null;
  if (producer.state === "failed" || producer.state === "cancelled") return { resultId: id2, reason: producer.state };
  if (producer.revision !== dep.producerRevision || !inputsCurrent(db, producer)) return { resultId: id2, reason: "stale_revision" };
  if (producer.state !== "completed") return { resultId: id2, reason: "producer_not_completed" };
  if (!id2) return { resultId: null, reason: "missing_output" };
  const record = rowResult(db, id2);
  if (record.binding.producer.workItemId !== dep.producer.workItemId || record.binding.producerRevision !== dep.producerRevision || record.binding.outputKey !== dep.outputKey) return { resultId: id2, reason: "scope_mismatch" };
  return { resultId: id2, reason: validateResult(db, record, dep.binding, observers, path, false, currentOnly) };
}
function pinnedInputsCurrent(db, item, pins) {
  try {
    return Array.isArray(pins) && pins.length === item.dependencies.length && item.dependencies.every((dep) => {
      const pin2 = pins.find((p) => p.edgeKey === dep.key);
      return !!pin2 && typeof pin2.resultId === "string" && dep.resultId === pin2.resultId && !validateEdge(db, dep, {}, /* @__PURE__ */ new Set(), pin2.resultId, true).reason;
    });
  } catch {
    return false;
  }
}
function dependencyProjection(db, item, observers = {}) {
  const current = inputsCurrent(db, item);
  const edges = item.dependencies.map((dep) => {
    const { resultId, reason } = validateEdge(db, dep, observers, /* @__PURE__ */ new Set());
    const base = { key: dep.key, producer: dep.producer, binding: dep.binding };
    return reason || resultId === null ? { ...base, satisfied: false, reason: reason ?? "missing_output", resultId } : { ...base, satisfied: true, resultId, pinned: dep.resultId !== void 0 };
  });
  return { ref: item.ref, revision: item.revision, inputsCurrent: current, ready: current && edges.every((e) => e.satisfied), edges };
}
function pin(db, item, projection) {
  if (!projection.ready) return projection;
  let changed = false;
  for (const edge of projection.edges) if (edge.satisfied && !edge.pinned) {
    db.prepare("UPDATE work_item_dependencies SET pinned_result_id=? WHERE consumer_id=? AND consumer_revision=? AND edge_key=? AND pinned_result_id IS NULL").run(edge.resultId, item.ref.workItemId, item.revision, edge.key);
    changed = true;
  }
  if (changed) appendEvent(db, item.task.taskId, controllerActor, "dependencies_resolved", {
    work_item_id: item.ref.workItemId,
    revision: item.revision,
    results: projection.edges.map((e) => ({ key: e.key, resultId: e.resultId }))
  });
  return { ...projection, edges: projection.edges.map((e) => e.satisfied ? { ...e, pinned: true } : e) };
}
function inspectDependencies(handle, ref, observers = {}) {
  const db = controllerDb(handle);
  return db.transaction(() => dependencyProjection(db, scopedWorkItem(db, ref), observers))();
}
function resolveDependencies(handle, input, observers = {}) {
  const db = controllerDb(handle);
  return db.transaction(() => {
    shape(input, ["ref", "expectedRevision"]);
    integer(input.expectedRevision);
    const item = scopedWorkItem(db, input.ref);
    assertNoHandoff(db, item.task.taskId);
    if (item.revision !== input.expectedRevision) throw new KddError("revision conflict");
    return pin(db, item, dependencyProjection(db, item, observers));
  }).immediate();
}
function publishResult(handle, input, observers = {}) {
  const db = controllerDb(handle);
  return db.transaction(() => {
    shape(input, ["commandId", "producer", "expectedRevision", "outputKey", "expectedResultId", "payload", "source"]);
    text(input.commandId);
    integer(input.expectedRevision);
    text(input.outputKey);
    if (input.expectedResultId !== null) text(input.expectedResultId);
    checkPayload(db, input.payload);
    const hash2 = digest(input), existing = db.prepare("SELECT id,command_hash FROM work_item_results WHERE command_id=?").get(input.commandId);
    if (existing && existing.command_hash !== hash2) throw new KddError("publication command conflict");
    const item = scopedWorkItem(db, input.producer);
    checkResultSource(db, item, input.source);
    if (existing) return rowResult(db, existing.id);
    if (item.revision !== input.expectedRevision || !inputsCurrent(db, item)) throw new KddError("stale revision or inputs");
    if (terminal(item)) throw new KddError("terminal work requires new work item");
    const output = item.definition.outputs.find((o) => o.key === input.outputKey);
    if (!output) throw new KddError("undeclared output");
    const deps = pin(db, item, dependencyProjection(db, item, observers));
    if (!deps.ready) throw new KddError("input dependencies not verified");
    const inputResults = deps.edges.map((e) => ({ edgeKey: e.key, resultId: e.resultId }));
    const binding = {
      producer: item.ref,
      producerRevision: item.revision,
      inputsHash: item.inputsHash,
      outputKey: input.outputKey,
      kind: output.kind,
      version: output.version,
      repoId: item.definition.repoId
    };
    const candidate = {
      id: newId(),
      commandId: "candidate",
      binding,
      payload: input.payload,
      source: input.source,
      inputResults,
      invalidatedAt: null,
      invalidationReason: null,
      successorId: null
    };
    const reason = validateResult(db, candidate, null, observers, /* @__PURE__ */ new Set(), true);
    if (reason) throw new KddError(`result verification failed: ${reason}`);
    const current = db.prepare("SELECT id FROM work_item_results WHERE producer_id=? AND producer_revision=? AND output_key=? AND invalidated_at IS NULL").get(item.ref.workItemId, item.revision, input.outputKey);
    if ((current?.id ?? null) !== input.expectedResultId) throw new KddError("output result conflict");
    if (current) db.prepare("UPDATE work_item_results SET invalidated_at=?,invalidation_reason=?,successor_id=? WHERE id=?").run(now(), "superseded", candidate.id, current.id);
    db.prepare("INSERT INTO work_item_results(id,command_id,command_hash,producer_id,producer_revision,output_key,kind,payload_json,source_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(
      candidate.id,
      input.commandId,
      hash2,
      item.ref.workItemId,
      item.revision,
      input.outputKey,
      input.payload.kind,
      canonical(input.payload),
      canonical({ source: input.source, binding, inputResults, fence: item.fence }),
      now()
    );
    appendEvent(db, item.task.taskId, controllerActor, "result_published", { result_id: candidate.id, commandId: input.commandId, binding, supersedes: current?.id ?? null });
    return rowResult(db, candidate.id);
  }).immediate();
}
function invalidateResult(handle, input) {
  const db = controllerDb(handle);
  return db.transaction(() => {
    shape(input, ["commandId", "resultId", "reason"], ["successorId"]);
    text(input.commandId);
    text(input.resultId);
    text(input.reason);
    const old = rowResult(db, input.resultId);
    const replay = db.prepare("SELECT detail FROM events WHERE action='result_invalidated' AND json_valid(detail) AND json_extract(detail,'$.commandId')=?").get(input.commandId);
    if (replay) {
      if (canonical(JSON.parse(replay.detail)) !== canonical(input)) throw new KddError("invalidation command conflict");
      return old;
    }
    assertNoHandoff(db, scopedWorkItem(db, old.binding.producer).task.taskId);
    if (old.invalidatedAt !== null) throw new KddError("result already invalidated");
    if (input.successorId !== void 0) {
      text(input.successorId);
      const successor = rowResult(db, input.successorId);
      if (successor.id === old.id || successor.binding.kind !== old.binding.kind || successor.binding.repoId !== old.binding.repoId || successor.invalidatedAt !== null) throw new KddError("incompatible successor");
    }
    db.prepare("UPDATE work_item_results SET invalidated_at=?,invalidation_reason=?,successor_id=? WHERE id=?").run(now(), input.reason, input.successorId ?? null, old.id);
    appendEvent(db, scopedWorkItem(db, old.binding.producer).task.taskId, controllerActor, "result_invalidated", input);
    return rowResult(db, old.id);
  }).immediate();
}
function completeWorkItem(handle, input, observers = {}) {
  const db = controllerDb(handle);
  return db.transaction(() => {
    shape(input, ["ref", "expectedRevision", "source"]);
    integer(input.expectedRevision);
    const item = scopedWorkItem(db, input.ref);
    checkResultSource(db, item, input.source);
    if (item.revision !== input.expectedRevision || !inputsCurrent(db, item)) throw new KddError("stale revision or inputs");
    if (item.state === "failed" || item.state === "cancelled") throw new KddError("terminal work requires new work item");
    if (!pin(db, item, dependencyProjection(db, item, observers)).ready) throw new KddError("dependencies not verified");
    for (const output of item.definition.outputs.filter((o) => o.required)) {
      const row = db.prepare("SELECT id FROM work_item_results WHERE producer_id=? AND producer_revision=? AND output_key=? AND invalidated_at IS NULL").get(item.ref.workItemId, item.revision, output.key);
      const reason = row ? validateResult(db, rowResult(db, row.id), null, observers, /* @__PURE__ */ new Set()) : "missing_output";
      if (reason) throw new KddError(`mandatory output not verified: ${reason}`);
    }
    if (item.state !== "completed") {
      db.prepare("UPDATE work_items SET state='completed' WHERE id=?").run(item.ref.workItemId);
      appendEvent(db, item.task.taskId, controllerActor, "work_item_completed", { work_item_id: item.ref.workItemId, revision: item.revision });
    }
    return scopedWorkItem(db, item.ref);
  }).immediate();
}
function setWorkItemWaiting(handle, input) {
  return setState(handle, input, "waiting_input");
}
function endWorkItem(handle, input) {
  const db = controllerDb(handle);
  shape(input, ["ref", "expectedRevision", "source", "state"]);
  if (input.state !== "failed" && input.state !== "cancelled") throw new KddError("invalid end state");
  return setStateWithDb(db, { ref: input.ref, expectedRevision: input.expectedRevision, source: input.source }, input.state);
}
function setState(handle, input, state) {
  return setStateWithDb(controllerDb(handle), input, state);
}
function setStateWithDb(db, input, state) {
  return db.transaction(() => {
    shape(input, ["ref", "expectedRevision", "source"]);
    integer(input.expectedRevision);
    const item = scopedWorkItem(db, input.ref);
    checkResultSource(db, item, input.source);
    if (item.revision !== input.expectedRevision || !inputsCurrent(db, item)) throw new KddError("stale revision or inputs");
    if (terminal(item) || state === "waiting_input" && !["pending", "ready"].includes(item.state)) throw new KddError("invalid state transition");
    if (db.prepare("SELECT 1 FROM work_item_owners WHERE work_item_id=? AND released_at IS NULL AND launch_id IS NOT NULL").get(item.ref.workItemId)) throw new KddError("launched owner must stop");
    db.prepare("UPDATE work_items SET state=? WHERE id=?").run(state, item.ref.workItemId);
    appendEvent(db, item.task.taskId, controllerActor, "work_item_state", { work_item_id: item.ref.workItemId, revision: item.revision, state });
    return scopedWorkItem(db, item.ref);
  }).immediate();
}

// src/memory.ts
import { execFileSync as execFileSync4 } from "child_process";
import { realpathSync as realpathSync4 } from "fs";
import { isAbsolute as isAbsolute3 } from "path";

// src/agent_events.ts
function parseClaudeStreamLine(line) {
  const s = line.trim();
  if (!s) return [];
  let msg;
  try {
    msg = JSON.parse(s);
  } catch {
    return [];
  }
  if (msg?.type === "assistant" && Array.isArray(msg.message?.content)) {
    const out = [];
    for (const b of msg.message.content) {
      if (b?.type === "text" && typeof b.text === "string") out.push({ kind: "text", detail: { text: b.text } });
      else if (b?.type === "tool_use") out.push({ kind: "tool_start", name: b.name, detail: { id: b.id, input: b.input } });
    }
    return out;
  }
  if (msg?.type === "user" && Array.isArray(msg.message?.content)) {
    const out = [];
    for (const b of msg.message.content) {
      if (b?.type === "tool_result") out.push({
        kind: "tool_finish",
        detail: { id: b.tool_use_id, output: b.content, isError: !!b.is_error }
      });
    }
    return out;
  }
  return [];
}
var SECRETS = [
  [/-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g, "[redacted key]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted]"],
  // openai/anthropic
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted]"],
  // github
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"],
  // aws access key id
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  // slack
  [/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, "[redacted jwt]"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi, "Bearer [redacted]"],
  // Только форма ДАМПА окружения: имя с начала строки, `=` без пробелов, значение без
  // пробелов. Не «любое упоминание» — ревью поймало, что широкая версия съедала
  // `API_KEY: string;` и `const GITHUB_TOKEN = cfg.token` в обычном исходнике, который
  // агент правит через Edit. Редакция стоит ДО записи, то есть портила бы файл навсегда:
  // читающий фид не отличил бы правку аннотации типа от правки секрета. Двоеточие ушло
  // целиком (YAML-секрет реже, чем TS-аннотация), длина имени ограничена — с ней regex
  // линеен, а прежний `[A-Z0-9_]*(?:TOKEN|…)` откатывался квадратично.
  [
    /^(export\s+)?([A-Z][A-Z0-9_]{0,48}(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIALS?))=(\S{8,})$/gm,
    "$1$2=[redacted]"
  ]
];
function redact(s) {
  let out = s;
  for (const [re, to] of SECRETS) out = out.replace(re, to);
  return out;
}
function capValue(v, depth) {
  if (typeof v === "string") return redact(capText(v, CAPS.agentFieldChars));
  if (depth >= 8) return "\u2026 [too deep]";
  if (Array.isArray(v)) {
    const kept = v.slice(0, CAPS.agentDetailItems).map((x) => capValue(x, depth + 1));
    if (v.length > kept.length) kept.push({ type: "text", text: `\u2026 [+${v.length - kept.length} items]` });
    return kept;
  }
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capValue(x, depth + 1)]));
  }
  return v;
}
var bytes = (s) => Buffer.byteLength(s, "utf8");
function capDetail(detail) {
  const capped = capValue(detail, 0);
  const json = JSON.stringify(capped);
  if (bytes(json) <= CAPS.agentDetailBytes) return json;
  const shrunk = Object.fromEntries(Object.entries(capped).map(([k, v]) => [k, v !== null && typeof v === "object" ? { truncated: bytes(JSON.stringify(v)) } : v]));
  const small = JSON.stringify(shrunk);
  return bytes(small) <= CAPS.agentDetailBytes ? small : JSON.stringify({ truncated: bytes(json) });
}
function appendAgentEvent(db, taskId, workerId, kind, opts) {
  return db.transaction(() => {
    const r = db.prepare(
      `INSERT INTO agent_events (task_id, worker_id, kind, name, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      taskId,
      workerId,
      kind,
      opts?.name ?? null,
      opts?.detail ? capDetail(opts.detail) : null,
      now()
    );
    return Number(r.lastInsertRowid);
  })();
}
var PRUNE_MARK = "agent_events_pruned_at";
function pruneAgentEvents(db, days = CAPS.agentEventDays, opts = {}) {
  const at = now();
  const last = Number(db.prepare(`SELECT value FROM meta WHERE key = ?`).get(PRUNE_MARK)?.value ?? 0);
  if (!opts.force && at - last < 86400) return 0;
  const cutoff = at - days * 86400;
  return db.transaction(() => {
    const n = db.prepare(
      `DELETE FROM agent_events WHERE id IN (
         SELECT ae.id FROM agent_events ae JOIN tasks t ON t.id = ae.task_id
          WHERE ae.kind IN ('text','tool_start','tool_finish')
            AND (t.status = 'done' OR t.archived_at IS NOT NULL)
            AND COALESCE(t.archived_at, t.updated_at) < ?
          LIMIT ?)`
    ).run(cutoff, CAPS.agentPruneBatch).changes;
    if (n < CAPS.agentPruneBatch) {
      db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run(PRUNE_MARK, String(at));
    }
    return n;
  })();
}
function listAgentEvents(db, taskId, opts) {
  return db.prepare(
    `SELECT * FROM agent_events WHERE task_id = ? AND id > ? ORDER BY id LIMIT ?`
  ).all(taskId, opts?.sinceId ?? 0, opts?.limit ?? 500);
}
function lastAgentEventKind(db, taskId, workerId) {
  const r = db.prepare(
    `SELECT kind FROM agent_events WHERE task_id = ? AND worker_id = ? ORDER BY id DESC LIMIT 1`
  ).get(taskId, workerId);
  return r?.kind ?? null;
}
function runProduced(db, taskId) {
  const end = db.prepare(
    `SELECT id, detail FROM agent_events WHERE task_id = ? AND kind = 'run_end' ORDER BY id DESC LIMIT 1`
  ).get(taskId);
  if (!end) return null;
  const dangling = db.prepare(
    `SELECT 1 FROM agent_events WHERE task_id = ? AND kind = 'run_start' AND id > ? LIMIT 1`
  ).get(taskId, end.id);
  if (dangling) return null;
  const start = db.prepare(
    `SELECT detail FROM agent_events WHERE task_id = ? AND kind = 'run_start' AND id < ? ORDER BY id DESC LIMIT 1`
  ).get(taskId, end.id);
  if (!start) return null;
  const before = headOf(start.detail);
  const after = headOf(end.detail);
  if (before === null || after === null) return null;
  return { before, after, committed: before !== after };
}
function headOf(detail) {
  if (!detail) return null;
  try {
    const h = JSON.parse(detail).head;
    return typeof h === "string" ? h : null;
  } catch {
    return null;
  }
}

// src/memory_import.ts
import { execFileSync as execFileSync3 } from "child_process";
import { createHash as createHash4 } from "crypto";
import { basename as basename2, posix, isAbsolute as isAbsolute2 } from "path";

// src/decisions.ts
import { createHash as createHash3 } from "crypto";
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readFileSync as readFileSync3, readdirSync as readdirSync3, realpathSync as realpathSync3, writeFileSync as writeFileSync2 } from "fs";
import { dirname as dirname3, join as join4 } from "path";
function slugify(title) {
  const s = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  return s || "untitled";
}
var normalize = (s) => s.replace(/\r\n/g, "\n").trim();
function contentHash(title, body) {
  return createHash3("sha256").update(`${normalize(title)}
${normalize(body)}`).digest("hex");
}
function normalizeSourceTasks(ids = []) {
  for (const id2 of ids) {
    if (!Number.isInteger(id2) || id2 < 1) throw new KddError(`invalid source task id '${id2}'`);
  }
  return [...new Set(ids)].sort((a, b) => a - b);
}
function parseSourceTasks(value) {
  if (value === void 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new KddError("invalid source_tasks frontmatter");
  }
  if (!Array.isArray(parsed)) throw new KddError("invalid source_tasks frontmatter");
  try {
    return normalizeSourceTasks(parsed);
  } catch {
    throw new KddError("invalid source_tasks frontmatter");
  }
}
function renderDecisionBody(input) {
  if (input.body !== void 0) return normalize(input.body);
  const sec = (name, v) => `## ${name}
${normalize(v ?? "") || "-"}`;
  return [
    sec("Decision", input.decision),
    sec("Rationale", input.rationale),
    sec("Alternatives", input.alternatives),
    sec("Supersedes", input.supersedes),
    sec("Outcome", input.outcome)
  ].join("\n\n");
}
function renderDecisionMd(input, created) {
  const sources = normalizeSourceTasks(input.sourceTasks);
  return `---
created: ${created}
status: active
superseded_by:
source_tasks: [${sources.join(", ")}]
---
# ${input.title.trim()}

${renderDecisionBody(input)}
`;
}
function parseDecisionMd(raw) {
  const text2 = raw.replace(/\r\n/g, "\n");
  const fm = {};
  let rest = text2;
  if (text2.startsWith("---\n")) {
    const end = text2.indexOf("\n---\n", 4);
    if (end !== -1) {
      for (const line of text2.slice(4, end).split("\n")) {
        const m = line.match(/^(\w+):\s*(.*)$/);
        if (m) fm[m[1]] = m[2].trim();
      }
      rest = text2.slice(end + 5);
    }
  }
  const tm = rest.match(/^# (.+)$/m);
  const title = tm ? tm[1].trim() : "";
  const indexBody = tm ? rest.slice(rest.indexOf(tm[0]) + tm[0].length).trim() : rest.trim();
  return {
    title,
    created: fm.created ?? "",
    status: fm.status || "active",
    supersededBy: fm.superseded_by ?? "",
    indexBody,
    hash: contentHash(title, indexBody),
    sourceTasks: parseSourceTasks(fm.source_tasks)
  };
}
function supersede(db, dir, oldSlug, newSlug) {
  const p = join4(dir, `${oldSlug}.md`);
  if (!existsSync3(p)) throw new KddError(`decision '${oldSlug}' not found`);
  assertLegacyDecisionSource(db, dirname3(realpathSync3(p)));
  let raw = readFileSync3(p, "utf8").replace(/\r\n/g, "\n");
  if (raw.startsWith("---\n") && /^status:/m.test(raw)) {
    raw = raw.replace(/^status:.*$/m, "status: superseded").replace(/^superseded_by:.*$/m, `superseded_by: ${newSlug}`);
  } else {
    const doc = parseDecisionMd(raw);
    raw = `---
created: ${doc.created}
status: superseded
superseded_by: ${newSlug}
---
${raw}`;
  }
  writeFileSync2(p, raw);
  db.prepare(`UPDATE decisions SET superseded_by = ? WHERE slug = ?`).run(newSlug, oldSlug);
}
function addDecision(db, decisionsDir, input) {
  assertLegacyDecisionSource(db, decisionsDir);
  if (!input.title.trim()) throw new KddError("title must not be empty");
  if (input.body !== void 0 && [input.decision, input.rationale, input.alternatives, input.outcome].some((v) => v !== void 0)) {
    throw new KddError("--body is mutually exclusive with section flags");
  }
  const sourceTasks = normalizeSourceTasks(input.sourceTasks);
  for (const id2 of sourceTasks) {
    if (!db.prepare(`SELECT 1 FROM tasks WHERE id = ?`).get(id2)) {
      throw new KddError(`task #${id2} not found`);
    }
  }
  const body = renderDecisionBody(input);
  const hash2 = contentHash(input.title, body);
  const provenance = JSON.stringify(sourceTasks);
  let fileDup;
  if (existsSync3(decisionsDir)) {
    for (const file of readdirSync3(decisionsDir).filter((name) => name.endsWith(".md")).sort()) {
      const path2 = join4(decisionsDir, file);
      assertLegacyDecisionSource(db, dirname3(realpathSync3(path2)));
      const doc = parseDecisionMd(readFileSync3(path2, "utf8"));
      if (doc.hash !== hash2) continue;
      const slug2 = file.slice(0, -3);
      if (JSON.stringify(doc.sourceTasks) !== provenance) {
        throw new KddError(`decision '${slug2}' provenance mismatch`);
      }
      fileDup ??= { slug: slug2, path: path2 };
    }
  }
  if (fileDup) return { ...fileDup, created: false };
  const dup = db.prepare(`SELECT slug, path FROM decisions WHERE content_hash = ?`).get(hash2);
  if (dup) {
    assertLegacyDecisionSource(db, dirname3(realpathSync3(dup.path)));
    const existing = parseDecisionMd(readFileSync3(dup.path, "utf8")).sourceTasks;
    if (JSON.stringify(existing) !== provenance) {
      throw new KddError(`decision '${dup.slug}' provenance mismatch`);
    }
    return { slug: dup.slug, path: dup.path, created: false };
  }
  const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const base = `${date}-${slugify(input.title)}`;
  let slug = base;
  const taken = (s) => existsSync3(join4(decisionsDir, `${s}.md`)) || !!db.prepare(`SELECT 1 FROM decisions WHERE slug = ?`).get(s);
  for (let i = 2; taken(slug); i++) slug = `${base}-${i}`;
  const path = join4(decisionsDir, `${slug}.md`);
  return db.transaction(() => {
    if (input.supersedes) supersede(db, decisionsDir, input.supersedes, slug);
    mkdirSync3(decisionsDir, { recursive: true });
    writeFileSync2(path, renderDecisionMd({ ...input, sourceTasks }, date));
    db.prepare(
      `INSERT INTO decisions (slug, title, path, content_hash, created, superseded_by, source_tasks)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`
    ).run(slug, input.title.trim(), path, hash2, date, provenance);
    db.prepare(
      `INSERT INTO search_index (kind, ref, title, body) VALUES ('decision', ?, ?, ?)`
    ).run(slug, input.title.trim(), body);
    return { slug, path, created: true };
  })();
}

// src/memory_import.ts
function readMemoryDocument(db, input) {
  shape(input, ["repoId", "checkoutPath", "commit", "path", "sha256"]);
  safeMemoryText(input.path, CAPS.agentFieldChars);
  memoryHex(input.sha256, [64]);
  const path = input.path;
  if (isAbsolute2(path) || path.includes("\\") || path.includes("\0") || path.split("/").some((p) => !p || p === "." || p === "..") || posix.normalize(path) !== path || memoryPrivatePath(path)) throw new KddError("private or invalid memory document path");
  const checkoutPath = memoryCommit(db, input.repoId, input.commit, input.checkoutPath);
  let bytes2;
  try {
    const options = { cwd: checkoutPath, stdio: "pipe", maxBuffer: 4 * CAPS.bodyChars + 4096 };
    const listing = execFileSync3(
      "/usr/bin/git",
      ["--no-replace-objects", "--literal-pathspecs", "ls-tree", "--full-tree", "-z", input.commit, "--", path],
      { ...options, encoding: "utf8" }
    ).split("\0").filter(Boolean);
    const match = listing.length === 1 ? /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([\s\S]+)$/.exec(listing[0]) : null;
    if (!match || match[3] !== path) throw new Error();
    bytes2 = execFileSync3("/usr/bin/git", ["--no-replace-objects", "cat-file", "blob", match[2]], options);
  } catch {
    throw new KddError("memory document blob unavailable");
  }
  if (createHash4("sha256").update(bytes2).digest("hex") !== input.sha256) throw new KddError("memory document hash mismatch");
  let body;
  try {
    body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes2);
  } catch {
    throw new KddError("memory document requires UTF-8 text");
  }
  if (body.includes("\0")) throw new KddError("memory document requires text");
  safeMemoryText(body, CAPS.bodyChars);
  const normalized = body.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n"), parsed = parseDecisionMd(normalized + "\n");
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized)?.[1];
  const declaredStatus = frontmatter?.split("\n").filter((line) => line.startsWith("status:")).at(-1)?.slice(7).trim();
  const hasStatus = declaredStatus !== void 0;
  const legacy = /(?:^|\/)\.planning\/decisions\/.*\.md$/.test(path);
  const documentStatus = hasStatus || parsed.supersededBy || legacy ? declaredStatus === "superseded" || parsed.supersededBy ? "superseded" : declaredStatus === "active" ? "active" : "unknown" : null;
  const title = parsed.title || basename2(path);
  safeMemoryText(title, CAPS.agentFieldChars);
  return { title, body, source: { kind: "git", repoId: input.repoId, commit: input.commit, path, sha256: input.sha256, documentStatus } };
}
function importMemory(handle, input, observers = {}) {
  const db = controllerDb(handle);
  return db.transaction(() => {
    shape(input, ["commandId", "scope", "applicability", "repoId", "checkoutPath", "commit", "path", "sha256", "author"], ["kind", "status"]);
    const document = readMemoryDocument(db, { repoId: input.repoId, checkoutPath: input.checkoutPath, commit: input.commit, path: input.path, sha256: input.sha256 });
    const kind = input.kind === void 0 ? "candidate" : input.kind;
    const status = input.status === void 0 ? "active" : input.status;
    if (status === "active" && (kind === "decision" || kind === "rule") && document.source.documentStatus !== null && document.source.documentStatus !== "active") {
      throw new KddError("inactive legacy memory requires explicit candidate acceptance");
    }
    const draft = {
      commandId: input.commandId,
      entryId: null,
      expectedRevision: 0,
      scope: input.scope,
      applicability: input.applicability,
      kind,
      status,
      title: document.title,
      body: document.body,
      source: document.source,
      author: input.author
    };
    const importKey = digest({ repoId: input.repoId, path: input.path, commit: input.commit, sha256: input.sha256, scope: input.scope, applicability: input.applicability });
    return writeMemoryDb(db, draft, observers, importKey);
  }).immediate();
}

// src/memory.ts
function memoryScope(db, scope) {
  shape(scope, ["projectId", "taskId"]);
  if (scope.projectId !== projectOf(db).project_id) throw new KddError("foreign project reference");
  if (scope.taskId !== null) scopedTask(db, { projectId: scope.projectId, taskId: scope.taskId });
}
function memoryHex(value, sizes) {
  if (typeof value !== "string" || !sizes.includes(value.length) || !/^[0-9a-f]+$/.test(value)) throw new KddError("invalid memory hash or id");
}
function safeMemoryText(value, cap) {
  text(value);
  if (value.length > cap) throw new KddError(`memory field exceeds limit ${cap}`);
  if (Buffer.from(value, "utf8").toString("utf8") !== value) throw new KddError("memory requires well-formed text");
  if (redact(value) !== value) throw new KddError("memory contains private credentials");
}
function memoryPrivatePath(value) {
  return /(?:^|[\/\\])(?:\.git|\.codex|\.claude|\.kdd|\.kdd-runtime|\.superpowers|\.npmrc|\.git-credentials|\.netrc|\.env(?:\.[^\/\\]*)?|credentials(?:\.[^\/\\]*)?|id_rsa|id_ed25519)(?:[\/\\]|$)/i.test(value) || /(?:^|[\/\\])\.planning[\/\\]runs(?:[\/\\]|$)/i.test(value) || /(?:^|[\/\\])(?:\.mcp\.json|config\.toml|settings\.local\.json)(?:$)/i.test(value) || /\.(?:pem|key)$/i.test(value);
}
function memoryCheckout(db, repoId, checkoutPath) {
  checkRepo(db, repoId);
  const candidates = checkoutPath === void 0 ? bindingsOf(db).filter((b) => b.repo_id === repoId).map((b) => b.checkout_path) : [checkoutPath];
  for (const path of candidates) {
    try {
      if (!isAbsolute3(path) || realpathSync4(path) !== path) continue;
      const common = canonicalCommonDir(path);
      if (bindingsOf(db).some((b) => b.repo_id === repoId && b.common_dir === common)) return path;
    } catch {
    }
  }
  throw new KddError("memory repository binding denied");
}
function memoryCommit(db, repoId, commit, checkoutPath) {
  memoryHex(commit, [40, 64]);
  checkRepo(db, repoId);
  const candidates = checkoutPath === void 0 ? bindingsOf(db).filter((b) => b.repo_id === repoId).map((b) => b.checkout_path) : [checkoutPath];
  for (const candidate of candidates) {
    try {
      const path = memoryCheckout(db, repoId, candidate);
      const options = { cwd: path, encoding: "utf8", stdio: "pipe", maxBuffer: 4096 };
      if (execFileSync4("/usr/bin/git", ["--no-replace-objects", "cat-file", "-t", commit], options).trim() === "commit" && execFileSync4("/usr/bin/git", ["--no-replace-objects", "rev-parse", "--verify", "--end-of-options", `${commit}^{commit}`], options).trim() === commit) return path;
    } catch {
    }
  }
  throw new KddError("unknown memory repository version or binding");
}
function validateDraft(db, draft) {
  memoryScope(db, draft.scope);
  shape(draft.applicability, ["repoId", "commit"]);
  const { repoId, commit } = draft.applicability;
  checkRepo(db, repoId);
  if (repoId !== null) memoryHex(repoId, [32]);
  if (commit !== null) {
    if (repoId === null) throw new KddError("memory commit requires repository");
    memoryCommit(db, repoId, commit);
  }
  if (!["fact", "decision", "rule", "candidate"].includes(draft.kind) || !["active", "withdrawn"].includes(draft.status)) throw new KddError("invalid memory kind or status");
  if (draft.kind === "fact" && repoId !== null && commit === null) throw new KddError("code fact requires exact commit");
  safeMemoryText(draft.title, CAPS.agentFieldChars);
  safeMemoryText(draft.body, CAPS.bodyChars);
  shape(draft.author, ["type", "id"]);
  if (!["user", "ai"].includes(draft.author.type)) throw new KddError("invalid memory author");
  if (draft.author.id !== null) safeMemoryText(draft.author.id, CAPS.agentFieldChars);
  for (const field of [draft.source, draft.author]) {
    const json = canonical(field);
    if (Buffer.byteLength(json) > CAPS.agentDetailBytes) throw new KddError(`memory metadata exceeds limit ${CAPS.agentDetailBytes}`);
    if (redact(json) !== json) throw new KddError("memory contains private credentials");
  }
  const source = draft.source;
  if (!source || typeof source !== "object") throw new KddError("invalid memory source");
  if (source.kind === "user" || source.kind === "host") {
    shape(source, ["kind", "ref"]);
    safeMemoryText(source.ref, CAPS.agentFieldChars);
    if (memoryPrivatePath(source.ref)) throw new KddError("private memory source denied");
  } else if (source.kind === "revision") {
    shape(source, ["kind", "ref", "hash"]);
    shape(source.ref, ["projectId", "entryId", "revision"]);
    if (source.ref.projectId !== draft.scope.projectId) throw new KddError("foreign memory source");
    memoryHex(source.ref.entryId, [32]);
    integer(source.ref.revision);
    memoryHex(source.hash, [64]);
    const record = memoryRecordDb(db, source.ref.entryId, source.ref.revision);
    if (record.hash !== source.hash) throw new KddError("memory source hash mismatch");
    if (draft.kind === "fact" && record.applicability.repoId !== null && canonical(record.applicability) !== canonical(draft.applicability)) throw new KddError("code fact source version mismatch");
  } else if (source.kind === "git") {
    shape(source, ["kind", "repoId", "commit", "path", "sha256", "documentStatus"]);
    const document = readMemoryDocument(db, {
      repoId: source.repoId,
      commit: source.commit,
      path: source.path,
      sha256: source.sha256,
      checkoutPath: memoryCommit(db, source.repoId, source.commit)
    });
    if (canonical(source) !== canonical(document.source)) throw new KddError("memory Git source mismatch");
    if (draft.kind === "fact" && (draft.applicability.repoId !== source.repoId || draft.applicability.commit !== source.commit)) throw new KddError("code fact source version mismatch");
  } else if (source.kind === "run") {
    if (draft.kind !== "candidate") throw new KddError("run memory requires candidate kind");
    assertRunMemorySource(db, draft.scope, draft.applicability, source, draft.author);
  } else {
    throw new KddError("invalid memory source");
  }
}
function memoryDraftHash(draft) {
  const { scope, applicability, kind, status, title, body, source, author } = draft;
  return digest({ scope, applicability, kind, status, title, body, source, author });
}
function memoryRecordDb(db, entryId, revision) {
  memoryHex(entryId, [32]);
  if (revision !== void 0) integer(revision);
  const row = db.prepare(`SELECT e.task_id,e.repo_id,e.applicable_commit,e.current_revision,r.*
    FROM memory_entries e JOIN memory_revisions r ON r.entry_id=e.id
    WHERE e.id=? AND r.revision=${revision === void 0 ? "e.current_revision" : "?"}`).get(...revision === void 0 ? [entryId] : [entryId, revision]);
  if (!row) throw new KddError("memory record unavailable");
  return {
    entryId: row.entry_id,
    revision: row.revision,
    currentRevision: row.current_revision,
    predecessor: row.predecessor,
    hash: row.content_hash,
    createdAt: row.created_at,
    kind: row.kind,
    status: row.status,
    title: row.title,
    body: row.body,
    source: JSON.parse(row.source_json),
    author: JSON.parse(row.author_json),
    evidence: JSON.parse(row.evidence_json),
    scope: { projectId: projectOf(db).project_id, taskId: row.task_id },
    applicability: { repoId: row.repo_id, commit: row.applicable_commit },
    effectiveStatus: row.revision === row.current_revision ? row.status : "superseded"
  };
}
function resolveMemoryView(db, view) {
  shape(view, ["scope", "repositories"]);
  memoryScope(db, view.scope);
  if (!Array.isArray(view.repositories)) throw new KddError("invalid memory repositories");
  const seen = /* @__PURE__ */ new Set();
  const repositories = view.repositories.map((version) => {
    shape(version, ["repoId", "checkoutPath", "commit"]);
    memoryHex(version.repoId, [32]);
    if (seen.has(version.repoId)) throw new KddError("duplicate memory repository");
    seen.add(version.repoId);
    return {
      repoId: version.repoId,
      commit: version.commit,
      checkoutPath: memoryCommit(db, version.repoId, version.commit, version.checkoutPath)
    };
  });
  return { scope: { projectId: view.scope.projectId, taskId: view.scope.taskId }, repositories };
}
function memoryReadOptions(options) {
  shape(options, [], ["candidates", "withdrawn"]);
  for (const flag of [options.candidates, options.withdrawn]) if (flag !== void 0 && typeof flag !== "boolean") throw new KddError("invalid memory read option");
}
function selectMemory(db, view, options = {}, historyEntryId, revision) {
  if (!db.inTransaction) throw new KddError("memory read requires transaction");
  memoryReadOptions(options);
  const resolved = resolveMemoryView(db, view), taskIds = [];
  if (resolved.scope.taskId !== null) {
    const task = scopedTask(db, { projectId: resolved.scope.projectId, taskId: resolved.scope.taskId });
    taskIds.push(task.id);
    if (task.parent_id !== null) taskIds.push(task.parent_id);
  }
  const clauses = [`(e.task_id IS NULL${taskIds.length ? ` OR e.task_id IN (${taskIds.map(() => "?").join(",")})` : ""})`];
  const parameters = [...taskIds];
  clauses.push(`(e.repo_id IS NULL${resolved.repositories.map((version) => {
    parameters.push(version.repoId, version.commit);
    return " OR (e.repo_id=? AND (e.applicable_commit IS NULL OR e.applicable_commit=?))";
  }).join("")})`);
  if (historyEntryId !== void 0) {
    memoryHex(historyEntryId, [32]);
    clauses.push("e.id=?");
    parameters.push(historyEntryId);
  } else if (revision !== void 0) throw new KddError("memory revision requires entry");
  if (revision !== void 0 && revision !== null) integer(revision);
  if (historyEntryId === void 0 || revision === null) clauses.push("r.revision=e.current_revision");
  else if (revision !== void 0) {
    clauses.push("r.revision=?");
    parameters.push(revision);
  }
  if (!options.candidates) clauses.push("r.kind<>'candidate'");
  if (!options.withdrawn) clauses.push("r.status='active'");
  const rows = db.prepare(`SELECT e.id,r.revision FROM memory_entries e
    JOIN memory_revisions r ON r.entry_id=e.id WHERE ${clauses.join(" AND ")} ORDER BY e.id,r.revision`).all(...parameters);
  if (historyEntryId !== void 0 && !rows.length) throw new KddError("memory record unavailable");
  return rows.map((row) => memoryRecordDb(db, row.id, row.revision));
}
function evidence(input, operation, previous, observers) {
  const origins = /* @__PURE__ */ new Set();
  if (input.source.kind === "user" || ["rule", "decision"].includes(input.kind) || previous && ["rule", "decision"].includes(previous.kind)) origins.add("user");
  if (input.kind === "fact" || previous?.kind === "fact") origins.add("host");
  return [...origins].map((origin) => {
    const request = {
      operation,
      entryId: input.entryId,
      expectedRevision: input.expectedRevision,
      origin,
      scope: input.scope,
      applicability: input.applicability,
      payloadHash: memoryDraftHash(input),
      source: input.source
    };
    const expected = canonical(request);
    try {
      const observed = observers.observe?.(structuredClone(request));
      shape(observed, ["request", "origin", "verdict", "observedAt", "expiresAt"]);
      if (!observed || canonical(observed.request) !== expected || observed.origin !== origin || observed.verdict !== "pass" || !Number.isFinite(observed.observedAt) || observed.observedAt < 0 || observed.observedAt > now() || observed.expiresAt !== null && (!Number.isFinite(observed.expiresAt) || observed.expiresAt <= now() || observed.expiresAt <= observed.observedAt)) throw new Error();
      const json = canonical(observed);
      if (Buffer.byteLength(json) > CAPS.agentDetailBytes || redact(json) !== json) throw new Error();
      return JSON.parse(json);
    } catch {
      throw new KddError("memory evidence not verified");
    }
  });
}
function receipt(record, created) {
  return {
    entryId: record.entryId,
    revision: record.revision,
    currentRevision: record.currentRevision,
    hash: record.hash,
    created,
    effectiveStatus: record.effectiveStatus
  };
}
function writeMemoryDb(db, input, observers, importKey) {
  if (!db.inTransaction) throw new KddError("memory write requires transaction");
  try {
    input = structuredClone(input);
  } catch {
    throw new KddError("invalid memory payload");
  }
  shape(input, ["commandId", "entryId", "expectedRevision", "scope", "applicability", "kind", "status", "title", "body", "source", "author"]);
  safeMemoryText(input.commandId, CAPS.agentFieldChars);
  integer(input.expectedRevision, 0);
  if (input.entryId === null ? input.expectedRevision !== 0 : input.expectedRevision === 0) throw new KddError("invalid memory expected revision");
  if (input.entryId !== null) memoryHex(input.entryId, [32]);
  if (importKey !== void 0) memoryHex(importKey, [64]);
  validateDraft(db, input);
  const commandHash = digest(input);
  const actor = { type: input.author.type, id: input.author.id ?? void 0 };
  const command = db.prepare("SELECT entry_id,revision,command_hash FROM memory_revisions WHERE command_id=?").get(input.commandId);
  const alias = command ? void 0 : db.prepare("SELECT detail FROM events WHERE action='memory_import_replay' AND json_extract(detail,'$.commandId')=?").get(input.commandId);
  const bound = command ?? (alias ? (() => {
    const detail = JSON.parse(alias.detail);
    return { entry_id: detail.entryId, revision: detail.revision, command_hash: detail.commandHash };
  })() : void 0);
  if (bound && bound.command_hash !== commandHash) throw new KddError("memory command conflict");
  const imported = !bound && importKey ? db.prepare("SELECT id FROM memory_entries WHERE import_key=?").get(importKey) : void 0;
  const replay = bound ? memoryRecordDb(db, bound.entry_id, bound.revision) : imported ? memoryRecordDb(db, imported.id, 1) : null;
  if (imported && replay?.hash !== memoryDraftHash(input)) throw new KddError("memory import publication conflict");
  const previous = replay ? replay.predecessor === null ? null : memoryRecordDb(db, replay.entryId, replay.predecessor) : input.entryId === null ? null : memoryRecordDb(db, input.entryId, input.expectedRevision);
  const existing = input.entryId === null ? null : memoryRecordDb(db, input.entryId);
  if (existing && (canonical(existing.scope) !== canonical(input.scope) || canonical(existing.applicability) !== canonical(input.applicability))) throw new KddError("immutable memory identity");
  if (previous && input.kind !== previous.kind && (previous.kind !== "candidate" || input.kind === "candidate")) throw new KddError("immutable memory kind");
  const originalImport = replay && replay.revision === 1 && db.prepare("SELECT import_key FROM memory_entries WHERE id=?").get(replay.entryId);
  const operation = importKey || originalImport && originalImport.import_key ? "import" : !previous ? "create" : input.status === "withdrawn" ? "withdraw" : input.kind !== previous.kind ? "accept" : "revise";
  const observations = evidence(input, operation, previous, observers);
  if (Buffer.byteLength(canonical(observations)) > CAPS.agentDetailBytes) throw new KddError(`memory evidence exceeds limit ${CAPS.agentDetailBytes}`);
  if (replay) {
    if (imported) appendEvent(
      db,
      input.scope.taskId,
      actor,
      "memory_import_replay",
      { commandId: input.commandId, commandHash, entryId: replay.entryId, revision: replay.revision }
    );
    return receipt(replay, false);
  }
  if (existing && existing.currentRevision !== input.expectedRevision) throw new KddError("stale memory revision");
  const entryId = input.entryId ?? newId(), revision = input.expectedRevision + 1;
  integer(revision);
  if (!existing) db.prepare("INSERT INTO memory_entries VALUES(?,?,?,?,?,?,?)").run(entryId, input.scope.taskId, input.applicability.repoId, input.applicability.commit, importKey ?? null, revision, now());
  db.prepare("INSERT INTO memory_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    entryId,
    revision,
    previous?.revision ?? null,
    input.kind,
    input.status,
    input.title,
    input.body,
    canonical(input.source),
    canonical(input.author),
    canonical(observations),
    memoryDraftHash(input),
    input.commandId,
    commandHash,
    now()
  );
  if (existing && db.prepare("UPDATE memory_entries SET current_revision=? WHERE id=? AND current_revision=?").run(revision, entryId, input.expectedRevision).changes !== 1) throw new KddError("stale memory revision");
  appendEvent(
    db,
    input.scope.taskId,
    actor,
    "memory_revision",
    {
      entryId,
      revision,
      predecessor: previous?.revision ?? null,
      kind: input.kind,
      status: input.status,
      source: input.source,
      hash: memoryDraftHash(input),
      operation
    }
  );
  return receipt(memoryRecordDb(db, entryId, revision), true);
}
function writeMemory(handle, input, observers = {}) {
  const db = controllerDb(handle);
  return db.transaction(() => writeMemoryDb(db, input, observers)).immediate();
}

// src/roles.ts
import { execFileSync as execFileSync5 } from "child_process";
import { createHash as createHash5 } from "crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync as readFileSync4, readdirSync as readdirSync4, realpathSync as realpathSync5 } from "fs";
import { isAbsolute as isAbsolute4, join as join5, relative } from "path";
var hash = (bytes2) => createHash5("sha256").update(bytes2).digest("hex");
var denied = (reason) => new KddError(`role revision denied: ${reason}`);
function validSkillPath(path) {
  return typeof path === "string" && !!path && !isAbsolute4(path) && !path.includes("\\") && !path.includes("\0") && !path.split("/").some((part) => !part || part === "." || part === "..");
}
function relativeSourcePath(path) {
  if (!validSkillPath(path)) throw denied("invalid skill path");
  return path;
}
function cleanText(value, label, limit) {
  if (typeof value !== "string" || !value.trim() || value.length > limit || redact(value) !== value) throw denied(`invalid ${label}`);
  return value;
}
function mime(path) {
  if (path.endsWith(".md")) return "text/markdown";
  if (path.endsWith(".txt")) return "text/plain";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".sh")) return "text/x-shellscript";
  return "application/octet-stream";
}
function filesForLocal(source) {
  if (!isAbsolute4(source.root) || source.root !== realpathSync5(source.root)) throw denied("source root must be canonical");
  const root = source.root, path = relativeSourcePath(source.path);
  const folder = join5(root, path);
  if (relative(root, folder).startsWith("..")) throw denied("skill escaped source root");
  for (let cursor = root, parts = path.split("/"), i = 0; i < parts.length; i++) {
    cursor = join5(cursor, parts[i]);
    if (!lstatSync(cursor).isDirectory()) throw denied("skill directory unavailable");
  }
  const files = [];
  const visit = (directory2, prefix) => {
    const before = lstatSync(directory2);
    if (!before.isDirectory()) throw denied("special skill directory");
    for (const name of readdirSync4(directory2).sort()) {
      if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) throw denied("invalid skill entry");
      const full = join5(directory2, name), path2 = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(full);
      if (stat.isDirectory()) {
        visit(full, path2);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > CAPS.skillFileBytes) throw denied("unsafe skill file");
      const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes2;
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw denied("skill file changed");
        bytes2 = readFileSync4(fd);
        const after2 = fstatSync(fd), current = lstatSync(full);
        if (bytes2.length > CAPS.skillFileBytes || after2.dev !== opened.dev || after2.ino !== opened.ino || after2.size !== opened.size || after2.mtimeMs !== opened.mtimeMs || after2.ctimeMs !== opened.ctimeMs || current.dev !== opened.dev || current.ino !== opened.ino) throw denied("skill file changed");
      } finally {
        closeSync(fd);
      }
      files.push({ path: path2, bytes: bytes2 });
      if (files.length > CAPS.skillFileCount) throw denied("too many skill files");
    }
    const after = lstatSync(directory2);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) throw denied("skill directory changed");
  };
  visit(folder, "");
  return files;
}
function filesForRepo(db, source) {
  const path = relativeSourcePath(source.path);
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(source.commit)) throw denied("invalid source commit");
  const checkout = realpathSync5(source.checkoutPath), common = canonicalCommonDir(checkout);
  const repo = repositoriesOf(db).find((row) => row.repo_id === source.repoId);
  const bound = bindingsOf(db).some((row) => row.repo_id === source.repoId && row.common_dir === common && row.checkout_path === checkout);
  if (!repo || !bound) throw denied("unbound source repository");
  const git3 = (args, maxBuffer = 2 * 1024 * 1024) => execFileSync5(
    "/usr/bin/git",
    ["--no-replace-objects", "-C", checkout, ...args],
    { stdio: ["ignore", "pipe", "ignore"], maxBuffer }
  );
  if (git3(["cat-file", "-t", source.commit]).toString().trim() !== "commit" || git3(["rev-parse", source.commit]).toString().trim() !== source.commit) throw denied("source commit unavailable");
  const tree = git3(["ls-tree", "-r", "-z", "--full-tree", source.commit, "--", path]);
  const entries = tree.toString("utf8").split("\0").filter(Boolean);
  if (!entries.length || entries.length > CAPS.skillFileCount) throw denied("skill tree empty or too large");
  return entries.map((entry) => {
    const match = /^(\d{6}) blob ([0-9a-f]{40,64})\t(.+)$/.exec(entry);
    if (!match || match[1] !== "100644" && match[1] !== "100755" || !match[3].startsWith(`${path}/`)) throw denied("unsafe Git skill entry");
    const relativePath = relativeSourcePath(match[3].slice(path.length + 1));
    const size = Number(git3(["cat-file", "-s", match[2]]).toString());
    if (!Number.isSafeInteger(size) || size > CAPS.skillFileBytes) throw denied("skill file too large");
    const bytes2 = git3(["cat-file", "blob", match[2]], CAPS.skillFileBytes + 1024);
    if (bytes2.length !== size) throw denied("Git skill blob changed");
    return { path: relativePath, bytes: bytes2 };
  });
}
function importSkill(db, skill) {
  const source = skill.source;
  const raw = source.kind === "local" ? filesForLocal(source) : filesForRepo(db, source);
  if (!raw.some((file) => file.path === "SKILL.md") || raw.reduce((n, file) => n + file.bytes.length, 0) > CAPS.skillTotalBytes) {
    throw denied("skill body missing or too large");
  }
  const body = raw.find((file) => file.path === "SKILL.md").bytes;
  try {
    if (!new TextDecoder("utf-8", { fatal: true }).decode(body).trim()) throw new Error("empty body");
  } catch {
    throw denied("invalid SKILL.md");
  }
  return raw.map((file) => {
    if (redact(file.bytes.toString("utf8")) !== file.bytes.toString("utf8")) throw denied("skill contains credentials");
    return { skill: skill.name, path: file.path, bytes: file.bytes, sha256: hash(file.bytes), mime: mime(file.path) };
  }).sort((a, b) => a.path.localeCompare(b.path));
}
function validateDefinition(value) {
  shape(value, ["name", "prompt", "runtime", "model", "effort", "access", "operations", "skills"]);
  const name = cleanText(value.name, "name", 80), prompt = cleanText(value.prompt, "prompt", 262144);
  if (/[\\/\x00-\x1f]/.test(name) || value.runtime !== "codex" || typeof value.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(value.model) || typeof value.effort !== "string" || !/^[a-z]+$/.test(value.effort) || !["read", "workspace-write"].includes(value.access) || !Array.isArray(value.operations) || !value.operations.length || new Set(value.operations).size !== value.operations.length || value.operations.some((operation) => !["get_context", "submit_report", "request_question", "read_skill_file"].includes(operation)) || !Array.isArray(value.skills)) throw denied("invalid definition");
  const names = /* @__PURE__ */ new Set();
  const skills = value.skills.map((skill) => {
    shape(skill, ["name", "mode", "description", "source"]);
    const skillName = cleanText(skill.name, "skill name", 80), description = cleanText(skill.description, "skill description", 1e3);
    const folded = skillName.normalize("NFKC").toLowerCase();
    if (/[\\/\x00-\x1f]/.test(skillName) || names.has(folded) || !["Always", "Available"].includes(skill.mode)) throw denied("duplicate or invalid skill");
    names.add(folded);
    if (!skill.source || !["local", "repo"].includes(skill.source.kind)) throw denied("invalid source");
    if (skill.source.kind === "local") shape(skill.source, ["kind", "root", "path"]);
    else shape(skill.source, ["kind", "repoId", "checkoutPath", "commit", "path"]);
    relativeSourcePath(skill.source.path);
    return { name: skillName, description, mode: skill.mode, source: structuredClone(skill.source) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const definition = {
    name,
    prompt,
    runtime: "codex",
    model: value.model,
    effort: value.effort,
    access: value.access,
    operations: [...value.operations].sort(),
    skills
  };
  if (redact(canonical(definition)) !== canonical(definition)) throw denied("definition contains credentials");
  return definition;
}
function manifestHash(definition, files) {
  return digest({
    skills: definition.skills.map((skill) => ({ name: skill.name, mode: skill.mode, source: skill.source })),
    files: [...files].sort((a, b) => {
      if (a.skill !== b.skill) return a.skill < b.skill ? -1 : 1;
      if (a.path !== b.path) return a.path < b.path ? -1 : 1;
      return 0;
    }).map((file) => ({ skill: file.skill, path: file.path, sha256: file.sha256, mime: file.mime, size: file.bytes.length }))
  });
}
function roleFilesDb(db, ref) {
  return db.prepare("SELECT skill_name,relative_path,bytes,sha256,mime FROM role_skill_files WHERE role_id=? AND revision=? ORDER BY skill_name,relative_path").all(ref.roleId, ref.revision).map((row) => {
    if (hash(row.bytes) !== row.sha256) throw denied("stored skill bytes changed");
    return { skill: row.skill_name, path: row.relative_path, bytes: row.bytes, sha256: row.sha256, mime: row.mime };
  });
}
function roleRevisionDb(db, ref) {
  if (!ref || typeof ref.roleId !== "string" || !Number.isSafeInteger(ref.revision) || ref.revision < 1) throw denied("invalid role ref");
  const row = db.prepare("SELECT p.project_id,r.definition_json,r.hash,r.manifest_hash FROM role_revisions r JOIN role_profiles p ON p.id=r.role_id WHERE r.role_id=? AND r.revision=?").get(ref.roleId, ref.revision);
  if (!row || row.project_id !== projectOf(db).project_id) throw denied("unknown role revision");
  const definition = JSON.parse(row.definition_json);
  const files = roleFilesDb(db, ref), manifest = manifestHash(definition, files);
  if (manifest !== row.manifest_hash || digest({ definition, manifestHash: manifest }) !== row.hash) throw denied("role revision changed");
  return { definition, receipt: { ...ref, hash: row.hash, manifestHash: manifest } };
}
function roleRevision(handle, ref) {
  const { definition, receipt: receipt2 } = roleRevisionDb(controllerDb(handle), ref);
  return { ...definition, ...receipt2 };
}
function currentRoleRevision(handle, roleId) {
  const db = controllerDb(handle);
  if (typeof roleId !== "string" || !/^[0-9a-f]{32}$/.test(roleId)) throw denied("invalid role ref");
  const row = db.prepare("SELECT current_revision FROM role_profiles WHERE id=? AND project_id=?").get(roleId, projectOf(db).project_id);
  if (!row) throw denied("unknown role");
  return roleRevision(handle, { roleId, revision: row.current_revision });
}
function roleActiveDb(db, roleId) {
  return !!db.prepare("SELECT 1 FROM role_profiles WHERE id=? AND project_id=? AND revoked_at IS NULL").get(roleId, projectOf(db).project_id);
}
function revokeRole(handle, roleId) {
  const db = controllerDb(handle);
  if (typeof roleId !== "string" || !/^[0-9a-f]{32}$/.test(roleId)) throw denied("invalid role ref");
  db.transaction(() => {
    const row = db.prepare("SELECT project_id,revoked_at FROM role_profiles WHERE id=?").get(roleId);
    if (!row || row.project_id !== projectOf(db).project_id) throw denied("unknown role");
    if (row.revoked_at !== null) return;
    db.prepare("UPDATE role_profiles SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(now(), roleId);
    appendEvent(db, null, { type: "ai", id: "controller" }, "role_revoked", { roleId });
  }).immediate();
}
function saveRoleRevision(handle, input) {
  const db = controllerDb(handle);
  if (!input || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || typeof input.commandId !== "string" || !input.commandId.trim() || input.commandId.length > 200 || input.roleId !== void 0 && !/^[0-9a-f]{32}$/.test(input.roleId)) throw denied("invalid command");
  const definition = validateDefinition(input.definition);
  const commandHash = digest({ roleId: input.roleId ?? null, expectedRevision: input.expectedRevision, definition });
  const replay = () => db.prepare("SELECT role_id,revision,hash,manifest_hash,command_hash FROM role_revisions WHERE command_id=?").get(input.commandId);
  const prior = replay();
  if (prior) {
    if (prior.command_hash !== commandHash) throw denied("command replay changed");
    return { roleId: prior.role_id, revision: prior.revision, hash: prior.hash, manifestHash: prior.manifest_hash };
  }
  const files = definition.skills.flatMap((skill) => importSkill(db, skill));
  const manifest = manifestHash(definition, files), roleHash = digest({ definition, manifestHash: manifest });
  return db.transaction(() => {
    const raced = replay();
    if (raced) {
      if (raced.command_hash !== commandHash) throw denied("command replay changed");
      return { roleId: raced.role_id, revision: raced.revision, hash: raced.hash, manifestHash: raced.manifest_hash };
    }
    const projectId = projectOf(db).project_id, roleId = input.roleId ?? newId(), revision = input.expectedRevision + 1;
    if (input.roleId === void 0) {
      if (input.expectedRevision !== 0) throw denied("new role revision must start at one");
      db.prepare("INSERT INTO role_profiles(id,project_id,name,current_revision) VALUES(?,?,?,1)").run(roleId, projectId, definition.name);
    } else {
      const current = db.prepare("SELECT project_id,name,current_revision,revoked_at FROM role_profiles WHERE id=?").get(roleId);
      if (current && current.revoked_at !== null) throw denied("role revoked");
      if (!current || current.project_id !== projectId || current.current_revision !== input.expectedRevision || current.name !== definition.name) throw denied("role revision fence changed");
    }
    db.prepare("INSERT INTO role_revisions(role_id,revision,definition_json,hash,manifest_hash,created_at,command_id,command_hash) VALUES(?,?,?,?,?,?,?,?)").run(roleId, revision, canonical(definition), roleHash, manifest, now(), input.commandId, commandHash);
    const insert = db.prepare("INSERT INTO role_skill_files(role_id,revision,skill_name,relative_path,sha256,mime,bytes) VALUES(?,?,?,?,?,?,?)");
    for (const file of files) insert.run(roleId, revision, file.skill, file.path, file.sha256, file.mime, file.bytes);
    if (input.roleId !== void 0) db.prepare("UPDATE role_profiles SET current_revision=? WHERE id=? AND current_revision=?").run(revision, roleId, input.expectedRevision);
    appendEvent(db, null, { type: "ai", id: "controller" }, "role_revision", { roleId, revision, hash: roleHash, manifestHash: manifest });
    return { roleId, revision, hash: roleHash, manifestHash: manifest };
  }).immediate();
}

// src/run_inputs.ts
import { createHash as createHash9 } from "crypto";
import { execFileSync as execFileSync8 } from "child_process";
import { constants as constants2, openSync as openSync2, closeSync as closeSync2, fstatSync as fstatSync2, lstatSync as lstatSync4, realpathSync as realpathSync9, readFileSync as readFileSync9, existsSync as existsSync8 } from "fs";
import { isAbsolute as isAbsolute6, dirname as dirname7, resolve as resolve4, relative as relative3 } from "path";

// src/memory_query.ts
import Database4 from "better-sqlite3";

// src/recall.ts
import { existsSync as existsSync4, readFileSync as readFileSync5, readdirSync as readdirSync5, realpathSync as realpathSync6 } from "fs";
import { dirname as dirname4, join as join6 } from "path";
function syncIndex(db, decisionsDir) {
  db.transaction(() => {
    if (canSyncLegacyDecisions(db, decisionsDir)) {
      const files = existsSync4(decisionsDir) ? readdirSync5(decisionsDir).filter((f) => f.endsWith(".md")) : [];
      const inDb = new Map(
        db.prepare(
          `SELECT slug, path, content_hash, created, superseded_by, source_tasks FROM decisions`
        ).all().map((r) => [r.slug, r])
      );
      const seen = /* @__PURE__ */ new Set();
      for (const f of files) {
        const slug = f.slice(0, -3);
        seen.add(slug);
        const path = join6(decisionsDir, f);
        if (!canSyncLegacyDecisions(db, dirname4(realpathSync6(path)))) continue;
        const doc = parseDecisionMd(readFileSync5(path, "utf8"));
        const title = doc.title || slug;
        const supersededBy = doc.status === "superseded" ? doc.supersededBy || "?" : doc.supersededBy || null;
        const sourceTasks = JSON.stringify(doc.sourceTasks);
        const row = inDb.get(slug);
        if (row && row.content_hash === doc.hash && (row.superseded_by ?? null) === (supersededBy ?? null)) {
          if (row.path !== path || row.source_tasks !== sourceTasks || row.created !== (doc.created || null)) {
            db.prepare(`UPDATE decisions SET path = ?, source_tasks = ?, created = ? WHERE slug = ?`).run(path, sourceTasks, doc.created || null, slug);
          }
          continue;
        }
        db.prepare(`DELETE FROM search_index WHERE kind='decision' AND ref = ?`).run(slug);
        db.prepare(
          `INSERT OR REPLACE INTO decisions
             (slug, title, path, content_hash, created, superseded_by, source_tasks)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(slug, title, path, doc.hash, doc.created || null, supersededBy, sourceTasks);
        db.prepare(
          `INSERT INTO search_index (kind, ref, title, body) VALUES ('decision', ?, ?, ?)`
        ).run(slug, title, doc.indexBody);
      }
      for (const slug of inDb.keys()) {
        if (seen.has(slug)) continue;
        db.prepare(`DELETE FROM decisions WHERE slug = ?`).run(slug);
        db.prepare(`DELETE FROM search_index WHERE kind='decision' AND ref = ?`).run(slug);
      }
    }
    const last = Number(
      db.prepare(`SELECT value FROM meta WHERE key='fts_last_event_id'`).get()?.value ?? "0"
    );
    const max = db.prepare(`SELECT MAX(id) AS m FROM events`).get().m ?? 0;
    if (max <= last) return;
    const ids = db.prepare(
      `SELECT DISTINCT task_id AS id FROM events WHERE id > ? AND task_id IS NOT NULL`
    ).all(last);
    const getTask = db.prepare(`SELECT * FROM tasks WHERE id = ?`);
    const getComments = db.prepare(`SELECT body FROM comments WHERE task_id = ? ORDER BY id`);
    for (const { id: id2 } of ids) {
      db.prepare(`DELETE FROM search_index WHERE kind='task' AND ref = ?`).run(String(id2));
      const t = getTask.get(id2);
      if (!t || t.archived_at) continue;
      const body = [t.body ?? "", ...getComments.all(id2).map((c) => c.body)].filter(Boolean).join("\n");
      db.prepare(
        `INSERT INTO search_index (kind, ref, title, body) VALUES ('task', ?, ?, ?)`
      ).run(String(id2), t.title, body);
    }
    db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('fts_last_event_id', ?)`).run(String(max));
  })();
}
function sanitizeQuery(q) {
  const parts = [];
  for (const m of q.matchAll(/"([^"]+)"|[\p{L}\p{N}_][\p{L}\p{N}_.-]*/gu)) {
    const raw = m[1] !== void 0 ? m[1].trim() : m[0].replace(/^[._-]+|[._-]+$/g, "");
    if (raw) parts.push(`"${raw.replace(/"/g, '""')}"`);
  }
  if (parts.length === 0) throw new KddError("empty query");
  return parts.join(" ");
}
function recall(db, decisionsDir, query, opts = {}) {
  if (opts.kind && opts.kind !== "decision" && opts.kind !== "task") {
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
    q: sanitizeQuery(query),
    kind: opts.kind ?? null,
    k
  });
}
function rebuild(db, decisionsDir) {
  assertLegacyDecisionSource(db, decisionsDir);
  if (existsSync4(decisionsDir)) for (const name of readdirSync5(decisionsDir).filter((f) => f.endsWith(".md"))) {
    assertLegacyDecisionSource(db, dirname4(realpathSync6(join6(decisionsDir, name))));
  }
  db.transaction(() => {
    db.exec(`DELETE FROM search_index; DELETE FROM decisions;`);
    db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('fts_last_event_id', '0')`).run();
  })();
  syncIndex(db, decisionsDir);
  return {
    decisions: db.prepare(`SELECT COUNT(*) c FROM decisions`).get().c,
    tasks: db.prepare(`SELECT COUNT(*) c FROM search_index WHERE kind='task'`).get().c
  };
}

// src/memory_query.ts
function memoryEntry(handle, view, entryId, revision) {
  const db = controllerDb(handle);
  if (revision !== void 0) integer(revision);
  return db.transaction(() => selectMemory(db, view, { candidates: true, withdrawn: true }, entryId, revision ?? null)[0])();
}
function memoryHistory(handle, view, entryId) {
  const db = controllerDb(handle);
  return db.transaction(() => selectMemory(db, view, { candidates: true, withdrawn: true }, entryId))();
}
function listMemory(handle, view, options = {}) {
  const db = controllerDb(handle);
  return db.transaction(() => selectMemory(db, view, options))();
}
function memoryRules(handle, view) {
  const db = controllerDb(handle);
  return db.transaction(() => selectMemory(db, view).filter((record) => record.kind === "rule"))();
}
function queryMemoryDb(db, view, query, options = {}, kinds) {
  shape(options, [], ["k", "candidates", "withdrawn"]);
  const readOptions = { candidates: options.candidates, withdrawn: options.withdrawn };
  memoryReadOptions(readOptions);
  const k = options.k === void 0 ? CAPS.recallK : options.k;
  integer(k);
  if (k > CAPS.recallKMax) throw new KddError(`memory k must be 1..${CAPS.recallKMax}`);
  safeMemoryText(query, CAPS.bodyChars);
  const match = sanitizeQuery(query);
  if (!match) throw new KddError("memory query requires words");
  const eligible = selectMemory(db, view, readOptions).filter((record) => !kinds || kinds.includes(record.kind));
  const corpus = new Database4(":memory:");
  try {
    corpus.exec("CREATE VIRTUAL TABLE hits USING fts5(ref UNINDEXED,title,body,tokenize='unicode61 remove_diacritics 2')");
    const insert = corpus.prepare("INSERT INTO hits(ref,title,body) VALUES(?,?,?)");
    corpus.transaction(() => {
      for (const row of eligible) insert.run(row.entryId, row.title, row.body);
    })();
    const hits = corpus.prepare(`SELECT ref,title,snippet(hits,2,'','','...',${CAPS.recallSnippetTokens}) snippet
      FROM hits WHERE hits MATCH ? ORDER BY bm25(hits,0,3.0,1.0),ref LIMIT ?`).all(match, k);
    const records = new Map(eligible.map((row) => [row.entryId, row]));
    return hits.map((hit) => {
      const row = records.get(hit.ref);
      return {
        ref: { projectId: row.scope.projectId, entryId: row.entryId, revision: row.revision },
        hash: row.hash,
        kind: row.kind,
        status: row.status,
        effectiveStatus: row.effectiveStatus,
        title: capText(hit.title, CAPS.recallTitleChars),
        snippet: hit.snippet,
        source: row.source,
        scope: row.scope,
        applicability: row.applicability
      };
    });
  } finally {
    corpus.close();
  }
}
function recallMemory(handle, view, query, options = {}) {
  const db = controllerDb(handle);
  return db.transaction(() => queryMemoryDb(db, view, query, options))();
}

// src/criteria.ts
function listCriteria(db, taskId) {
  return db.prepare(
    `SELECT * FROM criteria WHERE task_id = ? ORDER BY position, id`
  ).all(taskId);
}
function mustGetCriterion(db, taskId, id2) {
  const c = db.prepare(`SELECT * FROM criteria WHERE id = ?`).get(id2);
  assertLegacyTaskMutation(db, [taskId, ...c ? [c.task_id] : []]);
  if (!c || c.task_id !== taskId) throw new KddError(`criterion #${id2} not found on task #${taskId}`);
  return c;
}
var touchTask = (db, taskId) => {
  db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(now(), taskId);
};
function addCriterion(db, taskId, text2, actor) {
  if (!text2.trim()) throw new KddError("criterion text must not be empty");
  return db.transaction(() => {
    assertLegacyTaskMutation(db, [taskId]);
    mustGetTask(db, taskId);
    const pos = db.prepare(
      `SELECT COALESCE(MAX(position), -1) + 1 AS p FROM criteria WHERE task_id = ?`
    ).get(taskId).p;
    const r = db.prepare(
      `INSERT INTO criteria (task_id, text, position, created_at) VALUES (?, ?, ?, ?)`
    ).run(taskId, text2, pos, now());
    const id2 = Number(r.lastInsertRowid);
    appendTaskMutationEvent(db, taskId, actor, "criterion_added", { id: id2, text: text2 });
    touchTask(db, taskId);
    return mustGetCriterion(db, taskId, id2);
  }).immediate();
}
function setCriterionChecked(db, taskId, id2, checked, actor, evidence2) {
  return db.transaction(() => {
    const c = mustGetCriterion(db, taskId, id2);
    const proof = evidence2?.trim();
    if (c.checked_at !== null === checked && (!checked || !proof)) return c;
    const stored = proof ? actor.type === "ai" ? redact(proof) : proof : null;
    db.prepare(
      `UPDATE criteria SET checked_at = ?, evidence = ?, checked_by = ? WHERE id = ?`
    ).run(
      checked ? now() : null,
      checked ? stored : null,
      checked ? authorOf(actor) : null,
      id2
    );
    appendTaskMutationEvent(
      db,
      taskId,
      actor,
      checked ? "criterion_checked" : "criterion_unchecked",
      { id: id2, text: c.text, ...checked && stored ? { evidence: stored } : {} }
    );
    touchTask(db, taskId);
    return mustGetCriterion(db, taskId, id2);
  }).immediate();
}
function removeCriterion(db, taskId, id2, actor) {
  db.transaction(() => {
    const c = mustGetCriterion(db, taskId, id2);
    db.prepare(`DELETE FROM criteria WHERE id = ?`).run(id2);
    appendTaskMutationEvent(db, taskId, actor, "criterion_removed", { id: id2, text: c.text });
    touchTask(db, taskId);
  }).immediate();
}

// src/files.ts
import { createHash as createHash6 } from "crypto";
import {
  existsSync as existsSync5,
  mkdirSync as mkdirSync4,
  readFileSync as readFileSync6,
  renameSync as renameSync3,
  rmSync as rmSync3,
  statSync as statSync2,
  writeFileSync as writeFileSync3
} from "fs";
import { basename as basename3, dirname as dirname5, extname, join as join7 } from "path";
var MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  tif: "image/tiff",
  tiff: "image/tiff",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  zip: "application/zip",
  json: "application/json",
  csv: "text/csv",
  md: "text/markdown",
  txt: "text/plain",
  log: "text/plain"
};
var INLINE = /* @__PURE__ */ new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/x-icon",
  "image/tiff"
]);
var isInlineMime = (m) => m !== null && INLINE.has(m);
var filesDir = (dbPath) => {
  if (dbPath === ":memory:") throw new KddError("attachments need a real board file, not :memory:");
  return join7(dirname5(dbPath), "files");
};
var filePath = (dbPath, f) => join7(filesDir(dbPath), `${f.sha256}.${f.ext}`);
function listFiles(db, taskId) {
  return db.prepare(`SELECT * FROM files WHERE task_id = ? ORDER BY id`).all(taskId);
}
function getFile(db, id2) {
  return db.prepare(`SELECT * FROM files WHERE id = ?`).get(id2);
}
function attachFile(db, dbPath, taskId, srcPath, opts, actor) {
  return db.transaction(() => {
    assertLegacyTaskMutation(db, [taskId]);
    let data;
    try {
      const stat = statSync2(srcPath);
      if (stat.isDirectory()) throw new KddError(`${srcPath} is a directory`);
      if (stat.size > CAPS.fileBytes) {
        throw new KddError(`file is ${stat.size} bytes, the limit is ${CAPS.fileBytes}`);
      }
      data = readFileSync6(srcPath);
    } catch (e) {
      if (e instanceof KddError) throw e;
      throw new KddError(`cannot read ${srcPath}: ${e.message}`);
    }
    mustGetTask(db, taskId);
    const sha256 = createHash6("sha256").update(data).digest("hex");
    const ext = (extname(srcPath).slice(1) || "bin").toLowerCase();
    const target = join7(filesDir(dbPath), `${sha256}.${ext}`);
    if (!existsSync5(target)) {
      mkdirSync4(filesDir(dbPath), { recursive: true });
      const tmp = `${target}.${process.pid}.tmp`;
      writeFileSync3(tmp, data);
      renameSync3(tmp, target);
    }
    const name = capText(basename3(srcPath), CAPS.fileNameChars);
    const r = db.prepare(
      `INSERT INTO files (task_id, sha256, ext, original_name, mime_type, size_bytes,
                          description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, sha256) DO NOTHING`
    ).run(
      taskId,
      sha256,
      ext,
      name,
      MIME[ext] ?? null,
      data.length,
      opts.description ?? null,
      now()
    );
    const row = db.prepare(`SELECT * FROM files WHERE task_id = ? AND sha256 = ?`).get(taskId, sha256);
    if (r.changes === 0) {
      if (opts.description && opts.description !== row.description) {
        db.prepare(`UPDATE files SET description = ? WHERE id = ?`).run(opts.description, row.id);
        appendTaskMutationEvent(db, taskId, actor, "file_attached", { id: row.id, name, described: true });
        db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(now(), taskId);
        return { ...row, description: opts.description };
      }
      return row;
    }
    appendTaskMutationEvent(db, taskId, actor, "file_attached", { id: row.id, name });
    db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(now(), taskId);
    return row;
  }).immediate();
}
function detachFile(db, dbPath, fileId, actor) {
  db.transaction(() => {
    const f = getFile(db, fileId);
    if (!f) throw new KddError(`file #${fileId} not found`);
    assertLegacyTaskMutation(db, [f.task_id]);
    db.prepare(`DELETE FROM files WHERE id = ?`).run(fileId);
    appendTaskMutationEvent(db, f.task_id, actor, "file_detached", { id: fileId, name: f.original_name });
    db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(now(), f.task_id);
    const left = db.prepare(`SELECT COUNT(*) AS c FROM files WHERE sha256 = ? AND ext = ?`).get(f.sha256, f.ext).c;
    if (left === 0) rmSync3(filePath(dbPath, f), { force: true });
  }).immediate();
}

// src/codex_permissions.ts
import { spawn as spawn2, execFileSync as execFileSync7 } from "child_process";
import { createHash as createHash8 } from "crypto";
import { lstatSync as lstatSync3, mkdirSync as mkdirSync6, readdirSync as readdirSync7, realpathSync as realpathSync8, rmdirSync, readFileSync as readFileSync8, writeFileSync as writeFileSync5, existsSync as existsSync7 } from "fs";
import { dirname as dirname6, isAbsolute as isAbsolute5, join as join9, relative as relative2, resolve as resolve3, sep as sep2 } from "path";
import { fileURLToPath as fileURLToPath2 } from "url";

// src/codex_native_probe.ts
import assert from "assert/strict";
import { spawn, execFile, execFileSync as execFileSync6 } from "child_process";
import { createHash as createHash7 } from "crypto";
import { mkdtempSync, mkdirSync as mkdirSync5, writeFileSync as writeFileSync4, readFileSync as readFileSync7, existsSync as existsSync6, rmSync as rmSync4, realpathSync as realpathSync7, linkSync, symlinkSync, lstatSync as lstatSync2, readdirSync as readdirSync6, readlinkSync } from "fs";
import { createServer } from "http";
import { tmpdir, networkInterfaces } from "os";
import { createServer as createSocketServer } from "net";
import { join as join8 } from "path";
import * as zlib from "zlib";
import Database5 from "better-sqlite3";
import { fileURLToPath } from "url";
function brokerOperationNames(binding) {
  const db = new Database5(binding.dbPath, { fileMustExist: true });
  try {
    return runOperations(openRunContext(db, JSON.parse(readFileSync7(binding.configPath, "utf8")).token));
  } finally {
    db.close();
  }
}
async function observeCodexNative(executablePath, rawDiagnostic = false, model = "fixture-codex", broker, brokerOnly = false) {
  const executable = realpathSync7(executablePath);
  const version = execFileSync6(executable, ["--version"], { encoding: "utf8" }).trim();
  assert.equal(version, "codex-cli 0.159.0");
  assert.equal(process.platform, "darwin");
  const executableHash = createHash7("sha256").update(readFileSync7(executable)).digest("hex");
  const scriptHash = createHash7("sha256").update(readFileSync7(new URL(import.meta.url))).digest("hex");
  const guardHash = scriptHash;
  const root = realpathSync7(mkdtempSync(join8(tmpdir(), "kdd-native-")));
  const observations = [];
  const failures = [];
  const preflight = [];
  const networkControls = [];
  let tcpServer;
  let unixServer;
  let brokerDb;
  let operations2 = [];
  let brokerSkill = "Probe";
  const brokerPayload = (operation, body) => {
    if (operation === "get_context") return {};
    if (operation === "read_skill_file") return { skill: brokerSkill, path: "SKILL.md", offset: 0 };
    return { body };
  };
  try {
    let findTool2 = function(tools, name, namespace) {
      for (const tool of tools ?? []) {
        if (tool.name === name && ["function", "custom"].includes(tool.type)) return { ...tool, namespace };
        const found = findTool2(tool.tools, name, tool.type === "namespace" ? tool.name : namespace);
        if (found) return found;
      }
    }, flattenTools2 = function(tools, namespace) {
      return (tools ?? []).flatMap((t) => t.type === "namespace" ? flattenTools2(t.tools, t.name) : [{ name: t.name, namespace, type: t.type }]);
    }, fingerprint2 = function(path) {
      if (!existsSync6(path)) return "missing";
      const stat = lstatSync2(path);
      if (stat.isSymbolicLink()) return digest3(readlinkSync(path));
      if (!stat.isDirectory()) return digest3(readFileSync7(path));
      return digest3(JSON.stringify(readdirSync6(path).sort().map((name) => [name, fingerprint2(join8(path, name))])));
    };
    var findTool = findTool2, flattenTools = flattenTools2, fingerprint = fingerprint2;
    if (broker) {
      const original = new Database5(broker.dbPath, { fileMustExist: true });
      const probeDbPath = join8(root, "broker.db");
      try {
        await original.backup(probeDbPath);
      } finally {
        original.close();
      }
      const probeConfigPath = join8(root, "broker.json");
      writeFileSync4(probeConfigPath, JSON.stringify({
        dbPath: probeDbPath,
        token: JSON.parse(readFileSync7(broker.configPath, "utf8")).token
      }), { mode: 384 });
      broker = { ...broker, dbPath: probeDbPath, configPath: probeConfigPath };
      brokerDb = new Database5(broker.dbPath, { fileMustExist: true });
      const token = JSON.parse(readFileSync7(broker.configPath, "utf8")).token;
      operations2 = runOperations(openRunContext(brokerDb, token));
      const pin2 = brokerDb.prepare(`SELECT json_extract(grant_json,'$.role.roleId') role_id,
      json_extract(grant_json,'$.role.revision') revision FROM run_authorities WHERE token_hash=?`).get(createHash7("sha256").update(token).digest("hex"));
      const selected = pin2 && brokerDb.prepare(`SELECT skill_name FROM role_skill_files WHERE role_id=? AND revision=?
      AND relative_path='SKILL.md' ORDER BY skill_name LIMIT 1`).get(pin2.role_id, pin2.revision);
      if (selected) brokerSkill = selected.skill_name;
    }
    const workspace = join8(root, "workspace");
    const scratch = join8(root, "scratch");
    const protectedDir = join8(root, "protected");
    const source = join8(root, "source");
    const sibling = join8(root, "sibling");
    const clone = join8(root, "clone");
    for (const path of [scratch, protectedDir, source, sibling]) mkdirSync5(path);
    writeFileSync4(join8(protectedDir, "marker.txt"), "private-fixture\n");
    for (const name of ["store.db", "registry.db", "config.toml", "credential.json"]) writeFileSync4(join8(protectedDir, name), "private-fixture\n");
    writeFileSync4(join8(sibling, "marker.txt"), "private-fixture\n");
    const controlDir = join8(protectedDir, "controller");
    mkdirSync5(controlDir);
    const backend = join8(root, "backend");
    mkdirSync5(backend);
    writeFileSync4(join8(backend, "marker.txt"), "backend-original\n");
    const git3 = (cwd, ...args) => execFileSync6("/usr/bin/git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
    writeFileSync4(join8(source, "existing.txt"), "original\n");
    git3(source, "init", "-q");
    git3(source, "add", "existing.txt");
    git3(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "seed");
    git3(root, "clone", "--no-hardlinks", "-q", source, clone);
    git3(clone, "worktree", "add", "-q", "-b", "fixture-worktree", workspace);
    mkdirSync5(join8(workspace, ".codex"));
    const gitDir = git3(workspace, "rev-parse", "--absolute-git-dir");
    const commonDir = git3(workspace, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const foreign = join8(backend, "marker.txt");
    if (rawDiagnostic) linkSync(foreign, join8(workspace, "hardlink.txt"));
    symlinkSync(foreign, join8(workspace, "symlink.txt"));
    const catalogPath = join8(root, "model-catalog.json");
    writeFileSync4(catalogPath, closedCodexCatalog(model));
    let tcpRequests = 0;
    let unixRequests = 0;
    tcpServer = createServer((req, res) => {
      tcpRequests++;
      res.end("ack");
    });
    await new Promise((resolve5) => tcpServer.listen(0, "0.0.0.0", resolve5));
    const tcpPort = tcpServer.address().port;
    const socketPath = join8(scratch, "listener.sock");
    unixServer = createSocketServer((socket) => socket.once("data", () => {
      unixRequests++;
      socket.end("ack");
    }));
    await new Promise((resolve5) => unixServer.listen(socketPath, resolve5));
    const lanAddress = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
    let tcpBaseline = 0;
    let unixBaseline = 0;
    const networkCases = [
      ...[["loopback", "127.0.0.1"], ...lanAddress ? [["lan", lanAddress]] : []].map(([name, host]) => ({
        id: `network-${name}`,
        command: `/usr/bin/curl --disable --max-time 2 --silent --show-error -d native http://${host}:${tcpPort}/attempt`,
        failureCode: 7
      })),
      { id: "network-unix", command: `/bin/sh -c "echo native | /usr/bin/nc -U -w 1 '${socketPath}'"`, failureCode: 1 }
    ];
    async function checkNetworkControls() {
      for (const testCase of networkCases) {
        const output = await new Promise((resolve5, reject) => execFile(
          "/bin/sh",
          ["-c", testCase.command],
          { timeout: 4e3, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: scratch, LANG: "en_US.UTF-8" } },
          (error, stdout) => error ? reject(error) : resolve5(stdout)
        ));
        assert.equal(String(output).trim(), "ack");
        networkControls.push({ caseId: testCase.id, role: "host-control", exitCode: 0, commandHash: digest3(testCase.command), output });
      }
      assert.equal(tcpRequests, lanAddress ? 2 : 1);
      assert.equal(unixRequests, 1);
      tcpBaseline = tcpRequests;
      unixBaseline = unixRequests;
    }
    const sse = (type, fields) => `event: ${type}
data: ${JSON.stringify({ type, ...fields })}

`;
    async function runCase(testCase, writable) {
      let calls = 0;
      let output;
      let registry;
      let providerError;
      let firstRequestBytes = 0;
      const requests = [];
      const server = createServer(async (req, res) => {
        try {
          if (req.method !== "POST") {
            res.writeHead(404);
            res.end();
            return;
          }
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          let bytes2 = Buffer.concat(chunks);
          if (req.headers["content-encoding"] === "zstd") {
            if (typeof zlib.zstdDecompressSync !== "function") throw new Error("native fixture zstd unavailable");
            bytes2 = zlib.zstdDecompressSync(bytes2);
          }
          const body = JSON.parse(bytes2.toString());
          if (calls === 0) firstRequestBytes = bytes2.length;
          requests.push({ path: req.url, keys: Object.keys(body), tools: body.tools?.map((t) => ({ type: t.type, name: t.name })), input: body.input?.map((i) => ({ type: i.type, call_id: i.call_id, keys: i.type === "additional_tools" ? Object.keys(i) : void 0 })) });
          const callId = "probe_call";
          if (calls++ === 0) {
            registry = body.tools ?? body.input?.find((item2) => item2.type === "additional_tools")?.tools;
            const mcp = ["get_context", "submit_report", "request_question", "read_skill_file"].includes(testCase.tool);
            let tool = findTool2(registry, testCase.tool);
            if (testCase.unavailable) {
              if (tool) throw new Error(`ungranted native tool advertised: ${testCase.tool}`);
              tool = { name: testCase.tool, type: "function", namespace: "mcp__kdd_run" };
            }
            if (!tool) throw new Error(`native tool missing: ${testCase.tool}`);
            if (mcp && tool.namespace !== "mcp__kdd_run") throw new Error("unexpected MCP namespace");
            if (testCase.revoke) {
              const token = JSON.parse(readFileSync7(broker.configPath, "utf8")).token;
              const authority = brokerDb.prepare("SELECT authority_id FROM run_authorities WHERE token_hash=?").get(digest3(token));
              revokeRunAuthority(openController(brokerDb), authority.authority_id);
            }
            const item = tool.type === "custom" ? { type: "custom_tool_call", id: "probe_item", call_id: callId, name: tool.name, input: testCase.patch } : {
              type: "function_call",
              id: "probe_item",
              call_id: callId,
              name: tool.name,
              arguments: JSON.stringify(mcp || /mcp_resource/.test(testCase.tool) ? testCase.payload ?? {} : testCase.tool === "apply_patch" ? { patch: testCase.patch } : { cmd: testCase.command, max_output_tokens: 1e3 })
            };
            if (tool.namespace) item.namespace = tool.namespace;
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(sse("response.created", { response: { id: "probe_response" } }));
            res.write(sse("response.output_item.done", { item }));
            const items = [item];
            if (testCase.revoke) {
              for (const operation of operations2.filter((operation2) => operation2 !== testCase.tool)) {
                const granted = findTool2(registry, operation);
                if (!granted) throw new Error(`native tool missing: ${operation}`);
                const second = {
                  type: "function_call",
                  id: `probe_${operation}`,
                  call_id: `probe_${operation}`,
                  name: granted.name,
                  ...granted.namespace ? { namespace: granted.namespace } : {},
                  arguments: JSON.stringify(brokerPayload(operation, "late proposal"))
                };
                items.push(second);
                res.write(sse("response.output_item.done", { item: second }));
              }
            }
            res.end(sse("response.completed", { response: { id: "probe_response", output: items } }));
          } else {
            output = body.input?.find((item2) => item2.call_id === callId && /call_output$/.test(item2.type))?.output;
            if (output === void 0) throw new Error("actual native call output missing");
            if (testCase.revoke) {
              output = Object.fromEntries(operations2.map((operation) => {
                const id2 = operation === testCase.tool ? callId : `probe_${operation}`;
                const value = body.input?.find((item2) => item2.call_id === id2 && /call_output$/.test(item2.type))?.output;
                if (value === void 0) throw new Error(`actual revoked ${operation} output missing`);
                return [operation, value];
              }));
            }
            const item = { type: "message", id: "final", role: "assistant", content: [{ type: "output_text", text: "Probe complete." }] };
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(sse("response.output_item.done", { item }));
            res.end(sse("response.completed", { response: { id: "final_response", output: [item] } }));
          }
        } catch (error) {
          providerError ??= error.message;
          res.writeHead(500);
          res.end("Fixture protocol error");
          child.kill("SIGKILL");
        }
      });
      await new Promise((resolve5) => server.listen(0, "127.0.0.1", resolve5));
      const port = server.address().port;
      const filesystem = { ":minimal": "read", [workspace]: writable ? "write" : "read", [scratch]: "write", [backend]: "read", [source]: "deny", [sibling]: "deny", [clone]: "deny", [protectedDir]: "deny", [join8(workspace, ".git")]: "read", [commonDir]: "read", [gitDir]: "read", [catalogPath]: "deny", [join8(workspace, ".codex")]: "read" };
      if (broker) for (const path of [broker.configPath, broker.entryPath, broker.dbPath, `${broker.dbPath}-wal`, `${broker.dbPath}-shm`]) filesystem[path] = "deny";
      if (testCase.controlRoot) filesystem[testCase.controlRoot] = "write";
      const config = [
        ...fixedCodexConfig(filesystem, catalogPath, broker, void 0, broker ? operations2 : void 0),
        // Only the model response service changes; native tools use the shared production policy.
        `openai_base_url=${JSON.stringify(`http://127.0.0.1:${port}/v1`)}`
      ];
      const args = [...fixedCodexArguments(workspace, model, config), "Execute the supplied fixture tool call."];
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const env = {
        HOME: process.env.HOME ?? "",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
        TMPDIR: scratch,
        LANG: "en_US.UTF-8",
        CODEX_API_KEY: "fixture-preflight-not-a-secret"
      };
      let child;
      try {
        child = rawDiagnostic ? spawn(executable, args, { env, stdio: ["ignore", "pipe", "pipe"] }) : await spawnCheckedNative({
          controlDir,
          executable,
          args,
          env,
          cwd: workspace,
          writableRoots: [scratch, ...writable ? [workspace] : [], ...testCase.controlRoot ? [testCase.controlRoot] : []],
          phase: testCase.phase ?? "start"
        });
      } catch (error) {
        server.closeAllConnections();
        await new Promise((resolve5) => server.close(() => resolve5()));
        throw error;
      }
      child.stdout.on("data", (data) => stdout += data);
      child.stderr.on("data", (data) => stderr += data);
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, 2e4);
      try {
        const exitCode = await new Promise((resolve5, reject) => {
          child.once("error", reject);
          child.once("close", resolve5);
        });
        const observation = {
          tools: [],
          protectedHashes: [],
          outcome: "inconclusive",
          unchangedProtectedBytes: true,
          caseId: testCase.id,
          mode: writable ? "workspace" : "readonly",
          tool: testCase.tool,
          exitCode,
          control: !!testCase.controlRoot,
          phase: testCase.phase ?? "start",
          executed: output !== void 0,
          timedOut,
          providerError,
          output,
          requests,
          firstRequestBytes,
          permissionHash: createHash7("sha256").update(JSON.stringify({ executableHash, version, model, filesystem, config })).digest("hex"),
          configHash: createHash7("sha256").update(JSON.stringify({ executableHash, version, filesystem, config })).digest("hex")
        };
        if (output === void 0) observation.diagnostic = (stderr + stdout).slice(-3e3);
        if (broker) {
          const token = JSON.parse(readFileSync7(broker.configPath, "utf8")).token;
          const safe = (text2) => text2.replaceAll(token, "[redacted]").replaceAll(digest3(token), "[redacted]");
          if (observation.output !== void 0) observation.output = JSON.parse(safe(JSON.stringify(observation.output)));
          if (observation.diagnostic) observation.diagnostic = safe(observation.diagnostic);
        }
        if (registry) observation.tools = flattenTools2(registry);
        observation.unchangedProtectedBytes = readFileSync7(foreign, "utf8") === "backend-original\n";
        observations.push(observation);
        return observation;
      } finally {
        clearTimeout(timer);
        child.kill("SIGKILL");
        server.closeAllConnections();
        await new Promise((resolve5) => server.close(() => resolve5()));
      }
    }
    const patchCreate = (path) => `*** Begin Patch
*** Add File: ${path}
+created
*** End Patch`;
    const patchUpdate = (path) => `*** Begin Patch
*** Update File: ${path}
@@
-original
+changed
*** End Patch`;
    const patchDelete = (path) => `*** Begin Patch
*** Delete File: ${path}
*** End Patch`;
    const digest3 = (value) => createHash7("sha256").update(value).digest("hex");
    const protectedPaths = [
      backend,
      source,
      sibling,
      protectedDir,
      commonDir,
      join8(workspace, ".git"),
      join8(workspace, ".codex"),
      ...broker ? [broker.configPath, broker.entryPath] : []
    ];
    const storeTables = [
      "tasks",
      "criteria",
      "comments",
      "task_links",
      "files",
      "tracks",
      "project",
      "repositories",
      "repository_bindings",
      "decisions",
      "search_index",
      "managed_task_policy",
      "run_authorities",
      "role_profiles",
      "role_revisions",
      "role_skill_files"
    ];
    const storeSnapshot = (revoking = false) => brokerDb ? digest3(JSON.stringify(storeTables.filter((table) => !revoking || table !== "run_authorities").map((table) => brokerDb.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()))) : "none";
    async function check(testCase, writable, expected, effect) {
      const unchangedPaths = protectedPaths.filter((path) => path !== testCase.controlRoot);
      const before = unchangedPaths.map(fingerprint2);
      const storeBefore = storeSnapshot(testCase.revoke);
      const eventsBefore = brokerDb?.prepare("SELECT * FROM events ORDER BY id").all();
      const observation = await runCase(testCase, writable);
      const text2 = typeof observation.output === "string" ? observation.output : JSON.stringify(observation.output) ?? "";
      observation.challengeHash = digest3(JSON.stringify([testCase.tool, testCase.patch ?? testCase.command]));
      observation.protectedHashes = unchangedPaths.map((path, i) => ({ path, before: before[i], after: fingerprint2(path) }));
      observation.outcome = "inconclusive";
      const allowed = observation.executed && /(?:Process exited with code|Exit code:) 0/.test(text2);
      const denied5 = observation.executed && /Operation not permitted|Permission denied|patch rejected/.test(text2);
      if (allowed) observation.outcome = "allowed";
      else if (denied5) observation.outcome = "denied";
      else if (testCase.unavailable && observation.executed && text2.includes(testCase.tool) && /unsupported|unknown|unrecognized|not found/i.test(text2)) observation.outcome = "denied";
      else if (["get_context", "submit_report", "request_question", "read_skill_file"].includes(testCase.tool)) {
        if (text2.includes("run operation denied") || /["\\]isError["\\]*\s*:\s*true/.test(text2)) observation.outcome = "denied";
        else if (text2.includes("taskId") || text2.includes("eventId") || text2.includes("contentBase64")) observation.outcome = "allowed";
      } else if (/mcp_resource/.test(testCase.tool) && observation.executed) {
        if (/resources\/(?:read|list|templates\/list) failed:/.test(text2) && /unknown|not found|not support|Method not found|capability/i.test(text2)) observation.outcome = "denied";
        else if (testCase.tool.startsWith("list_") && /"(?:resources|resourceTemplates)"\s*:\s*\[\s*\]/.test(text2)) observation.outcome = "allowed";
      } else if (testCase.failureCode && observation.executed && new RegExp(`Process exited with code ${testCase.failureCode}\\b`).test(text2) && networkControls.some((control) => control.caseId === testCase.id && control.exitCode === 0 && control.commandHash === digest3(testCase.command))) {
        observation.outcome = "denied";
        observation.matchedControl = `host:${testCase.id}`;
      } else if (testCase.matchedControl && observation.executed && /Exit code: 1/.test(text2) && /Failed to write file/.test(text2) && testCase.matchedControl.outcome === "allowed" && !testCase.matchedControl.failure && testCase.matchedControl.challengeHash === observation.challengeHash && observation.protectedHashes.every((path) => path.before === path.after)) {
        observation.outcome = "denied";
        observation.matchedControl = testCase.matchedControl.caseId;
      }
      try {
        assert.equal(observation.timedOut, false);
        assert.equal(observation.providerError, void 0);
        assert.equal(observation.outcome, expected, `expected ${expected}, got ${observation.outcome}`);
        if (testCase.revoke) {
          const outputs = observation.output;
          for (const operation of operations2) assert.ok(JSON.stringify(outputs[operation]).includes("run operation denied"), `revoked ${operation} was accepted`);
        }
        if (!testCase.controlRoot) assert.equal(observation.unchangedProtectedBytes, true, "foreign hardlink bytes changed");
        assert.ok(observation.protectedHashes.every((path) => path.before === path.after), "protected tree changed");
        for (const tool of observation.tools) {
          const name = tool.namespace ? `${tool.namespace}__${tool.name}` : tool.name;
          assert.ok(name && [
            "exec_command",
            "write_stdin",
            "apply_patch",
            ...broker ? [
              ...operations2.map((operation) => `mcp__kdd_run__${operation}`),
              "list_mcp_resources",
              "list_mcp_resource_templates",
              "read_mcp_resource"
            ] : []
          ].includes(name), `unexpected surface: ${name}`);
        }
        if (broker) {
          assert.equal(storeSnapshot(testCase.revoke), storeBefore, "protected board rows changed");
        }
        if (broker && !testCase.revoke) {
          if (testCase.unavailable || testCase.tool !== "submit_report" && testCase.tool !== "request_question") assert.deepEqual(brokerDb.prepare("SELECT * FROM events ORDER BY id").all(), eventsBefore);
        }
        effect?.();
      } catch (error) {
        observation.failure = error.message;
        failures.push({ caseId: testCase.id, mode: observation.mode, reason: error.message });
      }
      await withNativeControllerLock(controlDir, () => {
        writeFileSync4(foreign, "backend-original\n");
        writeFileSync4(join8(workspace, "existing.txt"), "original\n");
        rmSync4(join8(workspace, "created.txt"), { force: true });
      });
      if (observation.failure && !rawDiagnostic) throw new Error(`native probe failed: ${observation.mode}:${testCase.id}: ${observation.failure}`);
      return observation;
    }
    async function guardChecks() {
      const marker = join8(workspace, "unexpected-child");
      const input = (phase) => ({
        controlDir,
        executable: process.execPath,
        args: ["-e", 'require("node:fs").writeFileSync("unexpected-child","started")'],
        env: { PATH: "/usr/bin:/bin" },
        cwd: workspace,
        writableRoots: [workspace, scratch],
        phase
      });
      async function refused(id2, phase, pattern) {
        try {
          await assert.rejects(spawnCheckedNative(input(phase)), pattern);
          assert.equal(existsSync6(marker), false);
          preflight.push({ caseId: id2, phase, outcome: "denied", executed: false });
        } catch (error) {
          failures.push({ caseId: id2, reason: error.message });
        }
      }
      for (const writable of [workspace, scratch]) {
        const deep = join8(writable, "unsafe-deep");
        mkdirSync5(deep);
        linkSync(foreign, join8(deep, "alias"));
        await refused(`existing-hardlink-${writable === workspace ? "workspace" : "scratch"}`, "start", /hardlink/);
        rmSync4(deep, { recursive: true });
      }
      symlinkSync(foreign, join8(scratch, "first-symlink"));
      linkSync(join8(scratch, "first-symlink"), join8(scratch, "linked-symlink"));
      await refused("linked-symlink-inode", "start", /hardlink/);
      rmSync4(join8(scratch, "first-symlink"));
      rmSync4(join8(scratch, "linked-symlink"));
      assertWritableRoots([workspace, scratch]);
      linkSync(foreign, join8(scratch, "late-hardlink"));
      await refused("fresh-resume-after-safe-preflight", "resume", /hardlink/);
      rmSync4(join8(scratch, "late-hardlink"));
      await withNativeControllerLock(controlDir, async () => {
        assertWritableRoots([workspace, scratch]);
        const moduleUrl = import.meta.url;
        const command = `const core=await import(process.argv[1]);const fs=await import('node:fs');try {await core.withNativeControllerLock(process.argv[2],()=>fs.writeFileSync(process.argv[3],'changed'));process.exit(3)}catch(e){if(!/busy/.test(e.message))throw e}`;
        execFileSync6(process.execPath, ["--input-type=module", "-e", command, moduleUrl, controlDir, marker]);
        assert.equal(existsSync6(marker), false);
        await refused("cross-process-controller-exclusion", "start", /busy/);
      });
    }
    await checkNetworkControls();
    if (rawDiagnostic) {
      for (let iteration = 1; iteration <= 3; iteration++) {
        await check({ id: `hardlink-shell-${iteration}`, tool: "exec_command", command: '/bin/sh -c "echo changed > hardlink.txt"' }, true, "denied", () => {
        });
        await check({ id: `hardlink-patch-${iteration}`, tool: "apply_patch", patch: "*** Begin Patch\n*** Update File: hardlink.txt\n@@\n-backend-original\n+changed\n*** End Patch" }, true, "denied", () => {
        });
      }
    } else {
      await guardChecks();
      if (!lanAddress) failures.push({ caseId: "network-lan", reason: "LAN positive control unavailable" });
      if (!brokerOnly) for (const writable of [false, true]) {
        const read = await check({ id: "read", tool: "exec_command", command: "/bin/cat existing.txt" }, writable, "allowed", () => {
        });
        if (!(JSON.stringify(read.output) ?? "").includes("original")) throw new Error("positive native read incomplete");
        await check({ id: "protected-read", tool: "exec_command", command: `/bin/cat '${join8(protectedDir, "marker.txt")}'` }, writable, "denied", () => {
        });
        const projectConfig = join8(workspace, ".codex/config.toml");
        await check({ id: "project-config-shell", tool: "exec_command", command: `/bin/sh -c "echo changed > '${projectConfig}'"` }, writable, "denied", () => assert.equal(existsSync6(projectConfig), false));
        await check({ id: "project-config-patch", tool: "apply_patch", patch: patchCreate(projectConfig) }, writable, "denied", () => assert.equal(existsSync6(projectConfig), false));
        const expected = writable ? "allowed" : "denied";
        for (let iteration = 1; iteration <= (writable ? 1 : 3); iteration++) {
          for (const operation of ["create", "update", "delete"]) {
            for (const tool of ["exec_command", "apply_patch"]) {
              const command = { create: '/bin/sh -c "echo created > created.txt"', update: '/bin/sh -c "echo changed > existing.txt"', delete: "/bin/rm existing.txt" }[operation];
              const patch = { create: patchCreate("created.txt"), update: patchUpdate("existing.txt"), delete: patchDelete("existing.txt") }[operation];
              await check({ id: `${operation}-${iteration}`, tool, command, patch }, writable, expected, () => {
                if (operation === "create") assert.equal(existsSync6(join8(workspace, "created.txt")), writable);
                if (operation === "update") assert.equal(readFileSync7(join8(workspace, "existing.txt"), "utf8"), writable ? "changed\n" : "original\n");
                if (operation === "delete") assert.equal(existsSync6(join8(workspace, "existing.txt")), !writable);
              });
            }
          }
        }
        const symlinkPatch = "*** Begin Patch\n*** Update File: symlink.txt\n@@\n-backend-original\n+changed\n*** End Patch";
        for (let iteration = 1; iteration <= 3; iteration++) {
          const control = writable ? await check({ id: `symlink-positive-control-${iteration}`, tool: "apply_patch", patch: symlinkPatch, controlRoot: backend }, writable, "allowed", () => {
            assert.equal(readFileSync7(foreign, "utf8"), "changed\n");
          }) : void 0;
          await check({ id: `symlink-patch-${iteration}`, tool: "apply_patch", patch: symlinkPatch, matchedControl: control }, writable, "denied");
          await check({ id: `symlink-shell-${iteration}`, tool: "exec_command", command: '/bin/sh -c "echo changed > symlink.txt"' }, writable, "denied");
        }
        for (const destination of [workspace, scratch]) {
          for (const [name, target] of [["readonly", foreign], ["denied", join8(protectedDir, "marker.txt")]]) {
            const newLink = join8(destination, `new-link-${name}`);
            await check({ id: `create-hardlink-${name}-${destination === workspace ? "workspace" : "scratch"}`, tool: "exec_command", command: `/bin/ln '${target}' '${newLink}'` }, writable, "denied", () => assert.equal(existsSync6(newLink), false));
            rmSync4(newLink, { force: true });
          }
        }
        await check({ id: "backend-write", tool: "exec_command", command: `/bin/sh -c "echo changed > '${foreign}'"` }, writable, "denied", () => {
        });
        const backendPatch = "*** Begin Patch\n*** Update File: " + foreign + "\n@@\n-backend-original\n+changed\n*** End Patch";
        const backendControl = await check({ id: "backend-positive-control", tool: "apply_patch", patch: backendPatch, controlRoot: backend }, writable, "allowed", () => assert.equal(readFileSync7(foreign, "utf8"), "changed\n"));
        await check({ id: "backend-patch", tool: "apply_patch", patch: backendPatch, matchedControl: backendControl }, writable, "denied");
        for (const path of [join8(source, "existing.txt"), join8(sibling, "marker.txt"), ...["store.db", "registry.db", "config.toml", "credential.json"].map((name) => join8(protectedDir, name))]) {
          await check({ id: `protected-read-${path.split("/").slice(-2).join("-")}`, tool: "exec_command", command: `/bin/cat '${path}'` }, writable, "denied");
          await check({ id: `protected-write-${path.split("/").slice(-2).join("-")}`, tool: "exec_command", command: `/bin/sh -c "echo changed > '${path}'"` }, writable, "denied");
          await check({ id: `protected-patch-${path.split("/").slice(-2).join("-")}`, tool: "apply_patch", patch: patchDelete(path) }, writable, "denied");
        }
        await check({ id: "rename-outside", tool: "exec_command", command: `/bin/mv existing.txt '${join8(backend, "renamed.txt")}'` }, writable, "denied", () => assert.equal(existsSync6(join8(backend, "renamed.txt")), false));
        await check({ id: "patch-move-outside", tool: "apply_patch", patch: `*** Begin Patch
*** Update File: existing.txt
*** Move to: ${join8(protectedDir, "moved.txt")}
@@
-original
+changed
*** End Patch` }, writable, "denied", () => assert.equal(existsSync6(join8(protectedDir, "moved.txt")), false));
        await check({ id: "git-ref", tool: "exec_command", command: "/usr/bin/git update-ref refs/heads/forbidden HEAD" }, writable, "denied", () => {
          assert.equal(git3(workspace, "for-each-ref", "refs/heads/forbidden"), "");
        });
        await check({ id: "git-object", tool: "exec_command", command: `/bin/sh -c "echo new-object | /usr/bin/git hash-object -w --stdin"` }, writable, "denied");
        for (const [id2, path] of [["git-pointer", join8(workspace, ".git")], ["git-worktree-head", join8(gitDir, "HEAD")], ["git-common-config", join8(commonDir, "config")]]) {
          await check({ id: id2, tool: "exec_command", command: `/bin/sh -c "echo changed > '${path}'"` }, writable, "denied");
          await check({ id: `${id2}-patch`, tool: "apply_patch", patch: patchDelete(path) }, writable, "denied");
        }
        await check({ id: "scratch-write", tool: "exec_command", command: `/bin/sh -c "echo scratch > '${join8(scratch, "allowed.txt")}'"` }, writable, "allowed", () => assert.equal(readFileSync7(join8(scratch, "allowed.txt"), "utf8"), "scratch\n"));
        await check({ id: "scratch-patch", tool: "apply_patch", patch: patchCreate(join8(scratch, "patch-allowed.txt")) }, writable, "allowed", () => assert.equal(readFileSync7(join8(scratch, "patch-allowed.txt"), "utf8"), "created\n"));
        rmSync4(join8(scratch, "patch-allowed.txt"));
        await check({ id: "fresh-resume-read", tool: "exec_command", command: "/bin/cat existing.txt", phase: "resume" }, writable, "allowed");
        for (const testCase of networkCases) {
          await check({ ...testCase, tool: "exec_command" }, writable, "denied", () => {
            assert.equal(tcpRequests, tcpBaseline);
            assert.equal(unixRequests, unixBaseline);
          });
        }
      }
      if (broker) {
        for (const writable of [false, true]) {
          for (const tool of ["list_mcp_resources", "list_mcp_resource_templates"]) {
            await check({ id: `broker-${tool}-empty`, tool, payload: {} }, writable, "allowed");
            await check({ id: `broker-${tool}-foreign`, tool, payload: { server: "foreign" } }, writable, "denied");
          }
          for (const server of ["kdd_run", "foreign"]) await check({ id: `broker-resource-read-${server}`, tool: "read_mcp_resource", payload: { server, uri: `file://${broker.configPath}` } }, writable, "denied");
          for (const [operation, id2] of [
            ["get_context", "context"],
            ["submit_report", "report"],
            ["request_question", "question"],
            ["read_skill_file", "skill"]
          ]) {
            const granted = operations2.includes(operation);
            const before = brokerDb.prepare("SELECT COUNT(*) n FROM events").get();
            await check({
              id: `broker-${id2}`,
              tool: operation,
              unavailable: !granted,
              payload: brokerPayload(operation, "native broker proof")
            }, writable, granted ? "allowed" : "denied", () => {
              const writes = granted && operation !== "get_context" && operation !== "read_skill_file";
              assert.deepEqual(brokerDb.prepare("SELECT COUNT(*) n FROM events").get(), { n: before.n + (writes ? 1 : 0) });
              if (writes) {
                const event = brokerDb.prepare("SELECT actor_type,action,detail FROM events ORDER BY id DESC LIMIT 1").get();
                assert.equal(event.actor_type, "ai");
                assert.equal(event.action, operation === "submit_report" ? "run_report" : "run_question");
                assert.equal(JSON.parse(event.detail).untrusted, true);
              }
            });
          }
          for (const path of [broker.configPath, broker.dbPath]) {
            await check({ id: `broker-read-${path === broker.configPath ? "config" : "store"}`, tool: "exec_command", command: `/bin/cat '${path}'` }, writable, "denied");
            await check({ id: `broker-patch-${path === broker.configPath ? "config" : "store"}`, tool: "apply_patch", patch: patchDelete(path) }, writable, "denied");
          }
          const cli = fileURLToPath(new URL("../../cli/dist/index.js", import.meta.url));
          assert.ok(existsSync6(cli), "raw CLI fixture executable unavailable");
          await check({ id: "broker-raw-cli-user", tool: "exec_command", command: `/bin/sh -c "KDD_DB='${broker.dbPath}' KDD_ACTOR=user '${broker.nodePath}' '${cli}' show 1 --json"` }, writable, "denied");
        }
        const eventsBeforeRevoke = brokerDb.prepare("SELECT COUNT(*) n FROM events").get();
        await check({
          id: "broker-live-revoke-operations",
          tool: operations2[0],
          revoke: true,
          payload: brokerPayload(operations2[0], "late proposal")
        }, true, "denied", () => {
          assert.deepEqual(brokerDb.prepare("SELECT COUNT(*) n FROM events").get(), { n: eventsBeforeRevoke.n + 1 });
        });
      }
    }
  } catch (error) {
    failures.push({ failure: error.message });
  } finally {
    brokerDb?.close();
    tcpServer?.closeAllConnections();
    if (tcpServer?.listening) await new Promise((resolve5) => tcpServer.close(() => resolve5()));
    if (unixServer?.listening) await new Promise((resolve5) => unixServer.close(() => resolve5()));
    rmSync4(root, { recursive: true, force: true });
  }
  return {
    version,
    model,
    executableHash,
    scriptHash,
    guardHash,
    applicable: failures.length === 0 && observations.length > 0,
    rawDiagnostic,
    preflight,
    networkControls,
    attempted: observations.length,
    executed: observations.filter((o) => o.executed).length,
    failures,
    observations,
    operations: operations2
  };
}

// src/codex_permissions.ts
function directory(path) {
  try {
    if (!isAbsolute5(path) || !lstatSync3(path).isDirectory()) throw new Error("not a real directory");
    return realpathSync8(path);
  } catch (error) {
    throw new KddError(`native root unavailable: ${path}: ${error.message}`);
  }
}
function assertWritableRoots(roots) {
  if (!roots.length) throw new KddError("native writable roots are unknown");
  const canonical2 = [...new Set(roots.map(directory))];
  function scan(path) {
    const before = lstatSync3(path);
    if (!before.isDirectory()) {
      if (before.nlink > 1) throw new KddError(`native hardlink in writable root: ${path}`);
      return;
    }
    for (const name of readdirSync7(path)) scan(join9(path, name));
    const after = lstatSync3(path);
    if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) {
      throw new KddError(`native root changed during scan: ${path}`);
    }
  }
  try {
    for (const root of canonical2) scan(root);
  } catch (error) {
    if (error instanceof KddError) throw error;
    throw new KddError(`native root scan incomplete: ${error.message}`);
  }
  return canonical2;
}
async function withNativeControllerLock(controlDir, action) {
  const lock = join9(directory(controlDir), "native-launch.lock");
  try {
    mkdirSync6(lock, { mode: 448 });
  } catch (error) {
    if (error.code === "EEXIST") throw new KddError("native controller busy; stale locks require trusted recovery");
    throw new KddError(`native controller lock unavailable: ${error.message}`);
  }
  const identity = lstatSync3(lock);
  try {
    return await action();
  } finally {
    const current = lstatSync3(lock);
    if (identity.dev !== current.dev || identity.ino !== current.ino || !current.isDirectory()) {
      throw new KddError("native controller lock replaced; trusted recovery required");
    }
    rmdirSync(lock);
  }
}
function inside(parent, path) {
  const suffix = relative2(parent, path);
  return suffix === "" || suffix !== ".." && !suffix.startsWith(`..${sep2}`) && !isAbsolute5(suffix);
}
async function spawnCheckedNative(input) {
  const { executable, cwd, phase, verified } = input;
  const args = [...input.args];
  const env = { ...input.env };
  const roots = [...input.writableRoots];
  if (phase !== "start" && phase !== "resume") throw new KddError("unknown native launch phase");
  const controlDir = directory(input.controlDir);
  const canonical2 = roots.map(directory);
  if (canonical2.some((root) => inside(root, controlDir))) throw new KddError("native control directory is writable");
  return withNativeControllerLock(controlDir, () => {
    if (verified !== void 0) {
      assertVerifiedCodexPackage(verified);
      if (executable !== verified.executable || cwd !== verified.cwd || controlDir !== verified.controlDir || JSON.stringify(env) !== JSON.stringify(verified.env) || JSON.stringify(canonical2) !== JSON.stringify([verified.scratchDir, ...verified.writableRoot ? [verified.writableRoot] : []]) || args.length !== verified.argv.length + 1 || verified.argv.some((arg, i) => args[i] !== arg)) {
        throw new KddError("native launch differs from verified package");
      }
    }
    if (roots.some((root, index) => directory(root) !== canonical2[index])) throw new KddError("native root binding changed");
    assertWritableRoots(canonical2);
    input.beforeSpawn?.();
    const child = spawn2(executable, args, { cwd: resolve3(cwd), env, stdio: ["ignore", "pipe", "pipe"] });
    return new Promise((resolveChild, reject) => {
      child.once("error", reject);
      child.once("spawn", () => {
        child.removeListener("error", reject);
        resolveChild(child);
      });
    });
  });
}
function codexBrokerBinding(configPath, entryPath) {
  try {
    for (const path of [configPath, entryPath]) {
      if (!isAbsolute5(path) || !lstatSync3(path).isFile() || lstatSync3(path).nlink !== 1) throw new KddError("native broker binding unavailable");
    }
    const config = JSON.parse(readFileSync8(configPath, "utf8"));
    if ((lstatSync3(configPath).mode & 511) !== 384 || !config || Array.isArray(config) || Object.keys(config).sort().join(",") !== "dbPath,token" || typeof config.dbPath !== "string" || !isAbsolute5(config.dbPath) || realpathSync8(config.dbPath) !== config.dbPath || typeof config.token !== "string" || !/^[0-9a-f]{64}$/.test(config.token)) throw new KddError("native broker config denied");
    for (const path of [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`]) {
      try {
        if (!lstatSync3(path).isFile() || lstatSync3(path).nlink !== 1) throw new KddError("native store alias denied");
      } catch (error) {
        if (error.code !== "ENOENT" || path === config.dbPath) throw error;
      }
    }
    return { configPath: realpathSync8(configPath), entryPath: realpathSync8(entryPath), dbPath: config.dbPath, nodePath: realpathSync8(process.execPath) };
  } catch (error) {
    if (error instanceof KddError) throw error;
    throw new KddError("native broker binding unavailable");
  }
}
var nativeAccess = (packet) => packet.writableRoot ? "workspace-write" : "read";
var digest2 = (value) => createHash8("sha256").update(value).digest("hex");
var verifiedPackages = /* @__PURE__ */ new WeakMap();
function closedCodexCatalog(model) {
  return JSON.stringify({ models: [{
    slug: model,
    display_name: model,
    description: "Managed coding tools",
    base_instructions: "Follow the supplied task instructions.",
    supported_reasoning_levels: [],
    shell_type: "unified_exec",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    availability_nux: null,
    upgrade: null,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: "freeform",
    truncation_policy: { mode: "tokens", limit: 1e4 },
    experimental_supported_tools: [],
    tool_mode: "direct",
    multi_agent_version: "disabled"
  }] });
}
function fixedCodexConfig(filesystem, catalogPath, broker, effort, brokerTools = ["get_context", "submit_report", "request_question"]) {
  const table = Object.entries(filesystem).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(",");
  return [
    'model_provider="openai"',
    `model_catalog_json=${JSON.stringify(catalogPath)}`,
    ...effort ? [`model_reasoning_effort=${JSON.stringify(effort)}`] : [],
    'approval_policy="never"',
    'default_permissions="kdd_probe"',
    `permissions.kdd_probe.filesystem={${table}}`,
    "permissions.kdd_probe.network.enabled=false",
    'web_search="disabled"',
    "project_doc_max_bytes=0",
    "tools.experimental_request_user_input.enabled=false",
    'shell_environment_policy.inherit="none"',
    ...broker ? [`mcp_servers={kdd_run={command=${JSON.stringify(broker.nodePath)},args=${JSON.stringify([broker.entryPath, "--config", broker.configPath])},enabled=true,required=true,env_vars=[],default_tools_approval_mode="auto",startup_timeout_sec=10.0,tool_timeout_sec=10.0,enabled_tools=${JSON.stringify(brokerTools)}}}`] : [],
    "features={apply_patch_freeform=true,unified_exec=true,enable_request_compression=false,plugins=false,apps=false,connectors=false,enable_mcp_apps=false,codex_apps_mcp_2026_07_28=false,multi_agent=false,multi_agent_v2=false,multi_agent_mode=false,agent_message_board=false,computer_use=false,browser_use=false,browser_use_external=false,browser_use_full_cdp_access=false,in_app_browser=false,hooks=false,codex_hooks=false,plugin_hooks=false,shell_snapshot=false,shell_snapshot_v2=false,responses_websockets=false,responses_websockets_v2=false,skip_host_skill_discovery=true,skill_search=false,skill_mcp_dependency_install=false,goals=false,view_image=false,image_generation=false,imagegenext=false,js_repl=false,js_repl_tools_only=false,code_mode=false,code_mode_host=false,code_mode_only=false,memories=false,memory_tool=false,external_agent_memory_import=false,standalone_web_search=false,web_search=false,web_search_cached=false,web_search_request=false,search_tool=false,tool_search=false,tool_search_always_defer_mcp_tools=false,remote_models=false,remote_control=false,remote_plugin=false,daemon_auto_start=false,request_permissions=false,request_permissions_tool=false,request_rule=false,tool_call_mcp_elicitation=false,default_mode_request_user_input=false,api_key_model_discovery=false}"
  ];
}
function fixedCodexArguments(cwd, model, config) {
  const args = ["exec", "--ignore-user-config", "--ignore-rules", "--strict-config", "--ephemeral", "--skip-git-repo-check", "--json", "-C", cwd, "-m", model];
  for (const override of config) args.push("-c", override);
  return [...args, "--"];
}
function assertNoProjectConfig(roots) {
  const ignoredUser = process.env.HOME ? resolve3(process.env.HOME, ".codex/config.toml") : void 0;
  for (const root of roots) {
    for (let dir = root; ; dir = dirname6(dir)) {
      const config = join9(dir, ".codex/config.toml");
      if (config !== ignoredUser) {
        try {
          lstatSync3(config);
          throw new KddError("native project config overlay unsupported");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      if (dirname6(dir) === dir) break;
    }
  }
}
function contextMetadata(version, model) {
  try {
    if (!process.env.HOME) throw new Error("HOME missing");
    const cache2 = JSON.parse(readFileSync8(join9(process.env.HOME, ".codex/models_cache.json"), "utf8"));
    const age = Date.now() - Date.parse(cache2.fetched_at ?? "");
    const entry = cache2.models?.find((item) => item.slug === model);
    if (cache2.client_version !== version.replace("codex-cli ", "") || !Number.isFinite(age) || age < -6e4 || age > 864e5 || !entry || !Number.isSafeInteger(entry.context_window) || entry.context_window <= 0 || !Number.isInteger(entry.effective_context_window_percent) || entry.effective_context_window_percent < 1 || entry.effective_context_window_percent > 100) throw new Error("unverified cache");
    return {
      contextWindow: Math.floor(entry.context_window * entry.effective_context_window_percent / 100),
      expiresAt: Date.parse(cache2.fetched_at) + 864e5,
      hash: digest2(JSON.stringify({
        version: cache2.client_version,
        model,
        contextWindow: entry.context_window,
        effectivePercent: entry.effective_context_window_percent
      }))
    };
  } catch {
    throw new KddError("Codex context window unavailable");
  }
}
async function discoverCodexModel(executable, version, model, effort) {
  const offered = await new Promise((resolveModels, rejectModels) => {
    const child = spawn2(executable, ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
    const models = [];
    let buffer = "";
    let finished = false;
    let requestId = 2;
    const timeout = setTimeout(() => finish(new KddError("Codex model discovery timed out")), 1e4);
    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      child.kill();
      if (error) rejectModels(error);
      else resolveModels(models);
    }
    child.on("error", () => finish(new KddError("Codex model discovery unavailable")));
    child.on("close", () => finish(new KddError("Codex model discovery incomplete")));
    child.stdin.on("error", () => finish(new KddError("Codex model discovery unavailable")));
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 4 * 1024 * 1024) return finish(new KddError("Codex model discovery oversized"));
      for (let newline; !finished && (newline = buffer.indexOf("\n")) >= 0; ) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const reply = JSON.parse(line);
          if (reply.id === 1) {
            if (reply.error) throw new Error("initialize failed");
            child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}
`);
            child.stdin.write(`${JSON.stringify({ id: requestId, method: "model/list", params: { includeHidden: true } })}
`);
          } else if (reply.id === requestId) {
            if (reply.error || !Array.isArray(reply.result?.data)) throw new Error("model/list failed");
            models.push(...reply.result.data);
            if (reply.result.nextCursor === null || reply.result.nextCursor === void 0) finish();
            else if (typeof reply.result.nextCursor === "string" && requestId < 12) {
              child.stdin.write(`${JSON.stringify({ id: ++requestId, method: "model/list", params: { cursor: reply.result.nextCursor, includeHidden: true } })}
`);
            } else throw new Error("model/list pagination failed");
          }
        } catch {
          finish(new KddError("Codex model discovery invalid"));
        }
      }
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "kddkit", version: "1" } } })}
`);
  });
  const chosen = offered.find((item) => item.model === model);
  if (!chosen) throw new KddError("unsupported Codex model");
  if (!Array.isArray(chosen.supportedReasoningEfforts) || !chosen.supportedReasoningEfforts.some((item) => item.reasoningEffort === effort)) throw new KddError("unsupported Codex effort");
  return contextMetadata(version, model);
}
function assertVerifiedCodexPackage(packet) {
  const binding = typeof packet === "object" && packet !== null ? verifiedPackages.get(packet) : void 0;
  if (!binding) throw new KddError("unverified native package");
  try {
    if (binding.snapshot() !== binding.stamp) throw new KddError("native package binding changed");
  } catch {
    throw new KddError("native package binding changed or unavailable");
  }
}
async function preflightCodex(input) {
  const cwd = directory(input.cwd);
  const scratchDir = directory(input.scratchDir);
  const controlDir = directory(input.controlDir);
  const executable = realpathSync8(input.executable);
  const runtimeDir = realpathSync8(dirname6(fileURLToPath2(import.meta.url)));
  const readableRoots = [...new Set(input.readableRoots.map(directory))];
  const writableRoot = input.writableRoot ? directory(input.writableRoot) : void 0;
  if (input.brokerConfigPath === void 0 !== (input.brokerEntryPath === void 0)) throw new KddError("incomplete native broker binding");
  const broker = input.brokerConfigPath === void 0 ? void 0 : codexBrokerBinding(input.brokerConfigPath, input.brokerEntryPath);
  const brokerTools = broker ? brokerOperationNames(broker) : void 0;
  const protectedPaths = [...new Set([
    ...input.protectedPaths,
    controlDir,
    ...broker ? [broker.configPath, broker.entryPath, dirname6(broker.dbPath)] : []
  ].map((path) => {
    if (!isAbsolute5(path)) throw new KddError("native protected path must be absolute");
    return realpathSync8(path);
  }))];
  const model = input.model;
  if (typeof model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(model)) throw new KddError("unsupported Codex model identifier");
  const effort = input.effort;
  if (typeof effort !== "string" || !/^[a-z]+$/.test(effort)) throw new KddError("unsupported Codex effort");
  if (!readableRoots.includes(cwd) || writableRoot && writableRoot !== cwd) throw new KddError("unsupported Codex workspace scope");
  const writableRoots = [scratchDir, ...writableRoot ? [writableRoot] : []];
  const overlaps = (a, b) => inside(a, b) || inside(b, a);
  if (readableRoots.some((root) => overlaps(root, scratchDir)) || writableRoots.some((root) => [...protectedPaths, runtimeDir, executable].some((path) => overlaps(root, path)))) throw new KddError("native root/control/runtime overlap");
  assertNoProjectConfig([cwd]);
  if (process.platform !== "darwin") throw new KddError("unsupported Codex host");
  const version = execFileSync7(executable, ["--version"], { encoding: "utf8" }).trim();
  if (version !== "codex-cli 0.159.0") throw new KddError("unsupported Codex version");
  const resolveGitMetadata = () => [...new Set(readableRoots.flatMap((root) => [join9(root, ".git"), ...["--absolute-git-dir", "--git-common-dir"].map((flag) => realpathSync8(execFileSync7("/usr/bin/git", ["-C", root, "rev-parse", "--path-format=absolute", flag], { encoding: "utf8" }).trim()))]))];
  const gitMetadata = resolveGitMetadata();
  const filesystem = { ":minimal": "read" };
  for (const path of readableRoots) filesystem[path] = "read";
  for (const path of writableRoots) filesystem[path] = "write";
  for (const path of protectedPaths) filesystem[path] = "deny";
  for (const path of [...gitMetadata, join9(cwd, ".codex")]) filesystem[path] = "read";
  const catalog = closedCodexCatalog(model);
  const catalogPath = join9(controlDir, `codex-catalog-${digest2(catalog)}.json`);
  filesystem[catalogPath] = "deny";
  const argv = Object.freeze(fixedCodexArguments(cwd, model, fixedCodexConfig(filesystem, catalogPath, broker, effort, brokerTools)));
  if (!process.env.HOME) throw new KddError("Codex home unavailable");
  const env = Object.freeze({ HOME: process.env.HOME, PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin", TMPDIR: scratchDir, LANG: "en_US.UTF-8" });
  const metadata = await discoverCodexModel(executable, version, model, effort);
  return withNativeControllerLock(controlDir, async () => {
    assertWritableRoots(writableRoots);
    if (existsSync7(catalogPath)) {
      if (lstatSync3(catalogPath).isSymbolicLink() || readFileSync8(catalogPath, "utf8") !== catalog) throw new KddError("native catalog binding changed");
    } else writeFileSync5(catalogPath, catalog, { mode: 384, flag: "wx" });
    const snapshot2 = () => {
      assertNoProjectConfig([cwd]);
      assertWritableRoots(writableRoots);
      if (JSON.stringify(resolveGitMetadata()) !== JSON.stringify(gitMetadata)) throw new KddError("native Git binding changed");
      const catalogStat = lstatSync3(catalogPath);
      if (!catalogStat.isFile() || catalogStat.nlink !== 1) throw new KddError("native catalog binding alias");
      const currentBroker = broker ? codexBrokerBinding(broker.configPath, broker.entryPath) : void 0;
      const identities = [.../* @__PURE__ */ new Set([
        cwd,
        controlDir,
        ...readableRoots,
        ...writableRoots,
        ...protectedPaths,
        ...gitMetadata,
        ...broker ? [broker.dbPath, broker.nodePath] : []
      ])].map((path) => {
        const stat = lstatSync3(path);
        if (stat.isSymbolicLink()) throw new KddError("native binding alias");
        return [path, stat.dev, stat.ino];
      });
      return digest2(JSON.stringify({
        identities,
        argv,
        env,
        executable,
        version,
        gitPointers: gitMetadata.filter((path) => lstatSync3(path).isFile()).map((path) => [path, digest2(readFileSync8(path))]),
        executableHash: digest2(readFileSync8(executable)),
        catalogHash: digest2(readFileSync8(catalogPath)),
        broker: currentBroker,
        brokerTools: broker ? brokerOperationNames(broker) : void 0,
        brokerEntryHash: broker ? digest2(readFileSync8(broker.entryPath)) : void 0,
        nodeHash: broker ? digest2(readFileSync8(broker.nodePath)) : void 0,
        runtimeHash: digest2(readFileSync8(fileURLToPath2(import.meta.url)))
      }));
    };
    const stamp = snapshot2();
    const evidence2 = await observeCodexNative(executable, false, model, broker);
    if (!evidence2.applicable || evidence2.rawDiagnostic || evidence2.observations.length !== (broker ? 160 : 129) || evidence2.executed !== evidence2.observations.length || evidence2.observations.some((o) => o.firstRequestBytes > 131072)) throw new KddError("Codex native enforcement unverified", { cause: {
      expected: broker ? 160 : 129,
      attempted: evidence2.attempted,
      executed: evidence2.executed,
      applicable: evidence2.applicable,
      observations: evidence2.observations.filter((o) => o.failure).map((o) => ({
        caseId: o.caseId,
        mode: o.mode,
        outcome: o.outcome,
        executed: o.executed,
        timedOut: o.timedOut,
        providerError: !!o.providerError
      })),
      failedGuards: evidence2.failures.filter((f) => f.caseId).map((f) => f.caseId)
    } });
    if (snapshot2() !== stamp) throw new KddError("native package binding changed during preflight");
    const contextWindow = metadata.contextWindow;
    const boundStamp = digest2(`${stamp}:${metadata.hash}`);
    const results = Object.freeze(evidence2.observations.filter((result2) => !result2.control).map((result2) => Object.freeze({
      caseId: `${result2.mode}:${result2.caseId}`,
      tool: result2.tool,
      outcome: result2.outcome,
      executed: result2.executed,
      unchangedProtectedBytes: result2.unchangedProtectedBytes,
      firstRequestBytes: result2.firstRequestBytes
    })));
    const packet = Object.freeze({
      executable,
      version,
      model,
      effort,
      contextWindow,
      brokerConfigPath: broker?.configPath,
      brokerTools: Object.freeze([...brokerTools ?? []]),
      cwd,
      controlDir,
      readableRoots: Object.freeze(readableRoots),
      writableRoot,
      scratchDir,
      protectedPaths: Object.freeze(protectedPaths),
      argv,
      env,
      configHash: boundStamp,
      results
    });
    verifiedPackages.set(packet, { stamp: boundStamp, snapshot: () => {
      if (Date.now() > metadata.expiresAt) throw new KddError("Codex context metadata expired");
      return digest2(`${snapshot2()}:${metadata.hash}`);
    } });
    return packet;
  });
}

// src/run_inputs.ts
var denied2 = () => new KddError("run input snapshot denied");
function rolePinDb(db, grant) {
  if (!grant.role || !Number.isSafeInteger(grant.native.contextWindow) || grant.native.contextWindow < 1) throw denied2();
  const { definition, receipt: receipt2 } = roleRevisionDb(db, grant.role), files = roleFilesDb(db, grant.role);
  return {
    ...receipt2,
    model: definition.model,
    effort: definition.effort,
    contextWindow: grant.native.contextWindow,
    skills: definition.skills.map((skill) => ({
      name: skill.name,
      mode: skill.mode,
      manifestHash: digest(files.filter((file) => file.skill === skill.name).map((file) => ({ path: file.path, sha256: file.sha256, mime: file.mime, size: file.bytes.length })))
    })),
    operations: [...grant.operations],
    nativeConfigHash: grant.native.configHash
  };
}
function runInputHash(snapshot2) {
  return digest({ ...snapshot2, inputHash: void 0, response: {
    ...snapshot2.response,
    inputs: { ...snapshot2.response.inputs, inputHash: void 0 }
  } });
}
function readRunInputSnapshotDb(db, authorityId) {
  if (!db.inTransaction || typeof authorityId !== "string" || !/^[0-9a-f]{32}$/.test(authorityId)) throw denied2();
  try {
    const row = db.prepare("SELECT * FROM run_input_snapshots WHERE authority_id=?").get(authorityId);
    const authority = db.prepare("SELECT * FROM run_authorities WHERE authority_id=?").get(authorityId);
    if (!row || !authority) throw denied2();
    const snapshot2 = JSON.parse(row.payload_json), grant = JSON.parse(authority.grant_json);
    shape(snapshot2, ["authorityId", "inputHash", "createdAt", "response", "validation"]);
    const { response: r, validation: v } = snapshot2, inputs = r.inputs;
    shape(v, ["repositories", "ownership", "inputResults", "artifacts"]);
    const baseKeys = [
      "schemaVersion",
      "authorityId",
      "inputHash",
      "createdAt",
      "budget",
      "requirements",
      "rules",
      "knowledge",
      "workItem",
      "dependencies",
      "repositories",
      "operations",
      "nativeConfigHash"
    ];
    if (inputs.schemaVersion === 2) shape(inputs, [...baseKeys, "role"]);
    else if (inputs.schemaVersion === 1) shape(inputs, baseKeys);
    else throw denied2();
    integer(snapshot2.createdAt, 0);
    if (snapshot2.authorityId !== authorityId || inputs.authorityId !== authorityId || row.created_at !== snapshot2.createdAt || inputs.createdAt !== snapshot2.createdAt || snapshot2.inputHash !== row.input_hash || inputs.inputHash !== row.input_hash || runInputHash(snapshot2) !== row.input_hash || r.projectId !== projectOf(db).project_id || grant.projectId !== r.projectId || r.taskId !== authority.task_id || grant.taskId !== r.taskId || r.workItemId !== authority.work_item_id || grant.workItemId !== r.workItemId || r.runId !== authority.run_id || grant.runId !== r.runId || r.generation !== authority.generation || grant.generation !== r.generation || digest(inputs.operations) !== digest(grant.operations) || inputs.nativeConfigHash !== grant.native.configHash || ![
      inputs.requirements,
      inputs.rules,
      inputs.knowledge,
      inputs.dependencies,
      inputs.repositories,
      v.repositories,
      v.inputResults,
      v.artifacts
    ].every(Array.isArray)) throw denied2();
    if (inputs.schemaVersion === 2) {
      if (!grant.role || digest(grant.role) !== digest({ roleId: inputs.role.roleId, revision: inputs.role.revision }) || digest(inputs.role) !== digest(rolePinDb(db, grant))) throw denied2();
    } else if (grant.role) throw denied2();
    return snapshot2;
  } catch {
    throw denied2();
  }
}
function persistRunInputSnapshotDb(db, snapshot2) {
  if (!db.inTransaction) throw denied2();
  db.prepare("INSERT INTO run_input_snapshots VALUES(?,?,?,?)").run(snapshot2.authorityId, snapshot2.inputHash, JSON.stringify(snapshot2), snapshot2.createdAt);
  readRunInputSnapshotDb(db, snapshot2.authorityId);
}
function runInputSnapshot(handle, ref) {
  const db = controllerDb(handle);
  return db.transaction(() => {
    shape(ref, ["projectId", "authorityId"]);
    if (ref.projectId !== projectOf(db).project_id) throw denied2();
    return readRunInputSnapshotDb(db, ref.authorityId);
  })();
}
function runContextWireBytes(response) {
  return Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(response) }] }), "utf8");
}
function safeContext(value) {
  const encoded = JSON.stringify(value);
  if (redact(encoded) !== encoded || Buffer.from(encoded).toString("utf8") !== encoded) throw new KddError("private or malformed run input");
}
function readRunArtifact(db, path, hash2, maxBytes, privateRoots, checkouts) {
  try {
    if (!isAbsolute6(path) || resolve4(path) !== path || realpathSync9(path) !== path || !/^[0-9a-f]{64}$/.test(hash2)) throw denied2();
    for (let ancestor = path; ; ancestor = dirname7(ancestor)) {
      if (lstatSync4(ancestor).isSymbolicLink()) throw denied2();
      if (dirname7(ancestor) === ancestor) break;
    }
    const fileRoot = filesDir(db.name), stored = existsSync8(fileRoot) && realpathSync9(fileRoot) === fileRoot && inside(fileRoot, path);
    if (memoryPrivatePath(stored ? relative3(fileRoot, path) : path) || privateRoots.some((root) => inside(root, path) && !(stored && root !== fileRoot && inside(root, fileRoot)) && !checkouts.some((checkout) => root !== checkout && inside(root, checkout) && inside(checkout, path) && !memoryPrivatePath(relative3(checkout, path))))) throw denied2();
    const before = lstatSync4(path);
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) throw denied2();
    for (const privatePath of [db.name, db.name + "-wal", db.name + "-shm"]) {
      if (path === privatePath) throw denied2();
      if (existsSync8(privatePath)) {
        const s = lstatSync4(privatePath);
        if (s.dev === before.dev && s.ino === before.ino) throw denied2();
      }
    }
    const fd = openSync2(path, constants2.O_RDONLY | constants2.O_NOFOLLOW);
    try {
      const file = fstatSync2(fd);
      if (file.dev !== before.dev || file.ino !== before.ino || !file.isFile() || file.nlink !== 1 || file.size > maxBytes) throw denied2();
      const bytes2 = readFileSync9(fd), after = fstatSync2(fd), current = lstatSync4(path);
      if (bytes2.length !== file.size || after.dev !== file.dev || after.ino !== file.ino || after.nlink !== 1 || after.size !== file.size || after.mtimeMs !== file.mtimeMs || after.ctimeMs !== file.ctimeMs || current.dev !== file.dev || current.ino !== file.ino || current.isSymbolicLink() || createHash9("sha256").update(bytes2).digest("hex") !== hash2) throw denied2();
      const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes2);
      safeContext(body);
      return body;
    } finally {
      closeSync2(fd);
    }
  } catch {
    throw new KddError("unsafe or changed run input artifact");
  }
}
function runInputRequirements(db, grant) {
  const task = scopedTask(db, { projectId: grant.projectId, taskId: grant.taskId });
  const ids = [...task.parent_id === null ? [] : [task.parent_id], task.id];
  if (db.prepare("SELECT 1 FROM work_items WHERE id=?").get(grant.workItemId)) {
    const item = scopedWorkItem(db, { projectId: grant.projectId, workItemId: grant.workItemId });
    for (const input of item.inputs) if (!ids.includes(input.task.taskId)) ids.push(input.task.taskId);
  }
  return ids.map((taskId) => {
    const ref = { projectId: grant.projectId, taskId }, t = scopedTask(db, ref);
    return {
      task: ref,
      parentId: t.parent_id,
      hash: contractHash(db, ref),
      title: t.title,
      body: t.body,
      criteria: db.prepare("SELECT id,text FROM criteria WHERE task_id=? ORDER BY id").all(taskId)
    };
  });
}
function buildRunInputSnapshot(db, original, authorityId, options = {}, observers = {}, privateRoots = []) {
  if (!db.inTransaction || !/^[0-9a-f]{32}$/.test(authorityId)) throw denied2();
  const grant = structuredClone(original);
  shape(options, [], ["maxBytes", "query", "k"]);
  if (!grant.role || !roleActiveDb(db, grant.role.roleId)) throw denied2();
  const role = rolePinDb(db, grant);
  const maxBytes = options.maxBytes ?? CAPS.agentDetailBytes;
  integer(maxBytes);
  if (maxBytes > CAPS.agentDetailBytes) throw new KddError("run input budget exceeds limit");
  if (options.k !== void 0) {
    integer(options.k);
    if (options.k > CAPS.recallKMax) throw denied2();
  }
  const task = scopedTask(db, { projectId: grant.projectId, taskId: grant.taskId });
  const repositories = grant.repositories.map((repo) => {
    const checkoutPath = memoryCheckout(db, repo.repoId, repo.checkoutPath);
    if (canonicalCommonDir(checkoutPath) !== repo.commonDir) throw denied2();
    const commit = execFileSync8(
      "/usr/bin/git",
      ["--no-replace-objects", "rev-parse", "--verify", "HEAD^{commit}"],
      { cwd: checkoutPath, encoding: "utf8", stdio: "pipe", maxBuffer: 4096 }
    ).trim();
    memoryCommit(db, repo.repoId, commit, checkoutPath);
    return { repoId: repo.repoId, checkoutPath, commit };
  });
  const view = { scope: { projectId: grant.projectId, taskId: grant.taskId }, repositories };
  const requirements = runInputRequirements(db, grant), eligible = selectMemory(db, view), rules = eligible.filter((r) => r.kind === "rule");
  const modeled = !!db.prepare("SELECT 1 FROM work_items WHERE id=?").get(grant.workItemId);
  const item = modeled ? scopedWorkItem(db, { projectId: grant.projectId, workItemId: grant.workItemId }) : null;
  let inputResults = [];
  if (item) {
    if (!grant.ownership) throw new KddError("modeled work requires ownership");
    checkOwnershipRef(db, grant.ownership);
    const o = db.prepare("SELECT * FROM work_item_owners WHERE work_item_id=? AND fence=? AND owner_id=? AND revision=? AND released_at IS NULL").get(item.ref.workItemId, grant.ownership.fence, grant.ownership.ownerId, grant.ownership.revision);
    if (!o || item.task.taskId !== task.id || item.revision !== grant.ownership.revision || item.fence !== grant.ownership.fence || !inputsCurrent(db, item)) throw denied2();
    const pins = JSON.parse(o.inputs_json);
    if (pins.projectId !== grant.projectId || pins.inputsHash !== item.inputsHash || !pinnedInputsCurrent(db, item, pins.inputResults)) throw denied2();
    if (grant.repositories.some((r) => r.write && (!o.write_access || item.definition.repoId !== r.repoId))) throw denied2();
    inputResults = pins.inputResults;
    for (const dep of item.dependencies) if (dep.binding.kind === "code" || dep.binding.kind === "merged") {
      const binding = dep.binding;
      if (!repositories.some((r) => r.repoId === binding.repoId && r.commit === binding.baseHead)) throw new KddError("dependency base differs from run input");
    }
    if (!dependencyProjection(db, item, observers).ready) throw new KddError("run input dependencies not verified");
  } else if (grant.ownership) throw denied2();
  const artifacts = [];
  const dependencies = inputResults.map((pin2) => {
    const record = rowResult(db, pin2.resultId), payload = record.payload;
    if (payload.kind === "contract") {
      const body = readRunArtifact(db, payload.artifact.path, payload.artifact.sha256, maxBytes, privateRoots, repositories.map((r) => r.checkoutPath));
      artifacts.push({ resultId: record.id, ...payload.artifact });
      return {
        edgeKey: pin2.edgeKey,
        resultId: record.id,
        payloadHash: digest(payload),
        binding: record.binding,
        payload: { kind: payload.kind, repoId: payload.repoId, version: payload.version, checkRefs: [...payload.checkRefs], head: payload.head },
        artifact: { sha256: payload.artifact.sha256, body }
      };
    }
    return { edgeKey: pin2.edgeKey, resultId: record.id, payloadHash: digest(payload), binding: record.binding, payload };
  });
  const query = options.query ?? task.title;
  if (typeof query !== "string" || query.length > CAPS.bodyChars) throw denied2();
  safeContext(query);
  let match = "";
  try {
    match = sanitizeQuery(query);
  } catch (error) {
    if (!(error instanceof KddError) || error.message !== "empty query") throw error;
  }
  const hits = match ? queryMemoryDb(db, view, query, { k: options.k }, ["fact", "decision"]) : [];
  const optional = hits.filter((h) => h.kind === "fact" || h.kind === "decision").map((h) => memoryRecordDb(db, h.ref.entryId, h.ref.revision));
  const createdAt = now(), snapshot2 = {
    authorityId,
    inputHash: "0".repeat(64),
    createdAt,
    response: {
      projectId: grant.projectId,
      taskId: grant.taskId,
      workItemId: grant.workItemId,
      runId: grant.runId,
      generation: grant.generation,
      task: { title: task.title, body: task.body, status: task.status },
      criteria: listCriteria(db, task.id).map((c) => ({ id: c.id, text: c.text, checked: c.checked_at !== null })),
      decisions: db.prepare(`SELECT d.slug,d.title FROM decisions d,json_each(d.source_tasks) s WHERE CAST(s.value AS INTEGER)=? ORDER BY d.slug`).all(task.id),
      inputs: {
        schemaVersion: 2,
        role,
        authorityId,
        inputHash: "0".repeat(64),
        createdAt,
        budget: { maxBytes, omittedRecords: optional.length },
        requirements,
        rules,
        knowledge: [],
        workItem: item ? { ref: item.ref, revision: item.revision, inputsHash: item.inputsHash, definition: item.definition } : null,
        dependencies,
        repositories: repositories.map((r, i) => ({ repoId: r.repoId, commit: r.commit, write: grant.repositories[i].write })),
        operations: [...grant.operations],
        nativeConfigHash: grant.native.configHash
      }
    },
    validation: { repositories, ownership: grant.ownership ?? null, inputResults, artifacts }
  };
  safeContext(snapshot2.response);
  const finalize = () => {
    snapshot2.inputHash = runInputHash(snapshot2);
    snapshot2.response.inputs.inputHash = snapshot2.inputHash;
    return runContextWireBytes(snapshot2.response);
  };
  let requiredBytes = finalize();
  if (requiredBytes > maxBytes) throw new KddError(`run input budget exceeded: requiredBytes=${requiredBytes} limit=${maxBytes}`);
  for (const record of optional) {
    safeContext(record);
    snapshot2.response.inputs.knowledge.push(record);
    snapshot2.response.inputs.budget.omittedRecords--;
    if (finalize() > maxBytes) {
      snapshot2.response.inputs.knowledge.pop();
      snapshot2.response.inputs.budget.omittedRecords++;
      finalize();
    }
  }
  if (canonical(requirements) !== canonical(runInputRequirements(db, grant)) || digest(rules) !== digest(selectMemory(db, view).filter((r) => r.kind === "rule")) || item && (!inputsCurrent(db, item) || !pinnedInputsCurrent(db, scopedWorkItem(db, item.ref), inputResults))) throw new KddError("run inputs changed during assembly");
  for (const repo of repositories) {
    const head = execFileSync8("/usr/bin/git", ["--no-replace-objects", "rev-parse", "--verify", "HEAD^{commit}"], { cwd: repo.checkoutPath, encoding: "utf8", stdio: "pipe" }).trim();
    if (head !== repo.commit) throw new KddError("run repository changed during assembly");
  }
  return snapshot2;
}

// src/run_inputs_current.ts
function runInputChangesDb(db, snapshot2) {
  if (!db.inTransaction) throw new KddError("run input check requires transaction");
  const { response, validation } = snapshot2, inputs = response.inputs, changes = [];
  if (inputs.schemaVersion === 2 && !roleActiveDb(db, inputs.role.roleId)) changes.push({ reason: "role_changed" });
  const memoryRef = (record) => ({ revision: record.revision, hash: record.hash });
  for (const required of inputs.requirements) {
    try {
      const current = scopedTask(db, required.task);
      if (current.parent_id !== required.parentId) changes.push({ reason: "membership_changed", taskId: required.task.taskId });
      if (contractHash(db, required.task) !== required.hash) changes.push({ reason: "requirements_changed", taskId: required.task.taskId });
    } catch {
      changes.push({ reason: "requirements_changed", taskId: required.task.taskId });
    }
  }
  let reposCurrent = true;
  for (const repo of validation.repositories) {
    try {
      memoryCommit(db, repo.repoId, repo.commit, repo.checkoutPath);
    } catch {
      reposCurrent = false;
      changes.push({ reason: "repository_changed", repoId: repo.repoId });
    }
  }
  if (inputs.workItem) {
    try {
      const saved = inputs.workItem, item = scopedWorkItem(db, saved.ref);
      if (item.task.taskId !== response.taskId || item.revision !== saved.revision || item.inputsHash !== saved.inputsHash || !inputsCurrent(db, item) || canonical(item.definition) !== canonical(saved.definition)) changes.push({ reason: "work_item_changed" });
      const o = validation.ownership;
      const row = o ? db.prepare("SELECT * FROM work_item_owners WHERE work_item_id=? AND fence=? AND owner_id=? AND revision=? AND released_at IS NULL").get(o.workItemId, o.fence, o.ownerId, o.revision) : void 0;
      if (!o || !row || item.fence !== o.fence || item.revision !== o.revision || JSON.parse(row.inputs_json).inputsHash !== saved.inputsHash || canonical(JSON.parse(row.inputs_json).inputResults) !== canonical(validation.inputResults)) changes.push({ reason: "ownership_changed" });
      if (!pinnedInputsCurrent(db, item, validation.inputResults)) changes.push({ reason: "dependency_changed" });
    } catch {
      changes.push({ reason: "work_item_changed" });
    }
  }
  for (const dependency of inputs.dependencies) {
    try {
      const r = rowResult(db, dependency.resultId);
      if (r.invalidatedAt !== null || digest(r.payload) !== dependency.payloadHash || canonical(r.binding) !== canonical(dependency.binding))
        changes.push({ reason: "dependency_changed", resultId: r.id });
      if (r.payload.kind === "readiness" && r.payload.expiresAt !== null && r.payload.expiresAt <= now()) changes.push({ reason: "readiness_expired", resultId: r.id });
    } catch {
      changes.push({ reason: "dependency_changed", resultId: dependency.resultId });
    }
  }
  for (const artifact of validation.artifacts) {
    try {
      readRunArtifact(db, artifact.path, artifact.sha256, inputs.budget.maxBytes, [], validation.repositories.map((r) => r.checkoutPath));
    } catch {
      changes.push({ reason: "dependency_changed", resultId: artifact.resultId });
    }
  }
  for (const memory of [...inputs.rules, ...inputs.knowledge]) {
    try {
      const current = memoryRecordDb(db, memory.entryId);
      if (current.revision !== memory.revision || current.hash !== memory.hash || current.status !== "active")
        changes.push({ reason: "memory_changed", entryId: memory.entryId, previous: memoryRef(memory), current: memoryRef(current) });
    } catch {
      changes.push({ reason: "memory_changed", entryId: memory.entryId, previous: memoryRef(memory), current: null });
    }
  }
  if (reposCurrent) {
    try {
      const view = { scope: { projectId: response.projectId, taskId: response.taskId }, repositories: validation.repositories };
      const saved = new Map(inputs.rules.map((r) => [r.entryId, memoryRef(r)]));
      const current = new Map(selectMemory(db, view).filter((r) => r.kind === "rule").map((r) => [r.entryId, memoryRef(r)]));
      for (const entryId of /* @__PURE__ */ new Set([...saved.keys(), ...current.keys()])) {
        const previous = saved.get(entryId) ?? null, next = current.get(entryId) ?? null;
        if (canonical(previous) !== canonical(next)) changes.push({ reason: "rules_changed", entryId, previous, current: next });
      }
    } catch {
      changes.push({ reason: "rules_changed" });
    }
  }
  return [...new Map(changes.map((c) => [canonical(c), c])).values()].sort((a, b) => canonical(a).localeCompare(canonical(b)));
}
function assertRunInputsCurrentDb(db, authorityId) {
  const snapshot2 = readRunInputSnapshotDb(db, authorityId);
  if (runInputChangesDb(db, snapshot2).length) throw new KddError("run inputs stale; explicit update required");
}
function assertOwnedRunInputsCurrentDb(db, owner) {
  const rows = db.prepare("SELECT authority_id,grant_json FROM run_authorities WHERE work_item_id=? ORDER BY generation DESC").all(owner.workItemId);
  for (const row of rows) {
    let grant;
    try {
      grant = JSON.parse(row.grant_json);
    } catch {
      throw new KddError("owned run inputs denied");
    }
    if (!grant.ownership) throw new KddError("owned run inputs missing");
    if (canonical(grant.ownership) === canonical(owner)) {
      assertRunInputsCurrentDb(db, row.authority_id);
      return;
    }
  }
}
function checkRunInputs(handle, ref) {
  const db = controllerDb(handle);
  return db.transaction(() => {
    shape(ref, ["projectId", "authorityId"]);
    if (ref.projectId !== projectOf(db).project_id || typeof ref.authorityId !== "string" || !/^[0-9a-f]{32}$/.test(ref.authorityId)) throw new KddError("run input reference denied");
    const row = db.prepare("SELECT task_id,grant_json FROM run_authorities WHERE authority_id=?").get(ref.authorityId);
    if (!row || JSON.parse(row.grant_json).projectId !== ref.projectId) throw new KddError("run input reference denied");
    let inputHash = null, changes;
    try {
      const snapshot2 = readRunInputSnapshotDb(db, ref.authorityId);
      inputHash = snapshot2.inputHash;
      changes = runInputChangesDb(db, snapshot2);
    } catch {
      changes = [{ reason: "snapshot_missing" }];
    }
    if (!changes.length) return { status: "current", authorityId: ref.authorityId, inputHash };
    const changeHash = digest(changes);
    const existing = db.prepare(`SELECT id FROM events WHERE action='run_inputs_changed' AND task_id=?
      AND json_extract(detail,'$.authorityId')=? AND json_extract(detail,'$.inputHash') IS ? AND json_extract(detail,'$.changeHash')=? ORDER BY id LIMIT 1`).get(row.task_id, ref.authorityId, inputHash, changeHash);
    const eventId = existing?.id ?? appendEvent(db, row.task_id, controllerActor, "run_inputs_changed", { authorityId: ref.authorityId, inputHash, changeHash, changes });
    return { status: "update_required", authorityId: ref.authorityId, inputHash, changeHash, changes, eventId };
  }).immediate();
}

// src/execution.ts
var controllerActor = { type: "ai", id: "controller" };
function shape(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((k) => !required.includes(k) && !optional.includes(k)) || required.some((k) => !Object.hasOwn(value, k))) throw new KddError("invalid input shape");
}
function text(value) {
  if (typeof value !== "string" || !value.trim()) throw new KddError("invalid nonempty string");
}
function integer(value, min = 1) {
  if (!Number.isSafeInteger(value) || value < min) throw new KddError("invalid safe integer");
}
function mode(value) {
  if (value !== "manual" && value !== "orchestrated") throw new KddError("invalid execution mode");
}
function scopedTask(db, ref) {
  shape(ref, ["projectId", "taskId"]);
  text(ref.projectId);
  integer(ref.taskId);
  if (ref.projectId !== projectOf(db).project_id) throw new KddError("foreign project reference");
  return mustGetTask(db, ref.taskId);
}
function contractHash(db, ref) {
  const task = scopedTask(db, ref);
  const criteria = db.prepare("SELECT id,text FROM criteria WHERE task_id=? ORDER BY id").all(task.id);
  return createHash10("sha256").update(JSON.stringify({
    projectId: ref.projectId,
    taskId: task.id,
    title: task.title,
    body: task.body,
    criteria
  })).digest("hex");
}
function taskContractHash(handle, ref) {
  const db = controllerDb(handle);
  return db.transaction(() => contractHash(db, ref))();
}
function checkAuthority(db, task, binding) {
  scopedTask(db, task);
  shape(binding, ["authorityId", "workItemId", "runId", "generation"]);
  text(binding.authorityId);
  text(binding.workItemId);
  text(binding.runId);
  integer(binding.generation);
  assertRunAuthorityBinding(db, task.taskId, binding);
}
function validateCreationSource(db, source) {
  shape(source, source.kind === "manual" ? ["kind", "sourceTask", "instructionRef"] : ["kind", "sourceTask", "authority", "proposalEventId"]);
  scopedTask(db, source.sourceTask);
  if (source.kind === "manual") {
    text(source.instructionRef);
    return { source_task_id: source.sourceTask.taskId, instruction_ref: source.instructionRef };
  }
  if (source.kind !== "run") throw new KddError("invalid source kind");
  checkAuthority(db, source.sourceTask, source.authority);
  integer(source.proposalEventId);
  const event = db.prepare("SELECT detail FROM events WHERE id=? AND task_id=? AND action='run_report'").get(source.proposalEventId, source.sourceTask.taskId);
  const detail = event?.detail ? JSON.parse(event.detail) : null;
  if (!detail || detail.work_item_id !== source.authority.workItemId || detail.run_id !== source.authority.runId || detail.generation !== source.authority.generation || detail.untrusted !== true) throw new KddError("invalid proposal event");
  return {
    source_task_id: source.sourceTask.taskId,
    source_work_item_id: source.authority.workItemId,
    source_run_id: source.authority.runId,
    generation: source.authority.generation,
    proposal_event_id: source.proposalEventId
  };
}
function createSubtasks(handle, input) {
  const db = controllerDb(handle);
  return db.transaction(() => {
    shape(input, ["parent", "expectedParentHash", "source", "children"]);
    const parent = scopedTask(db, input.parent);
    if (parent.parent_id !== null) throw new KddError("parent must be a root task");
    text(input.expectedParentHash);
    if (contractHash(db, input.parent) !== input.expectedParentHash) throw new KddError("stale parent contract");
    const provenance = validateCreationSource(db, input.source);
    if (!Array.isArray(input.children) || !input.children.length) throw new KddError("empty children");
    const keys = /* @__PURE__ */ new Set();
    for (const child of input.children) {
      shape(child, ["key", "title", "criteria"], ["body", "kind", "priority", "area", "trackId", "executionMode"]);
      text(child.key);
      text(child.title);
      if (keys.has(child.key)) throw new KddError("duplicate child key");
      keys.add(child.key);
      if (!Array.isArray(child.criteria) || !child.criteria.length) throw new KddError("empty criteria");
      child.criteria.forEach(text);
      if (child.body !== void 0 && typeof child.body !== "string") throw new KddError("invalid body");
      if (child.area !== void 0) text(child.area);
      if (child.trackId !== void 0) integer(child.trackId);
      if (child.kind !== void 0 && !KINDS.includes(child.kind)) throw new KddError("invalid kind");
      if (child.priority !== void 0 && !PRIORITIES.includes(child.priority)) throw new KddError("invalid priority");
      if (child.executionMode !== void 0) mode(child.executionMode);
    }
    const children = /* @__PURE__ */ Object.create(null);
    for (const child of input.children) {
      const row = addTask(db, {
        title: child.title,
        body: child.body,
        criteria: [...child.criteria],
        kind: child.kind,
        priority: child.priority,
        area: child.area,
        track_id: child.trackId
      }, controllerActor);
      db.prepare("UPDATE tasks SET parent_id=?,execution_mode=? WHERE id=?").run(parent.id, child.executionMode ?? parent.execution_mode, row.id);
      appendEvent(db, row.id, controllerActor, "subtask_created", { parent_task_id: parent.id, ...provenance });
      children[child.key] = mustGetTask(db, row.id);
    }
    return children;
  }).immediate();
}
function listSubtasks(handle, parent) {
  const db = controllerDb(handle);
  scopedTask(db, parent);
  return db.prepare("SELECT * FROM tasks WHERE parent_id=? ORDER BY id").all(parent.taskId);
}
var newId = () => randomBytes2(16).toString("hex");
function canonical(value) {
  const sort = (v) => Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v;
  return JSON.stringify(sort(value));
}
var digest = (value) => createHash10("sha256").update(canonical(value)).digest("hex");
function strings(value) {
  if (!Array.isArray(value)) throw new KddError("invalid strings");
  value.forEach(text);
  if (new Set(value).size !== value.length) throw new KddError("duplicate strings");
}
function dependencyKind(value) {
  if (!["contract", "code", "merged", "readiness"].includes(value)) throw new KddError("invalid dependency kind");
}
function checkRepo(db, repoId) {
  if (repoId === null) return;
  text(repoId);
  if (!db.prepare("SELECT 1 FROM repositories WHERE repo_id=?").get(repoId)) throw new KddError("unknown repository");
}
function assertNoHandoff(db, taskId) {
  if (db.prepare("SELECT 1 FROM execution_handoffs WHERE task_id=? AND completed_at IS NULL").get(taskId)) {
    throw new KddError("task handoff pending");
  }
}
function scopedWorkItem(db, ref, revision) {
  shape(ref, ["projectId", "workItemId"]);
  text(ref.projectId);
  text(ref.workItemId);
  if (ref.projectId !== projectOf(db).project_id) throw new KddError("foreign project reference");
  const row = db.prepare("SELECT * FROM work_items WHERE id=?").get(ref.workItemId);
  if (!row) throw new KddError("work item not found");
  if (revision !== void 0) integer(revision);
  const rev = revision ?? row.current_revision;
  const contract = db.prepare("SELECT * FROM work_item_revisions WHERE work_item_id=? AND revision=?").get(row.id, rev);
  if (!contract) throw new KddError("work item revision not found");
  const dependencies = db.prepare(`SELECT * FROM work_item_dependencies WHERE consumer_id=? AND consumer_revision=? ORDER BY edge_key`).all(row.id, rev).map((d) => ({
    key: d.edge_key,
    producer: { projectId: ref.projectId, workItemId: d.producer_id },
    producerRevision: d.producer_revision,
    outputKey: d.output_key,
    binding: JSON.parse(d.binding_json),
    ...d.pinned_result_id === null ? {} : { resultId: d.pinned_result_id }
  }));
  return {
    ref: { ...ref },
    task: { projectId: ref.projectId, taskId: row.task_id },
    revision: rev,
    state: row.state,
    fence: row.fence,
    definition: JSON.parse(contract.definition_json),
    inputs: JSON.parse(contract.inputs_json),
    inputsHash: contract.inputs_hash,
    dependencies
  };
}
function inputsCurrent(db, item) {
  return item.inputs.every((input) => contractHash(db, input.task) === input.hash);
}
function checkDefinition(db, definition) {
  shape(definition, ["kind", "repoId", "sourceTasks", "outputs"]);
  if (!["analysis", "architecture", "implementation", "check", "integration", "human_action", "curation"].includes(definition.kind)) {
    throw new KddError("invalid work item kind");
  }
  checkRepo(db, definition.repoId);
  if (!Array.isArray(definition.sourceTasks) || !Array.isArray(definition.outputs)) throw new KddError("invalid definition arrays");
  const sources = /* @__PURE__ */ new Set(), outputs = /* @__PURE__ */ new Set();
  for (const ref of definition.sourceTasks) {
    scopedTask(db, ref);
    if (sources.has(ref.taskId)) throw new KddError("duplicate source task");
    sources.add(ref.taskId);
  }
  for (const output of definition.outputs) {
    shape(output, ["key", "kind", "required", "version", "checkRefs"]);
    text(output.key);
    text(output.version);
    dependencyKind(output.kind);
    strings(output.checkRefs);
    if (typeof output.required !== "boolean") throw new KddError("invalid output requirement");
    if (outputs.has(output.key)) throw new KddError("duplicate output key");
    outputs.add(output.key);
    if ((output.kind === "code" || output.kind === "merged") && definition.repoId === null) throw new KddError("output requires repository");
  }
}
function checkBinding(db, binding) {
  dependencyKind(binding?.kind);
  const extra = {
    contract: [],
    code: ["baseHead"],
    merged: ["target", "baseHead"],
    readiness: ["resourceId", "configHash", "consumerScope", "capabilities"]
  }[binding.kind];
  shape(binding, ["kind", "repoId", "version", ...extra]);
  checkRepo(db, binding.repoId);
  text(binding.version);
  if (binding.kind === "code" || binding.kind === "merged") {
    if (binding.repoId === null) throw new KddError("dependency requires repository");
    text(binding.baseHead);
    if (binding.kind === "merged") text(binding.target);
  }
  if (binding.kind === "readiness") {
    text(binding.resourceId);
    text(binding.configHash);
    text(binding.consumerScope);
    strings(binding.capabilities);
  }
}
function insertRevision(db, id2, task, revision, definition) {
  checkDefinition(db, definition);
  const card = scopedTask(db, task), ids = /* @__PURE__ */ new Set([card.id, ...definition.sourceTasks.map((t) => t.taskId)]);
  if (card.parent_id !== null) ids.add(card.parent_id);
  const inputs = [...ids].sort((a, b) => a - b).map((taskId) => {
    const ref = { projectId: task.projectId, taskId };
    return { task: ref, hash: contractHash(db, ref) };
  });
  db.prepare("INSERT INTO work_item_revisions VALUES(?,?,?,?,?,?)").run(id2, revision, canonical(definition), canonical(inputs), digest(inputs), now());
}
function insertEdges(db, item, dependencies) {
  if (!Array.isArray(dependencies)) throw new KddError("invalid dependencies");
  const keys = /* @__PURE__ */ new Set();
  for (const dep of dependencies) {
    shape(dep, ["key", "producer", "producerRevision", "outputKey", "binding"], ["resultId"]);
    text(dep.key);
    text(dep.outputKey);
    integer(dep.producerRevision);
    checkBinding(db, dep.binding);
    if (keys.has(dep.key)) throw new KddError("duplicate edge key");
    keys.add(dep.key);
    const producer = scopedWorkItem(db, dep.producer, dep.producerRevision);
    if (item.ref.workItemId === producer.ref.workItemId) throw new KddError("self dependency cycle");
    const output = producer.definition.outputs.find((o) => o.key === dep.outputKey);
    if (!output || output.kind !== dep.binding.kind || output.version !== dep.binding.version || producer.definition.repoId !== dep.binding.repoId) throw new KddError("incompatible dependency output or scope");
    if (dep.binding.kind === "code" && (item.definition.repoId === null || item.definition.repoId !== producer.definition.repoId)) {
      throw new KddError("cross repository code dependency denied");
    }
    if (dep.resultId !== void 0) {
      text(dep.resultId);
      const result2 = db.prepare("SELECT payload_json FROM work_item_results WHERE id=? AND producer_id=? AND producer_revision=? AND output_key=? AND kind=?").get(dep.resultId, producer.ref.workItemId, producer.revision, dep.outputKey, dep.binding.kind);
      const payload = result2 ? JSON.parse(result2.payload_json) : null;
      if (!payload || payload.version !== dep.binding.version || payload.repoId !== dep.binding.repoId) throw new KddError("result binding mismatch");
    }
    db.prepare("INSERT INTO work_item_dependencies VALUES(?,?,?,?,?,?,?,?,?)").run(
      item.ref.workItemId,
      item.revision,
      dep.key,
      producer.ref.workItemId,
      producer.revision,
      dep.binding.kind,
      dep.outputKey,
      canonical(dep.binding),
      dep.resultId ?? null
    );
  }
}
function assertDag(db, refs) {
  const cycle = db.prepare(`WITH RECURSIVE active(consumer,producer) AS (
    SELECT d.consumer_id,d.producer_id FROM work_item_dependencies d
    JOIN work_items w ON w.id=d.consumer_id AND w.current_revision=d.consumer_revision
  ), reachable(id) AS (SELECT producer FROM active WHERE consumer=?
    UNION SELECT a.producer FROM active a JOIN reachable r ON a.consumer=r.id)
    SELECT 1 FROM reachable WHERE id=? LIMIT 1`);
  for (const ref of refs) if (cycle.get(ref.workItemId, ref.workItemId)) throw new KddError("dependency cycle");
}
function createWorkItem(handle, input) {
  const db = controllerDb(handle);
  return db.transaction(() => {
    shape(input, ["task", "definition", "dependencies"]);
    const task = scopedTask(db, input.task);
    assertNoHandoff(db, task.id);
    const ref = { projectId: input.task.projectId, workItemId: newId() };
    db.prepare("INSERT INTO work_items(id,task_id,current_revision,created_at) VALUES(?,?,1,?)").run(ref.workItemId, task.id, now());
    insertRevision(db, ref.workItemId, input.task, 1, input.definition);
    insertEdges(db, scopedWorkItem(db, ref), input.dependencies);
    assertDag(db, [ref]);
    appendEvent(db, task.id, controllerActor, "work_item_created", { work_item_id: ref.workItemId, revision: 1 });
    return scopedWorkItem(db, ref);
  }).immediate();
}
function reviseWorkItem(handle, input) {
  const db = controllerDb(handle);
  return db.transaction(() => {
    shape(input, ["ref", "expectedRevision", "definition", "dependencies"]);
    integer(input.expectedRevision);
    const item = scopedWorkItem(db, input.ref);
    assertNoHandoff(db, item.task.taskId);
    if (item.revision !== input.expectedRevision || item.revision === Number.MAX_SAFE_INTEGER) throw new KddError("revision conflict or overflow");
    if (["completed", "failed", "cancelled"].includes(item.state)) throw new KddError("terminal work item requires new work");
    if (db.prepare("SELECT 1 FROM work_item_owners WHERE work_item_id=? AND released_at IS NULL").get(item.ref.workItemId)) {
      throw new KddError("owned work item cannot change revision");
    }
    const revision = item.revision + 1;
    insertRevision(db, item.ref.workItemId, item.task, revision, input.definition);
    db.prepare("UPDATE work_items SET current_revision=?,state='pending' WHERE id=? AND current_revision=?").run(revision, item.ref.workItemId, input.expectedRevision);
    insertEdges(db, scopedWorkItem(db, item.ref), input.dependencies);
    assertDag(db, [item.ref]);
    appendEvent(db, item.task.taskId, controllerActor, "work_item_revised", { work_item_id: item.ref.workItemId, revision });
    return scopedWorkItem(db, item.ref);
  }).immediate();
}
function workItem(handle, ref) {
  const db = controllerDb(handle);
  return db.transaction(() => scopedWorkItem(db, ref))();
}
function taskWorkItems(handle, task) {
  const db = controllerDb(handle);
  return db.transaction(() => {
    scopedTask(db, task);
    return db.prepare("SELECT id FROM work_items WHERE task_id=? ORDER BY id").all(task.taskId).map((row) => scopedWorkItem(db, { projectId: task.projectId, workItemId: row.id }));
  })();
}
function createSubtaskPlan(handle, input) {
  const db = controllerDb(handle);
  return db.transaction(() => {
    shape(input, ["parent", "expectedParentHash", "source", "children", "workItems", "dependencies"]);
    if (!Array.isArray(input.workItems) || !Array.isArray(input.dependencies)) throw new KddError("invalid plan arrays");
    const tasks = createSubtasks(handle, {
      parent: input.parent,
      expectedParentHash: input.expectedParentHash,
      source: input.source,
      children: input.children
    });
    const refs = /* @__PURE__ */ Object.create(null);
    for (const draft of input.workItems) {
      shape(draft, ["key", "childKey", "definition"]);
      text(draft.key);
      text(draft.childKey);
      if (Object.hasOwn(refs, draft.key) || !Object.hasOwn(tasks, draft.childKey)) throw new KddError("invalid plan work item key");
      const ref = { projectId: input.parent.projectId, workItemId: newId() };
      refs[draft.key] = ref;
      db.prepare("INSERT INTO work_items(id,task_id,current_revision,created_at) VALUES(?,?,1,?)").run(ref.workItemId, tasks[draft.childKey].id, now());
      insertRevision(db, ref.workItemId, { projectId: ref.projectId, taskId: tasks[draft.childKey].id }, 1, draft.definition);
    }
    const dependencies = Object.fromEntries(Object.keys(refs).map((k) => [k, []]));
    for (const dep of input.dependencies) {
      shape(dep, ["consumerKey", "key", "producer", "outputKey", "binding"], ["resultId"]);
      text(dep.consumerKey);
      if (!Object.hasOwn(refs, dep.consumerKey)) throw new KddError("missing consumer key");
      shape(dep.producer, Object.hasOwn(dep.producer, "localKey") ? ["localKey"] : ["ref", "revision"]);
      let producer, producerRevision;
      if ("localKey" in dep.producer) {
        text(dep.producer.localKey);
        if (!Object.hasOwn(refs, dep.producer.localKey)) throw new KddError("missing producer key");
        producer = refs[dep.producer.localKey];
        producerRevision = 1;
      } else {
        producer = dep.producer.ref;
        producerRevision = dep.producer.revision;
      }
      dependencies[dep.consumerKey].push({
        key: dep.key,
        producer,
        producerRevision,
        outputKey: dep.outputKey,
        binding: dep.binding,
        ...dep.resultId === void 0 ? {} : { resultId: dep.resultId }
      });
    }
    for (const key of Object.keys(refs)) insertEdges(db, scopedWorkItem(db, refs[key]), dependencies[key]);
    assertDag(db, Object.values(refs));
    const workItems = Object.fromEntries(Object.keys(refs).map((key) => [key, scopedWorkItem(db, refs[key])]));
    appendEvent(db, input.parent.taskId, controllerActor, "subtask_plan_created", {
      tasks: Object.fromEntries(Object.entries(tasks).map(([k, t]) => [k, t.id])),
      work_items: refs
    });
    return { tasks, workItems };
  }).immediate();
}
function checkOwnershipRef(db, ref) {
  shape(ref, ["projectId", "workItemId", "revision", "ownerId", "fence"]);
  text(ref.ownerId);
  integer(ref.revision);
  integer(ref.fence);
  scopedWorkItem(db, { projectId: ref.projectId, workItemId: ref.workItemId }, ref.revision);
}
function liveOwner(db, ref) {
  checkOwnershipRef(db, ref);
  const item = scopedWorkItem(db, { projectId: ref.projectId, workItemId: ref.workItemId });
  const row = db.prepare("SELECT * FROM work_item_owners WHERE work_item_id=? AND fence=? AND owner_id=? AND revision=? AND released_at IS NULL").get(ref.workItemId, ref.fence, ref.ownerId, ref.revision);
  if (!row || item.revision !== ref.revision || item.fence !== ref.fence || !inputsCurrent(db, item) || JSON.parse(row.inputs_json).inputsHash !== item.inputsHash || !pinnedInputsCurrent(db, item, JSON.parse(row.inputs_json).inputResults)) throw new KddError("ownership fence or inputs stale");
  assertOwnedRunInputsCurrentDb(db, ref);
  return row;
}
var LEGACY_EXECUTION_SQL = `execution_mode='manual'
  AND NOT EXISTS (SELECT 1 FROM managed_task_policy p WHERE p.task_id=tasks.id)
  AND NOT EXISTS (SELECT 1 FROM execution_handoffs h WHERE h.task_id=tasks.id AND h.completed_at IS NULL)`;

// src/authority.ts
import { createHash as createHash12, randomBytes as randomBytes3 } from "crypto";
import { lstatSync as lstatSync5, realpathSync as realpathSync10 } from "fs";
import { isAbsolute as isAbsolute7 } from "path";

// src/role_prompt.ts
import { createHash as createHash11 } from "crypto";
import { readFileSync as readFileSync10 } from "fs";
var denied3 = () => new KddError("role launch denied");
var sha = (value) => createHash11("sha256").update(Buffer.from(value, "utf8")).digest("hex");
var outputReserve = 8192;
var framingReserve = 131072;
function rolePromptDb(db, snapshot2) {
  const inputs = snapshot2.response.inputs;
  if (inputs.schemaVersion !== 2) throw denied3();
  const { definition, receipt: receipt2 } = roleRevisionDb(db, inputs.role);
  if (receipt2.hash !== inputs.role.hash || receipt2.manifestHash !== inputs.role.manifestHash) throw denied3();
  const files = roleFilesDb(db, inputs.role);
  const always = definition.skills.filter((skill) => skill.mode === "Always").map((skill) => {
    const body = files.find((file) => file.skill === skill.name && file.path === "SKILL.md");
    if (!body) throw denied3();
    let text2;
    try {
      text2 = new TextDecoder("utf-8", { fatal: true }).decode(body.bytes);
    } catch {
      throw denied3();
    }
    if (!text2.trim()) throw denied3();
    return `=== SKILL ${JSON.stringify(skill.name)} (Always) ===
${text2}
=== END SKILL ===`;
  });
  const available = definition.skills.filter((skill) => skill.mode === "Available").map((skill) => `${JSON.stringify(skill.name)}: ${skill.description}
Read pinned bytes with read_skill_file({skill:${JSON.stringify(skill.name)},path:"SKILL.md",offset:0}).`);
  return [
    `=== ROLE ${JSON.stringify(definition.name)} ===
${definition.prompt}
=== END ROLE ===`,
    ...always,
    `=== RUN INPUTS ${snapshot2.inputHash} ===
${JSON.stringify(inputs)}
=== END RUN INPUTS ===`,
    `=== AVAILABLE SKILLS ===
${available.join("\n")}
=== END AVAILABLE SKILLS ===`
  ].join("\n\n");
}
function assertRolePromptBudget(prompt, native, reserve = outputReserve) {
  assertVerifiedCodexPackage(native);
  if (!Number.isSafeInteger(native.contextWindow) || native.contextWindow < 1 || !Number.isSafeInteger(reserve) || reserve < outputReserve) throw denied3();
  const explicit = Buffer.byteLength(prompt, "utf8") + Buffer.byteLength(JSON.stringify(native.argv), "utf8") + Buffer.byteLength(closedCodexCatalog(native.model), "utf8");
  if (explicit + framingReserve + reserve > native.contextWindow) throw new KddError("role prompt exceeds verified model context");
}
var permits = /* @__PURE__ */ new WeakMap();
function checkedPrompt(handle, projectId, authorityId, native) {
  const db = controllerDb(handle);
  return db.transaction(() => {
    if (projectId !== projectOf(db).project_id || !/^[0-9a-f]{32}$/.test(authorityId)) throw denied3();
    const row = db.prepare("SELECT task_id,work_item_id,run_id,generation,grant_json,token_hash FROM run_authorities WHERE authority_id=?").get(authorityId);
    if (!row) throw denied3();
    assertRunAuthorityBinding(db, row.task_id, {
      authorityId,
      workItemId: row.work_item_id,
      runId: row.run_id,
      generation: row.generation
    });
    const grant = JSON.parse(row.grant_json);
    const snapshot2 = readRunInputSnapshotDb(db, authorityId), pin2 = snapshot2.response.inputs;
    if (!native.brokerConfigPath || JSON.stringify(native.brokerTools) !== JSON.stringify(grant.operations)) throw denied3();
    let brokerToken;
    try {
      brokerToken = JSON.parse(readFileSync10(native.brokerConfigPath, "utf8")).token;
    } catch {
      throw denied3();
    }
    if (typeof brokerToken !== "string" || sha(brokerToken) !== row.token_hash) throw denied3();
    if (pin2.schemaVersion !== 2 || !grant.role || !roleActiveDb(db, grant.role.roleId) || pin2.role.roleId !== grant.role.roleId || pin2.role.revision !== grant.role.revision || pin2.role.model !== native.model || pin2.role.effort !== native.effort || pin2.role.contextWindow !== native.contextWindow || pin2.role.nativeConfigHash !== native.configHash || grant.native.configHash !== native.configHash) throw denied3();
    return rolePromptDb(db, snapshot2);
  }).immediate();
}
function prepareRoleLaunch(handle, input) {
  assertVerifiedCodexPackage(input.native);
  const prompt = checkedPrompt(handle, input.projectId, input.authorityId, input.native);
  const reserve = input.outputReserveTokens ?? outputReserve;
  assertRolePromptBudget(prompt, input.native, reserve);
  const promptHash = sha(prompt);
  const permit = Object.freeze({ prompt, promptHash, model: input.native.model, effort: input.native.effort, native: input.native });
  permits.set(permit, {
    handle,
    projectId: input.projectId,
    authorityId: input.authorityId,
    promptHash,
    native: input.native,
    reserve
  });
  const db = controllerDb(handle);
  db.transaction(() => {
    const row = db.prepare("SELECT task_id FROM run_authorities WHERE authority_id=?").get(input.authorityId);
    appendEvent(db, row.task_id, { type: "ai", id: "controller" }, "role_prompt_prepared", { authorityId: input.authorityId, promptHash });
  }).immediate();
  return permit;
}
async function spawnCheckedRoleRun(permit) {
  const stored = typeof permit === "object" && permit !== null ? permits.get(permit) : void 0;
  if (!stored || permit.promptHash !== stored.promptHash || permit.native !== stored.native || permit.model !== stored.native.model || permit.effort !== stored.native.effort || sha(permit.prompt) !== stored.promptHash) throw denied3();
  assertVerifiedCodexPackage(stored.native);
  const prompt = checkedPrompt(stored.handle, stored.projectId, stored.authorityId, stored.native);
  if (sha(prompt) !== stored.promptHash) throw denied3();
  assertRolePromptBudget(prompt, stored.native, stored.reserve);
  const native = stored.native;
  return spawnCheckedNative({
    controlDir: native.controlDir,
    writableRoots: [native.scratchDir, ...native.writableRoot ? [native.writableRoot] : []],
    executable: native.executable,
    args: [...native.argv, prompt],
    cwd: native.cwd,
    env: native.env,
    phase: "start",
    verified: native,
    beforeSpawn: () => {
      const current = checkedPrompt(stored.handle, stored.projectId, stored.authorityId, native);
      if (sha(current) !== stored.promptHash) throw denied3();
      assertRolePromptBudget(current, native, stored.reserve);
    }
  });
}

// src/authority.ts
var operations = ["get_context", "submit_report", "request_question", "read_skill_file"];
var contexts = /* @__PURE__ */ new WeakMap();
var denied4 = () => new KddError("run authority denied");
var tokenHash = (token) => createHash12("sha256").update(token).digest("hex");
var controllerActor2 = { type: "ai", id: "controller" };
function assertLegacyTaskMutation(db, taskIds) {
  const ids = [...new Set(taskIds)];
  if (ids.some((id2) => !Number.isSafeInteger(id2) || id2 < 1)) throw new KddError("invalid task ids");
  if (ids.length && db.prepare(`SELECT task_id FROM managed_task_policy WHERE task_id IN (${ids.map(() => "?").join(",")}) LIMIT 1`).get(...ids)) {
    throw new KddError("managed task requires controller authority");
  }
  if (ids.length && db.prepare(`SELECT task_id FROM execution_handoffs WHERE completed_at IS NULL AND task_id IN (${ids.map(() => "?").join(",")}) LIMIT 1`).get(...ids)) {
    throw new KddError("task handoff requires controller authority");
  }
}
function mark(db, taskId) {
  if (!Number.isSafeInteger(taskId) || taskId < 1) throw denied4();
  const task = mustGetTask(db, taskId);
  if (task.claimed_by !== null) throw new KddError("claimed legacy writer must stop before controller protection");
  if (db.prepare("INSERT OR IGNORE INTO managed_task_policy(task_id,created_at,source) VALUES(?,?,'controller')").run(taskId, now()).changes) {
    appendEvent(db, taskId, controllerActor2, "task_protected");
  }
}
function protectTask(handle, taskId) {
  const db = controllerDb(handle);
  db.transaction(() => mark(db, taskId)).immediate();
}
function modeledOwnership(db, input, scope) {
  const modeled = db.prepare("SELECT 1 FROM work_items WHERE id=?").get(input.workItemId);
  if (!modeled) {
    if (input.ownership !== void 0) throw denied4();
    return;
  }
  if (!input.ownership) throw new KddError("modeled work requires ownership");
  const owner = liveOwner(db, input.ownership);
  const item = scopedWorkItem(db, { projectId: input.ownership.projectId, workItemId: input.workItemId });
  if (owner.work_item_id !== input.workItemId || item.task.taskId !== input.taskId) throw denied4();
  if (scope.some((repo) => repo.write && (!owner.write_access || item.definition.repoId === null || item.definition.repoId !== repo.repoId))) {
    throw new KddError("ownership writable repository mismatch");
  }
}
function canonicalCheckout(path) {
  if (typeof path !== "string" || !isAbsolute7(path) || !lstatSync5(path).isDirectory()) throw new KddError("invalid repository scope");
  return realpathSync10(path);
}
function repositoryScope(db, input, native) {
  if (!Array.isArray(input) || !input.length) throw new KddError("empty repository scope");
  const repos = repositoriesOf(db), bindings = bindingsOf(db);
  const scope = input.map((resource) => {
    const checkoutPath = canonicalCheckout(resource.checkoutPath), commonDir = canonicalCommonDir(checkoutPath);
    const repo = repos.find((repo2) => repo2.repo_id === resource.repoId);
    const binding = bindings.find((binding2) => binding2.repo_id === resource.repoId && binding2.common_dir === commonDir);
    if (!repo || !binding || typeof resource.write !== "boolean" || resource.write && (repo.access !== "implementation" || binding.kind !== "managed")) throw new KddError("repository write/scope denied");
    return { repoId: repo.repo_id, checkoutPath, commonDir, write: resource.write };
  });
  const paths = scope.map((resource) => resource.checkoutPath), writes = scope.filter((resource) => resource.write).map((resource) => resource.checkoutPath);
  if (new Set(paths).size !== paths.length || writes.length > 1 || JSON.stringify([...paths].sort()) !== JSON.stringify([...native.readableRoots].sort()) || writes[0] !== native.writableRoot) throw new KddError("native repository scope differs from grant");
  return scope;
}
function privateStore(db, scope, native) {
  if (db.memory) return;
  const path = realpathSync10(db.name);
  if (db.name !== path) throw new KddError("project store alias denied");
  if (scope.some((resource) => inside(resource.checkoutPath, path) || inside(resource.commonDir, path))) throw new KddError("native repository scope exposes project store");
  const writableRoots = [canonicalCheckout(native.scratchDir), ...native.writableRoot ? [canonicalCheckout(native.writableRoot)] : []];
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (writableRoots.some((root) => inside(root, file))) throw new KddError("native writable scope exposes project store");
    try {
      if (!lstatSync5(file).isFile() || lstatSync5(file).nlink !== 1) throw new KddError("project store alias denied");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
function issueRunAuthority(handle, supplied) {
  const db = controllerDb(handle);
  if (!supplied?.role) throw new KddError("managed role required");
  shape(supplied, ["taskId", "workItemId", "runId", "expectedGeneration", "expiresAt", "operations", "repositories", "native", "role"], ["ownership", "context", "contextObservers", "probeBootstrap"]);
  if (supplied.contextObservers !== void 0) shape(supplied.contextObservers, [], ["observe"]);
  const { native, contextObservers, ...data } = supplied;
  const input = { ...structuredClone(data), native, contextObservers: contextObservers ? { observe: contextObservers.observe } : void 0 };
  shape(input.role, ["roleId", "revision"], ["hash", "manifestHash"]);
  return db.transaction(() => {
    if (!Number.isSafeInteger(input.taskId) || input.taskId < 1 || typeof input.workItemId !== "string" || !input.workItemId.trim() || typeof input.runId !== "string" || !input.runId.trim() || !Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0 || input.expectedGeneration === Number.MAX_SAFE_INTEGER || !Number.isFinite(input.expiresAt) || input.expiresAt <= now() || !Array.isArray(input.operations) || !input.operations.length || new Set(input.operations).size !== input.operations.length || input.operations.some((operation) => !operations.includes(operation))) throw denied4();
    assertNoHandoff(db, input.taskId);
    const generation = db.prepare("SELECT COALESCE(MAX(generation),0) generation FROM run_authorities WHERE task_id=? AND work_item_id=?").get(input.taskId, input.workItemId).generation;
    if (generation !== input.expectedGeneration) throw new KddError("run authority generation fence changed");
    assertVerifiedCodexPackage(input.native);
    const role = roleRevisionDb(db, input.role);
    const suppliedReceipt = input.role;
    if (suppliedReceipt.hash !== void 0 && suppliedReceipt.hash !== role.receipt.hash || suppliedReceipt.manifestHash !== void 0 && suppliedReceipt.manifestHash !== role.receipt.manifestHash)
      throw new KddError("run role receipt mismatch");
    if (!roleActiveDb(db, input.role.roleId)) throw new KddError("run role revoked");
    if (role.definition.model !== native.model || role.definition.effort !== native.effort || role.definition.access !== nativeAccess(native)) throw new KddError("run role/native mismatch");
    if (input.operations.some((operation) => !role.definition.operations.includes(operation))) throw new KddError("run operation outside role");
    if (input.operations.includes("read_skill_file") && role.definition.skills.length === 0)
      throw new KddError("run skill operation requires selected skills");
    if (role.definition.skills.length && !input.operations.includes("read_skill_file"))
      throw new KddError("selected skill requires read operation");
    const repositories = repositoryScope(db, input.repositories, input.native);
    modeledOwnership(db, input, repositories);
    privateStore(db, repositories, input.native);
    const bootstrap = input.probeBootstrap === true && input.expectedGeneration === 0 && role.definition.access === "read" && input.ownership === void 0 && JSON.stringify(input.operations) === JSON.stringify(["get_context", "read_skill_file"]) && native.brokerConfigPath === void 0 && native.brokerTools.length === 0;
    if (input.probeBootstrap !== void 0 && !bootstrap) throw new KddError("invalid native probe bootstrap");
    if (!bootstrap && (!native.brokerConfigPath || JSON.stringify(native.brokerTools) !== JSON.stringify(input.operations)))
      throw new KddError("native broker operations differ from grant");
    const grant = {
      projectId: projectOf(db).project_id,
      taskId: input.taskId,
      role: { roleId: input.role.roleId, revision: input.role.revision },
      workItemId: input.workItemId,
      runId: input.runId,
      generation: generation + 1,
      operations: [...input.operations],
      repositories,
      ...input.ownership ? { ownership: { ...input.ownership } } : {},
      native: {
        readableRoots: [...input.native.readableRoots],
        writableRoot: input.native.writableRoot,
        scratchDir: input.native.scratchDir,
        configHash: input.native.configHash,
        contextWindow: input.native.contextWindow
      }
    };
    const token = randomBytes3(32).toString("hex"), authorityId = randomBytes3(16).toString("hex");
    const snapshot2 = buildRunInputSnapshot(db, grant, authorityId, input.context, input.contextObservers, [native.controlDir, ...native.protectedPaths]);
    assertRolePromptBudget(rolePromptDb(db, snapshot2), native);
    assertVerifiedCodexPackage(native);
    repositoryScope(db, input.repositories, native);
    modeledOwnership(db, input, repositories);
    privateStore(db, repositories, native);
    mark(db, input.taskId);
    db.prepare("UPDATE run_authorities SET revoked_at=? WHERE task_id=? AND work_item_id=? AND revoked_at IS NULL").run(now(), input.taskId, input.workItemId);
    db.prepare("INSERT INTO run_authorities(authority_id,task_id,work_item_id,run_id,generation,expires_at,token_hash,grant_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(authorityId, input.taskId, input.workItemId, input.runId, grant.generation, input.expiresAt, tokenHash(token), JSON.stringify(grant), now());
    persistRunInputSnapshotDb(db, snapshot2);
    appendEvent(db, input.taskId, controllerActor2, "run_inputs_snapshot", { authorityId, inputHash: snapshot2.inputHash, wireBytes: runContextWireBytes(snapshot2.response), limit: snapshot2.response.inputs.budget.maxBytes });
    appendEvent(db, input.taskId, controllerActor2, "authority_issued", { authorityId, workItemId: grant.workItemId, runId: grant.runId, generation: grant.generation });
    return { authorityId, generation: grant.generation, token };
  }).immediate();
}
function revokeRunAuthority(handle, authorityId) {
  const db = controllerDb(handle);
  db.transaction(() => {
    const row = db.prepare("SELECT task_id,generation FROM run_authorities WHERE authority_id=?").get(authorityId);
    if (!row) throw denied4();
    if (db.prepare("UPDATE run_authorities SET revoked_at=? WHERE authority_id=? AND revoked_at IS NULL").run(now(), authorityId).changes) {
      appendEvent(db, row.task_id, controllerActor2, "authority_revoked", { authorityId, generation: row.generation });
    }
  }).immediate();
}
function currentAuthority(db, row) {
  if (!row || row.revoked_at !== null || !Number.isFinite(row.expires_at) || row.expires_at <= now()) throw denied4();
  let grant;
  try {
    grant = JSON.parse(row.grant_json);
  } catch {
    throw denied4();
  }
  const latest = db.prepare("SELECT MAX(generation) generation FROM run_authorities WHERE task_id=? AND work_item_id=?").get(row.task_id, row.work_item_id).generation;
  if (!grant || !Array.isArray(grant.operations) || !grant.operations.length || new Set(grant.operations).size !== grant.operations.length || grant.operations.some((operation) => !operations.includes(operation)) || grant.projectId !== projectOf(db).project_id || grant.taskId !== row.task_id || grant.workItemId !== row.work_item_id || grant.runId !== row.run_id || grant.generation !== row.generation || latest !== row.generation || !db.prepare("SELECT task_id FROM managed_task_policy WHERE task_id=?").get(row.task_id)) throw denied4();
  mustGetTask(db, row.task_id);
  try {
    const repositories = repositoryScope(db, grant.repositories, grant.native);
    if (JSON.stringify(repositories) !== JSON.stringify(grant.repositories)) throw denied4();
    modeledOwnership(db, grant, repositories);
    privateStore(db, repositories, grant.native);
    assertRunInputsCurrentDb(db, row.authority_id);
  } catch {
    throw denied4();
  }
  return { row, grant };
}
function assertRunAuthorityBinding(db, taskId, binding) {
  const row = db.prepare(`SELECT * FROM run_authorities WHERE authority_id=? AND task_id=?
    AND work_item_id=? AND run_id=? AND generation=?`).get(binding.authorityId, taskId, binding.workItemId, binding.runId, binding.generation);
  currentAuthority(db, row);
}
function assertRunMemorySource(db, scope, applicability, source, author) {
  shape(source, ["kind", "task", "authority", "reportEventId"]);
  scopedTask(db, source.task);
  shape(source.authority, ["authorityId", "workItemId", "runId", "generation"]);
  const binding = source.authority;
  text(binding.authorityId);
  text(binding.workItemId);
  text(binding.runId);
  integer(binding.generation);
  integer(source.reportEventId);
  const row = db.prepare(`SELECT * FROM run_authorities WHERE authority_id=? AND task_id=?
    AND work_item_id=? AND run_id=? AND generation=?`).get(
    binding.authorityId,
    source.task.taskId,
    binding.workItemId,
    binding.runId,
    binding.generation
  );
  const { grant } = currentAuthority(db, row);
  if (!grant.operations.includes("submit_report") || scope.projectId !== grant.projectId || scope.taskId !== grant.taskId || author.type !== "ai" || author.id !== grant.runId || applicability.repoId !== null && !grant.repositories.some((repo) => repo.repoId === applicability.repoId)) throw denied4();
  const event = db.prepare("SELECT detail,actor_type,actor_id FROM events WHERE id=? AND task_id=? AND action='run_report'").get(source.reportEventId, grant.taskId);
  let detail;
  try {
    detail = event?.detail ? JSON.parse(event.detail) : null;
  } catch {
    throw denied4();
  }
  if (!detail || event?.actor_type !== "ai" || event.actor_id !== grant.runId || detail.work_item_id !== grant.workItemId || detail.run_id !== grant.runId || detail.generation !== grant.generation || detail.untrusted !== true) throw denied4();
}
function lookup(db, token) {
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) throw denied4();
  const row = db.prepare("SELECT * FROM run_authorities WHERE token_hash=?").get(tokenHash(token));
  return currentAuthority(db, row);
}
function openRunContext(db, token) {
  return db.transaction(() => {
    const { row, grant } = lookup(db, token);
    const context = Object.freeze({ kind: "run" });
    contexts.set(context, { db, token, authorityId: row.authority_id, grant });
    return context;
  }).deferred();
}
function registered(context) {
  const stored = typeof context === "object" && context !== null ? contexts.get(context) : void 0;
  if (!stored?.db.open) throw denied4();
  return stored;
}
function live(context, operation) {
  const stored = registered(context), { row, grant } = lookup(stored.db, stored.token);
  if (row.authority_id !== stored.authorityId || JSON.stringify(grant) !== JSON.stringify(stored.grant) || operation && !grant.operations.includes(operation)) throw denied4();
  return { ...stored, grant };
}
function runOperations(context) {
  return registered(context).db.transaction(() => Object.freeze([...live(context).grant.operations])).deferred();
}
function readRunContext(context) {
  return registered(context).db.transaction(() => {
    const { db, authorityId } = live(context, "get_context");
    return readRunInputSnapshotDb(db, authorityId).response;
  }).immediate();
}
function readSkillFile(context, input) {
  return registered(context).db.transaction(() => {
    const { db, authorityId } = live(context, "read_skill_file");
    try {
      shape(input, ["skill", "path", "offset"]);
      if (typeof input.skill !== "string" || !input.skill || !validSkillPath(input.path) || !Number.isSafeInteger(input.offset) || input.offset < 0) throw denied4();
      const snapshot2 = readRunInputSnapshotDb(db, authorityId), pin2 = snapshot2.response.inputs;
      if (pin2.schemaVersion !== 2 || !pin2.role.skills.some((skill) => skill.name === input.skill)) throw denied4();
      const file = db.prepare(`SELECT bytes,sha256,mime FROM role_skill_files WHERE role_id=? AND revision=?
        AND skill_name=? AND relative_path=?`).get(pin2.role.roleId, pin2.role.revision, input.skill, input.path);
      if (!file || createHash12("sha256").update(file.bytes).digest("hex") !== file.sha256 || input.offset > file.bytes.length || file.bytes.length > 0 && input.offset === file.bytes.length) throw denied4();
      const chunk = file.bytes.subarray(input.offset, input.offset + 32768);
      return {
        contentBase64: chunk.toString("base64"),
        offset: input.offset,
        length: chunk.length,
        size: file.bytes.length,
        sha256: file.sha256,
        mime: file.mime
      };
    } catch {
      throw new KddError("skill file denied");
    }
  }).immediate();
}
function runMemoryView(db, authorityId, grant) {
  return { scope: { projectId: grant.projectId, taskId: grant.taskId }, repositories: readRunInputSnapshotDb(db, authorityId).validation.repositories };
}
function readRunMemory(context, input = {}) {
  return registered(context).db.transaction(() => {
    const { db, grant, authorityId } = live(context, "get_context");
    shape(input, [], ["entryId", "revision", "candidates", "withdrawn"]);
    if (input.revision !== void 0) integer(input.revision);
    if (input.revision !== void 0 && input.entryId === void 0) throw new KddError("memory revision requires entry");
    return selectMemory(
      db,
      runMemoryView(db, authorityId, grant),
      { candidates: input.candidates, withdrawn: input.withdrawn },
      input.entryId,
      input.entryId === void 0 ? void 0 : input.revision ?? null
    );
  }).immediate();
}
function recallRunMemory(context, query, options = {}) {
  return registered(context).db.transaction(() => {
    const { db, grant, authorityId } = live(context, "get_context");
    return queryMemoryDb(db, runMemoryView(db, authorityId, grant), query, options);
  }).immediate();
}
function runMemoryRules(context) {
  return registered(context).db.transaction(() => {
    const { db, grant, authorityId } = live(context, "get_context");
    return selectMemory(db, runMemoryView(db, authorityId, grant)).filter((record) => record.kind === "rule");
  }).immediate();
}
function runEvent(context, operation, body) {
  return registered(context).db.transaction(() => {
    const { db, token, grant } = live(context, operation);
    if (typeof body !== "string" || !body.trim() || body.length > CAPS.agentFieldChars) throw new KddError("invalid run body");
    const safe = redact(body.replaceAll(token, "[redacted]").replaceAll(tokenHash(token), "[redacted]"));
    return appendEvent(
      db,
      grant.taskId,
      { type: "ai", id: grant.runId },
      operation === "submit_report" ? "run_report" : "run_question",
      { work_item_id: grant.workItemId, run_id: grant.runId, generation: grant.generation, untrusted: true, body: safe }
    );
  }).immediate();
}
var submitRunReport = (context, body) => runEvent(context, "submit_report", body);
var requestRunQuestion = (context, body) => runEvent(context, "request_question", body);

// src/ops.ts
import { execFileSync as execFileSync9 } from "child_process";

// src/tracks.ts
function mustGetTrack(db, id2) {
  const t = db.prepare(`SELECT * FROM tracks WHERE id = ?`).get(id2);
  if (!t) throw new KddError(`track #${id2} not found`);
  return t;
}
function createTrack(db, input) {
  const name = input.name.trim();
  if (!name) throw new KddError("track name must not be empty");
  try {
    const r = db.prepare(
      `INSERT INTO tracks (name, description, created_at) VALUES (?, ?, ?)`
    ).run(name, input.description ?? null, now());
    return mustGetTrack(db, Number(r.lastInsertRowid));
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new KddError(`track '${name}' already exists`);
    throw e;
  }
}
function editTrack(db, id2, patch) {
  if (patch.status && patch.status !== "active" && patch.status !== "done") {
    throw new KddError(`invalid status '${patch.status}'; allowed: active, done`);
  }
  const fields = Object.keys(patch).filter((k) => patch[k] !== void 0);
  if (fields.length === 0) throw new KddError("nothing to edit");
  mustGetTrack(db, id2);
  try {
    db.prepare(`UPDATE tracks SET ${fields.map((f) => `${f} = ?`).join(", ")} WHERE id = ?`).run(...fields.map((f) => patch[f]), id2);
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new KddError(`track '${patch.name}' already exists`);
    throw e;
  }
  return mustGetTrack(db, id2);
}
function deleteTrack(db, id2) {
  mustGetTrack(db, id2);
  db.transaction(() => {
    const ids = db.prepare("SELECT id FROM tasks WHERE track_id=?").all(id2).map((task) => task.id);
    assertLegacyTaskMutation(db, ids);
    db.prepare(`UPDATE tasks SET track_id = NULL WHERE track_id = ?`).run(id2);
    db.prepare(`DELETE FROM tracks WHERE id = ?`).run(id2);
  }).immediate();
}
function listTracks(db, opts = {}) {
  const where = opts.status ? `WHERE tr.status = @status` : "";
  return db.prepare(
    `SELECT tr.*, COUNT(t.id) AS open_tasks
     FROM tracks tr
     LEFT JOIN tasks t ON t.track_id = tr.id AND t.archived_at IS NULL AND t.status <> 'done'
     ${where}
     GROUP BY tr.id ORDER BY tr.status, tr.name`
  ).all({ status: opts.status ?? null });
}

// src/ops.ts
function appendEvent(db, taskId, actor, action, detail, opts) {
  const r = db.prepare(
    `INSERT INTO events (task_id, actor_type, actor_id, action, detail, created_at,
                         parent_id, type, level)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    taskId,
    actor.type,
    actor.id ?? null,
    action,
    detail ? JSON.stringify(detail) : null,
    now(),
    opts?.parent_id ?? null,
    opts?.type ?? null,
    opts?.level ?? "info"
  );
  return Number(r.lastInsertRowid);
}
function appendTaskMutationEvent(db, taskId, actor, action, detail, opts) {
  const session = actor.type === "ai" ? actor.manualSession : void 0;
  if (!session) return appendEvent(db, taskId, actor, action, detail, opts);
  const git3 = (args) => {
    try {
      return execFileSync9("git", args, {
        cwd: session.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim() || void 0;
    } catch {
      return void 0;
    }
  };
  const worktree = git3(["rev-parse", "--show-toplevel"]);
  const branch = worktree ? git3(["symbolic-ref", "--quiet", "--short", "HEAD"]) : void 0;
  const head = worktree ? git3(["rev-parse", "--verify", "HEAD"]) : void 0;
  return appendEvent(db, taskId, actor, action, {
    ...detail ?? {},
    manual_provenance: {
      client: session.client,
      ...normalizeSessionId(session.sessionId) ? { session_id: session.sessionId } : {},
      ...worktree ? { worktree } : {},
      ...branch ? { branch } : {},
      ...head ? { head_commit: head } : {}
    }
  }, opts);
}
function mustGetTask(db, id2) {
  const t = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id2);
  if (!t) throw new KddError(`task #${id2} not found`);
  return t;
}
function checkPriority(p) {
  if (!PRIORITIES.includes(p)) {
    throw new KddError(`invalid priority '${p}'; allowed: ${PRIORITIES.join(", ")}`);
  }
}
function checkKind(k) {
  if (!KINDS.includes(k)) {
    throw new KddError(`invalid kind '${k}'; allowed: ${KINDS.join(", ")}`);
  }
}
var BUG_BODY_TEMPLATE = "## Steps\n\n## Expected\n\n## Actual\n";
function addTask(db, input, actor) {
  const priority = input.priority ?? "medium";
  checkPriority(priority);
  const kind = input.kind ?? "feature";
  checkKind(kind);
  if (!input.title.trim()) throw new KddError("title must not be empty");
  if (input.criteria?.some((c) => !c.trim())) {
    throw new KddError("criterion text must not be empty");
  }
  if (input.track_id != null) mustGetTrack(db, input.track_id);
  return db.transaction(() => {
    const ts = now();
    const r = db.prepare(
      `INSERT INTO tasks (title, body, priority, kind, area, track_id, position, created_at, updated_at, execution_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.title,
      input.body ?? null,
      priority,
      kind,
      input.area ?? null,
      input.track_id ?? null,
      nextPosition(db, "new"),
      ts,
      ts,
      projectOf(db).default_execution_mode
    );
    const id2 = Number(r.lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO criteria (task_id, text, position, created_at) VALUES (?, ?, ?, ?)`
    );
    (input.criteria ?? []).forEach((text2, i) => ins.run(id2, text2, i, ts));
    appendTaskMutationEvent(db, id2, actor, "created");
    return mustGetTask(db, id2);
  }).immediate();
}
function editTask(db, id2, patch, actor) {
  if (patch.priority !== void 0) checkPriority(patch.priority);
  if (patch.kind !== void 0) checkKind(patch.kind);
  if (patch.track_id != null) mustGetTrack(db, patch.track_id);
  const fields = Object.keys(patch).filter((k) => patch[k] !== void 0);
  if (fields.some((key) => !["title", "body", "priority", "area", "track_id", "kind"].includes(key))) throw new KddError("invalid task patch");
  if (fields.length === 0) throw new KddError("nothing to edit");
  return db.transaction(() => {
    assertLegacyTaskMutation(db, [id2]);
    mustGetTask(db, id2);
    const sets = fields.map((f) => `${f} = ?`).join(", ");
    db.prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`).run(...fields.map((f) => patch[f]), now(), id2);
    appendTaskMutationEvent(db, id2, actor, "edited", { fields });
    return mustGetTask(db, id2);
  }).immediate();
}
function commentTask(db, id2, body, actor) {
  if (!body.trim()) throw new KddError("comment must not be empty");
  const text2 = actor.type === "ai" ? redact(body) : body;
  return db.transaction(() => {
    assertLegacyTaskMutation(db, [id2]);
    mustGetTask(db, id2);
    const r = db.prepare(
      `INSERT INTO comments (task_id, author, body, created_at) VALUES (?, ?, ?, ?)`
    ).run(id2, authorOf(actor), text2, now());
    appendTaskMutationEvent(db, id2, actor, "commented");
    return db.prepare(`SELECT * FROM comments WHERE id = ?`).get(Number(r.lastInsertRowid));
  }).immediate();
}
function checkStatus(s) {
  if (!STATUSES.includes(s)) {
    throw new KddError(`invalid status '${s}'; allowed: ${STATUSES.join(", ")}`);
  }
}
function openCriteria(db, taskId) {
  return db.prepare(
    `SELECT COUNT(*) AS c FROM criteria WHERE task_id = ? AND checked_at IS NULL`
  ).get(taskId).c;
}
function submittedBy(db, taskId) {
  const r = db.prepare(
    `SELECT actor_type, actor_id FROM events
      WHERE task_id = ? AND action = 'moved' AND detail LIKE '%"to":"review"%'
      ORDER BY id DESC LIMIT 1`
  ).get(taskId);
  return r ? authorOf({ type: r.actor_type, id: r.actor_id ?? void 0 }) : null;
}
function nextPosition(db, status) {
  return db.prepare(
    `SELECT COALESCE(MAX(position), -1) + 1 AS p
     FROM tasks WHERE status = ? AND archived_at IS NULL`
  ).get(status).p;
}
function moveTask(db, id2, to, actor, reason) {
  checkStatus(to);
  return db.transaction(() => {
    assertLegacyTaskMutation(db, [id2]);
    const t = mustGetTask(db, id2);
    const submitter = t.status === "review" ? submittedBy(db, id2) : null;
    const res = checkMove(t.status, to, actor, reason, openCriteria(db, id2), t.claimed_by, submitter);
    if (!res.ok) throw new KddError(res.error);
    const self = t.status === "review" && to === "done" && submitter === authorOf(actor);
    const leaving = t.status === "in_progress" && to !== "in_progress";
    const reset = to === "review";
    db.prepare(
      `UPDATE tasks SET status = ?, position = ?, updated_at = ?${leaving ? ", claimed_by = NULL, claim_expires = NULL" : ""}${reset ? ", failed_attempts = 0" : ""}
       WHERE id = ?`
    ).run(to, nextPosition(db, to), now(), id2);
    appendTaskMutationEvent(db, id2, actor, "moved", {
      from: t.status,
      to,
      ...reason ? { reason } : {},
      ...self ? { self_accepted: true } : {}
    });
    if (reason) {
      db.prepare(
        `INSERT INTO comments (task_id, author, body, created_at) VALUES (?, ?, ?, ?)`
      ).run(id2, authorOf(actor), reason, now());
    }
    return mustGetTask(db, id2);
  }).immediate();
}
function placeTask(db, id2, to, orderedIds, actor) {
  checkStatus(to);
  return db.transaction(() => {
    assertLegacyTaskMutation(db, [id2, ...orderedIds]);
    const t = mustGetTask(db, id2);
    if (t.status !== to) {
      const res = checkMove(
        t.status,
        to,
        actor,
        void 0,
        openCriteria(db, id2),
        t.claimed_by,
        t.status === "review" ? submittedBy(db, id2) : null
      );
      if (!res.ok) throw new KddError(res.error);
      appendTaskMutationEvent(db, id2, actor, "moved", { from: t.status, to });
    }
    const setPos = db.prepare(`UPDATE tasks SET position = ? WHERE id = ?`);
    orderedIds.forEach((tid, i) => setPos.run(i, tid));
    const leaving = t.status === "in_progress" && to !== "in_progress";
    const reset = to === "review";
    db.prepare(
      `UPDATE tasks SET status = ?, updated_at = ?${leaving ? ", claimed_by = NULL, claim_expires = NULL" : ""}${reset ? ", failed_attempts = 0" : ""}
       WHERE id = ?`
    ).run(to, now(), id2);
    return mustGetTask(db, id2);
  }).immediate();
}
function blockTask(db, id2, reason, actor) {
  if (!reason.trim()) throw new KddError("block reason must not be empty");
  return db.transaction(() => {
    assertLegacyTaskMutation(db, [id2]);
    mustGetTask(db, id2);
    db.prepare(`UPDATE tasks SET blocked = 1, block_reason = ?, updated_at = ? WHERE id = ?`).run(reason, now(), id2);
    appendTaskMutationEvent(db, id2, actor, "blocked", { reason });
    return mustGetTask(db, id2);
  }).immediate();
}
function unblockTask(db, id2, actor) {
  return db.transaction(() => {
    assertLegacyTaskMutation(db, [id2]);
    mustGetTask(db, id2);
    db.prepare(`UPDATE tasks SET blocked = 0, block_reason = NULL, updated_at = ? WHERE id = ?`).run(now(), id2);
    appendTaskMutationEvent(db, id2, actor, "unblocked");
    return mustGetTask(db, id2);
  }).immediate();
}
function linkTasks(db, fromId, toId, kind, actor) {
  db.transaction(() => {
    assertLegacyTaskMutation(db, [fromId, toId]);
    mustGetTask(db, fromId);
    mustGetTask(db, toId);
    const r = db.prepare(
      `INSERT OR IGNORE INTO task_links (from_id, to_id, kind) VALUES (?, ?, ?)`
    ).run(fromId, toId, kind);
    if (r.changes > 0) appendTaskMutationEvent(db, fromId, actor, "linked", { to: toId, kind });
  }).immediate();
}
function archiveTask(db, id2, actor) {
  return db.transaction(() => {
    assertLegacyTaskMutation(db, [id2]);
    mustGetTask(db, id2);
    db.prepare(`UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?`).run(now(), now(), id2);
    appendTaskMutationEvent(db, id2, actor, "archived");
    return mustGetTask(db, id2);
  }).immediate();
}
function unarchiveTask(db, id2, actor) {
  return db.transaction(() => {
    assertLegacyTaskMutation(db, [id2]);
    mustGetTask(db, id2);
    db.prepare(`UPDATE tasks SET archived_at = NULL, updated_at = ? WHERE id = ?`).run(now(), id2);
    appendTaskMutationEvent(db, id2, actor, "unarchived");
    return mustGetTask(db, id2);
  }).immediate();
}

// src/queries.ts
import { existsSync as existsSync9, readFileSync as readFileSync11, realpathSync as realpathSync11 } from "fs";
import { dirname as dirname8 } from "path";
var PRIORITY_ORDER = `CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;
function manualEvent(event) {
  if (event.actor_type !== "ai" || !event.detail) return void 0;
  try {
    const detail = JSON.parse(event.detail);
    if (!detail || typeof detail !== "object") return void 0;
    const raw = detail.manual_provenance;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return void 0;
    const p = raw;
    if (p.client !== "claude" && p.client !== "codex") return void 0;
    return {
      client: p.client,
      ...normalizeSessionId(p.session_id) ? { session_id: p.session_id } : {},
      ...typeof p.worktree === "string" ? { worktree: p.worktree } : {},
      ...typeof p.branch === "string" ? { branch: p.branch } : {},
      ...typeof p.head_commit === "string" ? { head_commit: p.head_commit } : {}
    };
  } catch {
    return void 0;
  }
}
function manualHistory(events) {
  let latest;
  let previous;
  const handoffs = [];
  for (const event of [...events].sort((a, b) => a.id - b.id)) {
    const current = manualEvent(event);
    if (!current) continue;
    latest = current;
    if (!current.session_id) continue;
    if (previous && (previous.client !== current.client || previous.session_id !== current.session_id)) {
      handoffs.push({
        from_client: previous.client,
        from_session_id: previous.session_id,
        to_client: current.client,
        to_session_id: current.session_id,
        event_id: event.id,
        at: event.created_at
      });
    }
    previous = { client: current.client, session_id: current.session_id };
  }
  return { ...latest ? { manual_provenance: latest } : {}, handoffs };
}
var READY_SQL = `(status = 'new' AND blocked = 0 AND archived_at IS NULL AND kind <> 'research' AND ${LEGACY_EXECUTION_SQL})`;
function boardData(db, f = {}) {
  const where = [f.archived ? "archived_at IS NOT NULL" : "archived_at IS NULL"];
  const params = [];
  if (f.area) {
    where.push("area = ?");
    params.push(f.area);
  }
  if (f.kind) {
    where.push("kind = ?");
    params.push(f.kind);
  }
  if (f.track_id != null) {
    where.push("track_id = ?");
    params.push(f.track_id);
  }
  if (f.status) {
    where.push("status = ?");
    params.push(f.status);
  }
  if (f.ready != null) where.push(f.ready ? READY_SQL : `NOT ${READY_SQL}`);
  const rows = db.prepare(
    `SELECT *,
       ${READY_SQL} AS ready,
       (SELECT COUNT(*) FROM criteria WHERE criteria.task_id = tasks.id) AS criteria_total,
       (SELECT COUNT(*) FROM criteria WHERE criteria.task_id = tasks.id AND checked_at IS NOT NULL)
         AS criteria_checked
     FROM tasks WHERE ${where.join(" AND ")}
     ORDER BY position, ${PRIORITY_ORDER}, created_at`
  ).all(...params);
  const out = Object.fromEntries(STATUSES.map((s) => [s, []]));
  for (const r of rows) out[r.status].push(r);
  return out;
}
function taskDetail(db, id2) {
  const task = mustGetTask(db, id2);
  const criteria = listCriteria(db, id2);
  const comments = db.prepare(
    `SELECT * FROM comments WHERE task_id = ? ORDER BY created_at, id`
  ).all(id2);
  const events = db.prepare(
    `SELECT * FROM events WHERE task_id = ? ORDER BY created_at, id`
  ).all(id2);
  const links = db.prepare(
    `SELECT t.id, t.title, l.kind FROM task_links l
     JOIN tasks t ON t.id = CASE WHEN l.from_id = ? THEN l.to_id ELSE l.from_id END
     WHERE l.from_id = ? OR l.to_id = ?`
  ).all(id2, id2, id2);
  const agent_runs_total = db.prepare(
    `SELECT COUNT(*) c FROM agent_events WHERE task_id = ? AND kind = 'run_start'`
  ).get(id2).c;
  const files = listFiles(db, id2).map((f) => ({ ...f, path: filePath(db.name, f) }));
  const decisions = db.prepare(
    `SELECT d.slug, d.title, d.created, d.superseded_by
       FROM decisions d, json_each(d.source_tasks) source
      WHERE CAST(source.value AS INTEGER) = ?
      ORDER BY d.slug`
  ).all(id2);
  return {
    task,
    criteria,
    comments,
    events,
    links,
    decisions,
    files,
    agent_runs_total,
    ...manualHistory(events)
  };
}
function taskDetailCapped(db, id2) {
  const d = taskDetail(db, id2);
  return {
    task: {
      ...d.task,
      body: d.task.body === null ? null : capText(d.task.body, CAPS.bodyChars)
    },
    // criteria не режем: неполный список приёмки бесполезен
    criteria: d.criteria,
    comments: d.comments.slice(-CAPS.comments).map((c) => ({ ...c, body: capText(c.body, CAPS.commentChars) })),
    comments_total: d.comments.length,
    events: d.events.slice(-CAPS.events),
    events_total: d.events.length,
    links: d.links,
    decisions: d.decisions.slice(0, CAPS.decisions).map((decision) => ({ ...decision, title: capText(decision.title, CAPS.titleChars) })),
    decisions_total: d.decisions.length,
    // Вложения режем с НАЧАЛА списка (он упорядочен по id, то есть по времени): первым
    // приложили — первым и показываем. У комментариев обратная политика — там свежий важнее.
    files: d.files.slice(0, CAPS.files).map((f) => ({
      ...f,
      description: f.description === null ? null : capText(f.description, CAPS.fileDescChars)
    })),
    files_total: d.files.length,
    ...d.manual_provenance ? { manual_provenance: d.manual_provenance } : {},
    handoffs: d.handoffs.slice(-CAPS.events),
    handoffs_total: d.handoffs.length
  };
}
function syncedTaskDetail(db, decisionsDir, id2, full = false) {
  syncIndex(db, decisionsDir);
  return full ? taskDetail(db, id2) : taskDetailCapped(db, id2);
}
function decisionDetail(db, decisionsDir, slug) {
  syncIndex(db, decisionsDir);
  const row = db.prepare(
    `SELECT slug, title, path, created, superseded_by, source_tasks FROM decisions WHERE slug = ?`
  ).get(slug);
  if (!row) throw new KddError(`decision '${slug}' not found`);
  const trusted = canSyncLegacyDecisions(db, decisionsDir) && existsSync9(row.path) && canSyncLegacyDecisions(db, dirname8(realpathSync11(row.path)));
  const cached = trusted ? void 0 : db.prepare("SELECT body FROM search_index WHERE kind='decision' AND ref=?").get(slug);
  if (!trusted && !cached) throw new KddError(`decision '${slug}' has no indexed body`);
  const doc = trusted ? parseDecisionMd(readFileSync11(row.path, "utf8")) : {
    status: row.superseded_by ? "superseded" : "active",
    indexBody: cached.body,
    sourceTasks: JSON.parse(row.source_tasks)
  };
  return {
    ...row,
    status: doc.status,
    body: doc.indexBody,
    source_tasks: doc.sourceTasks.map((id2) => {
      const task = mustGetTask(db, id2);
      return { id: id2, title: task.title, status: task.status, archived_at: task.archived_at };
    })
  };
}
function statusDigest(db) {
  const active = `archived_at IS NULL`;
  const q = (w) => db.prepare(
    `SELECT * FROM tasks WHERE ${active} AND ${w}
     ORDER BY ${PRIORITY_ORDER}, created_at`
  ).all();
  return {
    in_progress: q(`status = 'in_progress'`),
    review: q(`status = 'review'`),
    blocked: q(`blocked = 1`),
    recent: db.prepare(
      `SELECT * FROM events ORDER BY id DESC LIMIT ${CAPS.statusEvents}`
    ).all()
  };
}
function attentionData(db, nowSeconds) {
  const rows = db.prepare(`
    WITH task_facts AS (
      SELECT t.*,
        MAX(t.updated_at, COALESCE(
          (SELECT MAX(e.created_at) FROM events e WHERE e.task_id = t.id), t.updated_at
        )) AS last_activity,
        (SELECT e.type FROM events e
          WHERE e.task_id = t.id AND e.action = 'blocked'
          ORDER BY e.id DESC LIMIT 1) AS latest_blocked_type,
        (SELECT MAX(e.id) FROM events e
          WHERE e.task_id = t.id AND e.action = 'moved'
            AND e.detail LIKE '%"to":"review"%') AS last_review_id
      FROM tasks t
      WHERE t.archived_at IS NULL AND t.status <> 'done'
    ), classified AS (
      SELECT f.*,
        CASE
          WHEN f.blocked = 1 AND (
            substr(f.block_reason, 1, 12) = 'needs human:' OR (
              f.failed_attempts >= @maxFailed AND f.latest_blocked_type = 'claim'
            )
          ) THEN 'needs_input'
          WHEN f.blocked = 0 AND f.status IN ('review', 'in_progress')
            AND f.last_review_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM criteria c
              JOIN events e ON e.task_id = c.task_id
              WHERE c.task_id = f.id AND c.checked_at IS NULL
                AND e.action = 'criterion_unchecked' AND e.id > f.last_review_id
                AND CASE WHEN json_valid(e.detail) THEN
                  json_type(e.detail, '$.id') = 'integer'
                  AND json_extract(e.detail, '$.id') = c.id END
            ) THEN 'review_rework'
          WHEN f.blocked = 0 AND f.status = 'review' THEN 'await_acceptance'
          WHEN f.blocked = 0 AND f.status = 'in_progress'
            AND f.last_activity <= @cutoff THEN 'stale_in_progress'
          ELSE NULL
        END AS reason
      FROM task_facts f
    ), candidates AS (
      SELECT id, title, status, reason, block_reason, last_activity,
        CASE reason
          WHEN 'needs_input' THEN 1
          WHEN 'review_rework' THEN 2
          WHEN 'await_acceptance' THEN 3
          ELSE 4
        END AS reason_rank
      FROM classified WHERE reason IS NOT NULL
    ), counted AS (
      SELECT *, COUNT(*) OVER () AS total_count FROM candidates
    )
    SELECT * FROM counted
    ORDER BY reason_rank, last_activity, id
    LIMIT @limit
  `).all({
    maxFailed: MAX_FAILED_ATTEMPTS,
    cutoff: nowSeconds - 86400,
    limit: CAPS.attentionRows
  });
  const total = rows[0]?.total_count ?? 0;
  const items = rows.map(({ reason_rank: _rank, total_count: _total, ...row }) => ({
    ...row,
    title: capText(row.title, CAPS.titleChars),
    block_reason: row.block_reason === null ? null : capText(row.block_reason, CAPS.blockReasonChars)
  }));
  return { items, omitted: total - items.length };
}
function exportEventDetail(detail, includeSensitive) {
  if (detail === null) return null;
  try {
    const decoded = JSON.stringify(JSON.parse(detail));
    let marker = "__KDD_EXPORT_NUMBER_";
    while (detail.includes(marker) || decoded.includes(marker)) marker += "_";
    const numbers = [];
    const protectedDetail = detail.replace(
      /"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
      (token) => token.startsWith('"') ? token : `"${marker}${numbers.push(token) - 1}__"`
    );
    const value = JSON.parse(protectedDetail);
    const restoreNumbers = (json) => json.replace(
      new RegExp(`"${marker}(\\d+)__"`, "g"),
      (_match, id2) => numbers[Number(id2)]
    );
    let changed = false;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const provenance = value.manual_provenance;
      if (provenance && typeof provenance === "object" && !Array.isArray(provenance) && Object.hasOwn(provenance, "worktree")) {
        delete provenance.worktree;
        changed = true;
      }
    }
    if (includeSensitive) return changed ? restoreNumbers(JSON.stringify(value)) : detail;
    const redacted = JSON.stringify(value, (_key, text2) => {
      if (typeof text2 !== "string") return text2;
      const safe = redact(text2);
      if (safe !== text2) changed = true;
      return safe;
    });
    return changed ? restoreNumbers(redacted) : detail;
  } catch {
    return includeSensitive ? detail : redact(detail);
  }
}
function exportBoard(db, decisionsDir, opts = {}) {
  syncIndex(db, decisionsDir);
  return db.transaction(() => {
    const tasks = db.prepare(`SELECT id,title,body,status,blocked,block_reason,priority,area,kind,
      track_id,position,archived_at,created_at,updated_at FROM tasks ORDER BY id`).all();
    const tracks = db.prepare(`SELECT id,name,description,status,created_at FROM tracks ORDER BY id`).all();
    const criteria = db.prepare(`SELECT id,task_id,text,checked_at,evidence,checked_by,position,
      created_at FROM criteria ORDER BY id`).all();
    const comments = db.prepare(`SELECT id,task_id,author,body,created_at FROM comments ORDER BY id`).all();
    const task_links = db.prepare(`SELECT from_id,to_id,kind FROM task_links
      ORDER BY from_id,to_id,kind`).all();
    const decisions = db.prepare(`SELECT d.slug,d.title,d.created,d.superseded_by,
      d.source_tasks,s.body FROM decisions d LEFT JOIN search_index s
      ON s.kind='decision' AND s.ref=d.slug ORDER BY d.slug`).all().map(({ source_tasks, body, ...row }) => {
      if (body === null) throw new KddError(`decision '${row.slug}' has no indexed body`);
      return { ...row, source_task_ids: JSON.parse(source_tasks), body };
    });
    const events = db.prepare(`SELECT id,task_id,actor_type,actor_id,action,detail,
      created_at,parent_id,type,level FROM events ORDER BY id`).all().map((row) => ({ ...row, detail: exportEventDetail(row.detail, !!opts.includeSensitive) }));
    const files = db.prepare(`SELECT id,task_id,sha256,ext,original_name,mime_type,
      size_bytes,description,created_at FROM files ORDER BY id`).all();
    const snapshot2 = {
      schema_version: 1,
      tasks,
      tracks,
      criteria,
      comments,
      task_links,
      decisions,
      events,
      files
    };
    return opts.includeSensitive ? snapshot2 : JSON.parse(JSON.stringify(
      snapshot2,
      (_key, value) => typeof value === "string" ? redact(value) : value
    ));
  })();
}
function unsubmitted(db, author) {
  const ids = db.prepare(
    `SELECT id FROM tasks t
      WHERE t.status = 'in_progress' AND t.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM criteria c WHERE c.task_id = t.id)
        AND NOT EXISTS (SELECT 1 FROM criteria c WHERE c.task_id = t.id AND c.checked_at IS NULL)
        AND (t.claimed_by IS NULL OR t.claimed_by NOT LIKE 'ai:%' OR t.claimed_by = ?)
      ORDER BY id`
  ).all(author);
  const lastCheck = db.prepare(
    `SELECT actor_type, actor_id FROM events
      WHERE task_id = ? AND action = 'criterion_checked' ORDER BY id DESC LIMIT 1`
  );
  return ids.filter(({ id: id2 }) => {
    const r = lastCheck.get(id2);
    return !!r && authorOf({ type: r.actor_type, id: r.actor_id ?? void 0 }) === author;
  }).map(({ id: id2 }) => id2);
}

// src/claim.ts
var DEFAULT_TTL = 15 * 60;
var SYSTEM = { type: "ai", id: "system" };
function recordFailedAttempt(db, id2, actor, reason) {
  db.transaction(() => {
    assertLegacyTaskMutation(db, [id2]);
    assertManualExecution(db, id2);
    db.prepare(`UPDATE tasks SET failed_attempts = failed_attempts + 1, updated_at = ? WHERE id = ?`).run(now(), id2);
    const fa = db.prepare(`SELECT failed_attempts FROM tasks WHERE id = ?`).get(id2).failed_attempts;
    if (fa >= MAX_FAILED_ATTEMPTS) {
      db.prepare(`UPDATE tasks SET blocked = 1, block_reason = ?, updated_at = ? WHERE id = ?`).run(`${fa} failed attempts (agent driver): ${reason}`, now(), id2);
      appendEvent(
        db,
        id2,
        actor,
        "blocked",
        { reason: `${fa} failed attempts`, last: reason },
        { type: "claim", level: "error" }
      );
    }
  }).immediate();
}
function releaseClaim(db, id2, actor, reason) {
  db.transaction(() => {
    assertLegacyTaskMutation(db, [id2]);
    assertManualExecution(db, id2);
    db.prepare(
      `UPDATE tasks SET status='new', claimed_by=NULL, claim_expires=NULL, updated_at=? WHERE id=?`
    ).run(now(), id2);
    appendEvent(db, id2, actor, "released", { reason }, { type: "claim", level: "warn" });
    recordFailedAttempt(db, id2, actor, reason);
  }).immediate();
}
function assertManualExecution(db, id2) {
  if (mustGetTask(db, id2).execution_mode !== "manual") throw new KddError("orchestrated task requires controller execution");
}
function assertTtl(ttl) {
  if (!Number.isFinite(ttl) || ttl <= 0) throw new KddError(`invalid ttl '${ttl}' (seconds > 0)`);
}
var CLAIMABLE_SQL = `status = 'new' AND blocked = 0 AND archived_at IS NULL AND claimed_by IS NULL
   AND ${LEGACY_EXECUTION_SQL}
   AND kind <> 'research'
   AND (SELECT COUNT(*) FROM criteria WHERE criteria.task_id = tasks.id) > 0`;
var criteriaCount = (db, id2) => db.prepare(`SELECT COUNT(*) c FROM criteria WHERE task_id = ?`).get(id2).c;
function killAll(ids, kill) {
  if (!ids.length) return /* @__PURE__ */ new Map();
  if (!kill) return new Map(ids.map((id2) => [id2, "stuck"]));
  try {
    return kill(ids);
  } catch {
    return new Map(ids.map((id2) => [id2, "stuck"]));
  }
}
var isTickLease = (claimedBy) => !!claimedBy?.startsWith("ai:tick:");
function expiredLeases(db) {
  return db.prepare(
    `SELECT id, claimed_by FROM tasks
     WHERE status = 'in_progress' AND claim_expires IS NOT NULL AND claim_expires < ?
       AND ${LEGACY_EXECUTION_SQL}`
  ).all(now());
}
function reclaimExpired(db, opts = {}) {
  return db.transaction(() => {
    const t = now();
    const expired = expiredLeases(db).filter((e) => !opts.except?.has(e.id));
    assertLegacyTaskMutation(db, expired.map((row) => row.id));
    const clear = db.prepare(
      `UPDATE tasks SET status='new', claimed_by=NULL, claim_expires=NULL, updated_at=? WHERE id=? AND ${LEGACY_EXECUTION_SQL}`
    );
    for (const e of expired) {
      clear.run(t, e.id);
      appendEvent(db, e.id, SYSTEM, "reclaimed", { former: e.claimed_by }, { type: "claim", level: "warn" });
      if (isTickLease(e.claimed_by)) {
        recordFailedAttempt(db, e.id, SYSTEM, "lease expired without progress");
        try {
          closeOrphanRun(db, e.id, e.claimed_by, "lease expired, reclaimed by driver");
        } catch {
        }
      }
    }
    return expired;
  }).immediate();
}
function closeOrphanRun(db, taskId, claimedBy, reason) {
  const wid = claimedBy.slice(3);
  const last = lastAgentEventKind(db, taskId, wid);
  if (last === "run_end") return;
  if (last === null) {
    appendAgentEvent(
      db,
      taskId,
      wid,
      "error",
      { detail: { message: `worker never started (spawn or worktree setup failed) \u2014 ${reason}` } }
    );
    return;
  }
  appendAgentEvent(
    db,
    taskId,
    wid,
    "error",
    { detail: { message: `worker died (SIGKILL/OOM/reboot) \u2014 ${reason}` } }
  );
  appendAgentEvent(db, taskId, wid, "run_end", { detail: { exitCode: null } });
}
function reapExpired(db, kill) {
  const seen = expiredLeases(db);
  const except = /* @__PURE__ */ new Set();
  let killed = 0;
  let stuck = 0;
  const outcomes = killAll(seen.filter((l) => isTickLease(l.claimed_by)).map((l) => l.id), kill);
  for (const l of seen) {
    if (!isTickLease(l.claimed_by)) continue;
    const outcome = outcomes.get(l.id) ?? "stuck";
    if (outcome === "gone") killed++;
    if (outcome === "stuck") {
      except.add(l.id);
      stuck++;
    }
  }
  const reclaimed = db.transaction(() => {
    for (const l of expiredLeases(db)) {
      if (isTickLease(l.claimed_by) && !seen.some((s) => s.id === l.id)) except.add(l.id);
    }
    return reclaimExpired(db, { except });
  }).immediate();
  return { reclaimed, killed, stuck };
}
function stopWorkers(db, kill) {
  const live2 = db.prepare(
    `SELECT id, claimed_by FROM tasks WHERE status='in_progress' AND claimed_by IS NOT NULL
     AND ${LEGACY_EXECUTION_SQL}`
  ).all();
  const dead = [];
  let killed = 0;
  let stuck = 0;
  const outcomes = killAll(live2.filter((l) => isTickLease(l.claimed_by)).map((l) => l.id), kill);
  for (const l of live2) {
    const claimedBy = l.claimed_by;
    if (!isTickLease(claimedBy)) continue;
    const outcome = outcomes.get(l.id) ?? "stuck";
    if (outcome === "stuck") {
      stuck++;
      continue;
    }
    if (outcome === "gone") killed++;
    dead.push({ id: l.id, claimedBy });
  }
  const released = db.transaction(() => {
    const eligible = dead.filter((row) => db.prepare(`SELECT 1 FROM tasks WHERE id=? AND ${LEGACY_EXECUTION_SQL}`).get(row.id));
    assertLegacyTaskMutation(db, eligible.map((row) => row.id));
    const clear = db.prepare(
      `UPDATE tasks SET status='new', claimed_by=NULL, claim_expires=NULL, updated_at=?
       WHERE id=? AND status='in_progress' AND claimed_by=? AND ${LEGACY_EXECUTION_SQL}`
    );
    let n = 0;
    for (const d of eligible) {
      if (clear.run(now(), d.id, d.claimedBy).changes !== 1) continue;
      n++;
      appendEvent(
        db,
        d.id,
        SYSTEM,
        "released",
        { reason: "agent mode stopped", former: d.claimedBy },
        { type: "claim", level: "warn" }
      );
      try {
        closeOrphanRun(db, d.id, d.claimedBy, "stopped by hand (agent mode off)");
      } catch {
      }
    }
    return n;
  }).immediate();
  return { killed, released, stuck };
}
function claimTask(db, id2, actor, ttl = DEFAULT_TTL, opts = {}) {
  assertTtl(ttl);
  assertLegacyTaskMutation(db, [id2]);
  if (mustGetTask(db, id2).execution_mode !== "manual") return { ok: false, error: "orchestrated task requires controller execution" };
  reapExpired(db, opts.kill);
  return db.transaction(() => {
    assertLegacyTaskMutation(db, [id2]);
    const t = mustGetTask(db, id2);
    if (t.execution_mode !== "manual") return { ok: false, error: "orchestrated task requires controller execution" };
    if (t.kind === "research" && actor.type === "ai") {
      appendEvent(
        db,
        id2,
        actor,
        "claim_rejected",
        { reason: "research is not agent work" },
        { type: "claim", level: "warn" }
      );
      return {
        ok: false,
        error: `cannot claim #${id2}: kind=research \u2014 the deliverable is a recorded decision, not code`
      };
    }
    if (criteriaCount(db, id2) === 0) {
      appendEvent(
        db,
        id2,
        actor,
        "claim_rejected",
        { reason: "no acceptance criteria" },
        { type: "claim", level: "warn" }
      );
      return { ok: false, error: `cannot claim #${id2}: no acceptance criteria (define done first)` };
    }
    const expires = now() + ttl;
    const r = db.prepare(
      `UPDATE tasks SET status='in_progress', claimed_by=?, claim_expires=?, updated_at=?
       WHERE id=? AND status='new' AND blocked=0 AND archived_at IS NULL AND claimed_by IS NULL AND ${LEGACY_EXECUTION_SQL}`
    ).run(authorOf(actor), expires, now(), id2);
    if (r.changes !== 1) {
      return {
        ok: false,
        error: `#${id2} is not claimable (status ${t.status}${t.claimed_by ? `, held by ${t.claimed_by}` : ""})`
      };
    }
    appendTaskMutationEvent(db, id2, actor, "claimed", { ttl, expires }, { type: "claim" });
    return { ok: true, task: mustGetTask(db, id2) };
  }).immediate();
}
function claimNext(db, actor, ttl = DEFAULT_TTL, opts = {}) {
  assertTtl(ttl);
  if (opts.reclaim !== false) reapExpired(db, opts.kill);
  return db.transaction(() => {
    const rows = db.prepare(
      `SELECT id FROM tasks WHERE ${CLAIMABLE_SQL} ORDER BY ${PRIORITY_ORDER}, created_at, id`
    ).all();
    for (const { id: id2 } of rows) {
      const expires = now() + ttl;
      const r = db.prepare(
        `UPDATE tasks SET status='in_progress', claimed_by=?, claim_expires=?, updated_at=?
         WHERE id=? AND status='new' AND blocked=0 AND archived_at IS NULL AND claimed_by IS NULL AND ${LEGACY_EXECUTION_SQL}`
      ).run(authorOf(actor), expires, now(), id2);
      if (r.changes === 1) {
        appendTaskMutationEvent(db, id2, actor, "claimed", { ttl, expires }, { type: "claim" });
        return mustGetTask(db, id2);
      }
    }
    return null;
  }).immediate();
}
function renewClaim(db, id2, actor, ttl = DEFAULT_TTL, opts = {}) {
  assertTtl(ttl);
  return db.transaction(() => {
    assertLegacyTaskMutation(db, [id2]);
    if (mustGetTask(db, id2).execution_mode !== "manual") return { ok: false, error: "orchestrated task requires controller execution" };
    const expires = now() + ttl;
    const r = db.prepare(
      `UPDATE tasks SET claim_expires=?, updated_at=? WHERE id=? AND claimed_by=? AND ${LEGACY_EXECUTION_SQL}`
    ).run(expires, now(), id2, authorOf(actor));
    if (r.changes !== 1) {
      return {
        ok: false,
        error: `#${id2} not held by ${authorOf(actor)} (lease lost or reclaimed) \u2014 stop work`
      };
    }
    if (opts.log !== false) {
      appendEvent(db, id2, actor, "claim_renewed", { ttl, expires }, { type: "claim" });
    }
    return { ok: true, task: mustGetTask(db, id2) };
  }).immediate();
}

// src/driver.ts
function activeWorkers(db) {
  return db.prepare(
    `SELECT COUNT(*) c FROM tasks WHERE status='in_progress' AND claimed_by IS NOT NULL`
  ).get().c;
}
function tick(db, opts) {
  const { reclaimed, killed, stuck } = reapExpired(db, opts.kill);
  let active = activeWorkers(db);
  let spawned = 0;
  const nonce = now();
  while (active < opts.maxWorkers) {
    const workerId = `tick:${nonce}-${spawned}`;
    const t = claimNext(db, { type: "ai", id: workerId }, opts.ttl, { reclaim: false });
    if (!t) break;
    try {
      opts.spawn(t.id, workerId, opts.projectDir);
      active++;
      spawned++;
    } catch (e) {
      releaseClaim(
        db,
        t.id,
        { type: "ai", id: workerId },
        `spawn failed: ${e instanceof Error ? e.message : String(e)}`
      );
      break;
    }
  }
  const pruned = pruneAgentEvents(db);
  if (pruned) checkpointWal(db);
  return { reclaimed: reclaimed.length, killed, stuck, spawned, active };
}

// src/worktree.ts
import { execFileSync as execFileSync10 } from "child_process";
import { existsSync as existsSync10, realpathSync as realpathSync12, rmSync as rmSync5 } from "fs";
import { dirname as dirname9, join as join10 } from "path";
var branchName = (taskId) => `kdd/task-${taskId}`;
var BRANCH_RE = /^refs\/heads\/kdd\/task-(\d+)$/;
function git2(repoRoot, args) {
  try {
    return execFileSync10("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch (e) {
    const err = e;
    const detail = (err.stderr ?? "").trim() || err.message || "git failed";
    throw new Error(`git ${args.join(" ")}: ${detail}`);
  }
}
function gitTry(repoRoot, args) {
  try {
    git2(repoRoot, args);
  } catch {
  }
}
function worktreePath(dbPath, taskId, title) {
  const root = dirname9(dbPath);
  const realRoot = existsSync10(root) ? realpathSync12(root) : root;
  return join10(realRoot, "worktrees", `task-${taskId}-${slugify(title)}`);
}
function headCommit(repoRoot) {
  return git2(repoRoot, ["rev-parse", "HEAD"]);
}
function taskBranchHead(repoRoot, taskId) {
  try {
    return git2(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branchName(taskId)}`]);
  } catch {
    return null;
  }
}
function listWorktrees(repoRoot) {
  const out = git2(repoRoot, ["worktree", "list", "--porcelain"]);
  const entries = [];
  let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) entries.push(cur);
      cur = { path: line.slice(9), branch: null };
    } else if (line.startsWith("branch ") && cur) {
      cur.branch = line.slice(7);
    }
  }
  if (cur) entries.push(cur);
  return entries;
}
function branchExists(repoRoot, branch) {
  try {
    git2(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}
function ensureWorktree(repoRoot, dbPath, taskId, title) {
  const branch = branchName(taskId);
  const ref = `refs/heads/${branch}`;
  const existing = listWorktrees(repoRoot).find((e) => e.branch === ref);
  if (existing && existsSync10(existing.path)) return existing.path;
  if (existing) gitTry(repoRoot, ["worktree", "remove", "--force", existing.path]);
  const path = worktreePath(dbPath, taskId, title);
  gitTry(repoRoot, ["worktree", "prune"]);
  rmSync5(path, { recursive: true, force: true });
  const tail = branchExists(repoRoot, branch) ? [path, branch] : [path, "-b", branch];
  git2(repoRoot, ["worktree", "add", ...tail]);
  return path;
}
function sweepWorktrees(db, repoRoot, isBusy) {
  const stmt = db.prepare(`SELECT status FROM tasks WHERE id = ?`);
  let removed = 0;
  for (const e of listWorktrees(repoRoot)) {
    const m = e.branch?.match(BRANCH_RE);
    if (!m) continue;
    const taskId = Number(m[1]);
    const row = stmt.get(taskId);
    if (row?.status === "in_progress") continue;
    if (isBusy?.(taskId)) continue;
    gitTry(repoRoot, ["worktree", "remove", "--force", e.path]);
    removed++;
  }
  if (removed) gitTry(repoRoot, ["worktree", "prune"]);
  return removed;
}

// src/release.ts
import { readFileSync as readFileSync12 } from "fs";
import { join as join11 } from "path";
var pkgCache = null;
function pkg() {
  if (pkgCache) return pkgCache;
  try {
    pkgCache = JSON.parse(
      readFileSync12(join11(import.meta.dirname, "../package.json"), "utf8")
    );
  } catch {
    pkgCache = {};
  }
  return pkgCache;
}
function kddVersion() {
  return pkg().version ?? "0.0.0";
}
function parseRepoUrl(url) {
  const m = url.replace(/\.git\/?$/i, "").match(/github\.com[/:]([^/]+)\/([^/]+)/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}
function repoSlug() {
  const r = pkg().repository;
  return parseRepoUrl(typeof r === "string" ? r : r?.url ?? "");
}
function parse(v) {
  const [core, ...rest] = v.replace(/^v/, "").split("-");
  const n = core.split(".").map((x) => Number.parseInt(x, 10) || 0);
  return { core: [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0], pre: rest.join("-") };
}
function compareVersions(a, b) {
  const A = parse(a);
  const B = parse(b);
  for (let i = 0; i < 3; i++) if (A.core[i] !== B.core[i]) return A.core[i] - B.core[i];
  if (!A.pre && B.pre) return 1;
  if (A.pre && !B.pre) return -1;
  const left = A.pre.split(".");
  const right = B.pre.split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] === void 0) return -1;
    if (right[i] === void 0) return 1;
    if (left[i] === right[i]) continue;
    const ln = /^\d+$/.test(left[i]) ? Number(left[i]) : null;
    const rn = /^\d+$/.test(right[i]) ? Number(right[i]) : null;
    if (ln !== null && rn !== null) return ln - rn;
    if (ln !== null) return -1;
    if (rn !== null) return 1;
    return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}
function versionChannel(version) {
  if (/^\d+\.\d+\.\d+$/.test(version)) return "stable";
  if (/^\d+\.\d+\.\d+-next\.\d+$/.test(version)) return "next";
  return null;
}
function updateDisposition(current, target, channel) {
  if (versionChannel(target) !== channel) return "ahead";
  if (current === target) return "current";
  if (versionChannel(current) === "next" && channel === "stable") return "install";
  return compareVersions(current, target) < 0 ? "install" : "ahead";
}
var TAG_STRIP_RE = /<\/?(?:details|summary|br|hr|img|picture|source|video|audio|div|span|table|thead|tbody|tfoot|tr|td|th|caption|ul|ol|li|dl|dt|dd|h[1-6]|blockquote|pre|code|kbd|samp|var|sub|sup|em|strong|small|del|ins|mark|abbr|center|font)\b[^>]*>/gi;
function stripHtml(md) {
  return md.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, i) => i % 2 === 1 ? part : part.replace(TAG_STRIP_RE, "")).join("");
}
var OK_TTL = 60 * 60 * 1e3;
var ERR_TTL = 5 * 60 * 1e3;
var cache = null;
var inflight = null;
function _resetCache() {
  cache = null;
  inflight = null;
}
function _cacheUntil() {
  return cache?.until ?? null;
}
async function releaseInfo(opts = {}) {
  if (!opts.fresh && cache && Date.now() < cache.until) return structuredClone(cache.info);
  if (opts.fresh) return structuredClone(await load(opts));
  inflight ??= load(opts).finally(() => {
    inflight = null;
  });
  return structuredClone(await inflight);
}
async function load(opts) {
  const current = kddVersion();
  const slug = repoSlug();
  const repoUrl = slug ? `https://github.com/${slug.owner}/${slug.repo}` : null;
  const store = (info, ttl) => {
    cache = { until: Date.now() + ttl, info };
    return info;
  };
  const fail = (error, ttl = ERR_TTL) => store({
    current,
    latest: null,
    next: null,
    hasUpdate: false,
    releases: [],
    repoUrl,
    error
  }, ttl);
  if (!slug) return fail("no repository url in package.json");
  try {
    const f = opts.fetch ?? globalThis.fetch;
    const res = await f(
      `https://api.github.com/repos/${slug.owner}/${slug.repo}/releases?per_page=10`,
      {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(5e3)
      }
    );
    if (!res.ok) return fail(`GitHub API ${res.status} ${res.statusText}`);
    const rows = await res.json();
    if (!Array.isArray(rows)) return fail("unexpected GitHub response");
    const releases = rows.flatMap((r) => r && typeof r === "object" && typeof r.tag_name === "string" && !r.draft ? [{
      version: r.tag_name.replace(/^v/, ""),
      url: String(r.html_url ?? `${repoUrl}/releases`),
      body: stripHtml(String(r.body ?? "")),
      publishedAt: String(r.published_at ?? ""),
      prerelease: Boolean(r.prerelease)
    }] : []);
    if (releases.length === 0) return fail("no published releases", OK_TTL);
    let latest = releases.filter((r) => !r.prerelease && versionChannel(r.version) === "stable").reduce(
      (m, r) => m === null || compareVersions(r.version, m) > 0 ? r.version : m,
      null
    );
    const next = releases.filter((r) => r.prerelease && versionChannel(r.version) === "next").reduce(
      (m, r) => m === null || compareVersions(r.version, m) > 0 ? r.version : m,
      null
    );
    if (latest === null) {
      try {
        const stableRes = await f(
          `https://api.github.com/repos/${slug.owner}/${slug.repo}/releases/latest`,
          { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(5e3) }
        );
        if (stableRes.ok) {
          const stable = await stableRes.json();
          if (stable && typeof stable.tag_name === "string" && !stable.draft && !stable.prerelease) {
            const version = stable.tag_name.replace(/^v/, "");
            if (versionChannel(version) === "stable") latest = version;
          }
        }
      } catch {
      }
    }
    return store({
      current,
      latest,
      next,
      hasUpdate: latest !== null && compareVersions(latest, current) > 0,
      releases,
      repoUrl,
      error: null
    }, OK_TTL);
  } catch (e) {
    console.error("[kdd] release check failed:", e);
    return fail("release check failed");
  }
}

// src/settings.ts
var TICK_INTERVALS = [30, 60, 300, 900];
var MAX_WORKERS_CAP = 10;
var DEFAULTS = { enabled: false, intervalSec: 60, maxWorkers: 3 };
var isInterval = (n) => TICK_INTERVALS.includes(n);
var isWorkers = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_WORKERS_CAP;
function readMeta(db, key) {
  return db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key)?.value;
}
function writeMeta(db, key, value) {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}
function getAutoTick(db) {
  const interval = Number(readMeta(db, "autotick_interval_sec"));
  const workers = Number(readMeta(db, "autotick_max_workers"));
  return {
    enabled: readMeta(db, "autotick_enabled") === "1",
    intervalSec: isInterval(interval) ? interval : DEFAULTS.intervalSec,
    maxWorkers: isWorkers(workers) ? workers : DEFAULTS.maxWorkers
  };
}
function setAutoTick(db, patch) {
  if (patch.intervalSec !== void 0 && !isInterval(patch.intervalSec)) {
    throw new KddError(`interval must be one of ${TICK_INTERVALS.join(", ")} seconds`);
  }
  if (patch.maxWorkers !== void 0 && !isWorkers(patch.maxWorkers)) {
    throw new KddError(`max workers must be an integer between 1 and ${MAX_WORKERS_CAP}`);
  }
  return db.transaction(() => {
    if (patch.enabled !== void 0) {
      writeMeta(db, "autotick_enabled", patch.enabled ? "1" : "0");
    }
    if (patch.intervalSec !== void 0) {
      writeMeta(db, "autotick_interval_sec", String(patch.intervalSec));
    }
    if (patch.maxWorkers !== void 0) {
      writeMeta(db, "autotick_max_workers", String(patch.maxWorkers));
    }
    return getAutoTick(db);
  })();
}
function getLastRun(db) {
  const raw = readMeta(db, "autotick_last");
  if (raw === void 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function setLastRun(db, run) {
  db.transaction(() => writeMeta(db, "autotick_last", JSON.stringify(run)))();
}
function maxWorkers(db) {
  const env = process.env.KDD_MAX_WORKERS;
  if (env === void 0) return getAutoTick(db).maxWorkers;
  const n = Number(env);
  if (!Number.isInteger(n) || n < 1) {
    throw new KddError("KDD_MAX_WORKERS must be a positive integer");
  }
  return n;
}
var maxWorkersEnvLocked = () => process.env.KDD_MAX_WORKERS !== void 0;
var MAX_REMINDED_SESSIONS = 10;
function getReminded(db, session) {
  return readReminded(db).find(([s]) => s === session)?.[1] ?? [];
}
function setReminded(db, session, ids) {
  db.transaction(() => {
    const kept = readReminded(db).filter(([s]) => s !== session);
    kept.push([session, ids]);
    writeMeta(
      db,
      "stop_reminded",
      JSON.stringify(kept.slice(Math.max(0, kept.length - MAX_REMINDED_SESSIONS)))
    );
  })();
}
function readReminded(db) {
  try {
    const raw = JSON.parse(readMeta(db, "stop_reminded") ?? "null");
    if (!Array.isArray(raw)) return [];
    return raw.filter((e) => Array.isArray(e) && typeof e[0] === "string" && Array.isArray(e[1]));
  } catch {
    return [];
  }
}

// src/brief.ts
import { existsSync as existsSync11, readFileSync as readFileSync13, readdirSync as readdirSync8, realpathSync as realpathSync13 } from "fs";
import { dirname as dirname10, join as join12 } from "path";
var lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function detailObject(detail) {
  if (!detail) return {};
  try {
    const value = JSON.parse(detail);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
function stringField(key, ...objects) {
  for (const object of objects) {
    const value = object[key];
    if (typeof value === "string") return value;
  }
  return void 0;
}
function readRunProvenance(db, taskId) {
  const row = db.prepare(
    `WITH latest_start AS (
       SELECT id, worker_id, detail
         FROM agent_events
        WHERE task_id = ? AND kind = 'run_start'
        ORDER BY id DESC
        LIMIT 1
     )
     SELECT s.worker_id,
            s.detail AS start_detail,
            (SELECT ae.detail FROM agent_events ae
              WHERE ae.task_id = ? AND ae.worker_id = s.worker_id
                AND ae.kind = 'run_end' AND ae.id > s.id
              ORDER BY ae.id ASC LIMIT 1) AS end_detail,
            (SELECT ae.detail FROM agent_events ae
              WHERE ae.task_id = ? AND ae.worker_id = s.worker_id
                AND ae.kind = 'error' AND ae.id > s.id
              ORDER BY ae.id DESC LIMIT 1) AS error_detail
       FROM latest_start s`
  ).get(taskId, taskId, taskId);
  if (!row) return void 0;
  const start = detailObject(row.start_detail);
  const end = detailObject(row.end_detail);
  const error = detailObject(row.error_detail);
  const provenance = { worker_id: row.worker_id };
  const sessionId = stringField("session_id", start, end, error);
  const branch = stringField("branch", start, end, error);
  const worktree = stringField("worktree", start, end, error);
  const beforeCommit = stringField("head", start);
  const afterCommit = stringField("head", end);
  const message = stringField("message", error);
  if (sessionId !== void 0) provenance.session_id = sessionId;
  if (branch !== void 0) provenance.branch = branch;
  if (worktree !== void 0) provenance.worktree = worktree;
  if (beforeCommit !== void 0) provenance.before_commit = beforeCommit;
  if (afterCommit !== void 0) provenance.after_commit = afterCommit;
  if (message !== void 0) provenance.error = message;
  return provenance;
}
function readTaskDecisions(db, decisionsDir, taskId) {
  if (!canSyncLegacyDecisions(db, decisionsDir)) {
    return db.prepare("SELECT slug,title,created,superseded_by,source_tasks FROM decisions ORDER BY slug").all().filter((row) => JSON.parse(row.source_tasks).includes(taskId)).map(({ source_tasks, ...row }) => ({ ...row, title: capText(row.title, CAPS.titleChars) }));
  }
  if (!existsSync11(decisionsDir)) return [];
  return readdirSync8(decisionsDir).filter((file) => file.endsWith(".md")).flatMap((file) => {
    const slug = file.slice(0, -3);
    if (!canSyncLegacyDecisions(db, dirname10(realpathSync13(join12(decisionsDir, file))))) return [];
    const decision = parseDecisionMd(readFileSync13(join12(decisionsDir, file), "utf8"));
    if (!decision.sourceTasks.includes(taskId)) return [];
    return [{
      slug,
      title: capText(decision.title || slug, CAPS.titleChars),
      created: decision.created || null,
      superseded_by: decision.status === "superseded" ? decision.supersededBy || "?" : decision.supersededBy || null
    }];
  });
}
function nextAction(task, criteria, controlled) {
  if (task.status === "done") return { kind: "done", text: "Task is done; no action remains." };
  if (task.archived_at !== null) {
    return { kind: "archived", text: "Task is archived; no action remains." };
  }
  if (task.blocked) {
    return {
      kind: "resolve_blocker",
      text: task.block_reason ? `Resolve blocker: ${task.block_reason}` : "Resolve the task blocker."
    };
  }
  if (controlled) return { kind: "await_controller", text: "Await controller execution or handoff." };
  if (task.status === "backlog") {
    return { kind: "start_work", text: "Move the task to new and start work." };
  }
  if (task.status === "new") return { kind: "start_work", text: "Start work on the task." };
  const open = criteria.find((criterion) => criterion.checked_at === null);
  if (open) {
    return {
      kind: "complete_criterion",
      criterion_id: open.id,
      text: `Complete criterion #${open.id}: ${open.text}`
    };
  }
  if (task.status !== "review") {
    return { kind: "submit_review", text: "Submit the task to review." };
  }
  return { kind: "await_acceptance", text: "Await human acceptance or requested changes." };
}
var briefBytes = (brief) => Buffer.byteLength(JSON.stringify(brief), "utf8");
function omitLastItem(section) {
  if (section.items.length === 0) return false;
  section.items.pop();
  section.omitted += 1;
  return true;
}
function drain(brief, section) {
  while (briefBytes(brief) > CAPS.briefBytes && omitLastItem(section)) {
  }
}
function fitBrief(brief, sources, errorSource) {
  if (briefBytes(brief) <= CAPS.briefBytes) return brief;
  drain(brief, brief.events);
  drain(brief, brief.comments);
  drain(brief, brief.files);
  drain(brief, brief.links);
  drain(brief, brief.decisions);
  drain(brief, brief.handoffs);
  if (briefBytes(brief) > CAPS.briefBytes && brief.provenance?.error && errorSource) {
    for (const cap of [128, 64, 32, 16]) {
      brief.provenance.error = capText(errorSource, cap);
      if (briefBytes(brief) <= CAPS.briefBytes) return brief;
    }
    delete brief.provenance.error;
  }
  for (const source of [brief.manual_provenance, brief.provenance]) {
    for (const field of ["worktree", "branch"]) {
      if (briefBytes(brief) > CAPS.briefBytes && source?.[field]) delete source[field];
    }
  }
  const caps = {
    block_reason: CAPS.blockReasonChars,
    goal: 512,
    next_action: 128,
    area: 128,
    title: CAPS.titleChars
  };
  const tighten = (key) => {
    if (sources[key] === null) {
      caps[key] = 16;
      return;
    }
    if (caps[key] <= 16) return;
    caps[key] = Math.max(16, Math.floor(caps[key] / 2));
    const value = capText(sources[key], caps[key]);
    if (key === "next_action") brief.next_action.text = value;
    else if (key === "block_reason") brief.task.block_reason = value;
    else if (key === "goal") brief.task.goal = value;
    else if (key === "area") brief.task.area = value;
    else brief.task.title = value;
  };
  while (briefBytes(brief) > CAPS.briefBytes && Object.values(caps).some((cap) => cap > 16)) {
    for (const key of ["block_reason", "goal", "next_action", "area", "title"]) {
      tighten(key);
      if (briefBytes(brief) <= CAPS.briefBytes) return brief;
    }
  }
  while (briefBytes(brief) > CAPS.briefBytes && brief.criteria.items.at(-1)?.checked_at !== null && brief.criteria.items.length > 0) {
    omitLastItem(brief.criteria);
  }
  if (briefBytes(brief) > CAPS.briefBytes && brief.provenance) {
    delete brief.provenance;
    brief.worker_provenance_omitted = true;
  }
  drain(brief, brief.criteria);
  if (briefBytes(brief) > CAPS.briefBytes) {
    throw new Error("task brief cannot fit the 4096-byte JSON budget");
  }
  return brief;
}
function taskBrief(db, decisionsDir, id2) {
  const detail = taskDetail(db, id2);
  const criteria = [...detail.criteria].sort((a, b) => {
    const rank = (criterion) => criterion.checked_at === null ? 0 : criterion.evidence ? 1 : 2;
    return rank(a) - rank(b) || a.position - b.position || a.id - b.id;
  });
  const provenance = readRunProvenance(db, id2);
  const errorSource = provenance?.error;
  if (provenance?.error) provenance.error = capText(provenance.error, 256);
  const task = {
    id: detail.task.id,
    title: capText(detail.task.title, CAPS.titleChars),
    goal: detail.task.body === null ? null : capText(detail.task.body, 512),
    status: detail.task.status,
    blocked: !!detail.task.blocked,
    block_reason: detail.task.block_reason === null ? null : capText(detail.task.block_reason, CAPS.blockReasonChars),
    priority: detail.task.priority,
    kind: detail.task.kind,
    area: detail.task.area === null ? null : capText(detail.task.area, 128),
    archived_at: detail.task.archived_at,
    parent_id: detail.task.parent_id,
    execution_mode: detail.task.execution_mode
  };
  const projectedCriteria = {
    items: criteria.map((criterion) => ({
      id: criterion.id,
      text: capText(criterion.text, 128),
      checked_at: criterion.checked_at,
      ...criterion.evidence ? { evidence: capText(criterion.evidence, 128) } : {},
      ...criterion.checked_by ? { checked_by: criterion.checked_by } : {}
    })),
    omitted: 0
  };
  const controlled = task.execution_mode === "orchestrated" || !!db.prepare("SELECT 1 FROM managed_task_policy WHERE task_id=?").get(id2) || !!db.prepare("SELECT 1 FROM execution_handoffs WHERE task_id=? AND completed_at IS NULL").get(id2);
  const action = nextAction(task, projectedCriteria.items, controlled);
  const actionSource = action.text;
  action.text = capText(action.text, 128);
  const brief = {
    task,
    criteria: projectedCriteria,
    comments: {
      items: detail.comments.map((comment) => ({
        id: comment.id,
        author: comment.author,
        body: capText(comment.body, 256),
        created_at: comment.created_at
      })).sort((a, b) => b.created_at - a.created_at || b.id - a.id),
      omitted: 0
    },
    events: {
      items: detail.events.filter((event) => event.action !== "commented").map((event) => ({
        id: event.id,
        actor_type: event.actor_type,
        ...event.actor_id ? { actor_id: event.actor_id } : {},
        action: event.action,
        ...event.detail ? { detail: capText(event.detail, 256) } : {},
        created_at: event.created_at
      })).sort((a, b) => b.created_at - a.created_at || b.id - a.id),
      omitted: 0
    },
    links: {
      items: detail.links.map((link) => ({ ...link, title: capText(link.title, CAPS.titleChars) })).sort((a, b) => a.id - b.id || lexical(a.kind, b.kind)),
      omitted: 0
    },
    decisions: {
      items: readTaskDecisions(db, decisionsDir, id2).sort((a, b) => lexical(a.slug, b.slug)),
      omitted: 0
    },
    files: {
      items: detail.files.map((file) => ({
        id: file.id,
        name: file.original_name,
        mime_type: file.mime_type,
        size_bytes: file.size_bytes,
        description: file.description === null ? null : capText(file.description, 128),
        path: file.path
      })).sort((a, b) => a.id - b.id),
      omitted: 0
    },
    ...detail.manual_provenance ? { manual_provenance: detail.manual_provenance } : {},
    handoffs: {
      items: detail.handoffs.slice(-3).reverse(),
      omitted: Math.max(0, detail.handoffs.length - 3)
    },
    ...provenance ? { provenance } : {},
    next_action: action,
    budget: { max_bytes: CAPS.briefBytes }
  };
  return fitBrief(brief, {
    block_reason: detail.task.block_reason,
    goal: detail.task.body,
    next_action: actionSource,
    area: detail.task.area,
    title: detail.task.title
  }, errorSource);
}

// src/execution_ownership.ts
function ownerRecord(db, row) {
  const item = scopedWorkItem(db, { projectId: JSON.parse(row.inputs_json).projectId, workItemId: row.work_item_id }, row.revision);
  const inputs = JSON.parse(row.inputs_json);
  return {
    ref: { ...item.ref, revision: row.revision, ownerId: row.owner_id, fence: row.fence },
    mode: row.mode,
    write: row.write_access === 1,
    inputsHash: inputs.inputsHash,
    inputResults: inputs.inputResults,
    launchIntent: row.launch_json === null ? null : JSON.parse(row.launch_json),
    releasedAt: row.released_at
  };
}
function ownership(handle, ref) {
  const db = controllerDb(handle);
  checkOwnershipRef(db, ref);
  const row = db.prepare("SELECT * FROM work_item_owners WHERE work_item_id=? AND fence=? AND revision=? AND owner_id=?").get(ref.workItemId, ref.fence, ref.revision, ref.ownerId);
  if (!row) throw new KddError("ownership not found");
  return ownerRecord(db, row);
}
function reserveWorkItem(handle, input, observers = {}) {
  const db = controllerDb(handle);
  return db.transaction(() => {
    shape(input, ["ref", "expectedRevision", "expectedFence", "expectedMode", "ownerId", "write"]);
    integer(input.expectedRevision);
    integer(input.expectedFence, 0);
    mode(input.expectedMode);
    text(input.ownerId);
    if (typeof input.write !== "boolean") throw new KddError("invalid write access");
    const item = scopedWorkItem(db, input.ref), task = mustGetTask(db, item.task.taskId);
    assertNoHandoff(db, task.id);
    if (item.revision !== input.expectedRevision || !inputsCurrent(db, item)) throw new KddError("stale revision or inputs");
    if (item.fence !== input.expectedFence || item.fence === Number.MAX_SAFE_INTEGER) throw new KddError("ownership fence conflict or overflow");
    if (task.execution_mode !== input.expectedMode) throw new KddError("execution mode changed");
    if (task.blocked || task.archived_at !== null || !["new", "in_progress"].includes(task.status) || !["pending", "ready"].includes(item.state)) throw new KddError("work item not reservable");
    if (!input.write && ["implementation", "integration"].includes(item.definition.kind)) throw new KddError("write ownership required");
    if (db.prepare("SELECT 1 FROM work_item_owners WHERE work_item_id=? AND released_at IS NULL").get(item.ref.workItemId)) throw new KddError("work item already owned");
    if (input.write) protectTask(handle, task.id);
    const deps = resolveDependencies(handle, { ref: item.ref, expectedRevision: item.revision }, observers);
    if (!deps.ready) throw new KddError("dependencies not verified");
    const fence = item.fence + 1;
    if (!db.prepare("UPDATE work_items SET fence=? WHERE id=? AND fence=? AND current_revision=?").run(fence, item.ref.workItemId, input.expectedFence, input.expectedRevision).changes) throw new KddError("ownership fence changed");
    db.prepare("INSERT INTO work_item_owners(work_item_id,fence,revision,owner_id,mode,write_access,inputs_json,created_at) VALUES(?,?,?,?,?,?,?,?)").run(item.ref.workItemId, fence, item.revision, input.ownerId, input.expectedMode, Number(input.write), canonical({
      projectId: item.ref.projectId,
      inputsHash: item.inputsHash,
      inputResults: deps.edges.map((e) => ({ edgeKey: e.key, resultId: e.resultId }))
    }), now());
    appendEvent(db, task.id, controllerActor, "work_item_reserved", { work_item_id: item.ref.workItemId, revision: item.revision, fence, owner_id: input.ownerId });
    return ownership(handle, { ...item.ref, revision: item.revision, fence, ownerId: input.ownerId });
  }).immediate();
}
function recordLaunchIntent(handle, input) {
  const db = controllerDb(handle);
  return db.transaction(() => {
    shape(input, ["owner", "intent"]);
    const owner = liveOwner(db, input.owner), item = scopedWorkItem(db, { projectId: input.owner.projectId, workItemId: input.owner.workItemId });
    assertNoHandoff(db, item.task.taskId);
    shape(input.intent, ["launchId", "writerScopeId"], ["authority"]);
    text(input.intent.launchId);
    text(input.intent.writerScopeId);
    if (input.intent.authority !== void 0) {
      checkAuthority(db, item.task, input.intent.authority);
      const grant = JSON.parse(db.prepare("SELECT grant_json FROM run_authorities WHERE authority_id=?").get(input.intent.authority.authorityId).grant_json);
      if (input.intent.authority.workItemId !== item.ref.workItemId || canonical(grant.ownership) !== canonical(input.owner)) throw new KddError("launch authority ownership mismatch");
    }
    if (owner.launch_json !== null) {
      if (canonical(JSON.parse(owner.launch_json)) !== canonical(input.intent)) throw new KddError("launch intent already recorded");
      return ownership(handle, input.owner);
    }
    db.prepare("UPDATE work_item_owners SET launch_id=?,launch_json=? WHERE work_item_id=? AND fence=? AND released_at IS NULL AND launch_id IS NULL").run(input.intent.launchId, canonical(input.intent), owner.work_item_id, owner.fence);
    appendEvent(db, item.task.taskId, controllerActor, "work_item_launch_intent", { owner: input.owner, intent: input.intent });
    return ownership(handle, input.owner);
  }).immediate();
}
function snapshot(db, task) {
  const rows = db.prepare("SELECT o.* FROM work_item_owners o JOIN work_items w ON w.id=o.work_item_id WHERE w.task_id=? AND o.released_at IS NULL ORDER BY o.work_item_id,o.fence").all(task.taskId);
  const authorities = db.prepare(`SELECT a.authority_id,a.work_item_id,a.run_id,a.generation FROM run_authorities a
    LEFT JOIN work_items w ON w.id=a.work_item_id WHERE a.task_id=? OR w.task_id=? ORDER BY a.authority_id`).all(task.taskId, task.taskId).map((a) => ({
    authorityId: a.authority_id,
    workItemId: a.work_item_id,
    runId: a.run_id,
    generation: a.generation
  }));
  return { owners: rows.map((row) => ownerRecord(db, row)), authorities };
}
function authorityTracked(db, record, authority) {
  try {
    const row = db.prepare("SELECT task_id,grant_json FROM run_authorities WHERE authority_id=? AND work_item_id=? AND run_id=? AND generation=?").get(authority.authorityId, authority.workItemId, authority.runId, authority.generation);
    if (!row || row.task_id !== record.task.taskId) return false;
    const grant = JSON.parse(row.grant_json);
    if (grant.projectId !== record.task.projectId || grant.taskId !== row.task_id || grant.workItemId !== authority.workItemId || grant.runId !== authority.runId || grant.generation !== authority.generation || !grant.ownership) return false;
    checkOwnershipRef(db, grant.ownership);
    const ref = grant.ownership;
    if (ref.workItemId !== authority.workItemId) return false;
    if (record.owners.some((owner) => canonical(owner.ref) === canonical(ref))) return true;
    return !!db.prepare(`SELECT 1 FROM work_item_owners o JOIN work_items w ON w.id=o.work_item_id
      JOIN execution_handoffs h ON h.id=o.release_handoff_id AND h.task_id=w.task_id
      WHERE w.task_id=? AND o.work_item_id=? AND o.fence=? AND o.revision=? AND o.owner_id=?
        AND o.released_at IS NOT NULL AND h.completed_at IS NOT NULL`).get(record.task.taskId, ref.workItemId, ref.fence, ref.revision, ref.ownerId);
  } catch {
    return false;
  }
}
function readHandoff(db, id2) {
  text(id2);
  const row = db.prepare("SELECT * FROM execution_handoffs WHERE id=?").get(id2);
  if (!row) throw new KddError("handoff not found");
  return row;
}
function handoffRecord(db, row) {
  const snap = JSON.parse(row.snapshot_json);
  const projectId = projectOf(db).project_id;
  return {
    id: row.id,
    commandId: row.command_id,
    task: { projectId, taskId: row.task_id },
    expectedMode: row.expected_mode,
    targetMode: row.target_mode,
    owners: snap.owners,
    authorities: snap.authorities,
    receipt: row.receipt_json === null ? null : JSON.parse(row.receipt_json)
  };
}
function handoff(handle, handoffId) {
  const db = controllerDb(handle);
  return handoffRecord(db, readHandoff(db, handoffId));
}
function beginHandoff(handle, input) {
  const db = controllerDb(handle);
  return db.transaction(() => {
    shape(input, ["commandId", "task", "expectedMode", "targetMode", "expectedOwners"]);
    text(input.commandId);
    mode(input.expectedMode);
    mode(input.targetMode);
    const task = scopedTask(db, input.task);
    if (!Array.isArray(input.expectedOwners)) throw new KddError("invalid owner set");
    input.expectedOwners.forEach((ref) => checkOwnershipRef(db, ref));
    const expected = [...input.expectedOwners].sort((a, b) => a.workItemId.localeCompare(b.workItemId) || a.fence - b.fence);
    const replay = db.prepare("SELECT id FROM execution_handoffs WHERE command_id=?").get(input.commandId);
    if (replay) {
      const prior = handoffRecord(db, readHandoff(db, replay.id));
      if (canonical(prior.task) !== canonical(input.task) || prior.expectedMode !== input.expectedMode || prior.targetMode !== input.targetMode || canonical(prior.owners.map((o) => o.ref)) !== canonical(expected)) throw new KddError("handoff command conflict");
      return prior;
    }
    assertNoHandoff(db, task.id);
    if (task.execution_mode !== input.expectedMode) throw new KddError("execution mode changed");
    if (task.claimed_by !== null) throw new KddError("legacy writer must stop before handoff");
    const snap = snapshot(db, input.task);
    if (canonical(snap.owners.map((o) => o.ref)) !== canonical(expected)) throw new KddError("handoff owner snapshot mismatch");
    const id2 = newId();
    db.prepare("INSERT INTO execution_handoffs(id,command_id,task_id,expected_mode,target_mode,snapshot_json,created_at) VALUES(?,?,?,?,?,?,?)").run(id2, input.commandId, task.id, input.expectedMode, input.targetMode, canonical({ ...snap, projectId: input.task.projectId }), now());
    appendEvent(db, task.id, controllerActor, "execution_handoff_intent", { handoff_id: id2, expected_mode: input.expectedMode, target_mode: input.targetMode, owners: expected });
    return handoffRecord(db, readHandoff(db, id2));
  }).immediate();
}
function stopReason(owner, observation, startedAt) {
  try {
    if (!observation) return "unknown";
    shape(observation, ["observationId", "owner", "launchId", "writerScopeId", "observedAt", "verdict", "complete", "writers"]);
    text(observation.observationId);
    if (canonical(observation.owner) !== canonical(owner.ref) || observation.launchId !== owner.launchIntent.launchId || observation.writerScopeId !== owner.launchIntent.writerScopeId || !Number.isFinite(observation.observedAt) || observation.observedAt < startedAt || observation.observedAt > now()) return "stale_observation";
    if (typeof observation.complete !== "boolean" || !Array.isArray(observation.writers) || !observation.writers.length) return "unknown";
    const ids = /* @__PURE__ */ new Set();
    for (const writer of observation.writers) {
      shape(writer, ["id", "state"]);
      text(writer.id);
      if (ids.has(writer.id)) return "unknown";
      ids.add(writer.id);
      if (!["gone", "alive", "unknown"].includes(writer.state)) return "unknown";
    }
    if (observation.verdict === "live" || observation.writers.some((w) => w.state === "alive")) return "live";
    if (observation.verdict !== "stopped" || !observation.complete || observation.writers.some((w) => w.state !== "gone")) return "unknown";
    return null;
  } catch {
    return "stale_observation";
  }
}
async function finishHandoff(handle, input, observer) {
  const db = controllerDb(handle);
  shape(input, ["handoffId"]);
  const record = handoffRecord(db, readHandoff(db, input.handoffId));
  if (record.receipt) return { status: "complete", receipt: record.receipt };
  const held = (reason) => {
    return db.transaction(() => {
      const current = handoffRecord(db, readHandoff(db, record.id));
      if (current.receipt) return { status: "complete", receipt: current.receipt };
      appendEvent(db, record.task.taskId, controllerActor, "execution_handoff_held", { handoff_id: record.id, reason });
      return { status: "held", handoffId: record.id, reason };
    }).immediate();
  };
  if (record.authorities.some((authority) => !authorityTracked(db, record, authority))) return held("unknown");
  const stops = [];
  for (const owner of record.owners) {
    if (owner.launchIntent === null) {
      stops.push({ owner: owner.ref, outcome: "never_started" });
      continue;
    }
    if (typeof observer !== "function") return held("missing_observer");
    let observation;
    const startedAt = now();
    try {
      observation = await observer(structuredClone(owner));
    } catch {
      return held("observer_error");
    }
    const reason = stopReason(owner, observation, startedAt);
    if (reason) return held(reason);
    stops.push({ owner: owner.ref, outcome: "stopped", observationId: observation.observationId, launchId: owner.launchIntent.launchId, writerScopeId: owner.launchIntent.writerScopeId });
  }
  controllerDb(handle);
  return db.transaction(() => {
    const current = handoffRecord(db, readHandoff(db, record.id));
    if (current.receipt) return { status: "complete", receipt: current.receipt };
    const task = scopedTask(db, record.task), snap = snapshot(db, record.task);
    if (task.execution_mode !== record.expectedMode || task.claimed_by !== null || canonical(snap.owners) !== canonical(record.owners) || canonical(snap.authorities) !== canonical(record.authorities) || record.owners.some((owner) => {
      const item = scopedWorkItem(db, { projectId: owner.ref.projectId, workItemId: owner.ref.workItemId });
      return item.revision !== owner.ref.revision || item.fence !== owner.ref.fence;
    })) return held("snapshot_changed");
    if (record.authorities.some((authority) => !authorityTracked(db, record, authority))) return held("unknown");
    for (const owner of record.owners) db.prepare("UPDATE work_item_owners SET released_at=?,release_handoff_id=? WHERE work_item_id=? AND fence=? AND released_at IS NULL").run(now(), record.id, owner.ref.workItemId, owner.ref.fence);
    const revokedAuthorityIds = [];
    for (const authority of record.authorities) {
      if (db.prepare("SELECT 1 FROM run_authorities WHERE authority_id=? AND revoked_at IS NULL").get(authority.authorityId)) {
        revokeRunAuthority(handle, authority.authorityId);
        revokedAuthorityIds.push(authority.authorityId);
      }
    }
    db.prepare("UPDATE tasks SET execution_mode=?,updated_at=? WHERE id=?").run(record.targetMode, now(), task.id);
    const receipt2 = { handoffId: record.id, task: record.task, mode: record.targetMode, released: record.owners.map((o) => o.ref), revokedAuthorityIds, stops };
    db.prepare("UPDATE execution_handoffs SET completed_at=?,receipt_json=? WHERE id=? AND completed_at IS NULL").run(now(), canonical(receipt2), record.id);
    appendEvent(db, task.id, controllerActor, "execution_handoff_completed", receipt2);
    return { status: "complete", receipt: receipt2 };
  }).immediate();
}
export {
  BUG_BODY_TEMPLATE,
  CAPS,
  DEFAULT_TTL,
  KINDS,
  KddError,
  MAX_FAILED_ATTEMPTS,
  MAX_WORKERS_CAP,
  MIGRATIONS,
  PRIORITIES,
  PRIORITY_ORDER,
  STATUSES,
  TICK_INTERVALS,
  TRANSITIONS,
  _cacheUntil,
  _resetCache,
  addCriterion,
  addDecision,
  addRepository,
  addTask,
  agentId,
  appendAgentEvent,
  appendEvent,
  appendTaskMutationEvent,
  archiveTask,
  assertLegacyDecisionSource,
  assertLegacyTaskMutation,
  assertRunAuthorityBinding,
  assertVerifiedCodexPackage,
  assertWritableRoots,
  attachFile,
  attentionData,
  authorOf,
  beginHandoff,
  bindRepository,
  bindingsOf,
  blockTask,
  boardData,
  canSyncLegacyDecisions,
  canonicalCommonDir,
  canonicalProjectPath,
  capDetail,
  capText,
  checkMove,
  checkRunInputs,
  checkpointWal,
  claimNext,
  claimTask,
  closeDb,
  commentTask,
  compareVersions,
  completeWorkItem,
  contentHash,
  createSubtaskPlan,
  createSubtasks,
  createTrack,
  createWorkItem,
  currentRoleRevision,
  decisionDetail,
  deleteTrack,
  detachFile,
  editTask,
  editTrack,
  endWorkItem,
  ensureWorktree,
  expiredLeases,
  exportBoard,
  filePath,
  filesDir,
  finishHandoff,
  getAutoTick,
  getFile,
  getLastRun,
  getReminded,
  handoff,
  headCommit,
  importMemory,
  initializeProjectStore,
  inspectDependencies,
  invalidateResult,
  isInlineMime,
  issueRunAuthority,
  kddHome,
  kddVersion,
  lastAgentEventKind,
  linkTasks,
  listAgentEvents,
  listCriteria,
  listFiles,
  listMemory,
  listProjectCheckouts,
  listProjects,
  listSubtasks,
  listTracks,
  logError,
  lookupProjectStore,
  manualSessionFromEnv,
  maxWorkers,
  maxWorkersEnvLocked,
  memoryEntry,
  memoryHistory,
  memoryRules,
  moveTask,
  mustGetTask,
  mustGetTrack,
  normalizeSessionId,
  normalizeSourceTasks,
  now,
  observeCodexNative,
  openController,
  openDb,
  openRunContext,
  ownership,
  parseClaudeStreamLine,
  parseDecisionMd,
  parseRepoUrl,
  placeTask,
  preflightCodex,
  prepareRoleLaunch,
  projectOf,
  projectPathOf,
  projectToplevelOf,
  protectTask,
  pruneAgentEvents,
  publishResult,
  readRunContext,
  readRunMemory,
  readSkillFile,
  reapExpired,
  rebindRepository,
  rebuild,
  recall,
  recallMemory,
  recallRunMemory,
  reclaimExpired,
  recordFailedAttempt,
  recordLaunchIntent,
  redact,
  releaseClaim,
  releaseInfo,
  removeCriterion,
  renderDecisionBody,
  renderDecisionMd,
  renewClaim,
  repoSlug,
  repositoriesOf,
  requestRunQuestion,
  reserveWorkItem,
  resolveDbPath,
  resolveDecisionsDir,
  resolveDependencies,
  resolveToplevel,
  result,
  reviseWorkItem,
  revokeRole,
  revokeRunAuthority,
  roleRevision,
  runInputSnapshot,
  runMemoryRules,
  runOperations,
  runProduced,
  sanitizeQuery,
  saveRoleRevision,
  setAutoTick,
  setCriterionChecked,
  setLastRun,
  setProjectToplevel,
  setReminded,
  setWorkItemWaiting,
  slugify,
  spawnCheckedNative,
  spawnCheckedRoleRun,
  statusDigest,
  stopWorkers,
  storeIdentity,
  submitRunReport,
  sweepWorktrees,
  syncIndex,
  syncedTaskDetail,
  taskBranchHead,
  taskBrief,
  taskContractHash,
  taskDetail,
  taskDetailCapped,
  taskWorkItems,
  tick,
  unarchiveTask,
  unblockTask,
  unsubmitted,
  updateDisposition,
  versionChannel,
  withNativeControllerLock,
  workItem,
  worktreePath,
  writeMemory
};
