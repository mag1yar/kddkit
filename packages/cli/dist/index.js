#!/usr/bin/env node

// src/index.ts
import { Command } from "commander";
import { readFileSync as readFileSync6 } from "fs";
import { basename as basename2, delimiter, dirname as dirname3, join as join6 } from "path";
import { spawn as spawnProcess2 } from "child_process";
import { networkInterfaces } from "os";
import { createInterface } from "readline";
import { fileURLToPath as fileURLToPath2 } from "url";
import lockfile from "proper-lockfile";
import {
  KddError as KddError2,
  addCriterion,
  addDecision,
  addTask,
  appendAgentEvent,
  archiveTask,
  attachFile,
  attentionData,
  authorOf,
  blockTask,
  closeDb,
  boardData,
  BUG_BODY_TEMPLATE,
  claimNext,
  claimTask,
  commentTask,
  createTrack,
  decisionDetail,
  deleteTrack,
  DEFAULT_TTL,
  detachFile,
  editTask,
  editTrack,
  ensureWorktree,
  exportBoard,
  filesDir,
  headCommit,
  kddVersion as kddVersion2,
  KINDS,
  linkTasks,
  listAgentEvents,
  listCriteria,
  listProjects,
  taskBranchHead,
  listTracks,
  maxWorkers,
  moveTask,
  mustGetTask,
  now as now3,
  openDb as openDb2,
  parseClaudeStreamLine,
  rebuild,
  recall,
  removeCriterion,
  renewClaim,
  resolveDbPath as resolveDbPath2,
  resolveDecisionsDir,
  resolveToplevel,
  setAutoTick,
  setCriterionChecked,
  setProjectToplevel,
  statusDigest,
  stopWorkers,
  storeIdentity,
  releaseInfo,
  compareVersions as compareVersions2,
  sweepWorktrees,
  syncedTaskDetail,
  taskBrief,
  tick,
  unarchiveTask,
  unblockTask
} from "@kddkit/core";
import {
  createScheduler,
  projectPool,
  startUi
} from "@kddkit/ui";

