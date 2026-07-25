#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { spawn as spawnProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';
import {
  KddError, addCriterion, addDecision, addTask, appendAgentEvent, archiveTask, blockTask,
  boardData, claimNext, claimTask, commentTask, createTrack, deleteTrack, DEFAULT_TTL, editTask,
  editTrack, ensureWorktree, exportBoard, headCommit, kddVersion, linkTasks, listAgentEvents, listCriteria, listProjects, taskBranchHead,
  listTracks, moveTask, mustGetTask, openDb, parseClaudeStreamLine, rebuild, recall, removeCriterion,
  renewClaim, resolveDbPath, resolveDecisionsDir, resolveToplevel, setCriterionChecked, statusDigest,
  sweepWorktrees, taskDetail, taskDetailCapped, tick, unarchiveTask, unblockTask, type Status,
} from '@kddkit/core';
import { projectPool, startUi } from '@kddkit/ui';
import { fail, getActor, parseId, withDb, withDbAt } from './context.js';
import {
  renderBoard, renderClaim, renderCriteria, renderRecall, renderShow, renderStatus, renderTracks,
} from './render.js';

const program = new Command()
  .name('kdd')
  .description('kanban substrate for humans and Claude')
  .version(kddVersion());

function out(json: boolean, obj: unknown, text: () => string): void {
  console.log(json ? JSON.stringify(obj) : text());
}

function readBody(opts: { body?: string; bodyFile?: string }): string | undefined {
  if (opts.bodyFile) return readFileSync(opts.bodyFile, 'utf8');
  if (opts.body === '-') return readFileSync(0, 'utf8'); // stdin
  return opts.body;
}

const WORKER_PROMPT = process.env.KDD_WORKER_PROMPT ??
  `You are a kdd agent worker. Read your task: run \`kdd show $KDD_TASK_ID\`. ` +
  `Do the work in this repository. Renew your lease periodically with \`kdd claim $KDD_TASK_ID --renew\` — ` +
  `if that errors you have LOST the lease, stop immediately. ` +
  // комментарий = durable-канал: он в taskDetail (get_task/kdd show), его читают люди и будущие
  // сессии. Activity-фид туда НЕ входит намеренно (не засоряет LLM-контекст). Потому итог — в коммент.
  `When done, leave ONE concise summary comment ` +
  `(\`kdd comment $KDD_TASK_ID "<what you changed and why; caveats or follow-ups>"\`) — this is the ` +
  `durable note humans and future sessions read, so keep it tight, not a log. Then check acceptance ` +
  `criteria (\`kdd criteria check\`) and \`kdd move $KDD_TASK_ID review\`. ` +
  `If you get blocked or must stop early, comment the reason first.`;

// #19: воркер зовём тем же node, что и сам tick (process.execPath) + абс. путём к этому dist/index.js,
// а НЕ bare `kdd` через login-shell node. У nvm/fnm-юзеров login-shell node может ≠ node сборки →
// нативный better-sqlite3 падает на NODE_MODULE_VERSION mismatch, воркер тихо мрёт. -lc сохраняем
// (грузит PATH для discovery claude/npx), но node вызываем явно. sq — shell-quote на случай пробелов в путях.
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const DEFAULT_SPAWN_CMD =
  `${sq(process.execPath)} ${sq(fileURLToPath(import.meta.url))} worker "$KDD_TASK_ID"`;

const TICK_LOCK_STALE = 10 * 60 * 1000; // ms; tick короткоживущий — 10 мин >> его длительности

// Детач fire-and-forget через login-shell (-lc грузит PATH: детач-процесс иначе не найдёт claude/npx).
function spawnWorker(taskId: number, workerId: string, projectDir: string): void {
  const cmd = process.env.KDD_SPAWN_CMD ?? DEFAULT_SPAWN_CMD;
  const shell = process.env.SHELL || '/bin/sh';
  const child = spawnProcess(shell, ['-lc', cmd], {
    cwd: projectDir,
    env: { ...process.env, KDD_TASK_ID: String(taskId), KDD_ACTOR: 'ai', KDD_SESSION: workerId },
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', (e) => {
    // async spawn-fail (ENOENT shell, EMFILE): без обработчика 'error' — uncaught -> crash tick.
    // releaseClaim здесь НЕ вызвать: withDb уже закрыл db к моменту события. Задача останется
    // in_progress до TTL -> reclaimExpired вернёт её и (для ai:tick) засчитает неудачу. Тут только
    // гасим краш + пишем в stderr для диагностики.
    process.stderr.write(`kdd tick: worker spawn failed for task ${taskId}: ${e.message}\n`);
  });
  child.unref(); // tick не ждёт воркера
}

