#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  KddError, addCriterion, addDecision, addTask, archiveTask, attachFile,
  addRepository, bindRepository, rebindRepository, projectOf, repositoriesOf, bindingsOf, primarySource, kddHome,
  attentionData, blockTask,
  boardData, BUG_BODY_TEMPLATE, claimTask, commentTask, createTrack, decisionDetail,
  deleteTrack, DEFAULT_TTL,
  detachFile, editTask, editTrack, exportBoard, kddVersion, KINDS, linkTasks,
  listCriteria, listProjects,
  listTracks, moveTask, now, openDb,
  rebuild, recall, removeCriterion,
  renewClaim, resolveDbPath, resolveDecisionsDir, resolveToplevel, setCriterionChecked,
  setProjectToplevel, statusDigest, storeIdentity, releaseInfo, compareVersions,
  syncedTaskDetail, taskBrief, unarchiveTask, unblockTask,
  type Kind, type Status, type UpdateChannel,
} from '@kddkit/core';
import { projectPool, startUi } from '@kddkit/ui';
import { fail, getActor, parseId, withDb, withDbAt } from './context.js';
import {
  renderAttention, renderBoard, renderBrief, renderClaim, renderCriteria, renderDecision,
  renderRecall, renderShow, renderStatus,
  renderTracks,
} from './render.js';
import { noticeOnStartup } from './update-notifier.js';
import { preflightTarget, runCommand, updateCli, updateClaude, updateCodex } from './update.js';

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
  .option('--kind <k>', 'feature|bug|chore|research')
  .option('--area <area>')
  .option('--track <id>', 'track id')
  .option('--criterion <text>', 'acceptance criterion (repeatable)', collect, [])
  .option('--json', 'machine-readable output')
  .action((title, o) => run(o.json, () => {
    // Скелет repro — только в пустое тело и только при создании: он подсказка о форме
    // готовности, а не содержимое, и затирать написанное человеком ему нечем.
    const body = readBody(o) ?? (o.kind === 'bug' ? BUG_BODY_TEMPLATE : undefined);
    const t = withDb((db) => addTask(db,
      { title, body, priority: o.priority, kind: o.kind as Kind | undefined, area: o.area,
        track_id: o.track ? parseId(o.track) : undefined,
        criteria: o.criterion.length ? o.criterion : undefined }, getActor()));
    out(o.json, t, () => `#${t.id} created`);
  }));

program.command('decide')
  .argument('<title>')
  .option('--decision <t>').option('--rationale <t>').option('--alternatives <t>')
  .option('--outcome <t>').option('--supersedes <slug>')
  .option('--source-task <id>', 'source task id (repeatable)', collect, [])
  .option('--body <md>', 'full md body, or "-" for stdin')
  .option('--body-file <path>')
  .option('--json')
  .action((title, o) => run(o.json, () => {
    const r = withDb((db) => addDecision(db, resolveDecisionsDir(), {
      title, decision: o.decision, rationale: o.rationale,
      alternatives: o.alternatives, outcome: o.outcome,
      supersedes: o.supersedes, body: readBody(o),
      sourceTasks: o.sourceTask.map(parseId),
    }));
    out(o.json, r, () =>
      r.created ? `decided: ${r.slug}\n${r.path}` : `already recorded: ${r.slug}`);
  }));

program.command('decision')
  .argument('<slug>')
  .option('--json')
  .action((slug, o) => run(o.json, () => {
    const d = withDb((db) => decisionDetail(db, resolveDecisionsDir(), slug));
    out(o.json, d, () => renderDecision(d));
  }));

program.command('board')
  .option('--area <area>')
  .option('--status <s>')
  .option('--kind <k>', 'feature|bug|chore|research')
  .option('--track <id>', 'track id')
  .option('--ready', 'only tasks takeable now (new, not blocked)')
  .option('--archived', 'show archived tasks only')
  .option('--json')
  .action((o) => run(o.json, () => {
    // add/edit валидируют kind через ops (KINDS-словарь); board шёл прямо в WHERE и типо
    // тихо давал 0 строк вместо ошибки — то же сообщение, что и там, для единообразия.
    if (o.kind && !KINDS.includes(o.kind)) {
      throw new KddError(`invalid kind '${o.kind}'; allowed: ${KINDS.join(', ')}`);
    }
    const b = withDb((db) => boardData(db,
      { area: o.area, status: o.status as Status | undefined, archived: o.archived,
        kind: o.kind as Kind | undefined,
        ready: o.ready ? true : undefined,
        track_id: o.track ? parseId(o.track) : undefined }));
    out(o.json, b, () => renderBoard(b));
  }));