// src/context.ts
import { agentId, KddError, manualSessionFromEnv, openDb, resolveDbPath } from "@kddkit/core";
function getActor() {
  const explicit = process.env.KDD_ACTOR;
  if (explicit === "user") return { type: "user" };
  if (explicit !== "ai" && process.env.CLAUDECODE !== "1" && !process.env.CODEX_SESSION_ID && !process.env.CODEX_THREAD_ID) return { type: "user" };
  const manualSession = manualSessionFromEnv();
  return { type: "ai", id: agentId(), ...manualSession ? { manualSession } : {} };
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

// src/procs.ts
import { execFileSync } from "child_process";
import { createHash } from "crypto";
var workerTag = (taskId, dbPath) => `kdd-worker-${taskId}@${createHash("sha256").update(dbPath).digest("hex").slice(0, 12)}`;
var psAll = () => execFileSync(
  "ps",
  ["-eo", "pid=,pgid=,args="],
  { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
);
function parsePs(out2) {
  const rows = [];
  for (const line of out2.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), pgid: Number(m[2]), args: m[3] });
  }
  return rows;
}
function scan(tag, ps) {
  const rows = parsePs(ps());
  return {
    // Подстроки достаточно: хвост `@<hash>` делает метку задачи 8 не префиксом метки задачи 85.
    hits: rows.filter((r) => r.args.includes(tag)).map((r) => ({ pid: r.pid, pgid: r.pgid })),
    own: rows.find((r) => r.pid === process.pid)?.pgid
  };
}
function findWorker(tag, ps = psAll) {
  return scan(tag, ps).hits;
}
function workerAlive(tag, ps = psAll) {
  try {
    return findWorker(tag, ps).length > 0;
  } catch {
    return true;
  }
}
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function signalGroup(pgid, sig, own) {
  if (pgid <= 1 || pgid === own) return;
  try {
    process.kill(-pgid, sig);
  } catch (e) {
    if (e.code !== "ESRCH") throw e;
  }
}
function killWorkers(tags, opts = {}) {
  const { ps = psAll, termWaitMs = 2e3, killWaitMs = 500 } = opts;
  const out2 = /* @__PURE__ */ new Map();
  if (!tags.size) return out2;
  const sweep = () => {
    const rows = parsePs(ps());
    const alive = /* @__PURE__ */ new Map();
    for (const [id, tag] of tags) {
      const hits = rows.filter((r) => r.args.includes(tag)).map((r) => ({ pid: r.pid, pgid: r.pgid }));
      if (hits.length) alive.set(id, hits);
    }
    return { alive, own: rows.find((r) => r.pid === process.pid)?.pgid };
  };
  const signalAll = (alive, sig, own) => {
    const pgids = new Set([...alive.values()].flat().map((p) => p.pgid));
    for (const pgid of pgids) signalGroup(pgid, sig, own);
  };
  const first = sweep();
  for (const id of tags.keys()) if (!first.alive.has(id)) out2.set(id, "absent");
  if (!first.alive.size) return out2;
  signalAll(first.alive, "SIGTERM", first.own);
  sleepSync(termWaitMs);
  const second = sweep();
  for (const id of first.alive.keys()) if (!second.alive.has(id)) out2.set(id, "gone");
  if (!second.alive.size) return out2;
  signalAll(second.alive, "SIGKILL", second.own);
  sleepSync(killWaitMs);
  const third = sweep();
  for (const id of second.alive.keys()) out2.set(id, third.alive.has(id) ? "stuck" : "gone");
  return out2;
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
  if (t.kind !== "feature") bits.push(`{${t.kind}}`);
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
function renderAttention(inbox) {
  const oneLine = (value) => value.replace(/[\r\n]+/g, " ");
  const lines = inbox.items.map(
    (item) => `#${item.id} [${item.reason}] ${oneLine(item.title)} (${item.status})${item.block_reason ? ` \u2014 ${oneLine(item.block_reason)}` : ""}`
  );
  if (lines.length === 0) lines.push("attention: none");
  if (inbox.omitted > 0) lines.push(`(+${inbox.omitted} omitted)`);
  return lines.join("\n");
}
function renderManual(lines, provenance) {
  if (!provenance) return;
  lines.push("manual provenance:");
  for (const [key, value] of Object.entries(provenance)) lines.push(`  ${key}: ${value}`);
}
function renderHandoffs(lines, handoffs, omitted) {
  if (!handoffs.length && !omitted) return;
  lines.push("handoffs:");
  for (const handoff of handoffs) {
    lines.push(`  ${handoff.from_client}:${handoff.from_session_id} -> ${handoff.to_client}:${handoff.to_session_id} (event #${handoff.event_id})`);
  }
  if (omitted) lines.push(`  (+${omitted} omitted)`);
}
function renderShow(d) {
  const t = d.task;
  const lines = [
    `#${t.id} ${t.title}`,
    `status: ${t.status}${t.blocked ? ` (BLOCKED: ${t.block_reason})` : ""}  kind: ${t.kind}  priority: ${t.priority}${t.area ? `  area: ${t.area}` : ""}${t.archived_at ? "  ARCHIVED" : ""}`
  ];
  if (d.files_total) {
    lines.push("", `files (${d.files_total}):`);
    if (d.files.length < d.files_total) {
      lines.push(`  (${d.files_total - d.files.length} more omitted)`);
    }
    for (const f of d.files) {
      lines.push(`  [${f.id}] ${f.original_name} ${f.mime_type ?? "unknown"} ${f.size_bytes}B  ${f.path}`);
      if (f.description) lines.push(`      ${f.description}`);
    }
  }
  if (t.body) lines.push("", t.body);
  if (d.criteria.length) {
    lines.push("", "criteria:", renderCriteria(d.criteria));
  }
  if (d.links.length) {
    lines.push("", "links:");
    for (const l of d.links) lines.push(`  ${l.kind} #${l.id} ${cap(l.title, CAPS.titleChars)}`);
  }
  if (d.decisions_total) {
    lines.push("", `decisions (${d.decisions_total}):`);
    if (d.decisions.length < d.decisions_total) {
      lines.push(`  (+${d.decisions_total - d.decisions.length} more omitted)`);
    }
    for (const decision of d.decisions) {
      const superseded = decision.superseded_by ? ` [superseded by ${cap(decision.superseded_by, CAPS.titleChars)}]` : "";
      lines.push(`  decision ${decision.slug}${superseded} ${decision.title}`);
    }
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
  if (d.manual_provenance || d.handoffs_total) lines.push("");
  renderManual(lines, d.manual_provenance);
  renderHandoffs(lines, d.handoffs, d.handoffs_total - d.handoffs.length);
  lines.push("", "history:");
  for (const e of d.events) {
    lines.push(`  ${renderAge(e.created_at)} ago ${e.actor_type} ${e.action}${e.detail ? ` ${e.detail}` : ""}`);
  }
  return lines.join("\n");
}
function renderBrief(brief) {
  const { task } = brief;
  const lines = [
    `#${task.id} ${task.title}`,
    `status: ${task.status}${task.blocked ? " BLOCKED" : ""}${task.archived_at !== null ? ` ARCHIVED @${task.archived_at}` : ""}`,
    `priority: ${task.priority}`,
    `kind: ${task.kind}`,
    `area: ${task.area ?? "none"}`
  ];
  if (task.block_reason) lines.push(`blocker: ${task.block_reason}`);
  if (task.goal) lines.push(`goal: ${task.goal}`);
  if (brief.criteria.items.length || brief.criteria.omitted) {
    lines.push("criteria:");
    for (const criterion2 of brief.criteria.items) {
      const checked = criterion2.checked_at === null ? " " : `x @${criterion2.checked_at}`;
      lines.push(`  [${checked}] ${criterion2.id}. ${criterion2.text}`);
      if (criterion2.evidence) lines.push(`      evidence: ${criterion2.evidence}`);
      if (criterion2.checked_by) lines.push(`      checked by: ${criterion2.checked_by}`);
    }
    if (brief.criteria.omitted) lines.push(`  (+${brief.criteria.omitted} omitted)`);
  }
  if (brief.comments.items.length || brief.comments.omitted) {
    lines.push("comments:");
    for (const comment of brief.comments.items) {
      lines.push(`  [${comment.id} @${comment.created_at} ${comment.author}] ${comment.body}`);
    }
    if (brief.comments.omitted) lines.push(`  (+${brief.comments.omitted} omitted)`);
  }
  if (brief.events.items.length || brief.events.omitted) {
    lines.push("events:");
    for (const event of brief.events.items) {
      lines.push(`  [${event.id} @${event.created_at} ${event.actor_type}${event.actor_id ? `:${event.actor_id}` : ""}] ${event.action}${event.detail ? ` ${event.detail}` : ""}`);
    }
    if (brief.events.omitted) lines.push(`  (+${brief.events.omitted} omitted)`);
  }
  if (brief.links.items.length || brief.links.omitted) {
    lines.push("links:");
    for (const link of brief.links.items) lines.push(`  ${link.kind} #${link.id} ${link.title}`);
    if (brief.links.omitted) lines.push(`  (+${brief.links.omitted} omitted)`);
  }
  if (brief.decisions.items.length || brief.decisions.omitted) {
    lines.push("decisions:");
    for (const decision of brief.decisions.items) {
      lines.push(`  ${decision.slug} ${decision.title}${decision.created ? ` [created ${decision.created}]` : ""}${decision.superseded_by ? ` [superseded by ${decision.superseded_by}]` : ""}`);
    }
    if (brief.decisions.omitted) lines.push(`  (+${brief.decisions.omitted} omitted)`);
  }
  if (brief.files.items.length || brief.files.omitted) {
    lines.push("files:");
    for (const file of brief.files.items) {
      lines.push(`  [${file.id}] ${file.name} ${file.mime_type ?? "unknown"} ${file.size_bytes}B ${file.path}`);
      if (file.description) lines.push(`      ${file.description}`);
    }
    if (brief.files.omitted) lines.push(`  (+${brief.files.omitted} omitted)`);
  }
  renderManual(lines, brief.manual_provenance);
  renderHandoffs(lines, brief.handoffs.items, brief.handoffs.omitted);
  if (brief.provenance) {
    lines.push("worker provenance:");
    for (const [key, value] of Object.entries(brief.provenance)) lines.push(`  ${key}: ${value}`);
  }
  if (brief.worker_provenance_omitted) lines.push("worker provenance omitted");
  const criterion = brief.next_action.criterion_id === void 0 ? "" : ` criterion #${brief.next_action.criterion_id}`;
  lines.push(`next [${brief.next_action.kind}${criterion}]: ${brief.next_action.text}`);
  lines.push(`budget: ${brief.budget.max_bytes} bytes`);
  return lines.join("\n");
}
function renderDecision(d) {
  const lines = [
    cap(d.title, CAPS.titleChars),
    `slug: ${d.slug}  status: ${cap(d.status, CAPS.titleChars)}`,
    `path: ${d.path}`
  ];
  const sources = d.source_tasks.slice(0, CAPS.decisionSources);
  lines.push("", `source tasks (${d.source_tasks.length}):`);
  if (sources.length < d.source_tasks.length) {
    lines.push(`  (+${d.source_tasks.length - sources.length} more omitted)`);
  }
  for (const task of sources) {
    lines.push(`  #${task.id} [${task.status}] ${cap(task.title, CAPS.titleChars)}${task.archived_at ? " ARCHIVED" : ""}`);
  }
  if (d.body) lines.push("", cap(d.body, CAPS.bodyChars));
  return lines.join("\n");
}
function renderCriteria(cs) {
  if (cs.length === 0) return "no criteria";
  return cs.flatMap((c) => {
    const lines = [`  [${c.checked_at ? "x" : " "}] ${c.id}. ${c.text}`];
    if (c.evidence) lines.push(`      evidence: ${c.evidence}`);
    if (c.checked_at && c.checked_by) {
      lines.push(`      checked by ${c.checked_by} ${renderAge(c.checked_at)} ago`);
    }
    return lines;
  }).join("\n");
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
  const mkSection = (name, ts) => ({
    header: `${name} (${ts.length})`,
    total: ts.length,
    rows: ts.slice(0, CAPS.statusRows).map(taskLine)
  });
  const sections = [
    mkSection("in_progress", d.in_progress),
    mkSection("review", d.review),
    mkSection("blocked", d.blocked)
  ];
  const recent = d.recent.map((e) => `  ${renderAge(e.created_at)} ago ${e.actor_type} ${e.action} #${e.task_id ?? "-"}`);
  let recentHidden = 0;
  const render = () => {
    const lines = [];
    for (const s of sections) {
      lines.push(s.header, ...s.rows);
      const hidden = s.total - s.rows.length;
      if (hidden > 0) lines.push(`  (+${hidden} more)`);
    }
    lines.push("recent:", ...recent);
    if (recentHidden > 0) lines.push(`  (+${recentHidden} more, see kdd show <id> for history)`);
    return lines.join("\n");
  };
  while (Buffer.byteLength(render(), "utf8") > CAPS.statusBytes) {
    if (recent.length > 0) {
      recent.pop();
      recentHidden++;
      continue;
    }
    const s = [...sections].reverse().find((s2) => s2.rows.length > 0);
    if (!s) break;
    s.rows.pop();
  }
  return render();
}

// src/tick-runner.ts
import { spawn as spawnProcess } from "child_process";
import { dirname } from "path";
import { now as now2 } from "@kddkit/core";

// src/tick-output.ts
function parseTickOutput(out2, err, code, at) {
  const zero = { at, reclaimed: 0, killed: 0, stuck: 0, spawned: 0, active: 0, reaped: 0 };
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
    killed: num(obj.killed),
    stuck: num(obj.stuck),
    spawned: num(obj.spawned),
    active: num(obj.active),
    reaped: num(obj.reaped)
  };
}

// src/tick-runner.ts
function createStopRunner(scriptPath, spawnFn = spawnProcess) {
  return ({ dbPath, projectPath, toplevel }) => new Promise((resolve, reject) => {
    const child = spawnFn(process.execPath, [scriptPath, "stop"], {
      cwd: toplevel ?? dirname(projectPath),
      env: { ...process.env, KDD_DB: dbPath },
      stdio: ["ignore", "ignore", "pipe"]
    });
    let err = "";
    child.stderr?.on("data", (d) => {
      err += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`kdd stop exited ${code}: ${err.trim()}`));
    });
  });
}
function createTickRunner(scriptPath, killTimeoutMs, spawnFn = spawnProcess, killGraceMs = 5e3) {
  return ({ dbPath, projectPath, toplevel }) => new Promise((resolve) => {
    const child = spawnFn(
      process.execPath,
      [scriptPath, "tick", "--json"],
      {
        // cwd нужен tick'у, чтобы резолвить toplevel для воркеров; базу пиннит KDD_DB.
        // Родитель projectPath (git common-dir) — верный toplevel только для обычного
        // <repo>/.git: у submodule это <super>/.git/modules, у --separate-git-dir и у
        // bare-репо с linked worktree он тоже расходится с toplevel. Fallback нужен
        // только для досок без project_toplevel в meta (созданы до этого поля) — и это
        // ДОГАДКА по чужому cwd, а не факт: KDD_TICK_SPAWNED ниже запрещает этому же
        // ребёнку поверить в свою догадку и записать её обратно в meta как истину.
        // Такую доску чинит только `kdd tick`/`kdd ui`, запущенный руками из настоящего
        // репозитория — там cwd honest, см. onePass/uiStart в index.ts.
        cwd: toplevel ?? dirname(projectPath),
        env: { ...process.env, KDD_DB: dbPath, KDD_TICK_SPAWNED: "1" },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let out2 = "";
    let err = "";
    let timedOut = false;
    child.stdout.on("data", (d) => {
      out2 += d.toString();
    });
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    let escalation;
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      escalation = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
      escalation.unref?.();
    }, killTimeoutMs);
    const settle = (run2) => {
      clearTimeout(killer);
      if (escalation) clearTimeout(escalation);
      resolve(run2);
    };
    child.on("error", (e) => {
      settle({ at: now2(), reclaimed: 0, killed: 0, stuck: 0, spawned: 0, active: 0, reaped: 0, error: e.message });
    });
    child.on("close", (code) => {
      if (timedOut) {
        settle({
          at: now2(),
          reclaimed: 0,
          killed: 0,
          stuck: 0,
          spawned: 0,
          active: 0,
          reaped: 0,
          error: `kdd tick killed after exceeding ${killTimeoutMs}ms timeout`
        });
        return;
      }
      settle(parseTickOutput(out2, err, code, now2()));
    });
  });
}

