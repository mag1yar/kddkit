import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import {
  KddError, addCriterion, addTask, blockTask, boardData, commentTask, createTrack, deleteTrack,
  editTask, editTrack, getAutoTick, getLastRun, kddHome, listAgentEvents, listProjects, listTracks,
  maxWorkers, maxWorkersEnvLocked, moveTask, openDb, placeTask, releaseInfo, removeCriterion,
  setAutoTick, setCriterionChecked, taskDetail, unblockTask, type Priority,
} from '@kddkit/core';

export {
  createScheduler, type ProjectRef, type Scheduler, type TickRunner, type WorkerStopper,
} from './scheduler.js';
import type { Scheduler } from './scheduler.js';

const hashOf = (dbPath: string) => basename(dirname(dbPath));

// Форма hash-а каталога проекта — ровно то, что пишет resolveDbPath в core/paths.ts:
// createHash('sha256').update(common).digest('hex').slice(0, 16). Проверка формы, а не
// только существования файла: hash приходит из ?project= сырым HTTP-параметром, и
// join(kddHome(), hash, 'kdd.db') с чем угодно кроме hex-строки — path traversal
// (?project=../../любой/путь) наружу store root. openDb ниже не только читает — она
// прогоняет миграции, т.е. ПИШЕТ в файл по этому пути, так что дырка не read-only.
const HASH_RE = /^[0-9a-f]{16}$/;

// Пул баз по hash проекта: один сервер обслуживает все локальные проекты.
// getDb(c) резолвит базу из ?project=<hash>, иначе дефолт (проект, откуда запущен ui).
// lockToDefault — сервер выставлен наружу (`kdd ui --host --token`): ?project не слушаем вовсе,
// иначе держатель токена, знающий путь чужого репозитория на этой машине, вычислил бы его hash
// (sha256 от пути) и правил бы доску, которую ему не показывали.
export function projectPool(defaultHash: string, opts: { lockToDefault?: boolean } = {}): {
  getDb: (c: Context) => Database.Database;
  get: (hash: string) => Database.Database;
  closeAll: () => void;
} {
  const pool = new Map<string, Database.Database>();
  const get = (hash: string): Database.Database => {
    const cached = pool.get(hash);
    if (cached) return cached;
    if (!HASH_RE.test(hash)) throw new KddError(`unknown project '${hash}'`);
    const dbPath = join(kddHome(), hash, 'kdd.db');
    // Существование файла — та же гарантия для «hash из HTTP-запроса не выдуман», что и
    // обход listProjects(), но без readonly-коннекта ко ВСЕМ остальным доскам на каждый
    // промах пула. openDb ниже создал бы базу с нуля, поэтому проверка обязательна.
    if (!existsSync(dbPath)) throw new KddError(`unknown project '${hash}'`);
    const db = openDb(dbPath);
    pool.set(hash, db);
    return db;
  };
  return {
    getDb: (c: Context) => get(opts.lockToDefault ? defaultHash : c.req.query('project') || defaultHash),
    get,
    closeAll: () => { for (const d of pool.values()) d.close(); },
  };
}

const USER = { type: 'user' } as const;

function intParam(c: Context, name: string): number {
  const raw = c.req.param(name);
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new KddError(`invalid ${name} '${raw}'`);
  return n;
}

const taskId = (c: Context): number => intParam(c, 'id');

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    throw new KddError('invalid JSON body');
  }
}

// Loopback не спасает от браузера: сайт с TTL 0 перерезолвит свой домен в 127.0.0.1, для
// браузера origin не менялся, и его скрипт читает /api/projects и правит доску. Единственное,
// что при этом невозможно подделать, — заголовок Host: он остаётся доменом атакующего.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// Смотрим на c.req.url, а не на заголовок: @hono/node-server собирает этот URL ровно из Host
// (или :authority у HTTP/2), то есть проверка та же, но работает и для in-process запросов,
// у которых заголовка нет вовсе.
const loopbackHost = (reqUrl: string, port: number | undefined): boolean => {
  let u: URL;
  try { u = new URL(reqUrl); } catch { return false; } // мусор — точно не наш
  if (!LOOPBACK_HOSTS.has(u.hostname)) return false;
  // Порт сверяем, только если знаем свой: соседний сервис на другом порту той же машины
  // не должен уметь притворяться нами в чужой вкладке.
  return port === undefined || u.port === String(port);
};