function run(json: boolean, fn: () => void): void {
  try { fn(); } catch (e) {
    fail(e instanceof KddError ? e.message : String(e), json);
  }
}

const collect = (v: string, acc: string[]): string[] => [...acc, v];

program.command('add')
  .argument('<title>')
  .option('--body <md>', 'markdown body, or "-" for stdin')
  .option('--body-file <path>')
  .option('--priority <p>', 'low|medium|high|urgent')
  .option('--area <area>')
  .option('--track <id>', 'track id')
  .option('--criterion <text>', 'acceptance criterion (repeatable)', collect, [])
  .option('--json', 'machine-readable output')
  .action((title, o) => run(o.json, () => {
    const t = withDb((db) => addTask(db,
      { title, body: readBody(o), priority: o.priority, area: o.area,
        track_id: o.track ? parseId(o.track) : undefined,
        criteria: o.criterion.length ? o.criterion : undefined }, getActor()));
    out(o.json, t, () => `#${t.id} created`);
  }));

program.command('decide')
  .argument('<title>')
  .option('--decision <t>').option('--rationale <t>').option('--alternatives <t>')
  .option('--outcome <t>').option('--supersedes <slug>')
  .option('--body <md>', 'full md body, or "-" for stdin')
  .option('--body-file <path>')
  .option('--json')
  .action((title, o) => run(o.json, () => {
    const r = withDb((db) => addDecision(db, resolveDecisionsDir(), {
      title, decision: o.decision, rationale: o.rationale,
      alternatives: o.alternatives, outcome: o.outcome,
      supersedes: o.supersedes, body: readBody(o),
    }));
    out(o.json, r, () =>
      r.created ? `decided: ${r.slug}\n${r.path}` : `already recorded: ${r.slug}`);
  }));

program.command('board')
  .option('--area <area>')
  .option('--status <s>')
  .option('--track <id>', 'track id')
  .option('--ready', 'only tasks takeable now (new, not blocked)')
  .option('--archived', 'show archived tasks only')
  .option('--json')
  .action((o) => run(o.json, () => {
    const b = withDb((db) => boardData(db,
      { area: o.area, status: o.status as Status | undefined, archived: o.archived,
        ready: o.ready ? true : undefined,
        track_id: o.track ? parseId(o.track) : undefined }));
    out(o.json, b, () => renderBoard(b));
  }));

program.command('show')
  .argument('<id>')
  .option('--json')
  .action((id, o) => run(o.json, () => {
    // --json остаётся полным дампом; текст идёт через капы core
    if (o.json) { out(true, withDb((db) => taskDetail(db, parseId(id))), () => ''); return; }
    console.log(renderShow(withDb((db) => taskDetailCapped(db, parseId(id)))));
  }));

program.command('move')
  .argument('<id>').argument('<status>')
  .option('--reason <text>', 'why the transition skips the matrix (ai)')
  .option('--json')
  .action((id, status, o) => run(o.json, () => {
    const t = withDb((db) => moveTask(db, parseId(id), status, getActor(), o.reason));
    out(o.json, t, () => `#${t.id} → ${t.status}`);
  }));

program.command('claim')
  .argument('[id]', 'task id to claim; omit when using --next')
  .option('--next', 'claim the top ready task from the queue')
  .option('--renew', 'renew the lease on a task you already hold')
  .option('--ttl <seconds>', 'lease length in seconds', String(DEFAULT_TTL))
  .option('--json')
  .action((id, o) => run(o.json, () => {
    const ttl = Number(o.ttl); // NaN на невалидном вводе -> core (assertTtl) отклонит
    const actor = getActor();
    if (o.next) { // --next: null = очередь пуста, не ошибка (exit 0 для driver-петли)
      const t = withDb((db) => claimNext(db, actor, ttl));
      if (!t) { out(o.json, { task: null }, () => 'no ready task'); return; }
      out(o.json, t, () => renderClaim(t, 'claimed'));
      return;
    }
    if (!id) throw new KddError('give a task id or use --next');
    const res = withDb((db) =>
      o.renew ? renewClaim(db, parseId(id), actor, ttl) : claimTask(db, parseId(id), actor, ttl));
    if (!res.ok) { fail(res.error, o.json); return; }
    out(o.json, res.task, () => renderClaim(res.task, o.renew ? 'renewed' : 'claimed'));
  }));

