import { describe, it, expect, afterEach } from 'vitest';
import { addTask, getAutoTick, openDb, setAutoTick, setLastRun } from '@kddkit/core';
import { createApp } from '../src/server.js';

const user = { type: 'user' } as const;
const mk = () => {
  const db = openDb(':memory:', 'x');
  return { db, app: createApp(() => db) };
};

describe('GET /api/board', () => {
  it('returns five columns with tasks grouped by status', async () => {
    const { db, app } = mk();
    addTask(db, { title: 'hello board' }, user);
    const res = await app.request('/api/board');
    expect(res.status).toBe(200);
    const b = (await res.json()) as Record<string, { title: string }[]>;
    expect(Object.keys(b)).toEqual(['backlog', 'new', 'in_progress', 'review', 'done']);
    expect(b.new.map((t) => t.title)).toEqual(['hello board']);
  });
});

describe('GET /api/version', () => {
  it('is 0 on empty db and grows after a mutation', async () => {
    const { db, app } = mk();
    expect(await (await app.request('/api/version')).json()).toEqual({ version: 0 });
    addTask(db, { title: 'x' }, user);
    const { version } = (await (await app.request('/api/version')).json()) as { version: number };
    expect(version).toBeGreaterThan(0);
  });
});

describe('GET /api/tasks/:id', () => {
  it('returns task detail with comments and events', async () => {
    const { db, app } = mk();
    const t = addTask(db, { title: 'detail me' }, user);
    const res = await app.request(`/api/tasks/${t.id}`);
    expect(res.status).toBe(200);
    const d = (await res.json()) as
      { task: { title: string }; comments: unknown[]; events: unknown[] };
    expect(d.task.title).toBe('detail me');
    expect(Array.isArray(d.comments)).toBe(true);
    expect(d.events.length).toBe(1);
  });

  it('unknown id → 400 with error text', async () => {
    const { app } = mk();
    const res = await app.request('/api/tasks/999');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/not found/);
  });

  it('non-numeric id → 400', async () => {
    const { app } = mk();
    expect((await app.request('/api/tasks/abc')).status).toBe(400);
  });
});