// src/prompt.ts
var COMMIT_TYPE = {
  feature: "feat",
  bug: "fix",
  chore: "chore",
  research: "docs"
};
var BODY = {
  feature: "Read the acceptance criteria first \u2014 they are the definition of done \u2014 then implement them.",
  bug: "Reproduce the failure first, then find its cause. Fix the CAUSE, not the symptom: grep every caller of the function you are about to touch, because a guard in one caller leaves its siblings broken. Add a test that fails on that cause and passes after your fix, and make sure the whole suite is green \u2014 a fix that breaks a neighbour is not a fix.",
  chore: "Read the acceptance criteria first \u2014 they are the definition of done. No behaviour test is expected here; the existing suite must stay green.",
  research: "The deliverable is a written decision, not code. Investigate, then propose the outcome in your summary comment \u2014 decision, rationale, and alternatives considered \u2014 for a human to record with `kdd decide`; decisions are human-gated, so do not run that command yourself."
};
var scopeOf = (area) => area && /^[a-z0-9._-]+$/i.test(area) ? `(${area})` : "";
function workerPrompt(kind, area) {
  return `You are a kdd agent worker. Read your task: run \`kdd show $KDD_TASK_ID\`. Do the work in this repository. ${BODY[kind]} Commit your work as \`${COMMIT_TYPE[kind]}${scopeOf(area)}: <subject>\` \u2014 the changelog is generated from commit subjects, and a non-conventional subject is silently dropped. When done, leave ONE concise summary comment (\`kdd comment $KDD_TASK_ID "<what you changed and why; caveats or follow-ups>"\`) \u2014 this is the durable note humans and future sessions read, so keep it tight, not a log. Then check acceptance criteria (\`kdd criteria ls $KDD_TASK_ID\`, then \`kdd criteria check $KDD_TASK_ID <criterionId> --evidence "<test command, URL, commit, attachment, or note>"\` when evidence is available) and \`kdd move $KDD_TASK_ID review\`. If you get blocked or must stop early, comment the reason first.`;
}

// src/update-notifier.ts
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { compareVersions, kddHome, kddVersion } from "@kddkit/core";
function readUpdateCache(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object") return null;
    const { latest, checkedAt } = value;
    if (latest !== null && (typeof latest !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(latest))) return null;
    if (typeof checkedAt !== "number" || !Number.isFinite(checkedAt) || checkedAt < 0) return null;
    return { latest, checkedAt };
  } catch {
    return null;
  }
}
function shouldRefresh(cache, now4) {
  if (!cache || cache.checkedAt > now4) return true;
  return now4 - cache.checkedAt >= (cache.latest ? 24 * 60 * 6e4 : 5 * 6e4);
}
function eligible(argv, env) {
  if (env.CI || env.NO_UPDATE_NOTIFIER || env.CLAUDECODE === "1" || env.CODEX_SESSION_ID || env.CODEX_THREAD_ID || env.KDD_ACTOR === "ai" || env.npm_command === "exec") return false;
  if (argv.some((arg) => ["--json", "--help", "-h", "--version", "-V"].includes(arg))) return false;
  return !["update", "worker", "help"].includes(argv[0] ?? "");
}
function noticeOnStartup(argv = process.argv.slice(2), env = process.env) {
  if (!eligible(argv, env)) return;
  const path = join(kddHome(), "update-check.json");
  const cache = readUpdateCache(path);
  if (cache?.latest && compareVersions(cache.latest, kddVersion()) > 0)
    process.stderr.write(`kdd: v${cache.latest} available; run kdd update
`);
  if (!shouldRefresh(cache, Date.now())) return;
  try {
    const worker = fileURLToPath(new URL("./update-check-worker.js", import.meta.url));
    const child = spawn(process.execPath, [worker], { detached: true, stdio: "ignore" });
    child.on("error", () => {
    });
    child.unref();
  } catch {
  }
}

// src/update.ts
import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync as readFileSync5, realpathSync as realpathSync2, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname as dirname2, isAbsolute, join as join5 } from "path";
import { kddHome as kddHome2, updateDisposition as updateDisposition3 } from "@kddkit/core";

// src/update-claude.ts
import { execFileSync as execFileSync2 } from "child_process";
import { readFileSync as readFileSync3, realpathSync } from "fs";
import { homedir } from "os";
import { join as join3 } from "path";
import { updateDisposition } from "@kddkit/core";

