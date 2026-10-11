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
  // Кап на ЗАПИСЬ: всё выше режет выдачу, этот — то, что вообще ложится в базу.
  fileBytes: 20 * 1024 * 1024
  // потолок вложения: доска личная, но 20 MB картинки хватает всем
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
  `,
  // v19: durable runtime attempts and scoped ownership retirement.
  `
CREATE TABLE work_item_retirements (
  id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, command_hash TEXT NOT NULL,
  work_item_id TEXT NOT NULL, fence INTEGER NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  created_at INTEGER NOT NULL, completed_at INTEGER, receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
  FOREIGN KEY(work_item_id,fence) REFERENCES work_item_owners(work_item_id,fence),
  CHECK((completed_at IS NULL)=(receipt_json IS NULL))
);
CREATE TABLE work_item_owners_v19 (
  work_item_id TEXT NOT NULL, fence INTEGER NOT NULL CHECK(typeof(fence)='integer' AND fence BETWEEN 1 AND 9007199254740991),
  revision INTEGER NOT NULL, owner_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('manual','orchestrated')),
  write_access INTEGER NOT NULL CHECK(write_access IN (0,1)),
  inputs_json TEXT NOT NULL CHECK(json_valid(inputs_json)),
  launch_id TEXT, launch_json TEXT CHECK(launch_json IS NULL OR json_valid(launch_json)),
  created_at INTEGER NOT NULL, released_at INTEGER,
  release_handoff_id TEXT REFERENCES execution_handoffs(id),
  release_retirement_id TEXT REFERENCES work_item_retirements(id),
  PRIMARY KEY(work_item_id,fence),
  FOREIGN KEY(work_item_id,revision) REFERENCES work_item_revisions(work_item_id,revision),
  CHECK((launch_id IS NULL)=(launch_json IS NULL)),
  CHECK((released_at IS NULL AND release_handoff_id IS NULL AND release_retirement_id IS NULL)
    OR (released_at IS NOT NULL AND ((release_handoff_id IS NOT NULL)+(release_retirement_id IS NOT NULL))=1))
);
INSERT INTO work_item_owners_v19 SELECT *,NULL FROM work_item_owners;
DROP TABLE work_item_owners;
ALTER TABLE work_item_owners_v19 RENAME TO work_item_owners;
CREATE UNIQUE INDEX idx_work_item_owners_live ON work_item_owners(work_item_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX idx_work_item_retirement_live ON work_item_retirements(work_item_id,fence) WHERE completed_at IS NULL;
CREATE TABLE runtime_sessions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id INTEGER NOT NULL REFERENCES tasks(id),
  work_item_id TEXT NOT NULL REFERENCES work_items(id), runtime TEXT NOT NULL CHECK(runtime IN ('codex','claude')),
  version TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL,
  semantic_hash TEXT NOT NULL CHECK(length(semantic_hash)=64 AND semantic_hash NOT GLOB '*[^0-9a-f]*'),
  provider_session_id TEXT, created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_runtime_provider_session ON runtime_sessions(runtime,provider_session_id) WHERE provider_session_id IS NOT NULL;
CREATE TABLE runtime_attempts (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES runtime_sessions(id),
  command_id TEXT NOT NULL UNIQUE, command_hash TEXT NOT NULL,
  work_item_id TEXT NOT NULL, fence INTEGER NOT NULL, revision INTEGER NOT NULL, owner_id TEXT NOT NULL,
  authority_id TEXT NOT NULL UNIQUE REFERENCES run_authorities(authority_id), run_id TEXT NOT NULL, generation INTEGER NOT NULL,
  input_hash TEXT NOT NULL CHECK(length(input_hash)=64 AND input_hash NOT GLOB '*[^0-9a-f]*'),
  phase TEXT NOT NULL CHECK(phase IN ('start','resume')), limits_json TEXT NOT NULL CHECK(json_valid(limits_json)),
  writer_scope_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('created','running','waiting','completed','failed','cancelled')),
  reason TEXT, pid INTEGER, process_json TEXT CHECK(process_json IS NULL OR json_valid(process_json)),
  created_at INTEGER NOT NULL, stop_intent_at INTEGER, terminal_json TEXT CHECK(terminal_json IS NULL OR json_valid(terminal_json)),
  exit_json TEXT CHECK(exit_json IS NULL OR json_valid(exit_json)),
  writers_stopped INTEGER NOT NULL DEFAULT 0 CHECK(writers_stopped IN (0,1)), ended_at INTEGER,
  FOREIGN KEY(work_item_id,fence) REFERENCES work_item_owners(work_item_id,fence),
  FOREIGN KEY(work_item_id,revision) REFERENCES work_item_revisions(work_item_id,revision),
  UNIQUE(work_item_id,run_id,generation),
  CHECK(ended_at IS NULL OR (writers_stopped=1 AND state IN ('completed','failed','cancelled')))
);
CREATE UNIQUE INDEX idx_runtime_session_active ON runtime_attempts(session_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX idx_runtime_work_active ON runtime_attempts(work_item_id) WHERE ended_at IS NULL;
CREATE TABLE runtime_events (
  attempt_id TEXT NOT NULL REFERENCES runtime_attempts(id), sequence INTEGER NOT NULL CHECK(sequence>0),
  kind TEXT NOT NULL CHECK(kind IN ('session','attempt_start','text','tool_start','tool_finish','usage','error','provider_terminal','host_stop','attempt_end')),
  detail_json TEXT NOT NULL CHECK(json_valid(detail_json)), created_at INTEGER NOT NULL,
  PRIMARY KEY(attempt_id,sequence)
);
CREATE TRIGGER runtime_events_no_update BEFORE UPDATE ON runtime_events
BEGIN SELECT RAISE(ABORT,'immutable runtime event'); END;
CREATE TRIGGER runtime_events_no_delete BEFORE DELETE ON runtime_events
BEGIN SELECT RAISE(ABORT,'immutable runtime event'); END;
CREATE TRIGGER runtime_sessions_identity BEFORE UPDATE OF id,project_id,task_id,work_item_id,runtime,version,model,effort,semantic_hash,created_at ON runtime_sessions
BEGIN SELECT RAISE(ABORT,'immutable runtime session'); END;
CREATE TRIGGER runtime_session_binding BEFORE UPDATE OF provider_session_id ON runtime_sessions
WHEN OLD.provider_session_id IS NOT NULL AND NEW.provider_session_id IS NOT OLD.provider_session_id
BEGIN SELECT RAISE(ABORT,'immutable provider session'); END;
CREATE TRIGGER runtime_sessions_no_delete BEFORE DELETE ON runtime_sessions
BEGIN SELECT RAISE(ABORT,'immutable runtime session'); END;
CREATE TRIGGER runtime_attempt_identity BEFORE UPDATE OF id,session_id,command_id,command_hash,work_item_id,fence,revision,owner_id,
  authority_id,run_id,generation,input_hash,phase,limits_json,writer_scope_id,created_at ON runtime_attempts
BEGIN SELECT RAISE(ABORT,'immutable runtime attempt identity'); END;
CREATE TRIGGER runtime_attempt_terminal BEFORE UPDATE ON runtime_attempts WHEN OLD.ended_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'immutable runtime outcome'); END;
CREATE TRIGGER runtime_attempt_no_delete BEFORE DELETE ON runtime_attempts
BEGIN SELECT RAISE(ABORT,'immutable runtime attempt'); END;
CREATE TRIGGER retirement_identity BEFORE UPDATE OF id,command_id,command_hash,work_item_id,fence,snapshot_json,created_at ON work_item_retirements
BEGIN SELECT RAISE(ABORT,'immutable retirement identity'); END;
CREATE TRIGGER retirement_terminal BEFORE UPDATE ON work_item_retirements WHEN OLD.completed_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'immutable retirement receipt'); END;
CREATE TRIGGER retirement_no_delete BEFORE DELETE ON work_item_retirements
BEGIN SELECT RAISE(ABORT,'immutable retirement'); END;
  `,
  // v20: оркестратор и tick вырезаны (#173). Таблицы пустые на всех живых досках (2026-10-11).
  // Порядок DROP — от потомков к родителям: foreign_keys=ON, DROP родителя делает неявный DELETE.
  // Но owners → retirements → owners — цикл, порядком его не развязать: проверка FK откладывается
  // до коммита (pragma сбрасывается сама на коммите), а к коммиту обе таблицы уже снесены.
  // Схема на выходе та же — живые доски, прошедшие v20 без этой строки, ничем не отличаются.
  `PRAGMA defer_foreign_keys = ON;