program.command('tick')
  .description('agent-mode: reclaim expired leases, claim ready tasks, spawn workers')
  .option('--json')
  .option('--watch', 'loop until SIGINT/SIGTERM instead of a single pass')
  .option('--interval <sec>', 'seconds between passes in --watch mode', '30')
  .action(async (o) => {
    const intervalMs = Number(o.interval) * 1000;
    if (o.watch && (!Number.isFinite(intervalMs) || intervalMs <= 0)) {
      fail(`--interval must be a positive number of seconds (got '${o.interval}')`, o.json);
    }
    const maxWorkers = Number(process.env.KDD_MAX_WORKERS ?? 3);
    const ttl = Number(process.env.KDD_WORKER_TTL ?? 1800);
    if (!Number.isInteger(maxWorkers) || maxWorkers < 1) fail('KDD_MAX_WORKERS must be a positive integer', o.json);

    // один проход: lock -> tick -> sweep. Возвращает результат ИЛИ {skipped:true} при занятом локе.
    const onePass = (): Record<string, unknown> => {
      const { dbPath, projectPath } = resolveDbPath();
      let release: (() => void) | undefined;
      try {
        release = lockfile.lockSync(join(dirname(dbPath), 'tick'), { stale: TICK_LOCK_STALE, realpath: false });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ELOCKED') return { skipped: true };
        throw e;
      }
      try {
        const toplevel = resolveToplevel();
        return withDbAt(dbPath, projectPath, (db) => {
          const t = tick(db, { maxWorkers, ttl, projectDir: toplevel, spawn: spawnWorker });
          // sweep ПОСЛЕ claim-loop: re-claimed задача уже in_progress → её worktree не тронут;
          // истинно брошенная (reclaim без re-claim) → status 'new' → worktree снесён.
          return { ...t, reaped: sweepWorktrees(db, toplevel) };
        });
      } finally {
        release();
      }
    };

    const print = (r: Record<string, unknown>): void => {
      const ts = o.watch ? new Date().toISOString() : '';
      out(o.json, o.watch ? { ...r, ts } : r, () => {
        const stamp = o.watch ? `[${ts}] ` : '';
        return r.skipped
          ? `${stamp}tick: locked (another tick running)`
          : `${stamp}tick: reclaimed ${r.reclaimed}, spawned ${r.spawned}, active ${r.active}, reaped ${r.reaped}`;
      });
    };

    // single-shot: ошибка фатальна (fail exits, как раньше). --watch: логируем и продолжаем —
    // overnight-раннер не должен падать целиком от одного транзиентного git-глюка.
    const pass = (): void => {
      try { print(onePass()); } catch (e) {
        const msg = e instanceof KddError ? e.message : String(e);
        if (!o.watch) fail(msg, o.json);
        process.stderr.write(`[${new Date().toISOString()}] tick error: ${msg}\n`);
      }
    };

    if (!o.watch) { pass(); return; }

    // --watch: kdd остаётся daemonless — это ОПЦИОНАЛЬНЫЙ long-lived раннер. Сериен (ждём проход
    // перед сном) + межпроцессный TICK_LOCK → двойного tick нет ни тут, ни со вторым watch/UI.
    let stop = false;
    let wake: (() => void) | undefined; // прерывает сон при сигнале
    const onSig = (): void => { stop = true; wake?.(); };
    process.on('SIGINT', onSig);
    process.on('SIGTERM', onSig);
    try {
      while (!stop) {
        pass();
        if (stop) break;
        await new Promise<void>((res) => {
          const timer = setTimeout(() => { wake = undefined; res(); }, intervalMs);
          wake = () => { clearTimeout(timer); wake = undefined; res(); };
        });
      }
    } finally {
      process.off('SIGINT', onSig);
      process.off('SIGTERM', onSig);
    }
  });