export function createApp(
  getDb: (c: Context) => Database.Database, defaultHash = '', scheduler?: Scheduler,
  opts: { token?: string; port?: () => number | undefined } = {},
): Hono {
  const app = new Hono();
  const token = opts.token;

  app.onError((e, c) => {
    if (e instanceof KddError) return c.json({ error: e.message }, 400);
    console.error(e);
    return c.json({ error: 'internal error' }, 500);
  });

  // Токен появляется РОВНО тогда, когда сервер сознательно выставлен за loopback
  // (`kdd ui --host`). Пока слушаем 127.0.0.1, граница доверия — сама машина, и проверять
  // нечего; наружу же доска без проверки — это чужие руки на кнопке «удалить критерий».
  // Статика под токен не уходит: пустая оболочка SPA ничего не рассказывает, а человек
  // открывает ссылку с ?token и сразу работает.
  if (token) {
    app.use('/api/*', async (c, next) => {
      // ping — вне проверки: по нему `kdd ui` из соседнего проекта решает, переиспользовать ли
      // этот сервер, а токена работающего сервера он знать не может. Секрета ping не выдаёт:
      // только «я kdd» + hash доски + нужен ли токен.
      if (c.req.path === '/api/ping') return next();
      if ((c.req.header('x-kdd-token') ?? c.req.query('token')) !== token) {
        return c.json({ error: 'unauthorized' }, 401);
      }
      await next();
    });
  } else {
    // Проверка Host — пара к loopback-биндингу, и только для него: у выставленного наружу
    // сервера Host законно чужой (LAN-адрес, имя машины), и там граница — токен выше.
    app.use('/api/*', async (c, next) => {
      if (!loopbackHost(c.req.url, opts.port?.())) {
        return c.json({ error: 'forbidden host' }, 403);
      }
      await next();
    });
  }

  // Мультипроектность: ping (переиспользование сервера из cli) + список проектов для select.
  // needsToken говорит второму `kdd ui`, с каким сервером он имеет дело: без этого он либо
  // молча печатал бы ссылку на сервер, поднятый совсем в другом режиме, либо (когда ping был
  // под токеном) получал 401 и падал с EADDRINUSE вместо переиспользования.
  app.get('/api/ping', (c) => c.json({ kdd: true, default: defaultHash, needsToken: !!token }));
  // Список — это абсолютные пути ВСЕХ досок на машине, то есть инвентарь чужой работы.
  // Переключатель проектов нужен своему человеку за loopback; выставленный наружу сервер
  // отдаёт только ту доску, ради которой его выставили.
  app.get('/api/projects', (c) => c.json(
    listProjects()
      .filter((p) => !token || hashOf(p.dbPath) === defaultHash)
      .map((p) => ({ id: hashOf(p.dbPath), path: p.projectPath })),
  ));

  app.get('/api/tracks', (c) => c.json(listTracks(getDb(c), { status: 'active' })));

  app.post('/api/tracks', async (c) => {
    const b = await jsonBody(c);
    return c.json(createTrack(getDb(c), {
      name: String(b.name ?? ''), description: b.description as string | undefined,
    }));
  });

  app.patch('/api/tracks/:id', async (c) => {
    const b = await jsonBody(c);
    return c.json(editTrack(getDb(c), taskId(c), {
      name: b.name as string | undefined,
      description: b.description as string | undefined,
      status: b.status as 'active' | 'done' | undefined,
    }));
  });

  app.delete('/api/tracks/:id', (c) => {
    deleteTrack(getDb(c), taskId(c));
    return c.json({ ok: true });
  });

  app.get('/api/board', (c) => {
    const track = Number(c.req.query('track'));
    return c.json(boardData(getDb(c),
      Number.isInteger(track) && track > 0 ? { track_id: track } : {}));
  });

  app.get('/api/version', (c) => c.json({
    version: (getDb(c).prepare(`SELECT COALESCE(MAX(id), 0) AS v FROM events`)
      .get() as { v: number }).v,
  }));

  // Версия приложения и changelog. Без ?project= — свойство процесса, а не доски,
  // поэтому getDb не трогаем. Кэш живёт в core: один фетч на процесс, а не на вкладку.
  app.get('/api/releases', async (c) => c.json(await releaseInfo()));

  // Тот же fallback, что и getDb в projectPool — единая точка правды на "чей это hash",
  // а не третья копия ?project || defaultHash рядом с планировщиком.
  // В выставленном наружу режиме ?project вообще не слушаем: hash — это sha256 от пути
  // репозитория, то есть держатель токена, знающий чужой путь на этой машине, вычислил бы
  // его сам и правил бы чужую доску. Прятать её из списка при этом бессмысленно.
  const projectHash = (c: Context): string =>
    (token ? defaultHash : c.req.query('project') || defaultHash);

  // Авто-tick: настройки в meta проекта, таймер — в планировщике сервера.
  // scheduler необязателен: без него (сервер поднят не через `kdd ui`, тесты)
  // настройки сохраняются, но таймеров нет и nextAt всегда null.
  const autoTickState = (c: Context): Record<string, unknown> => {
    const db = getDb(c);
    // maxWorkers(db) — эффективное значение (env > meta > дефолт), а не только
    // сохранённая настройка: иначе задизейбленное поле подписано "overridden by
    // KDD_MAX_WORKERS" и показывает число, которое этот override как раз заменил.
    // maxWorkers() кидает KddError при мусорном KDD_MAX_WORKERS — тут не даём 400
    // уронить весь GET (без контрола в шапке хуже, чем с неточным числом), падаем
    // на сохранённую настройку.
    let effectiveWorkers: number;
    try { effectiveWorkers = maxWorkers(db); } catch { effectiveWorkers = getAutoTick(db).maxWorkers; }
    return {
      ...getAutoTick(db),
      maxWorkers: effectiveWorkers,
      maxWorkersEnvLocked: maxWorkersEnvLocked(),
      last: getLastRun(db),
      nextAt: scheduler?.nextAt(projectHash(c)) ?? null,
      // Пока проход идёт, nextAt смотрит в прошлое (перевзвод — в хвосте прохода): без этого
      // флага UI показывал бы «next: in 0 s» всё время работы тика и не отличал бы висящий
      // проход от простоя.
      running: scheduler?.isRunning(projectHash(c)) ?? false,
    };
  };

  app.get('/api/autotick', (c) => c.json(autoTickState(c)));

  app.patch('/api/autotick', async (c) => {
    const b = await jsonBody(c);
    // Только настоящий boolean: "false"-строка от небрежного клиента не должна тихо включить tick.
    if (b.enabled !== undefined && typeof b.enabled !== 'boolean') {
      throw new KddError('enabled must be a boolean');
    }
    setAutoTick(getDb(c), {
      enabled: b.enabled as boolean | undefined,
      intervalSec: b.intervalSec as number | undefined,
      maxWorkers: b.maxWorkers as number | undefined,
    });
    scheduler?.sync(projectHash(c));
    // Off — это «останови автономию», а не «перестань спаунить новых»: живых воркеров добиваем.
    // Результат не ждём — kill ждёт смерти процесса секундами, а тумблер обязан ответить сразу.
    if (b.enabled === false) void scheduler?.killWorkers(projectHash(c));
    return c.json(autoTickState(c));
  });

  app.get('/api/tasks/:id', (c) => c.json(taskDetail(getDb(c), taskId(c))));

  // Tier1 agent feed: события воркера для таска, инкрементально по since=<id>.
  app.get('/api/tasks/:id/feed', (c) => c.json(
    listAgentEvents(getDb(c), taskId(c), { sinceId: Number(c.req.query('since') ?? 0) })));

  app.post('/api/tasks', async (c) => {
    const b = await jsonBody(c);
    return c.json(addTask(getDb(c), {
      title: String(b.title ?? ''),
      body: b.body as string | undefined,
      priority: b.priority as Priority | undefined,
      track_id: b.track_id as number | undefined,
    }, USER));
  });

  app.patch('/api/tasks/:id', async (c) => {
    const b = await jsonBody(c);
    return c.json(editTask(getDb(c), taskId(c), {
      title: b.title as string | undefined,
      body: b.body as string | undefined,
      priority: b.priority as Priority | undefined,
      track_id: b.track_id as number | null | undefined,
    }, USER));
  });

  app.post('/api/tasks/:id/move', async (c) => {
    const b = await jsonBody(c);
    const to = String(b.to ?? '');
    // order: полный порядок id колонки-назначения (drag на доске). Нет order → CLI-подобный move в конец.
    if (Array.isArray(b.order)) {
      const order = b.order.map(Number).filter(Number.isInteger);
      return c.json(placeTask(getDb(c), taskId(c), to, order, USER));
    }
    return c.json(moveTask(getDb(c), taskId(c), to, USER));
  });

  app.post('/api/tasks/:id/block', async (c) => {
    const b = await jsonBody(c);
    return c.json(blockTask(getDb(c), taskId(c), String(b.reason ?? ''), USER));
  });

  app.post('/api/tasks/:id/unblock', (c) => c.json(unblockTask(getDb(c), taskId(c), USER)));

  app.post('/api/tasks/:id/comments', async (c) => {
    const b = await jsonBody(c);
    return c.json(commentTask(getDb(c), taskId(c), String(b.body ?? ''), USER));
  });

  app.post('/api/tasks/:id/criteria', async (c) => {
    const b = await jsonBody(c);
    return c.json(addCriterion(getDb(c), taskId(c), String(b.text ?? ''), USER));
  });

  app.patch('/api/tasks/:id/criteria/:cid', async (c) => {
    const b = await jsonBody(c);
    return c.json(setCriterionChecked(
      getDb(c), taskId(c), intParam(c, 'cid'), Boolean(b.checked), USER));
  });

  app.delete('/api/tasks/:id/criteria/:cid', (c) => {
    removeCriterion(getDb(c), taskId(c), intParam(c, 'cid'), USER);
    return c.json({ ok: true });
  });

  return app;
}

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.map': 'application/json',
  '.woff2': 'font/woff2',
};