DROP TABLE runtime_events; DROP TABLE runtime_attempts; DROP TABLE runtime_sessions;
DROP TABLE work_item_retirements; DROP TABLE execution_handoffs; DROP TABLE work_item_owners;
DROP TABLE work_item_results; DROP TABLE work_item_dependencies; DROP TABLE work_item_revisions;
DROP TABLE work_items; DROP TABLE run_input_snapshots; DROP TABLE run_authorities;
DROP TABLE managed_task_policy; DROP TABLE memory_revisions; DROP TABLE memory_entries;
DROP TABLE role_skill_files; DROP TABLE role_revisions; DROP TABLE role_profiles;
DROP TABLE agent_events; DROP INDEX idx_memory_import_commands;
ALTER TABLE tasks DROP COLUMN execution_mode;
ALTER TABLE tasks DROP COLUMN failed_attempts;
ALTER TABLE repositories DROP COLUMN access;
ALTER TABLE project DROP COLUMN autonomy_enabled;
ALTER TABLE project DROP COLUMN default_execution_mode;
-- kind \u0434\u0435\u0440\u0436\u0438\u0442 CHECK('source','managed'): DROP COLUMN \u0435\u0433\u043E \u043D\u0435 \u0441\u043D\u0438\u043C\u0435\u0442, \u043F\u043E\u044D\u0442\u043E\u043C\u0443 \u043F\u0435\u0440\u0435\u0441\u0431\u043E\u0440\u043A\u0430.
-- managed-\u0441\u0442\u0440\u043E\u043A\u0438 \u0441\u043E\u0445\u0440\u0430\u043D\u044F\u044E\u0442\u0441\u044F: \u044D\u0442\u043E \u043F\u0440\u043E\u0441\u0442\u043E \u0435\u0449\u0451 \u043E\u0434\u0438\u043D \u0447\u0435\u043A\u0430\u0443\u0442 \u0442\u043E\u0433\u043E \u0436\u0435 \u0440\u0435\u043F\u043E.
CREATE TABLE repository_bindings_v20 (
  common_dir TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(repo_id),
  checkout_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
INSERT INTO repository_bindings_v20 SELECT common_dir, repo_id, checkout_path, created_at FROM repository_bindings;
DROP TABLE repository_bindings;
ALTER TABLE repository_bindings_v20 RENAME TO repository_bindings;
CREATE INDEX idx_repository_bindings_repo ON repository_bindings(repo_id);
  `
];

// src/project_store.ts
function projectOf(db) {
  return db.prepare("SELECT project_id,primary_repo_id,legacy_decisions_dir,created_at FROM project WHERE singleton=1").get();
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
      db.prepare("INSERT INTO repositories VALUES(?,?,NULL,?)").run(repoId, "primary", time());
      db.prepare("INSERT INTO repository_bindings VALUES(?,?,?,?)").run(common, repoId, paths[0], time());
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
function checkoutBinding(cwd, repoId) {
  return {
    common_dir: canonicalCommonDir(cwd),
    repo_id: repoId,
    checkout_path: realpathSync(git(cwd, ["rev-parse", "--show-toplevel"])),
    created_at: time()
  };
}
function insertBinding(db, binding) {
  db.prepare("INSERT INTO repository_bindings VALUES(@common_dir,@repo_id,@checkout_path,@created_at)").run(binding);
}
function primarySource(db) {
  const source = meta(db, "project_path");
  if (!source) return void 0;
  const primary = projectOf(db).primary_repo_id;
  const p = canonicalProjectPath(source);
  const bindings = bindingsOf(db).filter((b) => b.repo_id === primary);
  const direct = bindings.find((b) => b.common_dir === p || b.checkout_path === p);
  if (direct) return direct;
  let common;
  try {
    if (!existsSync(p)) return void 0;
    common = canonicalCommonDir(p);
  } catch {
    return void 0;
  }
  return bindings.find((b) => b.common_dir === common);
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
  const binding = checkoutBinding(input.cwd, input.repoId);
  return withRegistry(home, (registry) => registry.transaction(() => {
    assertAvailable(registry, binding.common_dir, home, dbPath, projectOf(db).project_id, input.repoId);
    const existing = bindingsOf(db).find((b) => b.common_dir === binding.common_dir);
    if (existing && existing.repo_id !== input.repoId) throw new KddError("repository binding conflict");
    const result = existing ?? db.transaction(() => {
      insertBinding(db, binding);
      audit(db, actor, "repository_bound", binding);
      return binding;
    }).immediate();
    locateBinding(registry, db, dbPath, result);
    return result;
  }).immediate());
}
function addRepository(db, dbPath, home, input, actor) {
  if (!input.purpose?.trim()) throw new KddError("repository purpose must not be empty");
  if (!projectOf(db).primary_repo_id) throw new KddError("restore the primary source before adding a repository");
  const binding = checkoutBinding(input.cwd, id());
  return withRegistry(home, (registry) => registry.transaction(() => {
    assertAvailable(registry, binding.common_dir, home, dbPath, projectOf(db).project_id);
    const existing = bindingsOf(db).find((b) => b.common_dir === binding.common_dir);
    const repository = existing ? repositoriesOf(db).find((r) => r.repo_id === existing.repo_id) : {
      repo_id: binding.repo_id,
      purpose: input.purpose.trim(),
      remote: null,
      created_at: time()
    };
    if (existing && repository.purpose !== input.purpose.trim()) throw new KddError("repository binding conflict");
    if (!existing) db.transaction(() => {
      db.prepare("INSERT INTO repositories VALUES(@repo_id,@purpose,@remote,@created_at)").run(repository);
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
    const binding = repeated ? existing : checkoutBinding(input.cwd, repoId);
    const wasSource = !!previous && primarySource(db)?.common_dir === previous.common_dir;
    catalogStore(db, dbPath, home);
    if (!repeated && oldPath !== newCommon) db.transaction(() => {
      if (!previous) {
        db.prepare("INSERT INTO repositories VALUES(?,?,NULL,?)").run(repoId, "primary", time());
        db.prepare("UPDATE project SET primary_repo_id=? WHERE singleton=1").run(repoId);
      } else db.prepare("DELETE FROM repository_bindings WHERE common_dir=?").run(oldPath);
      insertBinding(db, binding);
      if (wasSource || !project.primary_repo_id) {
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
  const source = primarySource(db);
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
    return source?.common_dir === common;
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
      if (primarySource(db)?.common_dir !== common) return;
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
  const registered = lookupProjectStore(realpathSync2(common), kddHome());
  if (registered) return registered;
  const hash = createHash("sha256").update(common).digest("hex").slice(0, 16);
  return { dbPath: join3(kddHome(), hash, "kdd.db"), projectPath: common };
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
    throw new KddError("not in a git repository (kdd resolves the checkout via git)");
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
      const row = db.prepare(`SELECT value FROM meta WHERE key = 'project_path'`).get();
      db.close();
      out.push({ dbPath, projectPath: row?.value ?? "(unknown)" });
    } catch {
    }
  }
  return out;
}

// src/state.ts
var STATUSES = ["backlog", "new", "in_progress", "review", "done"];
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

// src/ops.ts
import { execFileSync as execFileSync3 } from "child_process";

// src/redact.ts
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
  // агент цитирует в комментарии. Редакция стоит ДО записи, то есть портила бы текст навсегда:
  // читающий не отличил бы аннотацию типа от секрета. Двоеточие ушло
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
  const git2 = (args) => {
    try {
      return execFileSync3("git", args, {
        cwd: session.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim() || void 0;
    } catch {
      return void 0;
    }
  };
  const worktree = git2(["rev-parse", "--show-toplevel"]);
  const branch = worktree ? git2(["symbolic-ref", "--quiet", "--short", "HEAD"]) : void 0;
  const head = worktree ? git2(["rev-parse", "--verify", "HEAD"]) : void 0;
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
      `INSERT INTO tasks (title, body, priority, kind, area, track_id, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.title,
      input.body ?? null,
      priority,
      kind,
      input.area ?? null,
      input.track_id ?? null,
      nextPosition(db, "new"),
      ts,
      ts
    );
    const id2 = Number(r.lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO criteria (task_id, text, position, created_at) VALUES (?, ?, ?, ?)`
    );
    (input.criteria ?? []).forEach((text, i) => ins.run(id2, text, i, ts));
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
    mustGetTask(db, id2);
    const sets = fields.map((f) => `${f} = ?`).join(", ");
    db.prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`).run(...fields.map((f) => patch[f]), now(), id2);
    appendTaskMutationEvent(db, id2, actor, "edited", { fields });
    return mustGetTask(db, id2);
  }).immediate();
}
function commentTask(db, id2, body, actor) {
  if (!body.trim()) throw new KddError("comment must not be empty");
  const text = actor.type === "ai" ? redact(body) : body;
  return db.transaction(() => {
    mustGetTask(db, id2);
    const r = db.prepare(
      `INSERT INTO comments (task_id, author, body, created_at) VALUES (?, ?, ?, ?)`
    ).run(id2, authorOf(actor), text, now());
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
    const t = mustGetTask(db, id2);
    const submitter = t.status === "review" ? submittedBy(db, id2) : null;
    const res = checkMove(t.status, to, actor, reason, openCriteria(db, id2), t.claimed_by, submitter);
    if (!res.ok) throw new KddError(res.error);
    const self = t.status === "review" && to === "done" && submitter === authorOf(actor);
    const leaving = t.status === "in_progress" && to !== "in_progress";
    db.prepare(
      `UPDATE tasks SET status = ?, position = ?, updated_at = ?${leaving ? ", claimed_by = NULL, claim_expires = NULL" : ""}
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
    db.prepare(
      `UPDATE tasks SET status = ?, updated_at = ?${leaving ? ", claimed_by = NULL, claim_expires = NULL" : ""}
       WHERE id = ?`
    ).run(to, now(), id2);
    return mustGetTask(db, id2);
  }).immediate();
}
function blockTask(db, id2, reason, actor) {
  if (!reason.trim()) throw new KddError("block reason must not be empty");
  return db.transaction(() => {
    mustGetTask(db, id2);
    db.prepare(`UPDATE tasks SET blocked = 1, block_reason = ?, updated_at = ? WHERE id = ?`).run(reason, now(), id2);
    appendTaskMutationEvent(db, id2, actor, "blocked", { reason });
    return mustGetTask(db, id2);
  }).immediate();
}
function unblockTask(db, id2, actor) {
  return db.transaction(() => {
    mustGetTask(db, id2);
    db.prepare(`UPDATE tasks SET blocked = 0, block_reason = NULL, updated_at = ? WHERE id = ?`).run(now(), id2);
    appendTaskMutationEvent(db, id2, actor, "unblocked");
    return mustGetTask(db, id2);
  }).immediate();
}
function linkTasks(db, fromId, toId, kind, actor) {
  db.transaction(() => {
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
    mustGetTask(db, id2);
    db.prepare(`UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?`).run(now(), now(), id2);
    appendTaskMutationEvent(db, id2, actor, "archived");
    return mustGetTask(db, id2);
  }).immediate();
}
function unarchiveTask(db, id2, actor) {
  return db.transaction(() => {
    mustGetTask(db, id2);
    db.prepare(`UPDATE tasks SET archived_at = NULL, updated_at = ? WHERE id = ?`).run(now(), id2);
    appendTaskMutationEvent(db, id2, actor, "unarchived");
    return mustGetTask(db, id2);
  }).immediate();
}

// src/criteria.ts
function listCriteria(db, taskId) {
  return db.prepare(
    `SELECT * FROM criteria WHERE task_id = ? ORDER BY position, id`
  ).all(taskId);
}
function mustGetCriterion(db, taskId, id2) {
  const c = db.prepare(`SELECT * FROM criteria WHERE id = ?`).get(id2);
  if (!c || c.task_id !== taskId) throw new KddError(`criterion #${id2} not found on task #${taskId}`);
  return c;
}
var touchTask = (db, taskId) => {
  db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(now(), taskId);
};
function addCriterion(db, taskId, text, actor) {
  if (!text.trim()) throw new KddError("criterion text must not be empty");
  return db.transaction(() => {
    mustGetTask(db, taskId);
    const pos = db.prepare(
      `SELECT COALESCE(MAX(position), -1) + 1 AS p FROM criteria WHERE task_id = ?`
    ).get(taskId).p;
    const r = db.prepare(
      `INSERT INTO criteria (task_id, text, position, created_at) VALUES (?, ?, ?, ?)`
    ).run(taskId, text, pos, now());
    const id2 = Number(r.lastInsertRowid);
    appendTaskMutationEvent(db, taskId, actor, "criterion_added", { id: id2, text });
    touchTask(db, taskId);
    return mustGetCriterion(db, taskId, id2);
  }).immediate();
}
function setCriterionChecked(db, taskId, id2, checked, actor, evidence) {
  return db.transaction(() => {
    const c = mustGetCriterion(db, taskId, id2);
    const proof = evidence?.trim();
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
import { createHash as createHash2 } from "crypto";
import {
  existsSync as existsSync3,
  mkdirSync as mkdirSync3,
  readFileSync as readFileSync2,
  renameSync as renameSync3,
  rmSync as rmSync3,
  statSync,
  writeFileSync as writeFileSync2
} from "fs";
import { basename as basename2, dirname as dirname3, extname, join as join4 } from "path";
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
  return join4(dirname3(dbPath), "files");
};
var filePath = (dbPath, f) => join4(filesDir(dbPath), `${f.sha256}.${f.ext}`);
function listFiles(db, taskId) {
  return db.prepare(`SELECT * FROM files WHERE task_id = ? ORDER BY id`).all(taskId);
}
function getFile(db, id2) {
  return db.prepare(`SELECT * FROM files WHERE id = ?`).get(id2);
}
function attachFile(db, dbPath, taskId, srcPath, opts, actor) {
  return db.transaction(() => {
    let data;
    try {
      const stat = statSync(srcPath);
      if (stat.isDirectory()) throw new KddError(`${srcPath} is a directory`);
      if (stat.size > CAPS.fileBytes) {
        throw new KddError(`file is ${stat.size} bytes, the limit is ${CAPS.fileBytes}`);
      }
      data = readFileSync2(srcPath);
    } catch (e) {
      if (e instanceof KddError) throw e;
      throw new KddError(`cannot read ${srcPath}: ${e.message}`);
    }
    mustGetTask(db, taskId);
    const sha256 = createHash2("sha256").update(data).digest("hex");
    const ext = (extname(srcPath).slice(1) || "bin").toLowerCase();
    const target = join4(filesDir(dbPath), `${sha256}.${ext}`);
    if (!existsSync3(target)) {
      mkdirSync3(filesDir(dbPath), { recursive: true });
      const tmp = `${target}.${process.pid}.tmp`;
      writeFileSync2(tmp, data);
      renameSync3(tmp, target);
    }
    const name = capText(basename2(srcPath), CAPS.fileNameChars);
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
    db.prepare(`DELETE FROM files WHERE id = ?`).run(fileId);
    appendTaskMutationEvent(db, f.task_id, actor, "file_detached", { id: fileId, name: f.original_name });
    db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(now(), f.task_id);
    const left = db.prepare(`SELECT COUNT(*) AS c FROM files WHERE sha256 = ? AND ext = ?`).get(f.sha256, f.ext).c;
    if (left === 0) rmSync3(filePath(dbPath, f), { force: true });
  }).immediate();
}

// src/decisions.ts
import { createHash as createHash3 } from "crypto";
import { existsSync as existsSync4, mkdirSync as mkdirSync4, readFileSync as readFileSync3, readdirSync as readdirSync3, realpathSync as realpathSync3, writeFileSync as writeFileSync3 } from "fs";
import { dirname as dirname4, join as join5 } from "path";
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
  const text = raw.replace(/\r\n/g, "\n");
  const fm = {};
  let rest = text;
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---\n", 4);
    if (end !== -1) {
      for (const line of text.slice(4, end).split("\n")) {
        const m = line.match(/^(\w+):\s*(.*)$/);
        if (m) fm[m[1]] = m[2].trim();
      }
      rest = text.slice(end + 5);
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
  const p = join5(dir, `${oldSlug}.md`);
  if (!existsSync4(p)) throw new KddError(`decision '${oldSlug}' not found`);
  assertLegacyDecisionSource(db, dirname4(realpathSync3(p)));
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
  writeFileSync3(p, raw);
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
  const hash = contentHash(input.title, body);
  const provenance = JSON.stringify(sourceTasks);
  let fileDup;
  if (existsSync4(decisionsDir)) {
    for (const file of readdirSync3(decisionsDir).filter((name) => name.endsWith(".md")).sort()) {
      const path2 = join5(decisionsDir, file);
      assertLegacyDecisionSource(db, dirname4(realpathSync3(path2)));
      const doc = parseDecisionMd(readFileSync3(path2, "utf8"));
      if (doc.hash !== hash) continue;
      const slug2 = file.slice(0, -3);
      if (JSON.stringify(doc.sourceTasks) !== provenance) {
        throw new KddError(`decision '${slug2}' provenance mismatch`);
      }
      fileDup ??= { slug: slug2, path: path2 };
    }
  }
  if (fileDup) return { ...fileDup, created: false };
  const dup = db.prepare(`SELECT slug, path FROM decisions WHERE content_hash = ?`).get(hash);
  if (dup) {
    assertLegacyDecisionSource(db, dirname4(realpathSync3(dup.path)));
    const existing = parseDecisionMd(readFileSync3(dup.path, "utf8")).sourceTasks;
    if (JSON.stringify(existing) !== provenance) {
      throw new KddError(`decision '${dup.slug}' provenance mismatch`);
    }
    return { slug: dup.slug, path: dup.path, created: false };
  }
  const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const base = `${date}-${slugify(input.title)}`;
  let slug = base;
  const taken = (s) => existsSync4(join5(decisionsDir, `${s}.md`)) || !!db.prepare(`SELECT 1 FROM decisions WHERE slug = ?`).get(s);
  for (let i = 2; taken(slug); i++) slug = `${base}-${i}`;
  const path = join5(decisionsDir, `${slug}.md`);
  return db.transaction(() => {
    if (input.supersedes) supersede(db, decisionsDir, input.supersedes, slug);
    mkdirSync4(decisionsDir, { recursive: true });
    writeFileSync3(path, renderDecisionMd({ ...input, sourceTasks }, date));
    db.prepare(
      `INSERT INTO decisions (slug, title, path, content_hash, created, superseded_by, source_tasks)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`
    ).run(slug, input.title.trim(), path, hash, date, provenance);
    db.prepare(
      `INSERT INTO search_index (kind, ref, title, body) VALUES ('decision', ?, ?, ?)`
    ).run(slug, input.title.trim(), body);
    return { slug, path, created: true };
  })();
}

// src/recall.ts
import { existsSync as existsSync5, readFileSync as readFileSync4, readdirSync as readdirSync4, realpathSync as realpathSync4 } from "fs";
import { dirname as dirname5, join as join6 } from "path";
function syncIndex(db, decisionsDir) {
  db.transaction(() => {
    if (canSyncLegacyDecisions(db, decisionsDir)) {
      const files = existsSync5(decisionsDir) ? readdirSync4(decisionsDir).filter((f) => f.endsWith(".md")) : [];
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
        if (!canSyncLegacyDecisions(db, dirname5(realpathSync4(path)))) continue;
        const doc = parseDecisionMd(readFileSync4(path, "utf8"));
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
  if (existsSync5(decisionsDir)) for (const name of readdirSync4(decisionsDir).filter((f) => f.endsWith(".md"))) {
    assertLegacyDecisionSource(db, dirname5(realpathSync4(join6(decisionsDir, name))));
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

// src/queries.ts
import { existsSync as existsSync6, readFileSync as readFileSync5, realpathSync as realpathSync5 } from "fs";
import { dirname as dirname6 } from "path";
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
var READY_SQL = `(status = 'new' AND blocked = 0 AND archived_at IS NULL AND kind <> 'research')`;
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
  const trusted = canSyncLegacyDecisions(db, decisionsDir) && existsSync6(row.path) && canSyncLegacyDecisions(db, dirname6(realpathSync5(row.path)));
  const cached = trusted ? void 0 : db.prepare("SELECT body FROM search_index WHERE kind='decision' AND ref=?").get(slug);
  if (!trusted && !cached) throw new KddError(`decision '${slug}' has no indexed body`);
  const doc = trusted ? parseDecisionMd(readFileSync5(row.path, "utf8")) : {
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
        (SELECT MAX(e.id) FROM events e
          WHERE e.task_id = t.id AND e.action = 'moved'
            AND e.detail LIKE '%"to":"review"%') AS last_review_id
      FROM tasks t
      WHERE t.archived_at IS NULL AND t.status <> 'done'
    ), classified AS (
      SELECT f.*,
        CASE
          WHEN f.blocked = 1 AND substr(f.block_reason, 1, 12) = 'needs human:' THEN 'needs_input'
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
    const redacted = JSON.stringify(value, (_key, text) => {
      if (typeof text !== "string") return text;
      const safe = redact(text);
      if (safe !== text) changed = true;
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
    const snapshot = {
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
    return opts.includeSensitive ? snapshot : JSON.parse(JSON.stringify(
      snapshot,
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
function assertTtl(ttl) {
  if (!Number.isFinite(ttl) || ttl <= 0) throw new KddError(`invalid ttl '${ttl}' (seconds > 0)`);
}
var criteriaCount = (db, id2) => db.prepare(`SELECT COUNT(*) c FROM criteria WHERE task_id = ?`).get(id2).c;
function claimTask(db, id2, actor, ttl = DEFAULT_TTL) {
  assertTtl(ttl);
  return db.transaction(() => {
    let t = mustGetTask(db, id2);
    if (t.status === "in_progress" && t.claim_expires !== null && t.claim_expires < now()) {
      db.prepare(`UPDATE tasks SET status='new', claimed_by=NULL, claim_expires=NULL, updated_at=? WHERE id=?`).run(now(), id2);
      appendEvent(db, id2, SYSTEM, "reclaimed", { former: t.claimed_by }, { type: "claim", level: "warn" });
      t = mustGetTask(db, id2);
    }
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
       WHERE id=? AND status='new' AND blocked=0 AND archived_at IS NULL AND claimed_by IS NULL`
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
function renewClaim(db, id2, actor, ttl = DEFAULT_TTL) {
  assertTtl(ttl);
  return db.transaction(() => {
    const expires = now() + ttl;
    const r = db.prepare(
      `UPDATE tasks SET claim_expires=?, updated_at=? WHERE id=? AND claimed_by=? AND (claim_expires IS NULL OR claim_expires >= ?)`
    ).run(expires, now(), id2, authorOf(actor), now());
    if (r.changes !== 1) {
      return {
        ok: false,
        error: `#${id2} not held by ${authorOf(actor)} (lease lost or reclaimed) \u2014 stop work`
      };
    }
    appendEvent(db, id2, actor, "claim_renewed", { ttl, expires }, { type: "claim" });
    return { ok: true, task: mustGetTask(db, id2) };
  }).immediate();
}

// src/release.ts
import { readFileSync as readFileSync6 } from "fs";
import { join as join7 } from "path";
var pkgCache = null;
function pkg() {
  if (pkgCache) return pkgCache;
  try {
    pkgCache = JSON.parse(
      readFileSync6(join7(import.meta.dirname, "../package.json"), "utf8")
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
function readMeta(db, key) {
  return db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key)?.value;
}
function writeMeta(db, key, value) {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}
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
import { existsSync as existsSync7, readFileSync as readFileSync7, readdirSync as readdirSync5, realpathSync as realpathSync6 } from "fs";
import { dirname as dirname7, join as join8 } from "path";
var lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function readTaskDecisions(db, decisionsDir, taskId) {
  if (!canSyncLegacyDecisions(db, decisionsDir)) {
    return db.prepare("SELECT slug,title,created,superseded_by,source_tasks FROM decisions ORDER BY slug").all().filter((row) => JSON.parse(row.source_tasks).includes(taskId)).map(({ source_tasks, ...row }) => ({ ...row, title: capText(row.title, CAPS.titleChars) }));
  }
  if (!existsSync7(decisionsDir)) return [];
  return readdirSync5(decisionsDir).filter((file) => file.endsWith(".md")).flatMap((file) => {
    const slug = file.slice(0, -3);
    if (!canSyncLegacyDecisions(db, dirname7(realpathSync6(join8(decisionsDir, file))))) return [];
    const decision = parseDecisionMd(readFileSync7(join8(decisionsDir, file), "utf8"));
    if (!decision.sourceTasks.includes(taskId)) return [];
    return [{
      slug,
      title: capText(decision.title || slug, CAPS.titleChars),
      created: decision.created || null,
      superseded_by: decision.status === "superseded" ? decision.supersededBy || "?" : decision.supersededBy || null
    }];
  });
}
function nextAction(task, criteria) {
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
function fitBrief(brief, sources) {
  if (briefBytes(brief) <= CAPS.briefBytes) return brief;
  drain(brief, brief.events);
  drain(brief, brief.comments);
  drain(brief, brief.files);
  drain(brief, brief.links);
  drain(brief, brief.decisions);
  drain(brief, brief.handoffs);
  for (const field of ["worktree", "branch"]) {
    if (briefBytes(brief) > CAPS.briefBytes && brief.manual_provenance?.[field]) delete brief.manual_provenance[field];
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
    parent_id: detail.task.parent_id
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
  const action = nextAction(task, projectedCriteria.items);
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
    next_action: action,
    budget: { max_bytes: CAPS.briefBytes }
  };
  return fitBrief(brief, {
    block_reason: detail.task.block_reason,
    goal: detail.task.body,
    next_action: actionSource,
    area: detail.task.area,
    title: detail.task.title
  });
}
export {
  BUG_BODY_TEMPLATE,
  CAPS,
  DEFAULT_TTL,
  KINDS,
  KddError,
  MIGRATIONS,
  PRIORITIES,
  PRIORITY_ORDER,
  STATUSES,
  TRANSITIONS,
  _cacheUntil,
  _resetCache,
  addCriterion,
  addDecision,
  addRepository,
  addTask,
  agentId,
  appendEvent,
  appendTaskMutationEvent,
  archiveTask,
  assertLegacyDecisionSource,
  attachFile,
  attentionData,
  authorOf,
  bindRepository,
  bindingsOf,
  blockTask,
  boardData,
  canSyncLegacyDecisions,
  canonicalCommonDir,
  canonicalProjectPath,
  capText,
  checkMove,
  checkpointWal,
  claimTask,
  closeDb,
  commentTask,
  compareVersions,
  contentHash,
  createTrack,
  decisionDetail,
  deleteTrack,
  detachFile,
  editTask,
  editTrack,
  exportBoard,
  filePath,
  filesDir,
  getFile,
  getReminded,
  initializeProjectStore,
  isInlineMime,
  kddHome,
  kddVersion,
  linkTasks,
  listCriteria,
  listFiles,
  listProjectCheckouts,
  listProjects,
  listTracks,
  logError,
  lookupProjectStore,
  manualSessionFromEnv,
  moveTask,
  mustGetTask,
  mustGetTrack,
  normalizeSessionId,
  normalizeSourceTasks,
  now,
  openDb,
  parseDecisionMd,
  parseRepoUrl,
  placeTask,
  primarySource,
  projectOf,
  projectPathOf,
  projectToplevelOf,
  rebindRepository,
  rebuild,
  recall,
  redact,
  releaseInfo,
  removeCriterion,
  renderDecisionBody,
  renderDecisionMd,
  renewClaim,
  repoSlug,
  repositoriesOf,
  resolveDbPath,
  resolveDecisionsDir,
  resolveToplevel,
  sanitizeQuery,
  setCriterionChecked,
  setProjectToplevel,
  setReminded,
  slugify,
  statusDigest,
  storeIdentity,
  syncIndex,
  syncedTaskDetail,
  taskBrief,
  taskDetail,
  taskDetailCapped,
  unarchiveTask,
  unblockTask,
  unsubmitted,
  updateDisposition,
  versionChannel
};