program.command('worker')
  .argument('<id>')
  .description('agent-mode supervisor: run claude on a task, ingest its stream into agent_events')
  .action(async (id) => {
    const workerId = process.env.KDD_SESSION ?? `manual:${process.pid}`;
    let db: ReturnType<typeof openDb> | undefined;
    try {
      const taskId = parseId(id);
      const { dbPath, projectPath } = resolveDbPath();
      const toplevel = resolveToplevel();
      const claudeCmd = process.env.KDD_CLAUDE_CMD ?? 'claude';
      const allowed = process.env.KDD_ALLOWED_TOOLS ?? 'Bash Read Edit Write Grep Glob';
      const [bin, ...pre] = claudeCmd.split(/\s+/);
      const args = [...pre, '-p', WORKER_PROMPT,
        '--output-format', 'stream-json', '--verbose', '--allowedTools', allowed];

      // long-lived: withDb/withDbAt закрыли бы db сразу после callback, а claude ещё бежит.
      // Один db-handle на всю команду: resolveDbPath (шеллится в git rev-parse) и openDb — по разу,
      // не дважды (раньше mustGetTask шёл через отдельный withDb, N воркеров от tick = N лишних git-вызовов).
      db = openDb(dbPath, projectPath);
      const task = mustGetTask(db, taskId); // KddError, если задачи нет — ловим ниже, ДО run_start
      // изоляция: воркер бежит в своём worktree (ветка kdd/task-<id>), не в общем toplevel —
      // параллельные воркеры не затирают файлы друг друга. Idempotent: reuse если уже есть.
      const workdir = ensureWorktree(toplevel, dbPath, taskId, task.title);

      await new Promise<void>((resolve) => {
        appendAgentEvent(db!, taskId, workerId, 'run_start', { detail: { head: headCommit(workdir) } });
        const child = spawnProcess(bin, args, {
          cwd: workdir, stdio: ['ignore', 'pipe', 'inherit'],
          // KDD_ACTOR/KDD_SESSION НЕ хардкодим здесь — они текут из окружения самого воркера.
          // Tick-путь: tick уже выставил их (ai / tick:<nonce>-<i>) на процессе воркера, ...process.env
          // их пробрасывает — ai-gating на move-to-review сохраняется. Ручной `kdd worker <id>`
          // (без claim) — debug-aid для feed: наследует user-актора из шелла, никого не гейтит.
          // Полное продвижение задачи вручную требует предварительного `kdd claim` под тем же
          // KDD_SESSION — воркер claim'ом сознательно не владеет, им владеет tick.
          env: { ...process.env, KDD_TASK_ID: String(taskId) },
        });
        let ended = false; // ENOENT spawn failure fires BOTH 'error' и 'close' — run_end пишем один раз
        const end = (exitCode: number | null) => {
          if (ended) return;
          ended = true;
          // after_head предпочитаем из ветки kdd/task-<id> (главный репо) — переживает снос worktree
          // гонкой с tick.sweepWorktrees. workdir HEAD как fallback; оба недоступны → head=undefined
          // (неполный ран, run_end без head).
          let head: string | undefined;
          try { head = taskBranchHead(toplevel, taskId) ?? headCommit(workdir); } catch { /* worktree gone */ }
          appendAgentEvent(db!, taskId, workerId, 'run_end', { detail: { exitCode, head } });
          resolve();
        };
        child.on('error', (e) => {
          appendAgentEvent(db!, taskId, workerId, 'error', { detail: { message: e.message } });
          end(null);
        });
        const rl = createInterface({ input: child.stdout! });
        rl.on('line', (line) => {
          for (const ev of parseClaudeStreamLine(line)) appendAgentEvent(db!, taskId, workerId, ev.kind, ev);
        });
        child.on('close', (code) => { rl.close(); end(code); });
      });
    } catch (e) {
      db?.close();
      fail(e instanceof KddError ? e.message : String(e), false); // fail() exits — no fallthrough
    }
    db?.close();
  });

program.command('feed')
  .argument('<id>')
  .option('--since <n>', 'only events after this id')
  .option('--json')
  .action((id, o) => run(o.json, () => {
    const rows = withDb((db) => listAgentEvents(db, parseId(id),
      { sinceId: o.since ? Number(o.since) : 0 }));
    out(o.json, rows, () => rows.map((e) =>
      `${e.kind}${e.name ? ' ' + e.name : ''}${e.detail ? ' ' + e.detail : ''}`).join('\n') || 'no activity');
  }));

