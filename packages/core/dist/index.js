// src/caps.ts
var CAPS = {
  boardRows: 8,
  // строк на колонку в CLI board (контракт ≤4KB, cyrillic ×2 байта)
  listRows: 20,
  // строк на колонку в MCP list_tasks (Claude, без байт-бюджета)
  statusRows: 5,
  // строк на секцию kdd status
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
  recallK: 10,
  // дефолтный top-k
  recallKMax: 50,
  // потолок k — больше не отдаём никому
  recallSnippetTokens: 12,
  recallBytes: 4096,
  // бюджет текстовой выдачи kdd recall
  recallTitleChars: 60,
  trackDescChars: 200
};
function capText(s, n) {
  if (s.length <= n) return s;
  const cut = n - ((s.charCodeAt(n - 1) & 64512) === 55296 ? 1 : 0);
  return `${s.slice(0, cut)}\u2026 [+${s.length - cut} chars]`;
}

// src/db.ts
import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";
var now = () => Math.floor(Date.now() / 1e3);
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
  `
];
function openDb(dbPath, projectPath) {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  const from = db.pragma("user_version", { simple: true });
  for (let i = from; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
  if (from === 0 && projectPath) {
    db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('project_path', ?)`).run(projectPath);
  }
  return db;
}

// src/errors.ts
var KddError = class extends Error {
};
function logError(db, source, message) {
  db.prepare(`INSERT INTO errors (source, message, created_at) VALUES (?, ?, ?)`).run(source, message, now());
}