program.command('show')
  .argument('<id>')
  .option('--json')
  .action((id, o) => run(o.json, () => {
    // --json остаётся полным дампом; текст идёт через капы core
    if (o.json) {
      out(true, withDb((db) => syncedTaskDetail(db, resolveDecisionsDir(), parseId(id), true)), () => '');
      return;
    }
    console.log(renderShow(withDb((db) =>
      syncedTaskDetail(db, resolveDecisionsDir(), parseId(id)))));
  }));

program.command('brief')
  .argument('<taskId>')
  .option('--json')
  .action((taskId, o) => run(o.json, () => {
    const brief = withDb((db) => taskBrief(db, resolveDecisionsDir(), parseId(taskId)));
    out(o.json, brief, () => renderBrief(brief));
  }));

program.command('attention')
  .option('--json')
  .action((o) => run(o.json, () => {
    const inbox = withDb((db) => attentionData(db, now()));
    out(o.json, inbox, () => renderAttention(inbox));
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
  .argument('<id>', 'task id to claim')
  .option('--renew', 'renew the lease on a task you already hold')
  .option('--ttl <seconds>', 'lease length in seconds', String(DEFAULT_TTL))
  .option('--json')
  .action((id, o) => run(o.json, () => {
    const ttl = Number(o.ttl); // NaN на невалидном вводе -> core (assertTtl) отклонит
    const actor = getActor();
    const res = withDb((db) =>
      o.renew ? renewClaim(db, parseId(id), actor, ttl) : claimTask(db, parseId(id), actor, ttl));
    if (!res.ok) { fail(res.error, o.json); return; }
    out(o.json, res.task, () => renderClaim(res.task, o.renew ? 'renewed' : 'claimed'));
  }));

program.command('edit')
  .argument('<id>')
  .option('--title <t>').option('--body <md>').option('--body-file <path>')
  .option('--priority <p>').option('--area <a>')
  .option('--kind <k>', 'feature|bug|chore|research')
  .option('--track <id>', 'track id, or "none" to detach')
  .option('--json')
  .action((id, o) => run(o.json, () => {
    const track_id = o.track === undefined ? undefined : o.track === 'none' ? null : parseId(o.track);
    const t = withDb((db) => editTask(db, parseId(id),
      { title: o.title, body: readBody(o), priority: o.priority,
        kind: o.kind as Kind | undefined, area: o.area, track_id },
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

program.command('attach')
  .argument('<taskId>').argument('<path>')
  .option('--desc <text>', 'what is in the file — read by whoever has no picture')
  .option('--json')
  .action((taskId, path, o) => run(o.json, () => {
    const { dbPath, projectPath } = resolveDbPath();
    const f = withDbAt(dbPath, projectPath, (db) =>
      attachFile(db, dbPath, parseId(taskId), path, { description: o.desc }, getActor()));
    out(o.json, f, () => `#${f.task_id} file ${f.id} ${f.original_name}`);
  }));

program.command('detach')
  .argument('<fileId>')
  .option('--json')
  .action((fileId, o) => run(o.json, () => {
    const { dbPath, projectPath } = resolveDbPath();
    withDbAt(dbPath, projectPath, (db) => detachFile(db, dbPath, parseId(fileId), getActor()));
    out(o.json, { ok: true }, () => `file ${parseId(fileId)} detached`);
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

// Loopback-адреса: за ними граница доверия — сама машина, токен не нужен.
// '' и '::' — это «все интерфейсы», то есть самый громкий выход наружу.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// Адрес, по которому выставленную доску видно с телефона. Первый не-internal IPv4: точнее
// угадать нельзя (интерфейсов бывает несколько), но это на порядок полезнее, чем localhost.
const lanAddress = (): string | undefined => Object.values(networkInterfaces()).flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

program.command('ui')
  .option('--port <n>', 'port', '4499')
  .option('--host <addr>', 'bind address; anything but loopback needs --token', '127.0.0.1')
  .option('--token <t>', 'shared secret required on /api when bound outside loopback ($KDD_UI_TOKEN)')
  .action((o) => run(false, () => {
    const host = String(o.host);
    const token = o.token ?? process.env.KDD_UI_TOKEN;
    // Голая доска в общей сети — это чужие руки на кнопке «удалить», плюс список абсолютных
    // путей всех проектов машины. Наружу — только сознательно и только с секретом.
    if (!LOOPBACK.has(host) && !token) {
      throw new KddError(
        `--host ${host} exposes the board beyond this machine — pass --token <secret> ` +
        `(or set KDD_UI_TOKEN) so it is not open to the whole network`);
    }
    void uiStart(Number(o.port), host, token);
  }));

// Один сервер на все проекты: если kdd-ui уже поднят на порту — переиспользуем,
// печатаем URL с ?project=<этот-hash>. Иначе поднимаем сервер здесь.
async function uiStart(port: number, host = '127.0.0.1', token?: string): Promise<void> {
  const { dbPath, projectPath } = resolveDbPath();
  const hash = basename(dirname(dbPath));
  // Токен — в ссылке: страница берёт его оттуда и подставляет во все свои запросы,
  // так что перезагрузка вкладки его не теряет. Хост в ссылке — тот, по которому доска
  // реально доступна: после `--host` печатать localhost бессмысленно, ради другого
  // устройства всё и затевалось.
  const url = `http://${LOOPBACK.has(host) ? 'localhost' : lanAddress() ?? host}:${port}`
    + `?project=${hash}` + (token ? `&token=${encodeURIComponent(token)}` : '');
  const probe = async (path: string): Promise<Response | null> => {
    try { return await fetch(`http://localhost:${port}${path}`, { signal: AbortSignal.timeout(500) }); }
    catch { return null; } // сервера нет — поднимаем свой
  };
  // Проба и отказы — ДО openDb: openDb мигрирует общую доску, и старый сервер, которому мы
  // откажем, остался бы крутить старый код над уже новой схемой.
  const ping = await probe('/api/ping');
  const info = ping?.ok
    ? (await ping.json()) as { kdd?: boolean; needsToken?: boolean; store?: string; version?: string } : null;
  if (info?.kdd) {
    // Сервер старой версии крутит старый код (и старую схему) — переиспользовать его после
    // обновления значит молча показать доску не той версией. Убивать чужой процесс не будем.
    if (info.version !== kddVersion()) {
      fail(`a kdd ui of version ${info.version ?? 'unknown'} already runs on :${port} — stop it and run kdd ui again`, false);
    }
    if (info.store !== storeIdentity()) {
      fail(info.store
        ? `a kdd ui already runs on :${port} with a different store — stop it or choose another --port`
        : `the kdd ui already running on :${port} does not report its store — stop the old server or choose another --port`,
      false);
    }
    // Режим работающего сервера мог не совпасть с запрошенным. Молча напечатать ссылку —
    // значит соврать: человек уверен, что доска выставлена наружу и под токеном, а она
    // ни то ни другое (или наоборот — открыта, когда он думает, что нет).
    if (!!token !== !!info.needsToken) {
      fail(info.needsToken
        ? `a kdd ui already runs on :${port} and requires a token — pass the same --token to reuse it`
        : `a kdd ui already runs on :${port} without a token — stop it before exposing the board`,
      false);
    }
    if (token && (await probe(`/api/version?token=${encodeURIComponent(token)}`))?.status === 401) {
      fail(`the kdd ui already running on :${port} was started with a different token`, false);
    }
  }
  const db = openDb(dbPath, projectPath); // создаём/мигрируем базу → проект виден в /api/projects
  try {
    // `kdd ui` запущен изнутри проекта — путь, который знает toplevel достоверно;
    // project_store выводит из него primary source для legacy-доски.
    setProjectToplevel(db, resolveToplevel());
  } catch { /* не git-репо: путь возможен только с KDD_DB, toplevel останется неизвестным */ }
  db.close();
  if (info?.kdd) {
    console.log(`kdd ui: ${url} (reusing running server)`);
    return;
  }
  const { getDb, closeAll } = projectPool(hash, { lockToDefault: !!token });
  try {
    await startUi(getDb, port, hash, { host, token });
  } catch (e) {
    closeAll();
    fail(e instanceof Error ? e.message : String(e), false);
  }
  process.on('SIGINT', () => { closeAll(); process.exit(0); });
  console.log(`kdd ui: ${url}`);
}

const criteria = program.command('criteria').description('acceptance criteria on tasks');

criteria.command('add')
  .description('add an acceptance criterion to a task')
  .argument('<taskId>').argument('<text>')
  .option('--json')
  .action((taskId, text, o) => run(o.json, () => {
    const c = withDb((db) => addCriterion(db, parseId(taskId), text, getActor()));
    out(o.json, c, () => `#${c.task_id} criterion ${c.id} added`);
  }));

criteria.command('check')
  .description('mark a criterion verified, optionally with evidence')
  .argument('<taskId>').argument('<id>')
  .option('--evidence <text>', 'verification command, URL, commit, attachment or note')
  .option('--json')
  .action((taskId, id, o) => run(o.json, () => {
    const c = withDb((db) =>
      setCriterionChecked(db, parseId(taskId), parseId(id), true, getActor(), o.evidence));
    out(o.json, c, () => `#${c.task_id} criterion ${c.id} checked`);
  }));

criteria.command('uncheck')
  .description('mark a criterion unverified')
  .argument('<taskId>').argument('<id>')
  .option('--json')
  .action((taskId, id, o) => run(o.json, () => {
    const c = withDb((db) =>
      setCriterionChecked(db, parseId(taskId), parseId(id), false, getActor()));
    out(o.json, c, () => `#${c.task_id} criterion ${c.id} unchecked`);
  }));

criteria.command('rm')
  .description('remove an acceptance criterion')
  .argument('<taskId>').argument('<id>')
  .option('--json')
  .action((taskId, id, o) => run(o.json, () => {
    withDb((db) => removeCriterion(db, parseId(taskId), parseId(id), getActor()));
    out(o.json, { ok: true }, () => `#${parseId(taskId)} criterion ${parseId(id)} removed`);
  }));

criteria.command('ls')
  .description('list acceptance criteria on a task')
  .argument('<taskId>')
  .option('--json')
  .action((taskId, o) => run(o.json, () => {
    const cs = withDb((db) => listCriteria(db, parseId(taskId)));
    out(o.json, cs, () => renderCriteria(cs));
  }));

const track = program.command('track').description('manage tracks (task groups)');

track.command('add')
  .description('create a track')
  .argument('<name>')
  .option('--description <t>', '"use when…" routing hint for the agent')
  .option('--json')
  .action((name, o) => run(o.json, () => {
    const t = withDb((db) => createTrack(db, { name, description: o.description }));
    out(o.json, t, () => `track #${t.id} ${t.name}`);
  }));

track.command('ls')
  .description('list active tracks, or all tracks with --all')
  .option('--all', 'include completed tracks')
  .option('--json')
  .action((o) => run(o.json, () => {
    const ts = withDb((db) => listTracks(db, o.all ? {} : { status: 'active' }));
    out(o.json, ts, () => renderTracks(ts));
  }));

track.command('edit')
  .description('rename a track or change its description')
  .argument('<id>')
  .option('--name <t>').option('--description <t>')
  .option('--json')
  .action((id, o) => run(o.json, () => {
    const t = withDb((db) => editTrack(db, parseId(id),
      { name: o.name, description: o.description }));
    out(o.json, t, () => `track #${t.id} updated`);
  }));

track.command('done')
  .description('mark a track complete')
  .argument('<id>')
  .option('--json')
  .action((id, o) => run(o.json, () => {
    const t = withDb((db) => editTrack(db, parseId(id), { status: 'done' }));
    out(o.json, t, () => `track #${t.id} done`);
  }));

track.command('reopen')
  .description('reactivate a completed track')
  .argument('<id>')
  .option('--json')
  .action((id, o) => run(o.json, () => {
    const t = withDb((db) => editTrack(db, parseId(id), { status: 'active' }));
    out(o.json, t, () => `track #${t.id} active`);
  }));

track.command('rm')
  .description('delete a track and detach its tasks')
  .argument('<id>')
  .option('--json')
  .action((id, o) => run(o.json, () => {
    withDb((db) => deleteTrack(db, parseId(id))); // задачи отцепляются, память остаётся
    out(o.json, { ok: true }, () => `track #${parseId(id)} deleted`);
  }));

const projectCommand = program.command('project').description('inspect and explicitly bind project repositories');
function withProjectStore(fn: (db: ReturnType<typeof openDb>, dbPath: string) => unknown): unknown {
  const { dbPath, projectPath } = resolveDbPath();
  if (!existsSync(dbPath)) throw new KddError(`unknown project store: ${dbPath}; open it before binding repositories`);
  return withDbAt(dbPath, projectPath, db => fn(db, dbPath));
}
projectCommand.command('show').option('--json').action(o => run(o.json, () => {
  // Источник решений — один чекаут первичного репо; без пометки его не отличить от клонов.
  const result = withDb(db => {
    const source = primarySource(db)?.common_dir;
    return { project: projectOf(db), repositories: repositoriesOf(db),
      bindings: bindingsOf(db).map(b => ({ ...b, decisions_source: b.common_dir === source })) };
  });
  const source = result.bindings.find(b => b.decisions_source);
  out(o.json,result,() => JSON.stringify(result,null,2)
    + `\n${source ? `${source.checkout_path} (decisions source)` : 'no decisions source'}`);
}));
projectCommand.command('add-repo').argument('<checkout>')
  .requiredOption('--purpose <text>')
  .option('--json').action((cwd,o) => run(o.json, () => {
    const result = withProjectStore((db,path) => addRepository(db,path,kddHome(),{cwd,purpose:o.purpose},getActor()));
    out(o.json,result,() => JSON.stringify(result,null,2));
  }));
projectCommand.command('bind').argument('<checkout>')
  .requiredOption('--repo <id>')
  .option('--json').action((cwd,o) => run(o.json, () => {
    const result = withProjectStore((db,path) => bindRepository(db,path,kddHome(),{cwd,repoId:o.repo},getActor()));
    out(o.json,result,() => JSON.stringify(result,null,2));
  }));
projectCommand.command('rebind').argument('<old-common-dir>').argument('<checkout>')
  .option('--json').action((fromCommonDir,cwd,o) => run(o.json, () => {
    const result = withProjectStore((db,path) => rebindRepository(db,path,kddHome(),{fromCommonDir,cwd},getActor()));
    out(o.json,result,() => JSON.stringify(result,null,2));
  }));

program.command('projects')
  .option('--json')
  .action((o) => run(o.json, () => {
    const ps = listProjects();
    out(o.json, ps, () =>
      ps.length ? ps.map((p) => `${p.projectPath}\n  ${p.dbPath}`).join('\n') : 'no projects');
  }));

program.command('export')
  .option('--include-sensitive')
  .action((o) => run(true, () => {
    const dump = withDb((db) => exportBoard(db, resolveDecisionsDir(),
      { includeSensitive: !!o.includeSensitive }));
    console.log(JSON.stringify(dump));
  }));

program.command('update')
  .description('update installed kddkit CLI and plugins')
  .option('--next', 'explicitly subscribe installed components to the next preview channel')
  .option('--replace-cli-from-registry', 'allow replacing an older unknown-source CLI from npm registry; verified updates keep this consent')
  .addHelpText('after', '\nCLI consent receipt: <KDD_HOME>/update-cli-receipt.json (default ~/.kdd/update-cli-receipt.json). Delete it to revoke continuing consent. A same-version local tarball can be replaced while it remains valid.')
  .action(async (o: { next?: boolean; replaceCliFromRegistry?: boolean }) => {
    const channel: UpdateChannel = o.next ? 'next' : 'stable';
    const release = await releaseInfo({ fresh: true });
    const target = channel === 'next' ? release.next : release.latest;
    if (release.error || !target) {
      console.error(`kdd update: ${release.error ?? `no published ${channel} release available`}`);
      process.exitCode = 1;
      return;
    }
    if (channel === 'next' && release.latest && compareVersions(target, release.latest) <= 0) {
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
      updateCli(target, channel, runCommand, fileURLToPath(import.meta.url), process.execPath, !!o.replaceCliFromRegistry),
    ];
    for (const result of results) console.log(`${result.name}: ${result.status} — ${result.detail}`);
    if (results.some((result) => result.name !== 'cli' && result.status === 'updated'))
      console.log('Restart Claude Code or Codex to load updated plugins.');
    if (results.some((result) => result.status === 'failed')) process.exitCode = 1;
  });

noticeOnStartup();
await program.parseAsync();