program.command('edit')
  .argument('<id>')
  .option('--title <t>').option('--body <md>').option('--body-file <path>')
  .option('--priority <p>').option('--area <a>')
  .option('--track <id>', 'track id, or "none" to detach')
  .option('--json')
  .action((id, o) => run(o.json, () => {
    const track_id = o.track === undefined ? undefined : o.track === 'none' ? null : parseId(o.track);
    const t = withDb((db) => editTask(db, parseId(id),
      { title: o.title, body: readBody(o), priority: o.priority, area: o.area, track_id },
      getActor()));
    out(o.json, t, () => `#${t.id} updated`);
  }));

program.command('comment')
  .argument('<id>').argument('<text>')
  .option('--json')
  .action((id, text, o) => run(o.json, () => {
    const c = withDb((db) => commentTask(db, parseId(id), text, getActor()));
    out(o.json, c, () => `#${parseId(id)} commented`);
  }));

program.command('block')
  .argument('<id>').argument('<reason>')
  .option('--json')
  .action((id, reason, o) => run(o.json, () => {
    const t = withDb((db) => blockTask(db, parseId(id), reason, getActor()));
    out(o.json, t, () => `#${t.id} blocked: ${reason}`);
  }));

program.command('unblock')
  .argument('<id>')
  .option('--json')
  .action((id, o) => run(o.json, () => {
    const t = withDb((db) => unblockTask(db, parseId(id), getActor()));
    out(o.json, t, () => `#${t.id} unblocked`);
  }));

program.command('link')
  .argument('<from>').argument('<to>')
  .option('--kind <k>', 'link kind', 'relates_to')
  .option('--json')
  .action((from, to, o) => run(o.json, () => {
    withDb((db) => linkTasks(db, parseId(from), parseId(to), o.kind, getActor()));
    out(o.json, { ok: true }, () => `#${parseId(from)} linked to #${parseId(to)}`);
  }));

program.command('archive')
  .argument('<id>')
  .option('--json')
  .action((id, o) => run(o.json, () => {
    const t = withDb((db) => archiveTask(db, parseId(id), getActor()));
    out(o.json, t, () => `#${t.id} archived`);
  }));

program.command('unarchive')
  .argument('<id>')
  .option('--json')
  .action((id, o) => run(o.json, () => {
    const t = withDb((db) => unarchiveTask(db, parseId(id), getActor()));
    out(o.json, t, () => `#${t.id} unarchived`);
  }));

program.command('recall')
  .argument('<query>')
  .option('-k, --limit <n>', 'max results', '10')
  .option('--kind <kind>', 'decision|task')
  .option('--json')
  .action((query, o) => run(o.json, () => {
    const hits = withDb((db) => recall(db, resolveDecisionsDir(), query,
      { k: Number(o.limit), kind: o.kind }));
    out(o.json, hits, () => renderRecall(hits));
  }));

program.command('rebuild')
  .option('--json')
  .action((o) => run(o.json, () => {
    const r = withDb((db) => rebuild(db, resolveDecisionsDir()));
    out(o.json, r, () => `rebuilt: ${r.decisions} decisions, ${r.tasks} tasks indexed`);
  }));

program.command('status')
  .option('--json')
  .action((o) => run(o.json, () => {
    const d = withDb((db) => statusDigest(db));
    out(o.json, d, () => renderStatus(d));
  }));

program.command('ui')
  .option('--port <n>', 'port', '4499')
  .action((o) => run(false, () => { void uiStart(Number(o.port)); }));

// Один сервер на все проекты: если kdd-ui уже поднят на порту — переиспользуем,
// печатаем URL с ?project=<этот-hash>. Иначе поднимаем сервер здесь.
async function uiStart(port: number): Promise<void> {
  const { dbPath, projectPath } = resolveDbPath();
  const hash = basename(dirname(dbPath));
  openDb(dbPath, projectPath).close(); // создаём/мигрируем базу → проект виден в /api/projects
  const url = `http://localhost:${port}?project=${hash}`;
  try {
    const res = await fetch(`http://localhost:${port}/api/ping`, { signal: AbortSignal.timeout(500) });
    if (res.ok && ((await res.json()) as { kdd?: boolean }).kdd) {
      console.log(`kdd ui: ${url} (reusing running server)`);
      return;
    }
  } catch { /* сервера нет — поднимаем свой */ }
  const { getDb, closeAll } = projectPool(hash);
  try {
    await startUi(getDb, port, hash);
  } catch (e) {
    closeAll();
    fail(e instanceof Error ? e.message : String(e), false);
  }
  process.on('SIGINT', () => { closeAll(); process.exit(0); });
  console.log(`kdd ui: ${url}`);
}