// src/paths.ts
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import Database2 from "better-sqlite3";
var kddHome = () => process.env.KDD_HOME ?? join(homedir(), ".kdd");
function resolveDbPath(cwd = process.cwd()) {
  if (process.env.KDD_DB) return { dbPath: process.env.KDD_DB, projectPath: cwd };
  let common;
  try {
    common = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
  } catch {
    throw new KddError("not in a git repository (kdd resolves its store via git)");
  }
  const hash = createHash("sha256").update(common).digest("hex").slice(0, 16);
  return { dbPath: join(kddHome(), hash, "kdd.db"), projectPath: common };
}
function resolveDecisionsDir(cwd = process.cwd()) {
  if (process.env.KDD_DECISIONS_DIR) return process.env.KDD_DECISIONS_DIR;
  let top;
  try {
    top = execFileSync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
  } catch {
    throw new KddError("not in a git repository (kdd resolves .planning via git)");
  }
  return join(top, ".planning", "decisions");
}
function resolveToplevel(cwd = process.cwd()) {
  if (process.env.KDD_TOPLEVEL) return process.env.KDD_TOPLEVEL;
  try {
    return execFileSync(
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
  if (!existsSync(home)) return [];
  const out = [];
  for (const entry of readdirSync(home, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dbPath = join(home, entry.name, "kdd.db");
    if (!existsSync(dbPath)) continue;
    try {
      const db = new Database2(dbPath, { readonly: true });
      const row = db.prepare(`SELECT value FROM meta WHERE key='project_path'`).get();
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
var TRANSITIONS = {
  backlog: ["new"],
  new: ["backlog", "in_progress"],
  in_progress: ["new", "review"],
  review: ["in_progress", "done"],
  done: ["review"]
};
function checkMove(from, to, actor, reason, openCriteria2 = 0, claimedBy = null) {
  if (from === to) return { ok: false, error: `task is already in ${to}` };
  if (actor.type === "user") return { ok: true };
  if (reason) return { ok: true };
  if (from === "in_progress" && claimedBy?.startsWith("ai:") && claimedBy !== `ai:${actor.id ?? "?"}`) {
    return {
      ok: false,
      error: `lease lost (held by ${claimedBy}); you no longer own this task \u2014 stop work`
    };
  }
  if (!TRANSITIONS[from].includes(to)) {
    return {
      ok: false,
      error: `invalid transition ${from} \u2192 ${to} for ai; allowed: ${TRANSITIONS[from].join(", ")}; pass --reason if user requested a skip`
    };
  }
  if (to === "review" && openCriteria2 > 0) {
    return {
      ok: false,
      error: `cannot move to review: ${openCriteria2} unchecked acceptance criteria; check them (kdd criteria check) or pass --reason if user asked to skip`
    };
  }
  return { ok: true };
}

// src/tracks.ts
function mustGetTrack(db, id) {
  const t = db.prepare(`SELECT * FROM tracks WHERE id = ?`).get(id);
  if (!t) throw new KddError(`track #${id} not found`);
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
function editTrack(db, id, patch) {
  if (patch.status && patch.status !== "active" && patch.status !== "done") {
    throw new KddError(`invalid status '${patch.status}'; allowed: active, done`);
  }
  const fields = Object.keys(patch).filter((k) => patch[k] !== void 0);
  if (fields.length === 0) throw new KddError("nothing to edit");
  mustGetTrack(db, id);
  try {
    db.prepare(`UPDATE tracks SET ${fields.map((f) => `${f} = ?`).join(", ")} WHERE id = ?`).run(...fields.map((f) => patch[f]), id);
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new KddError(`track '${patch.name}' already exists`);
    throw e;
  }
  return mustGetTrack(db, id);
}
function deleteTrack(db, id) {
  mustGetTrack(db, id);
  db.transaction(() => {
    db.prepare(`UPDATE tasks SET track_id = NULL WHERE track_id = ?`).run(id);
    db.prepare(`DELETE FROM tracks WHERE id = ?`).run(id);
  })();
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
var authorOf = (a) => a.type === "ai" ? `ai:${a.id ?? "?"}` : "user";
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
function mustGetTask(db, id) {
  const t = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
  if (!t) throw new KddError(`task #${id} not found`);
  return t;
}
function checkPriority(p) {
  if (!PRIORITIES.includes(p)) {
    throw new KddError(`invalid priority '${p}'; allowed: ${PRIORITIES.join(", ")}`);
  }
}
function addTask(db, input, actor) {
  const priority = input.priority ?? "medium";
  checkPriority(priority);
  if (!input.title.trim()) throw new KddError("title must not be empty");
  if (input.criteria?.some((c) => !c.trim())) {
    throw new KddError("criterion text must not be empty");
  }
  if (input.track_id != null) mustGetTrack(db, input.track_id);
  return db.transaction(() => {
    const ts = now();
    const r = db.prepare(
      `INSERT INTO tasks (title, body, priority, area, track_id, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.title,
      input.body ?? null,
      priority,
      input.area ?? null,
      input.track_id ?? null,
      nextPosition(db, "new"),
      ts,
      ts
    );
    const id = Number(r.lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO criteria (task_id, text, position, created_at) VALUES (?, ?, ?, ?)`
    );
    (input.criteria ?? []).forEach((text, i) => ins.run(id, text, i, ts));
    appendEvent(db, id, actor, "created");
    return mustGetTask(db, id);
  })();
}
function editTask(db, id, patch, actor) {
  if (patch.priority !== void 0) checkPriority(patch.priority);
  if (patch.track_id != null) mustGetTrack(db, patch.track_id);
  const fields = Object.keys(patch).filter((k) => patch[k] !== void 0);
  if (fields.length === 0) throw new KddError("nothing to edit");
  return db.transaction(() => {
    mustGetTask(db, id);
    const sets = fields.map((f) => `${f} = ?`).join(", ");
    db.prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`).run(...fields.map((f) => patch[f]), now(), id);
    appendEvent(db, id, actor, "edited", { fields });
    return mustGetTask(db, id);
  })();
}
function commentTask(db, id, body, actor) {
  if (!body.trim()) throw new KddError("comment must not be empty");
  return db.transaction(() => {
    mustGetTask(db, id);
    const r = db.prepare(
      `INSERT INTO comments (task_id, author, body, created_at) VALUES (?, ?, ?, ?)`
    ).run(id, authorOf(actor), body, now());
    appendEvent(db, id, actor, "commented");
    return db.prepare(`SELECT * FROM comments WHERE id = ?`).get(Number(r.lastInsertRowid));
  })();
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
function nextPosition(db, status) {
  return db.prepare(
    `SELECT COALESCE(MAX(position), -1) + 1 AS p
     FROM tasks WHERE status = ? AND archived_at IS NULL`
  ).get(status).p;
}
function moveTask(db, id, to, actor, reason) {
  checkStatus(to);
  return db.transaction(() => {
    const t = mustGetTask(db, id);
    const res = checkMove(t.status, to, actor, reason, openCriteria(db, id), t.claimed_by);
    if (!res.ok) throw new KddError(res.error);
    const leaving = t.status === "in_progress" && to !== "in_progress";
    const reset = to === "review";
    db.prepare(
      `UPDATE tasks SET status = ?, position = ?, updated_at = ?${leaving ? ", claimed_by = NULL, claim_expires = NULL" : ""}${reset ? ", failed_attempts = 0" : ""}
       WHERE id = ?`
    ).run(to, nextPosition(db, to), now(), id);
    appendEvent(
      db,
      id,
      actor,
      "moved",
      reason ? { from: t.status, to, reason } : { from: t.status, to }
    );
    if (reason) {
      db.prepare(
        `INSERT INTO comments (task_id, author, body, created_at) VALUES (?, ?, ?, ?)`
      ).run(id, authorOf(actor), reason, now());
    }
    return mustGetTask(db, id);
  })();
}
function placeTask(db, id, to, orderedIds, actor) {
  checkStatus(to);
  return db.transaction(() => {
    const t = mustGetTask(db, id);
    if (t.status !== to) {
      const res = checkMove(t.status, to, actor, void 0, openCriteria(db, id), t.claimed_by);
      if (!res.ok) throw new KddError(res.error);
      appendEvent(db, id, actor, "moved", { from: t.status, to });
    }
    const setPos = db.prepare(`UPDATE tasks SET position = ? WHERE id = ?`);
    orderedIds.forEach((tid, i) => setPos.run(i, tid));
    const leaving = t.status === "in_progress" && to !== "in_progress";
    const reset = to === "review";
    db.prepare(
      `UPDATE tasks SET status = ?, updated_at = ?${leaving ? ", claimed_by = NULL, claim_expires = NULL" : ""}${reset ? ", failed_attempts = 0" : ""}
       WHERE id = ?`
    ).run(to, now(), id);
    return mustGetTask(db, id);
  })();
}
function blockTask(db, id, reason, actor) {
  if (!reason.trim()) throw new KddError("block reason must not be empty");
  return db.transaction(() => {
    mustGetTask(db, id);
    db.prepare(`UPDATE tasks SET blocked = 1, block_reason = ?, updated_at = ? WHERE id = ?`).run(reason, now(), id);
    appendEvent(db, id, actor, "blocked", { reason });
    return mustGetTask(db, id);
  })();
}
function unblockTask(db, id, actor) {
  return db.transaction(() => {
    mustGetTask(db, id);
    db.prepare(`UPDATE tasks SET blocked = 0, block_reason = NULL, updated_at = ? WHERE id = ?`).run(now(), id);
    appendEvent(db, id, actor, "unblocked");
    return mustGetTask(db, id);
  })();
}
function linkTasks(db, fromId, toId, kind, actor) {
  db.transaction(() => {
    mustGetTask(db, fromId);
    mustGetTask(db, toId);
    const r = db.prepare(
      `INSERT OR IGNORE INTO task_links (from_id, to_id, kind) VALUES (?, ?, ?)`
    ).run(fromId, toId, kind);
    if (r.changes > 0) appendEvent(db, fromId, actor, "linked", { to: toId, kind });
  })();
}
function archiveTask(db, id, actor) {
  return db.transaction(() => {
    mustGetTask(db, id);
    db.prepare(`UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?`).run(now(), now(), id);
    appendEvent(db, id, actor, "archived");
    return mustGetTask(db, id);
  })();
}
function unarchiveTask(db, id, actor) {
  return db.transaction(() => {
    mustGetTask(db, id);
    db.prepare(`UPDATE tasks SET archived_at = NULL, updated_at = ? WHERE id = ?`).run(now(), id);
    appendEvent(db, id, actor, "unarchived");
    return mustGetTask(db, id);
  })();
}

// src/criteria.ts
function listCriteria(db, taskId) {
  return db.prepare(
    `SELECT * FROM criteria WHERE task_id = ? ORDER BY position, id`
  ).all(taskId);
}
function mustGetCriterion(db, taskId, id) {
  const c = db.prepare(`SELECT * FROM criteria WHERE id = ? AND task_id = ?`).get(id, taskId);
  if (!c) throw new KddError(`criterion #${id} not found on task #${taskId}`);
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
    const id = Number(r.lastInsertRowid);
    appendEvent(db, taskId, actor, "criterion_added", { id, text });
    touchTask(db, taskId);
    return mustGetCriterion(db, taskId, id);
  })();
}
function setCriterionChecked(db, taskId, id, checked, actor) {
  return db.transaction(() => {
    const c = mustGetCriterion(db, taskId, id);
    if (c.checked_at !== null === checked) return c;
    db.prepare(`UPDATE criteria SET checked_at = ? WHERE id = ?`).run(checked ? now() : null, id);
    appendEvent(
      db,
      taskId,
      actor,
      checked ? "criterion_checked" : "criterion_unchecked",
      { id, text: c.text }
    );
    touchTask(db, taskId);
    return mustGetCriterion(db, taskId, id);
  })();
}
function removeCriterion(db, taskId, id, actor) {
  db.transaction(() => {
    const c = mustGetCriterion(db, taskId, id);
    db.prepare(`DELETE FROM criteria WHERE id = ?`).run(id);
    appendEvent(db, taskId, actor, "criterion_removed", { id, text: c.text });
    touchTask(db, taskId);
  })();
}

// src/decisions.ts
import { createHash as createHash2 } from "crypto";
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync, writeFileSync } from "fs";
import { join as join2 } from "path";
function slugify(title) {
  const s = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  return s || "untitled";
}
var normalize = (s) => s.replace(/\r\n/g, "\n").trim();
function contentHash(title, body) {
  return createHash2("sha256").update(`${normalize(title)}
${normalize(body)}`).digest("hex");
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
  return `---
created: ${created}
status: active
superseded_by:
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
    hash: contentHash(title, indexBody)
  };
}
function supersede(db, dir, oldSlug, newSlug) {
  const p = join2(dir, `${oldSlug}.md`);
  if (!existsSync2(p)) throw new KddError(`decision '${oldSlug}' not found`);
  let raw = readFileSync(p, "utf8").replace(/\r\n/g, "\n");
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
  writeFileSync(p, raw);
  db.prepare(`UPDATE decisions SET superseded_by = ? WHERE slug = ?`).run(newSlug, oldSlug);
}
function addDecision(db, decisionsDir, input) {
  if (!input.title.trim()) throw new KddError("title must not be empty");
  if (input.body !== void 0 && [input.decision, input.rationale, input.alternatives, input.outcome].some((v) => v !== void 0)) {
    throw new KddError("--body is mutually exclusive with section flags");
  }
  const body = renderDecisionBody(input);
  const hash = contentHash(input.title, body);
  const dup = db.prepare(`SELECT slug, path FROM decisions WHERE content_hash = ?`).get(hash);
  if (dup) return { slug: dup.slug, path: dup.path, created: false };
  const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const base = `${date}-${slugify(input.title)}`;
  let slug = base;
  const taken = (s) => existsSync2(join2(decisionsDir, `${s}.md`)) || !!db.prepare(`SELECT 1 FROM decisions WHERE slug = ?`).get(s);
  for (let i = 2; taken(slug); i++) slug = `${base}-${i}`;
  const path = join2(decisionsDir, `${slug}.md`);
  return db.transaction(() => {
    if (input.supersedes) supersede(db, decisionsDir, input.supersedes, slug);
    mkdirSync2(decisionsDir, { recursive: true });
    writeFileSync(path, renderDecisionMd(input, date));
    db.prepare(
      `INSERT INTO decisions (slug, title, path, content_hash, created, superseded_by)
       VALUES (?, ?, ?, ?, ?, NULL)`
    ).run(slug, input.title.trim(), path, hash, date);
    db.prepare(
      `INSERT INTO search_index (kind, ref, title, body) VALUES ('decision', ?, ?, ?)`
    ).run(slug, input.title.trim(), body);
    return { slug, path, created: true };
  })();
}

// src/recall.ts
import { existsSync as existsSync3, readFileSync as readFileSync2, readdirSync as readdirSync2 } from "fs";
import { join as join3 } from "path";
function syncIndex(db, decisionsDir) {
  db.transaction(() => {
    const files = existsSync3(decisionsDir) ? readdirSync2(decisionsDir).filter((f) => f.endsWith(".md")) : [];
    const inDb = new Map(
      db.prepare(`SELECT slug, content_hash, superseded_by FROM decisions`).all().map((r) => [r.slug, r])
    );
    const seen = /* @__PURE__ */ new Set();
    for (const f of files) {
      const slug = f.slice(0, -3);
      seen.add(slug);
      const path = join3(decisionsDir, f);
      const doc = parseDecisionMd(readFileSync2(path, "utf8"));
      const title = doc.title || slug;
      const supersededBy = doc.status === "superseded" ? doc.supersededBy || "?" : doc.supersededBy || null;
      const row = inDb.get(slug);
      if (row && row.content_hash === doc.hash && (row.superseded_by ?? null) === (supersededBy ?? null)) continue;
      db.prepare(`DELETE FROM search_index WHERE kind='decision' AND ref = ?`).run(slug);
      db.prepare(
        `INSERT OR REPLACE INTO decisions (slug, title, path, content_hash, created, superseded_by)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(slug, title, path, doc.hash, doc.created || null, supersededBy);
      db.prepare(
        `INSERT INTO search_index (kind, ref, title, body) VALUES ('decision', ?, ?, ?)`
      ).run(slug, title, doc.indexBody);
    }
    for (const slug of inDb.keys()) {
      if (seen.has(slug)) continue;
      db.prepare(`DELETE FROM decisions WHERE slug = ?`).run(slug);
      db.prepare(`DELETE FROM search_index WHERE kind='decision' AND ref = ?`).run(slug);
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
    for (const { id } of ids) {
      db.prepare(`DELETE FROM search_index WHERE kind='task' AND ref = ?`).run(String(id));
      const t = getTask.get(id);
      if (!t || t.archived_at) continue;
      const body = [t.body ?? "", ...getComments.all(id).map((c) => c.body)].filter(Boolean).join("\n");
      db.prepare(
        `INSERT INTO search_index (kind, ref, title, body) VALUES ('task', ?, ?, ?)`
      ).run(String(id), t.title, body);
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
var PRIORITY_ORDER = `CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;
var READY_SQL = `(status = 'new' AND blocked = 0 AND archived_at IS NULL)`;
function boardData(db, f = {}) {
  const where = [f.archived ? "archived_at IS NOT NULL" : "archived_at IS NULL"];
  const params = [];
  if (f.area) {
    where.push("area = ?");
    params.push(f.area);
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
function taskDetail(db, id) {
  const task = mustGetTask(db, id);
  const criteria = listCriteria(db, id);
  const comments = db.prepare(
    `SELECT * FROM comments WHERE task_id = ? ORDER BY created_at, id`
  ).all(id);
  const events = db.prepare(
    `SELECT * FROM events WHERE task_id = ? ORDER BY created_at, id`
  ).all(id);
  const links = db.prepare(
    `SELECT t.id, t.title, l.kind FROM task_links l
     JOIN tasks t ON t.id = CASE WHEN l.from_id = ? THEN l.to_id ELSE l.from_id END
     WHERE l.from_id = ? OR l.to_id = ?`
  ).all(id, id, id);
  return { task, criteria, comments, events, links };
}
function taskDetailCapped(db, id) {
  const d = taskDetail(db, id);
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
    links: d.links
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
function exportBoard(db) {
  return {
    tasks: db.prepare(`SELECT * FROM tasks ORDER BY id`).all(),
    comments: db.prepare(`SELECT * FROM comments ORDER BY id`).all(),
    links: db.prepare(`SELECT * FROM task_links`).all(),
    events: db.prepare(`SELECT * FROM events ORDER BY id`).all()
  };
}

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
      else if (b?.type === "tool_use") out.push({ kind: "tool_start", name: b.name, detail: { input: b.input } });
    }
    return out;
  }
  if (msg?.type === "user" && Array.isArray(msg.message?.content)) {
    const out = [];
    for (const b of msg.message.content) {
      if (b?.type === "tool_result") out.push({ kind: "tool_finish", detail: { output: b.content, isError: !!b.is_error } });
    }
    return out;
  }
  return [];
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
      opts?.detail ? JSON.stringify(opts.detail) : null,
      now()
    );
    return Number(r.lastInsertRowid);
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

// src/claim.ts
var DEFAULT_TTL = 15 * 60;
var SYSTEM = { type: "ai", id: "system" };
var MAX_FAILED_ATTEMPTS = 3;
function recordFailedAttempt(db, id, actor, reason) {
  db.prepare(`UPDATE tasks SET failed_attempts = failed_attempts + 1, updated_at = ? WHERE id = ?`).run(now(), id);
  const fa = db.prepare(`SELECT failed_attempts FROM tasks WHERE id = ?`).get(id).failed_attempts;
  if (fa >= MAX_FAILED_ATTEMPTS) {
    db.prepare(`UPDATE tasks SET blocked = 1, block_reason = ?, updated_at = ? WHERE id = ?`).run(`${fa} failed attempts (agent driver): ${reason}`, now(), id);
    appendEvent(
      db,
      id,
      actor,
      "blocked",
      { reason: `${fa} failed attempts`, last: reason },
      { type: "claim", level: "error" }
    );
  }
}
function releaseClaim(db, id, actor, reason) {
  db.transaction(() => {
    db.prepare(
      `UPDATE tasks SET status='new', claimed_by=NULL, claim_expires=NULL, updated_at=? WHERE id=?`
    ).run(now(), id);
    appendEvent(db, id, actor, "released", { reason }, { type: "claim", level: "warn" });
    recordFailedAttempt(db, id, actor, reason);
  })();
}
function assertTtl(ttl) {
  if (!Number.isFinite(ttl) || ttl <= 0) throw new KddError(`invalid ttl '${ttl}' (seconds > 0)`);
}
var CLAIMABLE_SQL = `status = 'new' AND blocked = 0 AND archived_at IS NULL AND claimed_by IS NULL
   AND (SELECT COUNT(*) FROM criteria WHERE criteria.task_id = tasks.id) > 0`;
var criteriaCount = (db, id) => db.prepare(`SELECT COUNT(*) c FROM criteria WHERE task_id = ?`).get(id).c;
function reclaimExpired(db) {
  const t = now();
  const expired = db.prepare(
    `SELECT id, claimed_by FROM tasks
     WHERE status = 'in_progress' AND claim_expires IS NOT NULL AND claim_expires < ?`
  ).all(t);
  const clear = db.prepare(
    `UPDATE tasks SET status='new', claimed_by=NULL, claim_expires=NULL, updated_at=? WHERE id=?`
  );
  for (const e of expired) {
    clear.run(t, e.id);
    appendEvent(db, e.id, SYSTEM, "reclaimed", { former: e.claimed_by }, { type: "claim", level: "warn" });
    if (e.claimed_by?.startsWith("ai:tick:")) {
      recordFailedAttempt(db, e.id, SYSTEM, "lease expired without progress");
      try {
        closeOrphanRun(db, e.id, e.claimed_by);
      } catch {
      }
    }
  }
  return expired.map((e) => e.id);
}
function closeOrphanRun(db, taskId, claimedBy) {
  const wid = claimedBy.slice(3);
  const last = lastAgentEventKind(db, taskId, wid);
  if (last === "run_end") return;
  if (last === null) {
    appendAgentEvent(
      db,
      taskId,
      wid,
      "error",
      { detail: { message: "worker never started (spawn or worktree setup failed) \u2014 lease expired, reclaimed by driver" } }
    );
    return;
  }
  appendAgentEvent(
    db,
    taskId,
    wid,
    "error",
    { detail: { message: "worker died (SIGKILL/OOM/reboot) \u2014 lease expired, reclaimed by driver" } }
  );
  appendAgentEvent(db, taskId, wid, "run_end", { detail: { exitCode: null } });
}
function claimTask(db, id, actor, ttl = DEFAULT_TTL) {
  assertTtl(ttl);
  return db.transaction(() => {
    reclaimExpired(db);
    const t = mustGetTask(db, id);
    if (criteriaCount(db, id) === 0) {
      appendEvent(
        db,
        id,
        actor,
        "claim_rejected",
        { reason: "no acceptance criteria" },
        { type: "claim", level: "warn" }
      );
      return { ok: false, error: `cannot claim #${id}: no acceptance criteria (define done first)` };
    }
    const expires = now() + ttl;
    const r = db.prepare(
      `UPDATE tasks SET status='in_progress', claimed_by=?, claim_expires=?, updated_at=?
       WHERE id=? AND status='new' AND blocked=0 AND archived_at IS NULL AND claimed_by IS NULL`
    ).run(authorOf(actor), expires, now(), id);
    if (r.changes !== 1) {
      return {
        ok: false,
        error: `#${id} is not claimable (status ${t.status}${t.claimed_by ? `, held by ${t.claimed_by}` : ""})`
      };
    }
    appendEvent(db, id, actor, "claimed", { ttl, expires }, { type: "claim" });
    return { ok: true, task: mustGetTask(db, id) };
  })();
}
function claimNext(db, actor, ttl = DEFAULT_TTL, opts = {}) {
  assertTtl(ttl);
  return db.transaction(() => {
    if (opts.reclaim !== false) reclaimExpired(db);
    const rows = db.prepare(
      `SELECT id FROM tasks WHERE ${CLAIMABLE_SQL} ORDER BY ${PRIORITY_ORDER}, created_at, id`
    ).all();
    for (const { id } of rows) {
      const expires = now() + ttl;
      const r = db.prepare(
        `UPDATE tasks SET status='in_progress', claimed_by=?, claim_expires=?, updated_at=?
         WHERE id=? AND status='new' AND blocked=0 AND archived_at IS NULL AND claimed_by IS NULL`
      ).run(authorOf(actor), expires, now(), id);
      if (r.changes === 1) {
        appendEvent(db, id, actor, "claimed", { ttl, expires }, { type: "claim" });
        return mustGetTask(db, id);
      }
    }
    return null;
  })();
}
function renewClaim(db, id, actor, ttl = DEFAULT_TTL) {
  assertTtl(ttl);
  return db.transaction(() => {
    mustGetTask(db, id);
    const expires = now() + ttl;
    const r = db.prepare(
      `UPDATE tasks SET claim_expires=?, updated_at=? WHERE id=? AND claimed_by=?`
    ).run(expires, now(), id, authorOf(actor));
    if (r.changes !== 1) {
      return {
        ok: false,
        error: `#${id} not held by ${authorOf(actor)} (lease lost or reclaimed) \u2014 stop work`
      };
    }
    appendEvent(db, id, actor, "claim_renewed", { ttl, expires }, { type: "claim" });
    return { ok: true, task: mustGetTask(db, id) };
  })();
}

// src/driver.ts
function activeWorkers(db) {
  return db.prepare(
    `SELECT COUNT(*) c FROM tasks WHERE status='in_progress' AND claimed_by IS NOT NULL`
  ).get().c;
}
function tick(db, opts) {
  const reclaimed = db.transaction(() => reclaimExpired(db))().length;
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
  return { reclaimed, spawned, active };
}

// src/worktree.ts
import { execFileSync as execFileSync2 } from "child_process";
import { existsSync as existsSync4, realpathSync, rmSync } from "fs";
import { dirname as dirname2, join as join4 } from "path";
var branchName = (taskId) => `kdd/task-${taskId}`;
var BRANCH_RE = /^refs\/heads\/kdd\/task-(\d+)$/;
function git(repoRoot, args) {
  try {
    return execFileSync2("git", args, {
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
    git(repoRoot, args);
  } catch {
  }
}
function worktreePath(dbPath, taskId, title) {
  const root = dirname2(dbPath);
  const realRoot = existsSync4(root) ? realpathSync(root) : root;
  return join4(realRoot, "worktrees", `task-${taskId}-${slugify(title)}`);
}
function headCommit(repoRoot) {
  return git(repoRoot, ["rev-parse", "HEAD"]);
}
function taskBranchHead(repoRoot, taskId) {
  try {
    return git(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branchName(taskId)}`]);
  } catch {
    return null;
  }
}
function listWorktrees(repoRoot) {
  const out = git(repoRoot, ["worktree", "list", "--porcelain"]);
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
    git(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}
function ensureWorktree(repoRoot, dbPath, taskId, title) {
  const branch = branchName(taskId);
  const ref = `refs/heads/${branch}`;
  const existing = listWorktrees(repoRoot).find((e) => e.branch === ref);
  if (existing && existsSync4(existing.path)) return existing.path;
  if (existing) gitTry(repoRoot, ["worktree", "remove", "--force", existing.path]);
  const path = worktreePath(dbPath, taskId, title);
  gitTry(repoRoot, ["worktree", "prune"]);
  rmSync(path, { recursive: true, force: true });
  const tail = branchExists(repoRoot, branch) ? [path, branch] : [path, "-b", branch];
  git(repoRoot, ["worktree", "add", ...tail]);
  return path;
}
function sweepWorktrees(db, repoRoot) {
  const stmt = db.prepare(`SELECT status FROM tasks WHERE id = ?`);
  let removed = 0;
  for (const e of listWorktrees(repoRoot)) {
    const m = e.branch?.match(BRANCH_RE);
    if (!m) continue;
    const row = stmt.get(Number(m[1]));
    if (row?.status === "in_progress") continue;
    gitTry(repoRoot, ["worktree", "remove", "--force", e.path]);
    removed++;
  }
  if (removed) gitTry(repoRoot, ["worktree", "prune"]);
  return removed;
}

// src/release.ts
import { readFileSync as readFileSync3 } from "fs";
import { join as join5 } from "path";
var pkgCache = null;
function pkg() {
  if (pkgCache) return pkgCache;
  try {
    pkgCache = JSON.parse(
      readFileSync3(join5(import.meta.dirname, "../package.json"), "utf8")
    );
  } catch {
    pkgCache = {};
  }
  return pkgCache;
}
function kddVersion() {
  return pkg().version ?? "0.0.0";
}
function repoSlug() {
  const r = pkg().repository;
  const url = typeof r === "string" ? r : r?.url ?? "";
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/i);
  return m ? { owner: m[1], repo: m[2] } : null;
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
  return A.pre < B.pre ? -1 : A.pre > B.pre ? 1 : 0;
}
export {
  CAPS,
  DEFAULT_TTL,
  KddError,
  MAX_FAILED_ATTEMPTS,
  MIGRATIONS,
  PRIORITIES,
  PRIORITY_ORDER,
  STATUSES,
  TRANSITIONS,
  addCriterion,
  addDecision,
  addTask,
  appendAgentEvent,
  appendEvent,
  archiveTask,
  authorOf,
  blockTask,
  boardData,
  capText,
  checkMove,
  claimNext,
  claimTask,
  commentTask,
  compareVersions,
  contentHash,
  createTrack,
  deleteTrack,
  editTask,
  editTrack,
  ensureWorktree,
  exportBoard,
  headCommit,
  kddHome,
  kddVersion,
  lastAgentEventKind,
  linkTasks,
  listAgentEvents,
  listCriteria,
  listProjects,
  listTracks,
  logError,
  moveTask,
  mustGetTask,
  mustGetTrack,
  now,
  openDb,
  parseClaudeStreamLine,
  parseDecisionMd,
  placeTask,
  rebuild,
  recall,
  reclaimExpired,
  recordFailedAttempt,
  releaseClaim,
  removeCriterion,
  renderDecisionBody,
  renderDecisionMd,
  renewClaim,
  repoSlug,
  resolveDbPath,
  resolveDecisionsDir,
  resolveToplevel,
  runProduced,
  sanitizeQuery,
  setCriterionChecked,
  slugify,
  statusDigest,
  sweepWorktrees,
  syncIndex,
  taskBranchHead,
  taskDetail,
  taskDetailCapped,
  tick,
  unarchiveTask,
  unblockTask,
  worktreePath
};