describe('POST /api/tasks', () => {
  it('creates a task with actor user', async () => {
    const { db, app } = mk();
    const res = await app.request('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: 'from ui', priority: 'high' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const t = (await res.json()) as { id: number; priority: string };
    expect(t.priority).toBe('high');
    const ev = db.prepare(`SELECT actor_type, action FROM events WHERE task_id = ?`).all(t.id);
    expect(ev).toEqual([{ actor_type: 'user', action: 'created' }]);
  });

  it('empty title → 400', async () => {
    const { app } = mk();
    const res = await app.request('/api/tasks', {
      method: 'POST', body: JSON.stringify({ title: '  ' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/title/);
  });

  it('invalid JSON body → 400', async () => {
    const { app } = mk();
    const res = await app.request('/api/tasks', { method: 'POST', body: 'not json' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid JSON body');
  });
});

describe('PATCH /api/tasks/:id', () => {
  it('edits title, body and priority', async () => {
    const { db, app } = mk();
    const t = addTask(db, { title: 'old' }, user);
    const res = await app.request(`/api/tasks/${t.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'new', body: '# md', priority: 'urgent' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const u = (await res.json()) as { title: string; body: string; priority: string };
    expect([u.title, u.body, u.priority]).toEqual(['new', '# md', 'urgent']);
  });
});

describe('POST /api/tasks/:id/move', () => {
  it('moves through the state machine', async () => {
    const { db, app } = mk();
    const t = addTask(db, { title: 'm' }, user);
    const res = await app.request(`/api/tasks/${t.id}/move`, {
      method: 'POST', body: JSON.stringify({ to: 'in_progress' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(((await res.json()) as { status: string }).status).toBe('in_progress');
  });

  it('same-status move → 400 already in', async () => {
    const { db, app } = mk();
    const t = addTask(db, { title: 'm' }, user);
    const res = await app.request(`/api/tasks/${t.id}/move`, {
      method: 'POST', body: JSON.stringify({ to: 'new' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/already in/);
  });
});

describe('POST /api/tasks/:id/comments', () => {
  it('adds a user comment visible in detail', async () => {
    const { db, app } = mk();
    const t = addTask(db, { title: 'c' }, user);
    const res = await app.request(`/api/tasks/${t.id}/comments`, {
      method: 'POST', body: JSON.stringify({ body: 'hi from ui' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { author: string }).author).toBe('user');
    const d = (await (await app.request(`/api/tasks/${t.id}`)).json()) as
      { comments: { body: string }[] };
    expect(d.comments.map((x) => x.body)).toEqual(['hi from ui']);
  });
});

describe('unknown api route', () => {
  it('GET /api/nope → 404', async () => {
    const { app } = mk();
    expect((await app.request('/api/nope')).status).toBe(404);
  });
});

describe('GET /api/releases', () => {
  // Живой вызов без подменённого fetch: у releaseInfo свой AbortSignal.timeout(5000),
  // и он обязан всегда срабатывать первым. С дефолтными 5000 vitest две отсечки идут
  // ноздря в ноздрю, и в сети, которая молча глотает пакеты вместо отказа, падает тест,
  // а не код. Запас — чтобы гонки не было вовсе.
  it('returns the app version and never fails the request', async () => {
    const { app } = mk();
    const res = await app.request('/api/releases');
    expect(res.status).toBe(200);
    const info = (await res.json()) as
      { current: string; releases: unknown[]; repoUrl: string | null };
    // current читается локально из package.json — есть даже когда GitHub недоступен
    expect(info.current).toMatch(/^\d+\.\d+\.\d+/);
    expect(Array.isArray(info.releases)).toBe(true);
    expect(info.repoUrl).toBe('https://github.com/mag1yar/kddkit');
  }, 20_000);
});

// KDD_MAX_WORKERS с машины разработчика перевернул бы maxWorkersEnvLocked
afterEach(() => { delete process.env.KDD_MAX_WORKERS; });

describe('/api/autotick', () => {
  it('GET на пустой базе — дефолты, без таймера', async () => {
    const { app } = mk();
    const res = await app.request('/api/autotick');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: false, intervalSec: 60, maxWorkers: 3,
      maxWorkersEnvLocked: false, last: null, nextAt: null,
    });
  });

  it('PATCH пишет настройки и отдаёт новое состояние', async () => {
    const { db, app } = mk();
    const res = await app.request('/api/autotick', {
      method: 'PATCH',
      body: JSON.stringify({ enabled: true, intervalSec: 300, maxWorkers: 4 }),
    });
    expect(res.status).toBe(200);
    const s = (await res.json()) as { enabled: boolean; intervalSec: number; maxWorkers: number };
    expect(s).toMatchObject({ enabled: true, intervalSec: 300, maxWorkers: 4 });
    expect(getAutoTick(db)).toMatchObject({ enabled: true, intervalSec: 300, maxWorkers: 4 });
  });

  it('PATCH с мусорным интервалом — 400 и ничего не записано', async () => {
    const { db, app } = mk();
    const res = await app.request('/api/autotick', {
      method: 'PATCH', body: JSON.stringify({ intervalSec: 7 }),
    });
    expect(res.status).toBe(400);
    expect(getAutoTick(db).intervalSec).toBe(60);
  });

  it('PATCH с enabled строкой "false" — 400, а не тихое включение', async () => {
    const { db, app } = mk();
    const res = await app.request('/api/autotick', {
      method: 'PATCH', body: JSON.stringify({ enabled: 'false' }),
    });
    expect(res.status).toBe(400);
    expect(getAutoTick(db).enabled).toBe(false);
  });

  it('PATCH дёргает scheduler.sync и отдаёт его nextAt', async () => {
    const db = openDb(':memory:', 'x');
    const synced: string[] = [];
    const app = createApp(() => db, 'proj', {
      sync: (h: string) => { synced.push(h); },
      syncAll: () => {},
      nextAt: () => 1700000060,
      stopAll: () => {},
    });
    const res = await app.request('/api/autotick', {
      method: 'PATCH', body: JSON.stringify({ enabled: true }),
    });
    const s = (await res.json()) as { nextAt: number | null };
    expect(synced).toEqual(['proj']);
    expect(s.nextAt).toBe(1700000060);
  });

  it('GET отдаёт последний проход', async () => {
    const { db, app } = mk();
    setLastRun(db, { at: 1700000000, reclaimed: 1, spawned: 2, active: 3, reaped: 0 });
    const s = (await (await app.request('/api/autotick')).json()) as
      { last: { spawned: number } | null };
    expect(s.last?.spawned).toBe(2);
  });

  // KDD_MAX_WORKERS переопределяет сохранённую настройку — GET должен отдавать
  // действующее число (env), а не то, что оно заменило, иначе задизейбленное
  // поле в UI подписано "overridden by ..." и врёт про своё собственное значение.
  it('GET с KDD_MAX_WORKERS — отдаёт env-значение и maxWorkersEnvLocked=true', async () => {
    const { db, app } = mk();
    setAutoTick(db, { maxWorkers: 3 });
    process.env.KDD_MAX_WORKERS = '5';
    const s = (await (await app.request('/api/autotick')).json()) as
      { maxWorkers: number; maxWorkersEnvLocked: boolean };
    expect(s).toMatchObject({ maxWorkers: 5, maxWorkersEnvLocked: true });
  });
});
