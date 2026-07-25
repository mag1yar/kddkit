import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import {
  KddError, addCriterion, addTask, blockTask, boardData, commentTask, createTrack, deleteTrack,
  editTask, editTrack, kddHome, listAgentEvents, listProjects, listTracks, moveTask, openDb,
  placeTask, releaseInfo, removeCriterion, setCriterionChecked, taskDetail, unblockTask,
  type Priority,
} from '@kddkit/core';

const hashOf = (dbPath: string) => basename(dirname(dbPath));

// Пул баз по hash проекта: один сервер обслуживает все локальные проекты.
// getDb(c) резолвит базу из ?project=<hash>, иначе дефолт (проект, откуда запущен ui).
export function projectPool(defaultHash: string): {
  getDb: (c: Context) => Database.Database; closeAll: () => void;
} {
  const pool = new Map<string, Database.Database>();
  const getDb = (c: Context): Database.Database => {
    const hash = c.req.query('project') || defaultHash;
    const cached = pool.get(hash);
    if (cached) return cached;
    if (!listProjects().some((p) => hashOf(p.dbPath) === hash)) {
      throw new KddError(`unknown project '${hash}'`);
    }
    const db = openDb(join(kddHome(), hash, 'kdd.db'));
    pool.set(hash, db);
    return db;
  };
  return { getDb, closeAll: () => { for (const d of pool.values()) d.close(); } };
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

export function createApp(
  getDb: (c: Context) => Database.Database, defaultHash = '',
): Hono {
  const app = new Hono();

  app.onError((e, c) => {
    if (e instanceof KddError) return c.json({ error: e.message }, 400);
    console.error(e);
    return c.json({ error: 'internal error' }, 500);
  });

  // Мультипроектность: ping (переиспользование сервера из cli) + список проектов для select.
  app.get('/api/ping', (c) => c.json({ kdd: true, default: defaultHash }));
  app.get('/api/projects', (c) => c.json(
    listProjects().map((p) => ({ id: hashOf(p.dbPath), path: p.projectPath })),
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

export function startUi(
  getDb: (c: Context) => Database.Database, port: number, defaultHash = '',
): Promise<{ url: string; close: () => void }> {
  const app = createApp(getDb, defaultHash);
  mountStatic(app, join(dirname(fileURLToPath(import.meta.url)), 'public'));
  return new Promise((res, rej) => {
    const server = serve({ fetch: app.fetch, port }, (info) => {
      res({ url: `http://localhost:${info.port}`, close: () => server.close() });
    });
    server.on('error', rej); // порт занят не-kdd → отдаём ошибку в cli, а не виснем
  });
}