// src/update-git.ts
import { mkdtempSync, readFileSync as readFileSync2, rmSync } from "fs";
import { tmpdir } from "os";
import { join as join2 } from "path";
function preflightGitPlugin(url, ref, version, client, run2, cwd) {
  const dir = mkdtempSync(join2(tmpdir(), "kdd-update-ref-"));
  const checkout = join2(dir, "checkout");
  try {
    const cloned = run2("git", ["clone", "--depth", "1", "--branch", ref, url, checkout], cwd);
    if (cloned.status !== 0) return `Git ref ${ref} is unavailable: ${cloned.stderr.trim() || cloned.error?.message || cloned.stdout.trim()}`;
    const marketplacePath = client === "claude" ? ".claude-plugin/marketplace.json" : ".agents/plugins/marketplace.json";
    const manifestPath = client === "claude" ? ".claude-plugin/plugin.json" : "integrations/codex-plugin/.codex-plugin/plugin.json";
    const marketplace2 = JSON.parse(readFileSync2(join2(checkout, marketplacePath), "utf8"));
    const manifest = JSON.parse(readFileSync2(join2(checkout, manifestPath), "utf8"));
    if (marketplace2.name !== "kddkit" || !Array.isArray(marketplace2.plugins) || !marketplace2.plugins.some((plugin2) => plugin2?.name === "kddkit") || manifest.name !== "kddkit" || manifest.version !== version)
      return `Git ref ${ref} does not contain kddkit ${version} for ${client}.`;
    return null;
  } catch (error) {
    return `Could not verify Git ref ${ref}: ${error instanceof Error ? error.message : error}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// src/update-claude.ts
var outcome = (status, detail) => ({ name: "claude", status, detail });
var errorText = (r) => (r.stderr.trim() || r.error?.message || r.stdout.trim() || "unknown error").slice(0, 500);
function gitRoot(cwd) {
  try {
    return realpathSync(execFileSync2(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim());
  } catch {
    return null;
  }
}
function pluginRows(run2, cwd) {
  const listed = run2("claude", ["plugin", "list", "--json"], cwd);
  if (listed.error?.code === "ENOENT") return outcome("skipped", "Claude Code CLI is not installed.");
  if (listed.status !== 0) return outcome("failed", `claude plugin list failed: ${errorText(listed)}`);
  try {
    const parsed = JSON.parse(listed.stdout);
    if (!Array.isArray(parsed)) throw new Error("invalid list");
    const rows = parsed.filter((row) => row?.id === "kddkit@kddkit");
    if (rows.some((row) => typeof row.version !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(row.version) || typeof row.scope !== "string" || typeof row.enabled !== "boolean")) throw new Error("invalid plugin");
    return rows;
  } catch {
    return outcome("failed", "claude plugin list returned invalid plugin data.");
  }
}
function marketplaceRows(run2, cwd) {
  const listed = run2("claude", ["plugin", "marketplace", "list", "--json"], cwd);
  if (listed.status !== 0) return outcome("failed", `claude marketplace list failed: ${errorText(listed)}`);
  try {
    const parsed = JSON.parse(listed.stdout);
    if (!Array.isArray(parsed)) throw new Error("invalid list");
    return parsed.filter((row) => row?.name === "kddkit");
  } catch {
    return outcome("failed", "claude marketplace list returned invalid data.");
  }
}
function declarations(root) {
  const config = process.env.CLAUDE_CONFIG_DIR ?? join3(homedir(), ".claude");
  const files = [["user", join3(config, "settings.json")]];
  if (root) files.push(
    ["project", join3(root, ".claude/settings.json")],
    ["local", join3(root, ".claude/settings.local.json")]
  );
  const out2 = [];
  for (const [scope, file] of files) {
    let data;
    try {
      data = JSON.parse(readFileSync3(file, "utf8"));
    } catch {
      continue;
    }
    const s = data?.extraKnownMarketplaces?.kddkit?.source;
    if (!s) continue;
    if (s.source === "github" && s.repo === "mag1yar/kddkit" && (s.ref === void 0 || typeof s.ref === "string"))
      out2.push({ kind: "github", base: s.repo, ref: s.ref, scope });
    else if (s.source === "git" && typeof s.url === "string" && /^(https:\/\/github\.com\/mag1yar\/kddkit(?:\.git)?|git@github\.com:mag1yar\/kddkit(?:\.git)?)$/.test(s.url) && (s.ref === void 0 || typeof s.ref === "string"))
      out2.push({ kind: "git", base: s.url, ref: s.ref, scope });
    else out2.push({ kind: "git", base: "", scope });
  }
  return out2;
}
function sourceArg(s, ref) {
  return `${s.base}${ref ? `${s.kind === "github" ? "@" : "#"}${ref}` : ""}`;
}
function matchesSource(s, market) {
  return market.length === 1 && market[0].source === s.kind && (s.kind === "github" ? market[0].repo === s.base : market[0].url === s.base) && market[0].ref === s.ref;
}
function matchesPlugins(rows, original, version) {
  return rows.length === original.length && original.every((old) => rows.some((row) => row.scope === old.scope && row.enabled === old.enabled && row.version === (version ?? old.version) && (old.scope === "user" || row.projectPath === old.projectPath)));
}
function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}
function updateClaude(target, channel, run2, cwd) {
  const first = pluginRows(run2, cwd);
  if (!Array.isArray(first)) return [first];
  if (!first.length) return [outcome("skipped", "kddkit is not installed in Claude Code.")];
  const root = gitRoot(cwd);
  if (new Set(first.map((row) => `${row.scope}:${row.projectPath ?? ""}`)).size !== first.length)
    return [outcome("skipped", "Claude plugin has duplicate scope declarations.")];
  const owned = first.filter((row) => ["user", "project", "local"].includes(row.scope) && (row.scope === "user" || !!root && !!row.projectPath && realPath(row.projectPath) === root));
  if (!owned.length) return [outcome("skipped", "Claude plugin is managed or belongs to another project.")];
  const skipped = owned.length === first.length ? [] : [outcome("skipped", "Claude plugin scopes outside this project were left unchanged.")];
  const sources = declarations(root);
  if (sources.length !== 1 || !sources[0].base)
    return [outcome("skipped", "Claude marketplace source or declaration scope is ambiguous or unsupported.")];
  const source = sources[0];
  const market = marketplaceRows(run2, cwd);
  if (!Array.isArray(market)) return [market];
  if (!matchesSource(source, market)) return [outcome("skipped", "Claude marketplace list disagrees with its declaration.")];
  const ref = channel === "stable" ? "master" : "next";
  if (source.ref !== ref && skipped.length) return [outcome(
    "skipped",
    "Claude marketplace ref switch would uninstall a plugin scope outside this project."
  )];
  const active = source.ref === ref ? owned : first;
  const dispositions = active.map((row) => updateDisposition(row.version, target, channel));
  if (dispositions.includes("ahead")) return [...skipped, outcome("current", `At least one Claude plugin is ahead of ${target}; no scope was changed.`)];
  if (dispositions.every((value) => value === "current") && source.ref === ref)
    return [...skipped, outcome("current", `Claude plugin is already ${target} on ${ref}.`)];
  const url = source.kind === "github" ? `https://github.com/${source.base}.git` : source.base;
  const preflight = preflightGitPlugin(url, ref, target, "claude", run2, cwd);
  if (preflight) return [outcome("failed", preflight)];
  const label = `Claude ${active.map((row) => row.scope).join(", ")} scope${active.length > 1 ? "s" : ""}`;
  if (source.ref === ref) {
    const refresh = run2("claude", ["plugin", "marketplace", "update", "kddkit"], cwd);
    if (refresh.status !== 0) return [outcome("failed", `${label}: marketplace refresh failed: ${errorText(refresh)}`)];
    for (const row of active) {
      if (updateDisposition(row.version, target, channel) === "current") continue;
      const args = ["plugin", "update", "kddkit@kddkit", "--scope", row.scope];
      const updated = run2("claude", args, cwd);
      if (updated.status !== 0) return [...skipped, outcome("failed", /confirm|approv|\btty\b|-y\b/i.test(errorText(updated)) ? `${label}: interactive approval required; run claude ${args.join(" ")} in a terminal.` : `${label}: update failed: ${errorText(updated)}`)];
    }
    const checked = pluginRows(run2, cwd);
    const expected = first.map((row) => active.includes(row) ? { ...row, version: target } : row);
    if (!Array.isArray(checked) || !matchesPlugins(checked, expected))
      return [...skipped, outcome("failed", `${label}: expected ${target} after update.`)];
    return [...skipped, outcome("updated", `${label}: updated to ${target}; verified.`)];
  }
  const removed = run2("claude", ["plugin", "marketplace", "remove", "kddkit", "--scope", source.scope], cwd);
  if (removed.status !== 0) return [outcome("failed", `${label}: marketplace remove failed: ${errorText(removed)}`)];
  let problem = null;
  const added = run2("claude", ["plugin", "marketplace", "add", sourceArg(source, ref), "--scope", source.scope], cwd);
  if (added.status !== 0) problem = `target marketplace add failed: ${errorText(added)}`;
  else for (const row of first) {
    const installedResult = run2("claude", ["plugin", "install", "kddkit@kddkit", "--scope", row.scope], cwd);
    if (installedResult.status !== 0) problem = /confirm|approv|\btty\b|-y\b/i.test(errorText(installedResult)) ? `interactive approval required; run claude plugin install kddkit@kddkit --scope ${row.scope} in a terminal` : `target plugin install failed in ${row.scope}: ${errorText(installedResult)}`;
    else if (!row.enabled) {
      const disabled = run2("claude", ["plugin", "disable", "kddkit@kddkit", "--scope", row.scope], cwd);
      if (disabled.status !== 0) problem = `could not restore ${row.scope} disabled state: ${errorText(disabled)}`;
    }
    if (problem) break;
  }
  if (!problem) {
    const checked = pluginRows(run2, cwd);
    const nextMarket = marketplaceRows(run2, cwd);
    if (!Array.isArray(checked) || !Array.isArray(nextMarket) || !matchesPlugins(checked, first, target) || !matchesSource({ ...source, ref }, nextMarket))
      problem = `expected ${target} on ${ref} after switch`;
  }
  if (!problem) return [outcome("updated", `${label}: updated to ${target} on ${ref}; verified.`)];
  const partial = marketplaceRows(run2, cwd);
  if (Array.isArray(partial) && partial.length)
    run2("claude", ["plugin", "marketplace", "remove", "kddkit", "--scope", source.scope], cwd);
  const restored = run2("claude", ["plugin", "marketplace", "add", sourceArg(source, source.ref), "--scope", source.scope], cwd);
  if (restored.status === 0) {
    for (const row of first) {
      const reinstalled = run2("claude", ["plugin", "install", "kddkit@kddkit", "--scope", row.scope], cwd);
      if (reinstalled.status === 0 && !row.enabled)
        run2("claude", ["plugin", "disable", "kddkit@kddkit", "--scope", row.scope], cwd);
    }
    const checked = pluginRows(run2, cwd);
    const oldMarket = marketplaceRows(run2, cwd);
    if (Array.isArray(checked) && Array.isArray(oldMarket) && matchesPlugins(checked, first) && matchesSource(source, oldMarket))
      return [outcome("failed", `${label}: ${problem}; original plugin restored.`)];
  }
  return [outcome("failed", `${label}: ${problem}; CRITICAL: rollback failed. Restore ${sourceArg(source, source.ref)} in ${source.scope} scope and the original plugin scopes/versions manually.`)];
}

// src/update-codex.ts
import { readFileSync as readFileSync4 } from "fs";
import { homedir as homedir2 } from "os";
import { join as join4 } from "path";
import { updateDisposition as updateDisposition2 } from "@kddkit/core";
import { parse } from "smol-toml";
var outcome2 = (status, detail) => ({ name: "codex", status, detail });
var errorText2 = (r) => (r.stderr.trim() || r.error?.message || r.stdout.trim() || "unknown error").slice(0, 500);
var configPath = () => join4(process.env.CODEX_HOME ?? join4(homedir2(), ".codex"), "config.toml");
function readCodexSource(file) {
  try {
    const doc = parse(readFileSync4(file, "utf8"));
    const market = doc.marketplaces?.kddkit;
    if (!market || market.source_type !== "git" || typeof market.source !== "string" || market.ref !== void 0 && typeof market.ref !== "string" || market.ref_name !== void 0 && typeof market.ref_name !== "string" || market.ref !== void 0 && market.ref_name !== void 0 && market.ref !== market.ref_name || market.sparse_paths !== void 0 && (!Array.isArray(market.sparse_paths) || market.sparse_paths.some((path) => typeof path !== "string"))) return null;
    const ref = market.ref ?? market.ref_name;
    return {
      source: market.source,
      ...ref !== void 0 ? { ref } : {},
      sparsePaths: market.sparse_paths ?? []
    };
  } catch {
    return null;
  }
}
function plugin(run2) {
  const listed = run2("codex", ["plugin", "list", "--json"]);
  if (listed.error?.code === "ENOENT") return outcome2("skipped", "Codex CLI is not installed.");
  if (listed.status !== 0) return outcome2("failed", `codex plugin list failed: ${errorText2(listed)}`);
  try {
    const parsed = JSON.parse(listed.stdout);
    if (!Array.isArray(parsed?.installed)) throw new Error("invalid list");
    const rows = parsed.installed.filter((row) => row?.pluginId === "kddkit@kddkit");
    if (rows.length > 1 || rows.some((row) => !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(row.version) || row.installed !== true || typeof row.enabled !== "boolean" || typeof row.marketplaceSource?.sourceType !== "string" || typeof row.marketplaceSource?.source !== "string")) throw new Error("invalid plugin");
    return rows[0] ?? null;
  } catch {
    return outcome2("failed", "codex plugin list returned invalid plugin data.");
  }
}
function marketplace(run2) {
  const listed = run2("codex", ["plugin", "marketplace", "list", "--json"]);
  if (listed.status !== 0) return outcome2("failed", `codex marketplace list failed: ${errorText2(listed)}`);
  try {
    const parsed = JSON.parse(listed.stdout);
    if (!Array.isArray(parsed?.marketplaces)) throw new Error("invalid list");
    const rows = parsed.marketplaces.filter((row) => row?.name === "kddkit");
    if (rows.length > 1) throw new Error("ambiguous marketplace");
    return rows[0] ?? null;
  } catch {
    return outcome2("failed", "codex marketplace list returned invalid data.");
  }
}
function addArgs(source, ref) {
  return [
    "plugin",
    "marketplace",
    "add",
    source.source,
    ...ref ? ["--ref", ref] : [],
    ...source.sparsePaths.flatMap((path) => ["--sparse", path])
  ];
}
function sameSource(a, b, ref) {
  return !!a && a.source === b.source && a.ref === ref && a.sparsePaths.length === b.sparsePaths.length && a.sparsePaths.every((path, i) => path === b.sparsePaths[i]);
}
function observed(run2, source, ref, version, enabled) {
  const row = plugin(run2);
  const market = marketplace(run2);
  return !!row && "pluginId" in row && row.version === version && row.enabled === enabled && row.marketplaceSource.sourceType === "git" && row.marketplaceSource.source === source.source && !!market && !("status" in market) && market.marketplaceSource?.sourceType === "git" && market.marketplaceSource.source === source.source && sameSource(readCodexSource(configPath()), source, ref);
}
function updateCodex(target, channel, run2) {
  const first = plugin(run2);
  if (first === null) return outcome2("skipped", "kddkit is not installed in Codex.");
  if ("status" in first) return first;
  if (!first.enabled) return outcome2("skipped", "Codex plugin is disabled; its manager would re-enable it during reinstall.");
  if (first.marketplaceSource.sourceType !== "git") return outcome2(
    "skipped",
    `Codex marketplace is ${first.marketplaceSource.sourceType}; update its source manually.`
  );
  const source = readCodexSource(configPath());
  if (!source || !/^(https:\/\/github\.com\/mag1yar\/kddkit(?:\.git)?|git@github\.com:mag1yar\/kddkit(?:\.git)?)$/.test(source.source))
    return outcome2("skipped", "Codex Git marketplace config is absent, invalid, or unrelated.");
  const market = marketplace(run2);
  if (!market || "status" in market || market.marketplaceSource?.sourceType !== "git" || market.marketplaceSource.source !== source.source || first.marketplaceSource.source !== source.source)
    return outcome2("skipped", "Codex marketplace source disagrees with config or plugin.");
  const ref = channel === "stable" ? "master" : "next";
  const disposition = updateDisposition2(first.version, target, channel);
  if (disposition === "ahead") return outcome2("current", `Codex plugin ${first.version} is ahead of ${target}.`);
  if (disposition === "current" && source.ref === ref) return outcome2("current", `Codex plugin is already ${target} on ${ref}.`);
  const preflight = preflightGitPlugin(source.source, ref, target, "codex", run2);
  if (preflight) return outcome2("failed", preflight);
  if (source.ref === ref) {
    const upgraded = run2("codex", ["plugin", "marketplace", "upgrade", "kddkit"]);
    if (upgraded.status !== 0) return outcome2("failed", `Codex marketplace upgrade failed: ${errorText2(upgraded)}`);
    if (!observed(run2, source, ref, target, first.enabled)) {
      const added2 = run2("codex", ["plugin", "add", "kddkit@kddkit"]);
      if (added2.status !== 0) return outcome2("failed", `Codex plugin add failed: ${errorText2(added2)}`);
    }
    return observed(run2, source, ref, target, first.enabled) ? outcome2("updated", `${first.version} \u2192 ${target}; verified.`) : outcome2("failed", `Codex plugin did not reach ${target} on ${ref}.`);
  }
  const removed = run2("codex", ["plugin", "marketplace", "remove", "kddkit"]);
  if (removed.status !== 0) return outcome2("failed", `Codex marketplace remove failed: ${errorText2(removed)}`);
  let problem = null;
  const added = run2("codex", addArgs(source, ref));
  if (added.status !== 0) problem = `target marketplace add failed: ${errorText2(added)}`;
  else if (!observed(run2, source, ref, target, first.enabled)) {
    const installed = run2("codex", ["plugin", "add", "kddkit@kddkit"]);
    if (installed.status !== 0) problem = `target plugin add failed: ${errorText2(installed)}`;
  }
  if (!problem && !observed(run2, source, ref, target, first.enabled))
    problem = `Codex plugin did not reach ${target} on ${ref}`;
  if (!problem) return outcome2("updated", `${first.version} \u2192 ${target} on ${ref}; verified.`);
  const partial = marketplace(run2);
  if (partial && !("status" in partial)) run2("codex", ["plugin", "marketplace", "remove", "kddkit"]);
  const restored = run2("codex", addArgs(source, source.ref));
  if (restored.status === 0) {
    if (!observed(run2, source, source.ref, first.version, first.enabled))
      run2("codex", ["plugin", "add", "kddkit@kddkit"]);
    if (observed(run2, source, source.ref, first.version, first.enabled))
      return outcome2("failed", `${problem}; original Codex plugin restored.`);
  }
  return outcome2("failed", `${problem}; CRITICAL: rollback failed. Restore ${source.source} ref ${source.ref ?? "(default)"} with sparse paths ${source.sparsePaths.join(", ")} and plugin ${first.version} manually.`);
}

// src/update.ts
var runCommand = (file, args, cwd) => {
  const result = spawnSync(file, args, {
    cwd,
    encoding: "utf8",
    timeout: 5 * 6e4,
    maxBuffer: 1024 * 1024
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...result.error ? { error: result.error } : {}
  };
};
function preflightTarget(target, channel, run2) {
  const tag = channel === "stable" ? "latest" : "next";
  const result = run2("npm", ["view", "@kddkit/cli", "dist-tags", "--json", "--registry=https://registry.npmjs.org"]);
  if (result.status !== 0) return `npm dist-tags check failed: ${result.stderr.trim() || result.error?.message || result.stdout.trim()}`;
  try {
    const tags = JSON.parse(result.stdout);
    if (!tags || typeof tags !== "object" || typeof tags[tag] !== "string")
      return `npm dist-tags has no ${tag} version.`;
    if (tags[tag] !== target) return `npm ${tag}=${tags[tag]} disagrees with GitHub Release ${target}.`;
    return null;
  } catch {
    return "npm dist-tags returned invalid JSON.";
  }
}
function receiptPath() {
  return join5(kddHome2(), "update-cli-receipt.json");
}
function readReceipt() {
  try {
    const path = receiptPath();
    if (statSync(path).size > 4096) return null;
    const value = JSON.parse(readFileSync5(path, "utf8"));
    return value && typeof value.cliPath === "string" && typeof value.npmRoot === "string" && typeof value.version === "string" && (value.channel === "stable" || value.channel === "next") ? value : null;
  } catch {
    return null;
  }
}
function writeReceipt(receipt) {
  const path = receiptPath();
  mkdirSync(dirname2(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(receipt), { mode: 384, flag: "wx" });
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}
function npmCliFor(nodePath) {
  const candidates = [nodePath];
  try {
    candidates.push(realpathSync2(nodePath));
  } catch {
  }
  for (const executable of candidates) {
    for (const path of [
      join5(dirname2(dirname2(executable)), "lib/node_modules/npm/bin/npm-cli.js"),
      join5(dirname2(executable), "node_modules/npm/bin/npm-cli.js")
    ]) if (existsSync(path)) return path;
    try {
      const sibling = realpathSync2(join5(dirname2(executable), "npm"));
      if (basename(sibling) === "npm-cli.js" && basename(dirname2(dirname2(sibling))) === "npm")
        return sibling;
    } catch {
    }
  }
  return null;
}
function updateCli(latest, channel, run2, cliFile, nodePath, replaceUnknownSource = false) {
  const name = "cli";
  if (process.env.npm_command === "exec") return {
    name,
    status: "skipped",
    detail: "This is an npm exec/npx run; update the installed CLI separately."
  };
  const npmCli = npmCliFor(nodePath);
  if (!npmCli) return {
    name,
    status: "skipped",
    detail: `This Node has no npm CLI; use its package manager to install @kddkit/cli@${latest}.`
  };
  const root = run2(nodePath, [npmCli, "root", "-g"]);
  const npmRoot = root.stdout.trim();
  if (root.status !== 0 || !isAbsolute(npmRoot)) return {
    name,
    status: "failed",
    detail: `npm root -g failed: ${root.stderr.trim() || root.error?.message || root.stdout.trim()}`
  };
  const scopeDir = join5(npmRoot, "@kddkit");
  const packageDir = join5(scopeDir, "cli");
  const distDir = join5(packageDir, "dist");
  const expectedFile = join5(distDir, "index.js");
  try {
    if ([scopeDir, packageDir, distDir, expectedFile].some((path) => lstatSync(path).isSymbolicLink()) || realpathSync2(cliFile) !== realpathSync2(expectedFile)) return {
      name,
      status: "skipped",
      detail: `This kdd is not the CLI owned by npm at ${npmRoot}; update its source or owning installation manually.`
    };
  } catch {
    return {
      name,
      status: "skipped",
      detail: `This kdd is outside npm's global root ${npmRoot}; update its source or owning installation manually.`
    };
  }
  const listed = run2(nodePath, [npmCli, "ls", "-g", "@kddkit/cli", "--json", "--long"]);
  if (listed.status !== 0) return {
    name,
    status: "failed",
    detail: `npm ls -g @kddkit/cli failed: ${listed.stderr.trim() || listed.error?.message || listed.stdout.trim()}`
  };
  let installed;
  try {
    const tree = JSON.parse(listed.stdout);
    const row = tree?.dependencies?.["@kddkit/cli"];
    if (!row || typeof row !== "object") throw new Error("package missing");
    installed = row;
  } catch {
    return { name, status: "failed", detail: "npm ls -g @kddkit/cli returned invalid installation data." };
  }
  const current = installed.version;
  const source = installed.resolved;
  if (typeof current !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(current) || source !== void 0 && typeof source !== "string") return {
    name,
    status: "failed",
    detail: "npm ls -g @kddkit/cli returned invalid version or source data."
  };
  const disposition = updateDisposition3(current, latest, channel);
  if (disposition !== "install") return {
    name,
    status: "current",
    detail: disposition === "ahead" ? `CLI ${current} is ahead of ${latest}; no downgrade within this channel.` : `CLI is already ${current}.`
  };
  const receipt = readReceipt();
  const consent = receipt?.cliPath === realpathSync2(cliFile) && receipt.npmRoot === npmRoot && receipt.version === current;
  if (source === void 0 && !consent && !replaceUnknownSource) return {
    name,
    status: "skipped",
    detail: "npm did not report this CLI installation source; use --replace-cli-from-registry only if you want to replace it from npm."
  };
  if (source !== void 0 && source !== `https://registry.npmjs.org/@kddkit/cli/-/cli-${current}.tgz`) return {
    name,
    status: "skipped",
    detail: "This CLI source is not the published npm registry tarball; update its source manually."
  };
  const install = run2(nodePath, [npmCli, "install", "-g", `@kddkit/cli@${latest}`]);
  if (install.status !== 0) return {
    name,
    status: "failed",
    detail: `npm install failed: ${install.stderr.trim() || install.error?.message || install.stdout.trim()}`
  };
  const invoked = run2("kdd", ["--version"]);
  const observed2 = invoked.stdout.trim() || invoked.stderr.trim() || invoked.error?.message || "(unavailable)";
  if (invoked.status !== 0 || observed2 !== latest) return {
    name,
    status: "failed",
    detail: `npm installed ${latest} from ${current}, but kdd --version reports ${observed2}; check your PATH and npm prefix.`
  };
  try {
    writeReceipt({ cliPath: realpathSync2(cliFile), npmRoot, version: latest, channel });
  } catch (error) {
    return {
      name,
      status: "failed",
      detail: `kdd --version verified ${latest}, but could not save update consent receipt: ${error instanceof Error ? error.message : error}`
    };
  }
  return { name, status: "updated", detail: `${current} \u2192 ${latest}; ${source === void 0 ? "unknown source replaced explicitly or by receipt; " : ""}kdd --version verified.` };
}

// src/index.ts
var program = new Command().name("kdd").description("kanban substrate for humans and Claude").version(kddVersion2());
function out(json, obj, text) {
  console.log(json ? JSON.stringify(obj) : text());
}
function readBody(opts) {
  if (opts.bodyFile) return readFileSync6(opts.bodyFile, "utf8");
  if (opts.body === "-") return readFileSync6(0, "utf8");
  return opts.body;
}
var runMarker = (tag) => ` Ignore this run marker, it is not part of your task: ${tag}`;
var sq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
var defaultSpawnCmd = (taskId, tag) => `${sq(process.execPath)} ${sq(fileURLToPath2(import.meta.url))} worker ${taskId} --tag ${tag}`;
var nodeFirstPath = () => [dirname3(process.execPath), process.env.PATH].filter(Boolean).join(delimiter);
var TICK_LOCK_STALE = 10 * 60 * 1e3;
var TICK_KILL_TIMEOUT = 5 * 60 * 1e3;
function spawnWorker(taskId, workerId, projectDir, tag) {
  const cmd = process.env.KDD_SPAWN_CMD ?? defaultSpawnCmd(taskId, tag);
  const shell = process.env.SHELL || "/bin/sh";
  const ident = `export KDD_TASK_ID=${sq(String(taskId))} KDD_ACTOR=ai KDD_SESSION=${sq(workerId)}; `;
  const child = spawnProcess2(shell, ["-lc", ident + cmd], {
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
var tickRunner = createTickRunner(fileURLToPath2(import.meta.url), TICK_KILL_TIMEOUT);
var stopRunner = createStopRunner(fileURLToPath2(import.meta.url));
var killerFor = (dbPath) => (taskIds) => killWorkers(new Map(taskIds.map((id) => [id, workerTag(id, dbPath)])));
var secondsError = (name, v) => Number.isFinite(v) && v > 0 ? null : `invalid ${name} '${process.env[name]}' (seconds > 0)`;
var ttlError = (ttl) => secondsError("KDD_WORKER_TTL", ttl);
var DEFAULT_IDLE = 1800;
function run(json, fn) {
  try {
    fn();
  } catch (e) {
    fail(e instanceof KddError2 ? e.message : String(e), json);
  }
}
var collect = (v, acc) => [...acc, v];
program.command("add").argument("<title>").option("--body <md>", 'markdown body, or "-" for stdin').option("--body-file <path>").option("--priority <p>", "low|medium|high|urgent").option("--kind <k>", "feature|bug|chore|research").option("--area <area>").option("--track <id>", "track id").option("--criterion <text>", "acceptance criterion (repeatable)", collect, []).option("--json", "machine-readable output").action((title, o) => run(o.json, () => {
  const body = readBody(o) ?? (o.kind === "bug" ? BUG_BODY_TEMPLATE : void 0);
  const t = withDb((db) => addTask(
    db,
    {
      title,
      body,
      priority: o.priority,
      kind: o.kind,
      area: o.area,
      track_id: o.track ? parseId(o.track) : void 0,
      criteria: o.criterion.length ? o.criterion : void 0
    },
    getActor()
  ));
  out(o.json, t, () => `#${t.id} created`);
}));
program.command("decide").argument("<title>").option("--decision <t>").option("--rationale <t>").option("--alternatives <t>").option("--outcome <t>").option("--supersedes <slug>").option("--source-task <id>", "source task id (repeatable)", collect, []).option("--body <md>", 'full md body, or "-" for stdin').option("--body-file <path>").option("--json").action((title, o) => run(o.json, () => {
  const r = withDb((db) => addDecision(db, resolveDecisionsDir(), {
    title,
    decision: o.decision,
    rationale: o.rationale,
    alternatives: o.alternatives,
    outcome: o.outcome,
    supersedes: o.supersedes,
    body: readBody(o),
    sourceTasks: o.sourceTask.map(parseId)
  }));
  out(o.json, r, () => r.created ? `decided: ${r.slug}
${r.path}` : `already recorded: ${r.slug}`);
}));
program.command("decision").argument("<slug>").option("--json").action((slug, o) => run(o.json, () => {
  const d = withDb((db) => decisionDetail(db, resolveDecisionsDir(), slug));
  out(o.json, d, () => renderDecision(d));
}));
program.command("board").option("--area <area>").option("--status <s>").option("--kind <k>", "feature|bug|chore|research").option("--track <id>", "track id").option("--ready", "only tasks takeable now (new, not blocked)").option("--archived", "show archived tasks only").option("--json").action((o) => run(o.json, () => {
  if (o.kind && !KINDS.includes(o.kind)) {
    throw new KddError2(`invalid kind '${o.kind}'; allowed: ${KINDS.join(", ")}`);
  }
  const b = withDb((db) => boardData(
    db,
    {
      area: o.area,
      status: o.status,
      archived: o.archived,
      kind: o.kind,
      ready: o.ready ? true : void 0,
      track_id: o.track ? parseId(o.track) : void 0
    }
  ));
  out(o.json, b, () => renderBoard(b));
}));
program.command("show").argument("<id>").option("--json").action((id, o) => run(o.json, () => {
  if (o.json) {
    out(true, withDb((db) => syncedTaskDetail(db, resolveDecisionsDir(), parseId(id), true)), () => "");
    return;
  }
  console.log(renderShow(withDb((db) => syncedTaskDetail(db, resolveDecisionsDir(), parseId(id)))));
}));
program.command("brief").argument("<taskId>").option("--json").action((taskId, o) => run(o.json, () => {
  const brief = withDb((db) => taskBrief(db, resolveDecisionsDir(), parseId(taskId)));
  out(o.json, brief, () => renderBrief(brief));
}));
program.command("attention").option("--json").action((o) => run(o.json, () => {
  const inbox = withDb((db) => attentionData(db, now3()));
  out(o.json, inbox, () => renderAttention(inbox));
}));
program.command("move").argument("<id>").argument("<status>").option("--reason <text>", "why the transition skips the matrix (ai)").option("--json").action((id, status, o) => run(o.json, () => {
  const t = withDb((db) => moveTask(db, parseId(id), status, getActor(), o.reason));
  out(o.json, t, () => `#${t.id} \u2192 ${t.status}`);
}));
program.command("claim").argument("[id]", "task id to claim; omit when using --next").option("--next", "claim the top ready task from the queue").option("--renew", "renew the lease on a task you already hold").option("--ttl <seconds>", "lease length in seconds", String(DEFAULT_TTL)).option("--json").action((id, o) => run(o.json, () => {
  const ttl = Number(o.ttl);
  const actor = getActor();
  const { dbPath, projectPath } = resolveDbPath2();
  const kill = killerFor(dbPath);
  if (o.next) {
    const t = withDbAt(dbPath, projectPath, (db) => claimNext(db, actor, ttl, { kill }));
    if (!t) {
      out(o.json, { task: null }, () => "no ready task");
      return;
    }
    out(o.json, t, () => renderClaim(t, "claimed"));
    return;
  }
  if (!id) throw new KddError2("give a task id or use --next");
  const res = withDbAt(dbPath, projectPath, (db) => o.renew ? renewClaim(db, parseId(id), actor, ttl) : claimTask(db, parseId(id), actor, ttl, { kill }));
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
  const ttl = Number(process.env.KDD_WORKER_TTL ?? DEFAULT_TTL);
  const badTtl = ttlError(ttl);
  if (badTtl) fail(badTtl, o.json);
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
      release = lockfile.lockSync(join6(dirname3(dbPath), "tick"), { stale: TICK_LOCK_STALE, realpath: false });
    } catch (e) {
      if (e.code === "ELOCKED") return { skipped: true };
      throw e;
    }
    try {
      const toplevel = resolveToplevel();
      return withDbAt(dbPath, projectPath, (db) => {
        if (!process.env.KDD_TICK_SPAWNED) setProjectToplevel(db, toplevel);
        const tagOf = (taskId) => workerTag(taskId, dbPath);
        const t = tick(db, {
          maxWorkers: maxWorkers(db),
          ttl,
          projectDir: toplevel,
          spawn: (taskId, workerId, dir) => spawnWorker(taskId, workerId, dir, tagOf(taskId)),
          kill: killerFor(dbPath)
        });
        return { ...t, reaped: sweepWorktrees(db, toplevel, (taskId) => workerAlive(tagOf(taskId))) };
      });
    } finally {
      release();
    }
  };
  const print = (r) => {
    const ts = o.watch ? (/* @__PURE__ */ new Date()).toISOString() : "";
    out(o.json, o.watch ? { ...r, ts } : r, () => {
      const stamp = o.watch ? `[${ts}] ` : "";
      return r.skipped ? `${stamp}tick: locked (another tick running)` : `${stamp}tick: reclaimed ${r.reclaimed}, killed ${r.killed}, stuck ${r.stuck}, spawned ${r.spawned}, active ${r.active}, reaped ${r.reaped}`;
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
program.command("stop").description("agent-mode: kill live workers, release the leases of those that died").option("--json").action(async (o) => {
  try {
    const { dbPath, projectPath } = resolveDbPath2();
    const release = await lockfile.lock(join6(dirname3(dbPath), "tick"), {
      stale: TICK_LOCK_STALE,
      realpath: false,
      retries: { retries: 8, minTimeout: 250, maxTimeout: 4e3 }
    });
    try {
      const r = withDbAt(dbPath, projectPath, (db) => {
        setAutoTick(db, { enabled: false });
        return stopWorkers(db, killerFor(dbPath));
      });
      out(o.json, r, () => `stop: killed ${r.killed}, released ${r.released}, stuck ${r.stuck}`);
    } finally {
      release();
    }
  } catch (e) {
    fail(e instanceof KddError2 ? e.message : String(e), o.json);
  }
});
program.command("worker").argument("<id>").option("--tag <tag>", "ps-visible run marker used to find this worker (set by kdd tick)").description("agent-mode supervisor: run claude on a task, ingest its stream into agent_events").action(async (id, o) => {
  const workerId = process.env.KDD_SESSION ?? `manual:${process.pid}`;
  let db;
  try {
    const taskId = parseId(id);
    const { dbPath, projectPath } = resolveDbPath2();
    const toplevel = resolveToplevel();
    const claudeCmd = process.env.KDD_CLAUDE_CMD ?? "claude";
    const allowed = process.env.KDD_ALLOWED_TOOLS ?? "Bash Read Edit Write Grep Glob";
    const [bin, ...pre] = claudeCmd.split(/\s+/);
    db = openDb2(dbPath, projectPath);
    const task = mustGetTask(db, taskId);
    const workdir = ensureWorktree(toplevel, dbPath, taskId, task.title);
    const actor = getActor();
    const ttl = Number(process.env.KDD_WORKER_TTL ?? DEFAULT_TTL);
    const bad = ttlError(ttl);
    if (bad) throw new KddError2(bad);
    const idle = Number(process.env.KDD_WORKER_IDLE ?? DEFAULT_IDLE);
    const badIdle = secondsError("KDD_WORKER_IDLE", idle);
    if (badIdle) throw new KddError2(badIdle);
    const holdsLease = task.claimed_by === authorOf(actor);
    const leaseMismatch = !holdsLease && task.claimed_by !== null ? `held by ${task.claimed_by}, we are ${authorOf(actor)} \u2014 heartbeat disarmed, the lease will expire under a live agent (check KDD_ACTOR/KDD_SESSION in your shell profile)` : null;
    if (leaseMismatch) process.stderr.write(`kdd worker: task #${taskId} ${leaseMismatch}
`);
    const marker = o.tag ?? (holdsLease ? workerTag(taskId, dbPath) : `kdd-worker-manual-${taskId}-${process.pid}`);
    const prompt = (process.env.KDD_WORKER_PROMPT ?? workerPrompt(task.kind, task.area)) + runMarker(marker);
    const args = [
      ...pre,
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--allowedTools",
      allowed,
      "--add-dir",
      filesDir(dbPath)
    ];
    await new Promise((resolve) => {
      appendAgentEvent(db, taskId, workerId, "run_start", { detail: { head: headCommit(workdir) } });
      if (leaseMismatch) {
        appendAgentEvent(db, taskId, workerId, "error", { detail: { message: leaseMismatch } });
      }
      const child = spawnProcess2(bin, args, {
        cwd: workdir,
        stdio: ["ignore", "pipe", "inherit"],
        // Своя процессная группа (B3): всё, что claude поднимет через Bash и что переживёт его
        // самого, сигнала по одному pid не получит, а метки рана в argv не несёт — значит и
        // findWorker его больше не увидит. Порты и CPU держались бы до перезагрузки.
        // killWorker это не ломает: он ищет claude по метке в промпте и берёт ЕГО pgid.
        detached: true,
        // KDD_ACTOR/KDD_SESSION НЕ хардкодим здесь — они текут из окружения самого воркера.
        // Tick-путь: tick уже выставил их (ai / tick:<nonce>-<i>) на процессе воркера, ...process.env
        // их пробрасывает — ai-gating на move-to-review сохраняется. Ручной `kdd worker <id>`
        // (без claim) — debug-aid для feed: наследует user-актора из шелла, никого не гейтит.
        // Полное продвижение задачи вручную требует предварительного `kdd claim` под тем же
        // KDD_SESSION — воркер claim'ом сознательно не владеет, им владеет tick.
        env: { ...process.env, KDD_TASK_ID: String(taskId), PATH: nodeFirstPath() }
      });
      let stopping = false;
      const stopAgent = () => {
        if (stopping || !child.pid) return;
        stopping = true;
        signalGroup(child.pid, "SIGTERM");
        setTimeout(() => signalGroup(child.pid, "SIGKILL"), 2e3).unref();
      };
      const onSig = () => {
        stopAgent();
      };
      process.on("SIGINT", onSig);
      process.on("SIGTERM", onSig);
      const beat = holdsLease ? setInterval(() => {
        try {
          const r = renewClaim(db, taskId, actor, ttl, { log: false });
          if (r.ok) return;
          clearInterval(beat);
          stopAgent();
          appendAgentEvent(db, taskId, workerId, "error", { detail: { message: r.error } });
        } catch (e) {
          process.stderr.write(
            `kdd worker: heartbeat failed: ${e instanceof Error ? e.message : String(e)}
`
          );
        }
      }, Math.max(1, Math.floor(ttl / 3)) * 1e3) : void 0;
      beat?.unref();
      let lastLine = Date.now();
      const watchdog = setInterval(() => {
        if (Date.now() - lastLine < idle * 1e3) return;
        clearInterval(watchdog);
        if (beat) clearInterval(beat);
        appendAgentEvent(
          db,
          taskId,
          workerId,
          "error",
          { detail: { message: `agent produced no output for ${idle}s \u2014 wedged, stopping the run` } }
        );
        stopAgent();
      }, Math.max(1, Math.floor(idle / 3)) * 1e3);
      watchdog.unref();
      let ended = false;
      const end = (exitCode) => {
        if (ended) return;
        ended = true;
        if (beat) clearInterval(beat);
        clearInterval(watchdog);
        process.off("SIGINT", onSig);
        process.off("SIGTERM", onSig);
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
        lastLine = Date.now();
        try {
          for (const ev of parseClaudeStreamLine(line)) appendAgentEvent(db, taskId, workerId, ev.kind, ev);
        } catch (e) {
          process.stderr.write(`kdd worker: feed write failed: ${e instanceof Error ? e.message : String(e)}
`);
        }
      });
      child.on("close", (code) => {
        rl.close();
        end(code);
      });
    });
  } catch (e) {
    if (db) closeDb(db);
    fail(e instanceof KddError2 ? e.message : String(e), false);
  }
  if (db) closeDb(db);
});
program.command("feed").argument("<id>").option("--since <n>", "only events after this id").option("--json").action((id, o) => run(o.json, () => {
  const rows = withDb((db) => listAgentEvents(
    db,
    parseId(id),
    { sinceId: o.since ? Number(o.since) : 0 }
  ));
  out(o.json, rows, () => rows.map((e) => `${e.kind}${e.name ? " " + e.name : ""}${e.detail ? " " + e.detail : ""}`).join("\n") || "no activity");
}));
program.command("edit").argument("<id>").option("--title <t>").option("--body <md>").option("--body-file <path>").option("--priority <p>").option("--area <a>").option("--kind <k>", "feature|bug|chore|research").option("--track <id>", 'track id, or "none" to detach').option("--json").action((id, o) => run(o.json, () => {
  const track_id = o.track === void 0 ? void 0 : o.track === "none" ? null : parseId(o.track);
  const t = withDb((db) => editTask(
    db,
    parseId(id),
    {
      title: o.title,
      body: readBody(o),
      priority: o.priority,
      kind: o.kind,
      area: o.area,
      track_id
    },
    getActor()
  ));
  out(o.json, t, () => `#${t.id} updated`);
}));
program.command("comment").argument("<id>").argument("<text>").option("--json").action((id, text, o) => run(o.json, () => {
  const c = withDb((db) => commentTask(db, parseId(id), text, getActor()));
  out(o.json, c, () => `#${parseId(id)} commented`);
}));
program.command("attach").argument("<taskId>").argument("<path>").option("--desc <text>", "what is in the file \u2014 read by whoever has no picture").option("--json").action((taskId, path, o) => run(o.json, () => {
  const { dbPath, projectPath } = resolveDbPath2();
  const f = withDbAt(dbPath, projectPath, (db) => attachFile(db, dbPath, parseId(taskId), path, { description: o.desc }, getActor()));
  out(o.json, f, () => `#${f.task_id} file ${f.id} ${f.original_name}`);
}));
program.command("detach").argument("<fileId>").option("--json").action((fileId, o) => run(o.json, () => {
  const { dbPath, projectPath } = resolveDbPath2();
  withDbAt(dbPath, projectPath, (db) => detachFile(db, dbPath, parseId(fileId), getActor()));
  out(o.json, { ok: true }, () => `file ${parseId(fileId)} detached`);
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
var LOOPBACK = /* @__PURE__ */ new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
var lanAddress = () => Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
program.command("ui").option("--port <n>", "port", "4499").option("--host <addr>", "bind address; anything but loopback needs --token", "127.0.0.1").option("--token <t>", "shared secret required on /api when bound outside loopback ($KDD_UI_TOKEN)").action((o) => run(false, () => {
  const host = String(o.host);
  const token = o.token ?? process.env.KDD_UI_TOKEN;
  if (!LOOPBACK.has(host) && !token) {
    throw new KddError2(
      `--host ${host} exposes the board beyond this machine \u2014 pass --token <secret> (or set KDD_UI_TOKEN) so it is not open to the whole network`
    );
  }
  void uiStart(Number(o.port), host, token);
}));
async function uiStart(port, host = "127.0.0.1", token) {
  const { dbPath, projectPath } = resolveDbPath2();
  const hash = basename2(dirname3(dbPath));
  const db = openDb2(dbPath, projectPath);
  try {
    setProjectToplevel(db, resolveToplevel());
  } catch {
  }
  db.close();
  const url = `http://${LOOPBACK.has(host) ? "localhost" : lanAddress() ?? host}:${port}?project=${hash}` + (token ? `&token=${encodeURIComponent(token)}` : "");
  const probe = async (path) => {
    try {
      return await fetch(`http://localhost:${port}${path}`, { signal: AbortSignal.timeout(500) });
    } catch {
      return null;
    }
  };
  const ping = await probe("/api/ping");
  const info = ping?.ok ? await ping.json() : null;
  if (info?.kdd) {
    if (info.store !== storeIdentity()) {
      fail(
        info.store ? `a kdd ui already runs on :${port} with a different store \u2014 stop it or choose another --port` : `the kdd ui already running on :${port} does not report its store \u2014 stop the old server or choose another --port`,
        false
      );
    }
    if (!!token !== !!info.needsToken) {
      fail(
        info.needsToken ? `a kdd ui already runs on :${port} and requires a token \u2014 pass the same --token to reuse it` : `a kdd ui already runs on :${port} without a token \u2014 stop it before exposing the board`,
        false
      );
    }
    if (token && (await probe(`/api/version?token=${encodeURIComponent(token)}`))?.status === 401) {
      fail(`the kdd ui already running on :${port} was started with a different token`, false);
    }
    console.log(`kdd ui: ${url} (reusing running server)`);
    return;
  }
  const { getDb, get, closeAll } = projectPool(hash, { lockToDefault: !!token });
  const scheduler = createScheduler(tickRunner, get, stopRunner);
  try {
    await startUi(getDb, port, hash, scheduler, { host, token });
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
criteria.command("add").description("add an acceptance criterion to a task").argument("<taskId>").argument("<text>").option("--json").action((taskId, text, o) => run(o.json, () => {
  const c = withDb((db) => addCriterion(db, parseId(taskId), text, getActor()));
  out(o.json, c, () => `#${c.task_id} criterion ${c.id} added`);
}));
criteria.command("check").description("mark a criterion verified, optionally with evidence").argument("<taskId>").argument("<id>").option("--evidence <text>", "verification command, URL, commit, attachment or note").option("--json").action((taskId, id, o) => run(o.json, () => {
  const c = withDb((db) => setCriterionChecked(db, parseId(taskId), parseId(id), true, getActor(), o.evidence));
  out(o.json, c, () => `#${c.task_id} criterion ${c.id} checked`);
}));
criteria.command("uncheck").description("mark a criterion unverified").argument("<taskId>").argument("<id>").option("--json").action((taskId, id, o) => run(o.json, () => {
  const c = withDb((db) => setCriterionChecked(db, parseId(taskId), parseId(id), false, getActor()));
  out(o.json, c, () => `#${c.task_id} criterion ${c.id} unchecked`);
}));
criteria.command("rm").description("remove an acceptance criterion").argument("<taskId>").argument("<id>").option("--json").action((taskId, id, o) => run(o.json, () => {
  withDb((db) => removeCriterion(db, parseId(taskId), parseId(id), getActor()));
  out(o.json, { ok: true }, () => `#${parseId(taskId)} criterion ${parseId(id)} removed`);
}));
criteria.command("ls").description("list acceptance criteria on a task").argument("<taskId>").option("--json").action((taskId, o) => run(o.json, () => {
  const cs = withDb((db) => listCriteria(db, parseId(taskId)));
  out(o.json, cs, () => renderCriteria(cs));
}));
var track = program.command("track").description("manage tracks (task groups)");
track.command("add").description("create a track").argument("<name>").option("--description <t>", '"use when\u2026" routing hint for the agent').option("--json").action((name, o) => run(o.json, () => {
  const t = withDb((db) => createTrack(db, { name, description: o.description }));
  out(o.json, t, () => `track #${t.id} ${t.name}`);
}));
track.command("ls").description("list active tracks, or all tracks with --all").option("--all", "include completed tracks").option("--json").action((o) => run(o.json, () => {
  const ts = withDb((db) => listTracks(db, o.all ? {} : { status: "active" }));
  out(o.json, ts, () => renderTracks(ts));
}));
track.command("edit").description("rename a track or change its description").argument("<id>").option("--name <t>").option("--description <t>").option("--json").action((id, o) => run(o.json, () => {
  const t = withDb((db) => editTrack(
    db,
    parseId(id),
    { name: o.name, description: o.description }
  ));
  out(o.json, t, () => `track #${t.id} updated`);
}));
track.command("done").description("mark a track complete").argument("<id>").option("--json").action((id, o) => run(o.json, () => {
  const t = withDb((db) => editTrack(db, parseId(id), { status: "done" }));
  out(o.json, t, () => `track #${t.id} done`);
}));
track.command("reopen").description("reactivate a completed track").argument("<id>").option("--json").action((id, o) => run(o.json, () => {
  const t = withDb((db) => editTrack(db, parseId(id), { status: "active" }));
  out(o.json, t, () => `track #${t.id} active`);
}));
track.command("rm").description("delete a track and detach its tasks").argument("<id>").option("--json").action((id, o) => run(o.json, () => {
  withDb((db) => deleteTrack(db, parseId(id)));
  out(o.json, { ok: true }, () => `track #${parseId(id)} deleted`);
}));
program.command("projects").option("--json").action((o) => run(o.json, () => {
  const ps = listProjects();
  out(o.json, ps, () => ps.length ? ps.map((p) => `${p.projectPath}
  ${p.dbPath}`).join("\n") : "no projects");
}));
program.command("export").option("--include-sensitive").action((o) => run(true, () => {
  const dump = withDb((db) => exportBoard(
    db,
    resolveDecisionsDir(),
    { includeSensitive: !!o.includeSensitive }
  ));
  console.log(JSON.stringify(dump));
}));
program.command("update").description("update installed kddkit CLI and plugins").option("--next", "explicitly subscribe installed components to the next preview channel").option("--replace-cli-from-registry", "allow replacing an older unknown-source CLI from npm registry; verified updates keep this consent").addHelpText("after", "\nCLI consent receipt: <KDD_HOME>/update-cli-receipt.json (default ~/.kdd/update-cli-receipt.json). Delete it to revoke continuing consent. A same-version local tarball can be replaced while it remains valid.").action(async (o) => {
  const channel = o.next ? "next" : "stable";
  const release = await releaseInfo({ fresh: true });
  const target = channel === "next" ? release.next : release.latest;
  if (release.error || !target) {
    console.error(`kdd update: ${release.error ?? `no published ${channel} release available`}`);
    process.exitCode = 1;
    return;
  }
  if (channel === "next" && release.latest && compareVersions2(target, release.latest) <= 0) {
    console.error(`kdd update: no newer preview than stable ${release.latest} is published.`);
    process.exitCode = 1;
    return;
  }
  const preflight = preflightTarget(target, channel, runCommand);
  if (preflight) {
    console.error(`kdd update: ${preflight}`);
    process.exitCode = 1;
    return;
  }
  console.log(`kdd update: ${channel} ${target}`);
  const results = [
    ...updateClaude(target, channel, runCommand, process.cwd()),
    updateCodex(target, channel, runCommand),
    updateCli(target, channel, runCommand, fileURLToPath2(import.meta.url), process.execPath, !!o.replaceCliFromRegistry)
  ];
  for (const result of results) console.log(`${result.name}: ${result.status} \u2014 ${result.detail}`);
  if (results.some((result) => result.name !== "cli" && result.status === "updated"))
    console.log("Restart Claude Code or Codex to load updated plugins.");
  if (results.some((result) => result.status === "failed")) process.exitCode = 1;
});
noticeOnStartup();
await program.parseAsync();
