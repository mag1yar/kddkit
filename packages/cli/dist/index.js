#!/usr/bin/env node

// src/index.ts
import { Command } from "commander";
import { readFileSync } from "fs";
import { basename, dirname, join } from "path";
import { spawn as spawnProcess } from "child_process";
import { createInterface } from "readline";
import { fileURLToPath } from "url";
import lockfile from "proper-lockfile";
import {
  KddError as KddError2,
  addCriterion,
  addDecision,
  addTask,
  appendAgentEvent,
  archiveTask,
  blockTask,
  boardData,
  claimNext,
  claimTask,
  commentTask,
  createTrack,
  deleteTrack,
  DEFAULT_TTL,
  editTask,
  editTrack,
  ensureWorktree,
  exportBoard,
  headCommit,
  kddVersion,
  linkTasks,
  listAgentEvents,
  listCriteria,
  listProjects,
  taskBranchHead,
  listTracks,
  maxWorkers,
  moveTask,
  mustGetTask,
  now as now2,
  openDb as openDb2,
  parseClaudeStreamLine,
  rebuild,
  recall,
  removeCriterion,
  renewClaim,
  resolveDbPath as resolveDbPath2,
  resolveDecisionsDir,
  resolveToplevel,
  setCriterionChecked,
  statusDigest,
  sweepWorktrees,
  taskDetail,
  taskDetailCapped,
  tick,
  unarchiveTask,
  unblockTask
} from "@kddkit/core";
import { createScheduler, projectPool, startUi } from "@kddkit/ui";