const criteria = program.command('criteria').description('acceptance criteria on tasks');

criteria.command('add')
  .argument('<taskId>').argument('<text>')
  .option('--json')
  .action((taskId, text, o) => run(o.json, () => {
    const c = withDb((db) => addCriterion(db, parseId(taskId), text, getActor()));
    out(o.json, c, () => `#${c.task_id} criterion ${c.id} added`);
  }));

criteria.command('check')
  .argument('<taskId>').argument('<id>')
  .option('--json')
  .action((taskId, id, o) => run(o.json, () => {
    const c = withDb((db) =>
      setCriterionChecked(db, parseId(taskId), parseId(id), true, getActor()));
    out(o.json, c, () => `#${c.task_id} criterion ${c.id} checked`);
  }));

criteria.command('uncheck')
  .argument('<taskId>').argument('<id>')
  .option('--json')
  .action((taskId, id, o) => run(o.json, () => {
    const c = withDb((db) =>
      setCriterionChecked(db, parseId(taskId), parseId(id), false, getActor()));
    out(o.json, c, () => `#${c.task_id} criterion ${c.id} unchecked`);
  }));

criteria.command('rm')
  .argument('<taskId>').argument('<id>')
  .option('--json')
  .action((taskId, id, o) => run(o.json, () => {
    withDb((db) => removeCriterion(db, parseId(taskId), parseId(id), getActor()));
    out(o.json, { ok: true }, () => `#${parseId(taskId)} criterion ${parseId(id)} removed`);
  }));

criteria.command('ls')
  .argument('<taskId>')
  .option('--json')
  .action((taskId, o) => run(o.json, () => {
    const cs = withDb((db) => listCriteria(db, parseId(taskId)));
    out(o.json, cs, () => renderCriteria(cs));
  }));

const track = program.command('track').description('manage tracks (task groups)');

track.command('add')
  .argument('<name>')
  .option('--description <t>', '"use when…" routing hint for the agent')
  .option('--json')
  .action((name, o) => run(o.json, () => {
    const t = withDb((db) => createTrack(db, { name, description: o.description }));
    out(o.json, t, () => `track #${t.id} ${t.name}`);
  }));

track.command('ls')
  .option('--all', 'include completed tracks')
  .option('--json')
  .action((o) => run(o.json, () => {
    const ts = withDb((db) => listTracks(db, o.all ? {} : { status: 'active' }));
    out(o.json, ts, () => renderTracks(ts));
  }));

track.command('edit')
  .argument('<id>')
  .option('--name <t>').option('--description <t>')
  .option('--json')
  .action((id, o) => run(o.json, () => {
    const t = withDb((db) => editTrack(db, parseId(id),
      { name: o.name, description: o.description }));
    out(o.json, t, () => `track #${t.id} updated`);
  }));

track.command('done')
  .argument('<id>')
  .option('--json')
  .action((id, o) => run(o.json, () => {
    const t = withDb((db) => editTrack(db, parseId(id), { status: 'done' }));
    out(o.json, t, () => `track #${t.id} done`);
  }));

track.command('reopen')
  .argument('<id>')
  .option('--json')
  .action((id, o) => run(o.json, () => {
    const t = withDb((db) => editTrack(db, parseId(id), { status: 'active' }));
    out(o.json, t, () => `track #${t.id} active`);
  }));

track.command('rm')
  .argument('<id>')
  .option('--json')
  .action((id, o) => run(o.json, () => {
    withDb((db) => deleteTrack(db, parseId(id))); // задачи отцепляются, память остаётся
    out(o.json, { ok: true }, () => `track #${parseId(id)} deleted`);
  }));

program.command('projects')
  .option('--json')
  .action((o) => run(o.json, () => {
    const ps = listProjects();
    out(o.json, ps, () =>
      ps.length ? ps.map((p) => `${p.projectPath}\n  ${p.dbPath}`).join('\n') : 'no projects');
  }));

program.command('export')
  .action(() => run(true, () => {
    const dump = withDb((db) => exportBoard(db));
    console.log(JSON.stringify(dump));
  }));

program.parse();