// ponytail: свой static-хендлер ~20 строк — serveStatic из @hono/node-server
// требует root относительно cwd, что ломается при запуске из чужой директории
function mountStatic(app: Hono, publicDir: string): void {
  app.get('*', async (c) => {
    if (c.req.path.startsWith('/api/')) return c.notFound();
    const rel = c.req.path === '/' ? 'index.html' : c.req.path.slice(1);
    const file = resolve(publicDir, rel);
    if (!file.startsWith(resolve(publicDir))) return c.notFound();
    for (const p of [file, join(publicDir, 'index.html')]) {
      try {
        const data = await readFile(p);
        return c.body(new Uint8Array(data), 200,
          { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
      } catch { /* следующий кандидат */ }
    }
    return c.text('ui not built', 404);
  });
}

// hostname по умолчанию — loopback. Без него node биндит '::', то есть все интерфейсы: любой
// в том же кафе читал и правил бы доску, а `/api/projects` отдавал бы ему абсолютные пути всех
// проектов на машине ещё до всякого выбора. Выход наружу — осознанный опт-ин с токеном.
export function startUi(
  getDb: (c: Context) => Database.Database, port: number, defaultHash = '',
  scheduler?: Scheduler, opts: { host?: string; token?: string } = {},
): Promise<{ url: string; close: () => void }> {
  // Порт узнаём только из колбэка listen (port 0 = эфемерный), а приложение собирается до —
  // поэтому Host-проверка спрашивает его функцией, а не значением. Запросов между listen и
  // присвоением быть не может: сокет до этого момента не принят.
  let listening: number | undefined;
  const app = createApp(getDb, defaultHash, scheduler,
    { token: opts.token, port: () => listening });
  mountStatic(app, join(dirname(fileURLToPath(import.meta.url)), 'public'));
  return new Promise((res, rej) => {
    const server = serve({ fetch: app.fetch, port, hostname: opts.host ?? '127.0.0.1' }, (info) => {
      listening = info.port;
      scheduler?.syncAll(); // таймеры включённых проектов поднимаются сами после рестарта
      res({ url: `http://localhost:${info.port}`, close: () => { scheduler?.stopAll(); server.close(); } });
    });
    server.on('error', rej); // порт занят не-kdd → отдаём ошибку в cli, а не виснем
  });
}