// src/context.ts
import { KddError, openDb, resolveDbPath } from "@kddkit/core";
function getActor() {
  return process.env.KDD_ACTOR === "ai" ? { type: "ai", id: process.env.KDD_SESSION } : { type: "user" };
}
function withDbAt(dbPath, projectPath, fn) {
  const db = openDb(dbPath, projectPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
function withDb(fn) {
  const { dbPath, projectPath } = resolveDbPath();
  return withDbAt(dbPath, projectPath, fn);
}
function parseId(s) {
  const n = Number(s.replace(/^#/, ""));
  if (!Number.isInteger(n) || n <= 0) throw new KddError(`invalid task id '${s}'`);
  return n;
}
function fail(msg, json) {
  if (json) console.log(JSON.stringify({ error: msg }));
  else console.error(`error: ${msg}`);
  process.exit(1);
}

// src/render.ts
import {
  CAPS,
  STATUSES,
  capText as cap,
  now
} from "@kddkit/core";
function renderClaim(t, verb) {
  const left = t.claim_expires ? Math.max(0, Math.round((t.claim_expires - now()) / 60)) : 0;
  return `#${t.id} ${verb} by ${t.claimed_by ?? "?"} (expires in ${left}m)`;
}
function renderAge(epoch) {
  const d = now() - epoch;
  if (d < 3600) return `${Math.max(1, Math.floor(d / 60))}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}
function taskLine(t) {
  const bits = [`#${t.id}`, cap(t.title, CAPS.titleChars), `[${t.priority}]`];
  if (t.area) bits.push(`@${t.area}`);
  if (t.criteria_total) bits.push(`${t.criteria_checked}/${t.criteria_total}`);
  if (t.blocked) bits.push(`BLOCKED: ${cap(t.block_reason ?? "", CAPS.blockReasonChars)}`);
  return `  ${bits.join(" ")}`;
}
function renderBoard(b) {
  const lines = [];
  for (const s of STATUSES) {
    lines.push(`${s} (${b[s].length})`);
    const shown = b[s].slice(0, CAPS.boardRows);
    for (const t of shown) lines.push(taskLine(t));
    if (b[s].length > shown.length) {
      lines.push(`  (+${b[s].length - shown.length} more, use --status ${s})`);
    }
  }
  return lines.join("\n");
}
function renderShow(d) {
  const t = d.task;
  const lines = [
    `#${t.id} ${t.title}`,
    `status: ${t.status}${t.blocked ? ` (BLOCKED: ${t.block_reason})` : ""}  priority: ${t.priority}${t.area ? `  area: ${t.area}` : ""}${t.archived_at ? "  ARCHIVED" : ""}`
  ];
  if (t.body) lines.push("", t.body);
  if (d.criteria.length) {
    lines.push("", "criteria:", renderCriteria(d.criteria));
  }
  if (d.links.length) {
    lines.push("", "links:");
    for (const l of d.links) lines.push(`  ${l.kind} #${l.id} ${cap(l.title, CAPS.titleChars)}`);
  }
  if (d.comments_total) {
    lines.push("", `comments (${d.comments_total}):`);
    if (d.comments.length < d.comments_total) {
      lines.push(`  (${d.comments_total - d.comments.length} earlier omitted)`);
    }
    for (const c of d.comments) {
      lines.push(`  [${c.author} ${renderAge(c.created_at)} ago] ${c.body}`);
    }
  }
  lines.push("", "history:");
  for (const e of d.events) {
    lines.push(`  ${renderAge(e.created_at)} ago ${e.actor_type} ${e.action}${e.detail ? ` ${e.detail}` : ""}`);
  }
  return lines.join("\n");
}
function renderCriteria(cs) {
  if (cs.length === 0) return "no criteria";
  return cs.map((c) => `  [${c.checked_at ? "x" : " "}] ${c.id}. ${c.text}`).join("\n");
}
function renderRecall(hits) {
  if (hits.length === 0) return "no results";
  const line = (h) => {
    const snip = h.snippet.replace(/\s+/g, " ").trim();
    if (h.kind === "decision") {
      const tag = h.superseded_by ? ` [superseded by ${h.superseded_by}]` : "";
      return `decision ${h.ref}${tag} ${cap(h.title, CAPS.recallTitleChars)} \u2014 ${snip}`;
    }
    return `task #${h.ref} [${h.status ?? "?"}] ${cap(h.title, CAPS.recallTitleChars)} \u2014 ${snip}`;
  };
  const all = hits.map(line);
  const shown = [...all];
  while (shown.length > 1 && Buffer.byteLength(shown.join("\n"), "utf8") > CAPS.recallBytes - 32) {
    shown.pop();
  }
  if (shown.length < all.length) shown.push(`(+${all.length - shown.length} more, use -k)`);
  return shown.join("\n");
}
function renderTracks(ts) {
  if (ts.length === 0) return "no tracks";
  return ts.map((t) => {
    const head = `#${t.id} ${t.name} (${t.open_tasks})${t.status === "done" ? " DONE" : ""}`;
    return t.description ? `${head}
  ${cap(t.description, CAPS.trackDescChars)}` : head;
  }).join("\n");
}
function renderStatus(d) {
  const lines = [];
  const section = (name, ts) => {
    lines.push(`${name} (${ts.length})`);
    const shown = ts.slice(0, CAPS.statusRows);
    for (const t of shown) lines.push(taskLine(t));
    if (ts.length > shown.length) lines.push(`  (+${ts.length - shown.length} more)`);
  };
  section("in_progress", d.in_progress);
  section("review", d.review);
  section("blocked", d.blocked);
  lines.push("recent:");
  for (const e of d.recent) {
    lines.push(`  ${renderAge(e.created_at)} ago ${e.actor_type} ${e.action} #${e.task_id ?? "-"}`);
  }
  return lines.join("\n");
}

// src/tick-output.ts
function parseTickOutput(out2, err, code, at) {
  const zero = { at, reclaimed: 0, spawned: 0, active: 0, reaped: 0 };
  let parsed;
  try {
    parsed = JSON.parse(out2);
  } catch {
    parsed = void 0;
  }
  const obj = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : void 0;
  if (code !== 0) {
    const stdoutError = obj && typeof obj.error === "string" ? obj.error : void 0;
    return { ...zero, error: stdoutError || err.trim() || `kdd tick exited with code ${code}` };
  }
  if (!obj) return { ...zero, error: `unparsable tick output: ${out2.slice(0, 200)}` };
  if (obj.skipped) return { ...zero, skipped: true };
  const num = (v) => typeof v === "number" ? v : 0;
  return {
    at,
    reclaimed: num(obj.reclaimed),
    spawned: num(obj.spawned),
    active: num(obj.active),
    reaped: num(obj.reaped)
  };
}

// src/index.ts
var program = new Command().name("kdd").description("kanban substrate for humans and Claude").version(kddVersion());
function out(json, obj, text) {
  console.log(json ? JSON.stringify(obj) : text());
}
function readBody(opts) {
  if (opts.bodyFile) return readFileSync(opts.bodyFile, "utf8");
  if (opts.body === "-") return readFileSync(0, "utf8");
  return opts.body;
}
var WORKER_PROMPT = process.env.KDD_WORKER_PROMPT ?? `You are a kdd agent worker. Read your task: run \`kdd show $KDD_TASK_ID\`. Do the work in this repository. Renew your lease periodically with \`kdd claim $KDD_TASK_ID --renew\` \u2014 if that errors you have LOST the lease, stop immediately. When done, leave ONE concise summary comment (\`kdd comment $KDD_TASK_ID "<what you changed and why; caveats or follow-ups>"\`) \u2014 this is the durable note humans and future sessions read, so keep it tight, not a log. Then check acceptance criteria (\`kdd criteria check\`) and \`kdd move $KDD_TASK_ID review\`. If you get blocked or must stop early, comment the reason first.`;
var sq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
var DEFAULT_SPAWN_CMD = `${sq(process.execPath)} ${sq(fileURLToPath(import.meta.url))} worker "$KDD_TASK_ID"`;
var TICK_LOCK_STALE = 10 * 60 * 1e3;
function spawnWorker(taskId, workerId, projectDir) {
  const cmd = process.env.KDD_SPAWN_CMD ?? DEFAULT_SPAWN_CMD;
  const shell = process.env.SHELL || "/bin/sh";
  const child = spawnProcess(shell, ["-lc", cmd], {
    cwd: projectDir,
    env: { ...process.env, KDD_TASK_ID: String(taskId), KDD_ACTOR: "ai", KDD_SESSION: workerId },
    detached: true,
    stdio: "ignore"
  });
  child.on("error", (e) => {
    process.stderr.write(`kdd tick: worker spawn failed for task ${taskId}: ${e.message}
`);
  });
  child.unref();
}
var tickRunner = ({ dbPath, projectPath }) => new Promise((resolve) => {
  const child = spawnProcess(
    process.execPath,
    [fileURLToPath(import.meta.url), "tick", "--json"],
    {
      // cwd нужен tick'у, чтобы резолвить toplevel для воркеров; базу пиннит KDD_DB,
      // projectPath — это git common-dir, его родитель и есть toplevel.
      cwd: dirname(projectPath),
      env: { ...process.env, KDD_DB: dbPath },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  let out2 = "";
  let err = "";
  child.stdout.on("data", (d) => {
    out2 += d.toString();
  });
  child.stderr.on("data", (d) => {
    err += d.toString();
  });
  child.on("error", (e) => resolve({ at: now2(), reclaimed: 0, spawned: 0, active: 0, reaped: 0, error: e.message }));
  child.on("close", (code) => resolve(parseTickOutput(out2, err, code, now2())));
});
function run(json, fn) {
  try {
    fn();
  } catch (e) {
    fail(e instanceof KddError2 ? e.message : String(e), json);
  }
}
var collect = (v, acc) => [...acc, v];
program.command("add").argument("<title>").option("--body <md>", 'markdown body, or "-" for stdin').option("--body-file <path>").option("--priority <p>", "low|medium|high|urgent").option("--area <area>").option("--track <id>", "track id").option("--criterion <text>", "acceptance criterion (repeatable)", collect, []).option("--json", "machine-readable output").action((title, o) => run(o.json, () => {
  const t = withDb((db) => addTask(
    db,
    {
      title,
      body: readBody(o),
      priority: o.priority,
      area: o.area,
      track_id: o.track ? parseId(o.track) : void 0,
      criteria: o.criterion.length ? o.criterion : void 0
    },
    getActor()
  ));
  out(o.json, t, () => `#${t.id} created`);
}));
program.command("decide").argument("<title>").option("--decision <t>").option("--rationale <t>").option("--alternatives <t>").option("--outcome <t>").option("--supersedes <slug>").option("--body <md>", 'full md body, or "-" for stdin').option("--body-file <path>").option("--json").action((title, o) => run(o.json, () => {
  const r = withDb((db) => addDecision(db, resolveDecisionsDir(), {
    title,
    decision: o.decision,
    rationale: o.rationale,
    alternatives: o.alternatives,
    outcome: o.outcome,
    supersedes: o.supersedes,
    body: readBody(o)
  }));
  out(o.json, r, () => r.created ? `decided: ${r.slug}
${r.path}` : `already recorded: ${r.slug}`);
}));
program.command("board").option("--area <area>").option("--status <s>").option("--track <id>", "track id").option("--ready", "only tasks takeable now (new, not blocked)").option("--archived", "show archived tasks only").option("--json").action((o) => run(o.json, () => {
  const b = withDb((db) => boardData(
    db,
    {
      area: o.area,
      status: o.status,
      archived: o.archived,
      ready: o.ready ? true : void 0,
      track_id: o.track ? parseId(o.track) : void 0
    }
  ));
  out(o.json, b, () => renderBoard(b));
}));
program.command("show").argument("<id>").option("--json").action((id, o) => run(o.json, () => {
  if (o.json) {
    out(true, withDb((db) => taskDetail(db, parseId(id))), () => "");
    return;
  }
  console.log(renderShow(withDb((db) => taskDetailCapped(db, parseId(id)))));
}));
program.command("move").argument("<id>").argument("<status>").option("--reason <text>", "why the transition skips the matrix (ai)").option("--json").action((id, status, o) => run(o.json, () => {
  const t = withDb((db) => moveTask(db, parseId(id), status, getActor(), o.reason));
  out(o.json, t, () => `#${t.id} \u2192 ${t.status}`);
}));
program.command("claim").argument("[id]", "task id to claim; omit when using --next").option("--next", "claim the top ready task from the queue").option("--renew", "renew the lease on a task you already hold").option("--ttl <seconds>", "lease length in seconds", String(DEFAULT_TTL)).option("--json").action((id, o) => run(o.json, () => {
  const ttl = Number(o.ttl);
  const actor = getActor();
  if (o.next) {
    const t = withDb((db) => claimNext(db, actor, ttl));
    if (!t) {
      out(o.json, { task: null }, () => "no ready task");
      return;
    }
    out(o.json, t, () => renderClaim(t, "claimed"));
    return;
  }
  if (!id) throw new KddError2("give a task id or use --next");
  const res = withDb((db) => o.renew ? renewClaim(db, parseId(id), actor, ttl) : claimTask(db, parseId(id), actor, ttl));
  if (!res.ok) {
    fail(res.error, o.json);
    return;
  }
  out(o.json, res.task, () => renderClaim(res.task, o.renew ? "renewed" : "claimed"));
}));
program.command("tick").description("agent-mode: reclaim expired leases, claim ready tasks, spawn workers").option("--json").option("--watch", "loop until SIGINT/SIGTERM instead of a single pass").option("--interval <sec>", "seconds between passes in --watch mode", "30").action(async (o) => {
  const intervalMs = Number(o.interval) * 1e3;
  if (o.watch && (!Number.isFinite(intervalMs) || intervalMs <= 0)) {
    fail(`--interval must be a positive number of seconds (got '${o.interval}')`, o.json);
  }
  const ttl = Number(process.env.KDD_WORKER_TTL ?? 1800);
  if (process.env.KDD_MAX_WORKERS !== void 0) {
    const n = Number(process.env.KDD_MAX_WORKERS);
    if (!Number.isInteger(n) || n < 1) {
      fail("KDD_MAX_WORKERS must be a positive integer", o.json);
    }
  }
  const onePass = () => {
    const { dbPath, projectPath } = resolveDbPath2();
    let release;
    try {
      release = lockfile.lockSync(join(dirname(dbPath), "tick"), { stale: TICK_LOCK_STALE, realpath: false });
    } catch (e) {
      if (e.code === "ELOCKED") return { skipped: true };
      throw e;
    }
    try {
      const toplevel = resolveToplevel();
      return withDbAt(dbPath, projectPath, (db) => {
        const t = tick(db, { maxWorkers: maxWorkers(db), ttl, projectDir: toplevel, spawn: spawnWorker });
        return { ...t, reaped: sweepWorktrees(db, toplevel) };
      });
    } finally {
      release();
    }
  };
  const print = (r) => {
    const ts = o.watch ? (/* @__PURE__ */ new Date()).toISOString() : "";
    out(o.json, o.watch ? { ...r, ts } : r, () => {
      const stamp = o.watch ? `[${ts}] ` : "";
      return r.skipped ? `${stamp}tick: locked (another tick running)` : `${stamp}tick: reclaimed ${r.reclaimed}, spawned ${r.spawned}, active ${r.active}, reaped ${r.reaped}`;
    });
  };
  const pass = () => {
    try {
      print(onePass());
    } catch (e) {
      const msg = e instanceof KddError2 ? e.message : String(e);
      if (!o.watch) fail(msg, o.json);
      process.stderr.write(`[${(/* @__PURE__ */ new Date()).toISOString()}] tick error: ${msg}
`);
    }
  };
  if (!o.watch) {
    pass();
    return;
  }
  let stop = false;
  let wake;
  const onSig = () => {
    stop = true;
    wake?.();
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);
  try {
    while (!stop) {
      pass();
      if (stop) break;
      await new Promise((res) => {
        const timer = setTimeout(() => {
          wake = void 0;
          res();
        }, intervalMs);
        wake = () => {
          clearTimeout(timer);
          wake = void 0;
          res();
        };
      });
    }
  } finally {
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
  }
});
program.command("worker").argument("<id>").description("agent-mode supervisor: run claude on a task, ingest its stream into agent_events").action(async (id) => {
  const workerId = process.env.KDD_SESSION ?? `manual:${process.pid}`;
  let db;
  try {
    const taskId = parseId(id);
    const { dbPath, projectPath } = resolveDbPath2();
    const toplevel = resolveToplevel();
    const claudeCmd = process.env.KDD_CLAUDE_CMD ?? "claude";
    const allowed = process.env.KDD_ALLOWED_TOOLS ?? "Bash Read Edit Write Grep Glob";
    const [bin, ...pre] = claudeCmd.split(/\s+/);
    const args = [
      ...pre,
      "-p",
      WORKER_PROMPT,
      "--output-format",
      "stream-json",
      "--verbose",
      "--allowedTools",
      allowed
    ];
    db = openDb2(dbPath, projectPath);
    const task = mustGetTask(db, taskId);
    const workdir = ensureWorktree(toplevel, dbPath, taskId, task.title);
    await new Promise((resolve) => {
      appendAgentEvent(db, taskId, workerId, "run_start", { detail: { head: headCommit(workdir) } });
      const child = spawnProcess(bin, args, {
        cwd: workdir,
        stdio: ["ignore", "pipe", "inherit"],
        // KDD_ACTOR/KDD_SESSION НЕ хардкодим здесь — они текут из окружения самого воркера.
        // Tick-путь: tick уже выставил их (ai / tick:<nonce>-<i>) на процессе воркера, ...process.env
        // их пробрасывает — ai-gating на move-to-review сохраняется. Ручной `kdd worker <id>`
        // (без claim) — debug-aid для feed: наследует user-актора из шелла, никого не гейтит.
        // Полное продвижение задачи вручную требует предварительного `kdd claim` под тем же
        // KDD_SESSION — воркер claim'ом сознательно не владеет, им владеет tick.
        env: { ...process.env, KDD_TASK_ID: String(taskId) }
      });
      let ended = false;
      const end = (exitCode) => {
        if (ended) return;
        ended = true;
        let head;
        try {
          head = taskBranchHead(toplevel, taskId) ?? headCommit(workdir);
        } catch {
        }
        appendAgentEvent(db, taskId, workerId, "run_end", { detail: { exitCode, head } });
        resolve();
      };
      child.on("error", (e) => {
        appendAgentEvent(db, taskId, workerId, "error", { detail: { message: e.message } });
        end(null);
      });
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        for (const ev of parseClaudeStreamLine(line)) appendAgentEvent(db, taskId, workerId, ev.kind, ev);
      });
      child.on("close", (code) => {
        rl.close();
        end(code);
      });
    });
  } catch (e) {
    db?.close();
    fail(e instanceof KddError2 ? e.message : String(e), false);
  }
  db?.close();
});
program.command("feed").argument("<id>").option("--since <n>", "only events after this id").option("--json").action((id, o) => run(o.json, () => {
  const rows = withDb((db) => listAgentEvents(
    db,
    parseId(id),
    { sinceId: o.since ? Number(o.since) : 0 }
  ));
  out(o.json, rows, () => rows.map((e) => `${e.kind}${e.name ? " " + e.name : ""}${e.detail ? " " + e.detail : ""}`).join("\n") || "no activity");
}));
program.command("edit").argument("<id>").option("--title <t>").option("--body <md>").option("--body-file <path>").option("--priority <p>").option("--area <a>").option("--track <id>", 'track id, or "none" to detach').option("--json").action((id, o) => run(o.json, () => {
  const track_id = o.track === void 0 ? void 0 : o.track === "none" ? null : parseId(o.track);
  const t = withDb((db) => editTask(
    db,
    parseId(id),
    { title: o.title, body: readBody(o), priority: o.priority, area: o.area, track_id },
    getActor()
  ));
  out(o.json, t, () => `#${t.id} updated`);
}));
program.command("comment").argument("<id>").argument("<text>").option("--json").action((id, text, o) => run(o.json, () => {
  const c = withDb((db) => commentTask(db, parseId(id), text, getActor()));
  out(o.json, c, () => `#${parseId(id)} commented`);
}));
program.command("block").argument("<id>").argument("<reason>").option("--json").action((id, reason, o) => run(o.json, () => {
  const t = withDb((db) => blockTask(db, parseId(id), reason, getActor()));
  out(o.json, t, () => `#${t.id} blocked: ${reason}`);
}));
program.command("unblock").argument("<id>").option("--json").action((id, o) => run(o.json, () => {
  const t = withDb((db) => unblockTask(db, parseId(id), getActor()));
  out(o.json, t, () => `#${t.id} unblocked`);
}));
program.command("link").argument("<from>").argument("<to>").option("--kind <k>", "link kind", "relates_to").option("--json").action((from, to, o) => run(o.json, () => {
  withDb((db) => linkTasks(db, parseId(from), parseId(to), o.kind, getActor()));
  out(o.json, { ok: true }, () => `#${parseId(from)} linked to #${parseId(to)}`);
}));
program.command("archive").argument("<id>").option("--json").action((id, o) => run(o.json, () => {
  const t = withDb((db) => archiveTask(db, parseId(id), getActor()));
  out(o.json, t, () => `#${t.id} archived`);
}));
program.command("unarchive").argument("<id>").option("--json").action((id, o) => run(o.json, () => {
  const t = withDb((db) => unarchiveTask(db, parseId(id), getActor()));
  out(o.json, t, () => `#${t.id} unarchived`);
}));
program.command("recall").argument("<query>").option("-k, --limit <n>", "max results", "10").option("--kind <kind>", "decision|task").option("--json").action((query, o) => run(o.json, () => {
  const hits = withDb((db) => recall(
    db,
    resolveDecisionsDir(),
    query,
    { k: Number(o.limit), kind: o.kind }
  ));
  out(o.json, hits, () => renderRecall(hits));
}));
program.command("rebuild").option("--json").action((o) => run(o.json, () => {
  const r = withDb((db) => rebuild(db, resolveDecisionsDir()));
  out(o.json, r, () => `rebuilt: ${r.decisions} decisions, ${r.tasks} tasks indexed`);
}));
program.command("status").option("--json").action((o) => run(o.json, () => {
  const d = withDb((db) => statusDigest(db));
  out(o.json, d, () => renderStatus(d));
}));
program.command("ui").option("--port <n>", "port", "4499").action((o) => run(false, () => {
  void uiStart(Number(o.port));
}));
async function uiStart(port) {
  const { dbPath, projectPath } = resolveDbPath2();
  const hash = basename(dirname(dbPath));
  openDb2(dbPath, projectPath).close();
  const url = `http://localhost:${port}?project=${hash}`;
  try {
    const res = await fetch(`http://localhost:${port}/api/ping`, { signal: AbortSignal.timeout(500) });
    if (res.ok && (await res.json()).kdd) {
      console.log(`kdd ui: ${url} (reusing running server)`);
      return;
    }
  } catch {
  }
  const { getDb, get, closeAll } = projectPool(hash);
  const scheduler = createScheduler(tickRunner, get);
  try {
    await startUi(getDb, port, hash, scheduler);
  } catch (e) {
    scheduler.stopAll();
    closeAll();
    fail(e instanceof Error ? e.message : String(e), false);
  }
  process.on("SIGINT", () => {
    scheduler.stopAll();
    closeAll();
    process.exit(0);
  });
  console.log(`kdd ui: ${url}`);
}
var criteria = program.command("criteria").description("acceptance criteria on tasks");
criteria.command("add").argument("<taskId>").argument("<text>").option("--json").action((taskId, text, o) => run(o.json, () => {
  const c = withDb((db) => addCriterion(db, parseId(taskId), text, getActor()));
  out(o.json, c, () => `#${c.task_id} criterion ${c.id} added`);
}));
criteria.command("check").argument("<taskId>").argument("<id>").option("--json").action((taskId, id, o) => run(o.json, () => {
  const c = withDb((db) => setCriterionChecked(db, parseId(taskId), parseId(id), true, getActor()));
  out(o.json, c, () => `#${c.task_id} criterion ${c.id} checked`);
}));
criteria.command("uncheck").argument("<taskId>").argument("<id>").option("--json").action((taskId, id, o) => run(o.json, () => {
  const c = withDb((db) => setCriterionChecked(db, parseId(taskId), parseId(id), false, getActor()));
  out(o.json, c, () => `#${c.task_id} criterion ${c.id} unchecked`);
}));
criteria.command("rm").argument("<taskId>").argument("<id>").option("--json").action((taskId, id, o) => run(o.json, () => {
  withDb((db) => removeCriterion(db, parseId(taskId), parseId(id), getActor()));
  out(o.json, { ok: true }, () => `#${parseId(taskId)} criterion ${parseId(id)} removed`);
}));
criteria.command("ls").argument("<taskId>").option("--json").action((taskId, o) => run(o.json, () => {
  const cs = withDb((db) => listCriteria(db, parseId(taskId)));
  out(o.json, cs, () => renderCriteria(cs));
}));
var track = program.command("track").description("manage tracks (task groups)");
track.command("add").argument("<name>").option("--description <t>", '"use when\u2026" routing hint for the agent').option("--json").action((name, o) => run(o.json, () => {
  const t = withDb((db) => createTrack(db, { name, description: o.description }));
  out(o.json, t, () => `track #${t.id} ${t.name}`);
}));
track.command("ls").option("--all", "include completed tracks").option("--json").action((o) => run(o.json, () => {
  const ts = withDb((db) => listTracks(db, o.all ? {} : { status: "active" }));
  out(o.json, ts, () => renderTracks(ts));
}));
track.command("edit").argument("<id>").option("--name <t>").option("--description <t>").option("--json").action((id, o) => run(o.json, () => {
  const t = withDb((db) => editTrack(
    db,
    parseId(id),
    { name: o.name, description: o.description }
  ));
  out(o.json, t, () => `track #${t.id} updated`);
}));
track.command("done").argument("<id>").option("--json").action((id, o) => run(o.json, () => {
  const t = withDb((db) => editTrack(db, parseId(id), { status: "done" }));
  out(o.json, t, () => `track #${t.id} done`);
}));
track.command("reopen").argument("<id>").option("--json").action((id, o) => run(o.json, () => {
  const t = withDb((db) => editTrack(db, parseId(id), { status: "active" }));
  out(o.json, t, () => `track #${t.id} active`);
}));
track.command("rm").argument("<id>").option("--json").action((id, o) => run(o.json, () => {
  withDb((db) => deleteTrack(db, parseId(id)));
  out(o.json, { ok: true }, () => `track #${parseId(id)} deleted`);
}));
program.command("projects").option("--json").action((o) => run(o.json, () => {
  const ps = listProjects();
  out(o.json, ps, () => ps.length ? ps.map((p) => `${p.projectPath}
  ${p.dbPath}`).join("\n") : "no projects");
}));
program.command("export").action(() => run(true, () => {
  const dump = withDb((db) => exportBoard(db));
  console.log(JSON.stringify(dump));
}));
program.parse();
