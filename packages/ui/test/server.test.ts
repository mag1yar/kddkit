import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPS, addTask, createTrack, editTrack, getAutoTick, openDb, setAutoTick, setLastRun } from '@kddkit/core';
import { createApp, projectPool } from '../src/server.js';

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
      maxWorkersEnvLocked: false, last: null, nextAt: null, running: false,
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
      isRunning: () => false,
      killWorkers: async () => {},
      stopAll: () => {},
    });
    const res = await app.request('/api/autotick', {
      method: 'PATCH', body: JSON.stringify({ enabled: true }),
    });
    const s = (await res.json()) as { nextAt: number | null };
    expect(synced).toEqual(['proj']);
    expect(s.nextAt).toBe(1700000060);
  });

  // #112: off — это «останови автономию», а не «перестань спаунить новых». Без этого человек
  // выключил тумблер, а три claude дожёвывают свои задачи, коммитят и комментируют доску.
  it('PATCH enabled:false добивает живых воркеров, enabled:true — нет', async () => {
    const db = openDb(':memory:', 'x');
    const killed: string[] = [];
    const app = createApp(() => db, 'proj', {
      sync: () => {}, syncAll: () => {}, nextAt: () => null, isRunning: () => false,
      killWorkers: async (h: string) => { killed.push(h); }, stopAll: () => {},
    });
    await app.request('/api/autotick', { method: 'PATCH', body: JSON.stringify({ enabled: true }) });
    expect(killed).toEqual([]);
    await app.request('/api/autotick', { method: 'PATCH', body: JSON.stringify({ enabled: false }) });
    expect(killed).toEqual(['proj']);
  });

  // Пока проход идёт, nextAt смотрит в прошлое — UI обязан узнать про это из ответа,
  // иначе показывает «next: in 0 s» все пять минут таймаута.
  it('GET отдаёт running=true, пока проход в полёте', async () => {
    const db = openDb(':memory:', 'x');
    const app = createApp(() => db, 'proj', {
      sync: () => {}, syncAll: () => {}, nextAt: () => 1700000000,
      isRunning: () => true, killWorkers: async () => {}, stopAll: () => {},
    });
    const s = (await (await app.request('/api/autotick')).json()) as { running: boolean };
    expect(s.running).toBe(true);
  });

  it('GET отдаёт последний проход', async () => {
    const { db, app } = mk();
    setLastRun(db, { at: 1700000000, reclaimed: 1, killed: 0, stuck: 0, spawned: 2, active: 3, reaped: 0 });
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

describe('projectPool', () => {
  afterEach(() => { delete process.env.KDD_HOME; });

  // Форма hash-а — то, что реально пишет resolveDbPath: 16 hex-символов sha256. get(hash)
  // раньше проверял только existsSync(join(kddHome(), hash, 'kdd.db')) — не гарантия членства
  // в store, hash приходит сырым из ?project=. Traversal-строка обязана падать ДО join/openDb,
  // а не найти существующий файл где-то ещё на диске.
  it('rejects a traversal-shaped project hash before touching the filesystem', () => {
    const home = mkdtempSync(join(tmpdir(), 'kdd-pool-'));
    process.env.KDD_HOME = home;
    const pool = projectPool('');
    expect(() => pool.get('../../etc/passwd')).toThrow(/unknown project/);
  });

  it('rejects a well-formed but unknown hash the same way', () => {
    const home = mkdtempSync(join(tmpdir(), 'kdd-pool-'));
    process.env.KDD_HOME = home;
    const pool = projectPool('');
    expect(() => pool.get('0123456789abcdef')).toThrow(/unknown project/);
  });

  it('accepts a real project hash and returns a cached db on the second call', () => {
    const home = mkdtempSync(join(tmpdir(), 'kdd-pool-'));
    process.env.KDD_HOME = home;
    const hash = 'abc123abc123abc1';
    openDb(join(home, hash, 'kdd.db'), '/repo/.git').close();
    const pool = projectPool('');
    const db1 = pool.get(hash);
    const db2 = pool.get(hash);
    expect(db1).toBe(db2);
    pool.closeAll();
  });
});

describe('kind over the http api', () => {
  it('is accepted on create and echoed back', async () => {
    const { app } = mk();
    const res = await app.request('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'broken', kind: 'bug' }),
    });
    expect(await res.json()).toMatchObject({ title: 'broken', kind: 'bug' });
  });

  it('is patchable', async () => {
    const { db, app } = mk();
    addTask(db, { title: 'a' }, user);
    const res = await app.request('/api/tasks/1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'chore' }),
    });
    expect(await res.json()).toMatchObject({ kind: 'chore' });
  });
});

// #34: сервер обслуживает ЛЮБОЙ проект из ~/.kdd по ?project=<hash> — в том числе доску,
// которую уже мигрировал более новый kdd из другого worktree. Ошибка обязана доехать до
// вкладки текстом, а не 500 «internal error».
describe('a board from a newer kdd', () => {
  afterEach(() => { delete process.env.KDD_HOME; });

  it('surfaces the version mismatch as a 400 with the message', async () => {
    const home = mkdtempSync(join(tmpdir(), 'kdd-newer-'));
    process.env.KDD_HOME = home;
    const hash = 'a'.repeat(16);
    const dbPath = join(home, hash, 'kdd.db');
    const db = openDb(dbPath, 'x');
    db.pragma('user_version = 99');
    db.close();

    const pool = projectPool(hash);
    const res = await createApp(pool.getDb, hash).request('/api/board');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/schema v99/);
  });
});

// #60: /api/projects — это инвентарь абсолютных путей ВСЕХ досок на машине, и отдаётся он
// до всякого выбора проекта. За loopback это переключатель проектов для своего человека;
// выставленный наружу сервер (token) отдаёт только ту доску, ради которой его выставили.
describe('GET /api/projects', () => {
  afterEach(() => { delete process.env.KDD_HOME; });

  const twoProjects = (): string => {
    const home = mkdtempSync(join(tmpdir(), 'kdd-proj-'));
    process.env.KDD_HOME = home;
    openDb(join(home, 'a'.repeat(16), 'kdd.db'), '/mine/.git').close();
    openDb(join(home, 'b'.repeat(16), 'kdd.db'), '/some/other/repo/.git').close();
    return home;
  };

  it('lists every local project on loopback', async () => {
    twoProjects();
    const res = await createApp(() => openDb(':memory:', 'x'), 'a'.repeat(16)).request('/api/projects');
    expect((await res.json() as unknown[]).length).toBe(2);
  });

  it('exposed with a token, lists only the project it serves', async () => {
    twoProjects();
    const app = createApp(() => openDb(':memory:', 'x'), 'a'.repeat(16), undefined, { token: 's3cret' });
    const res = await app.request('/api/projects?token=s3cret');
    expect(await res.json()).toEqual([{ id: 'a'.repeat(16), path: '/mine/.git' }]);
  });
});

// Ревью: фильтр списка проектов был косметикой — getDb всё равно резолвил любой ?project,
// а hash это sha256 от пути репозитория, то есть держатель токена, знающий чужой путь на
// этой машине, вычислял его сам и правил чужую доску.
describe('exposed mode ignores ?project', () => {
  afterEach(() => { delete process.env.KDD_HOME; });

  it('serves the default board no matter what ?project asks for', async () => {
    const home = mkdtempSync(join(tmpdir(), 'kdd-lock-'));
    process.env.KDD_HOME = home;
    const mine = 'a'.repeat(16);
    const other = 'b'.repeat(16);
    addTask(openDb(join(home, mine, 'kdd.db'), '/mine/.git'), { title: 'mine' }, user);
    addTask(openDb(join(home, other, 'kdd.db'), '/other/.git'), { title: 'secret' }, user);

    const locked = projectPool(mine, { lockToDefault: true });
    const app = createApp(locked.getDb, mine, undefined, { token: 's3cret' });
    const b = (await (await app.request(`/api/board?project=${other}&token=s3cret`)).json()) as
      Record<string, { title: string }[]>;
    expect(b.new.map((t) => t.title)).toEqual(['mine']); // не 'secret'
    locked.closeAll();
  });

  it('still switches projects on loopback', async () => {
    const home = mkdtempSync(join(tmpdir(), 'kdd-switch-'));
    process.env.KDD_HOME = home;
    const mine = 'a'.repeat(16);
    const other = 'b'.repeat(16);
    addTask(openDb(join(home, mine, 'kdd.db'), '/mine/.git'), { title: 'mine' }, user);
    addTask(openDb(join(home, other, 'kdd.db'), '/other/.git'), { title: 'theirs' }, user);

    const pool = projectPool(mine);
    const app = createApp(pool.getDb, mine);
    const b = (await (await app.request(`/api/board?project=${other}`)).json()) as
      Record<string, { title: string }[]>;
    expect(b.new.map((t) => t.title)).toEqual(['theirs']);
    pool.closeAll();
  });
});

// #122: файловые роуты. База должна быть НАСТОЯЩИМ файлом (стор вложений = dirname(db.name)),
// поэтому у этого блока свой mk, не общий ':memory:'.
describe('file routes', () => {
  const mkFiles = () => {
    const dir = mkdtempSync(join(tmpdir(), 'kdd-ui-files-'));
    const db = openDb(join(dir, 'kdd.db'), dir);
    return { dir, db, app: createApp(() => db) };
  };
  const upload = (name: string, type: string, body: string, description?: string) => {
    const fd = new FormData();
    fd.set('file', new File([body], name, { type }));
    if (description !== undefined) fd.set('description', description);
    return fd;
  };

  it('загружает файл и отдаёт картинку инлайн', async () => {
    const { db, app } = mkFiles();
    const t = addTask(db, { title: 'с картинкой' }, user);
    const res = await app.request(`/api/tasks/${t.id}/files`,
      { method: 'POST', body: upload('shot.png', 'image/png', 'PNGDATA', 'красная кнопка') });
    expect(res.status).toBe(200);
    const f = (await res.json()) as { id: number; original_name: string; description: string };
    expect(f.original_name).toBe('shot.png');
    expect(f.description).toBe('красная кнопка');

    const got = await app.request(`/api/files/${f.id}`);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(got.headers.get('content-disposition')).toBeNull();
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await got.text()).toBe('PNGDATA');
  });

  it('svg и pdf отдаются вложением, а не инлайн: SVG исполняет скрипт с нашего origin', async () => {
    const { db, app } = mkFiles();
    const t = addTask(db, { title: 'опасное' }, user);
    for (const [name, type] of [['x.svg', 'image/svg+xml'], ['x.pdf', 'application/pdf']]) {
      const res = await app.request(`/api/tasks/${t.id}/files`,
        { method: 'POST', body: upload(name, type, `body-${name}`) });
      const f = (await res.json()) as { id: number };
      const got = await app.request(`/api/files/${f.id}`);
      expect(got.headers.get('content-type')).toBe('application/octet-stream');
      expect(got.headers.get('content-disposition')).toMatch(/^attachment/);
    }
  });

  it('имя в content-disposition санитайзится: кавычка и перевод строки не ломают заголовок', async () => {
    const { db, app } = mkFiles();
    const t = addTask(db, { title: 'кривое имя' }, user);
    const res = await app.request(`/api/tasks/${t.id}/files`,
      { method: 'POST', body: upload('a"b\nc.bin', 'application/octet-stream', 'X') });
    const f = (await res.json()) as { id: number };
    const cd = (await app.request(`/api/files/${f.id}`)).headers.get('content-disposition')!;
    expect(cd).toBe('attachment; filename="a_b_c.bin"');
  });

  // Санитайзинг только стема оставлял дыру: ext берётся из того же клиентского имени, а
  // multipart раскрывает в нём %0A. Перевод строки в ext → невалидный заголовок → Headers.set
  // бросает TypeError → 500, и файл нельзя скачать уже никогда.
  it('мусор ПОСЛЕ последней точки тоже санитайзится: отдача не падает', async () => {
    const { db, app } = mkFiles();
    const t = addTask(db, { title: 'кривое расширение' }, user);
    const res = await app.request(`/api/tasks/${t.id}/files`,
      { method: 'POST', body: upload('a.b\nc', 'application/octet-stream', 'X') });
    const f = (await res.json()) as { id: number };
    const got = await app.request(`/api/files/${f.id}`);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-disposition')).toBe('attachment; filename="a.b_c"');
  });

  // M7: раньше .slice(0, 100) резала уже собранную "имя.расширение" строку целиком — длинное
  // имя срезало и точку с расширением, и скачанный файл терял подсказку типа.
  it('длинное имя режется на стеме, расширение переживает срез', async () => {
    const { db, app } = mkFiles();
    const t = addTask(db, { title: 'длинное имя' }, user);
    const longName = `${'x'.repeat(150)}.bin`;
    const res = await app.request(`/api/tasks/${t.id}/files`,
      { method: 'POST', body: upload(longName, 'application/octet-stream', 'X') });
    const f = (await res.json()) as { id: number };
    const cd = (await app.request(`/api/files/${f.id}`)).headers.get('content-disposition')!;
    expect(cd).toMatch(/\.bin"$/);
  });

  // path заведён ради агента (kdd show / get_task открывают вложение через Read). Вкладке он
  // не нужен — она ходит по /api/files/<id>, — а выставленному наружу серверу незачем отдавать
  // держателю токена раскладку ~/.kdd и hash доски.
  it('детали задачи не отдают абсолютный путь вложения', async () => {
    const { db, app } = mkFiles();
    const t = addTask(db, { title: 'путь наружу' }, user);
    await app.request(`/api/tasks/${t.id}/files`,
      { method: 'POST', body: upload('a.png', 'image/png', 'X') });
    const d = (await (await app.request(`/api/tasks/${t.id}`)).json()) as
      { files: Record<string, unknown>[] };
    expect(d.files).toHaveLength(1);
    expect(d.files[0]!.path).toBeUndefined();
    expect(d.files[0]!.id).toBeDefined(); // остальное на месте
  });

  it('удаляет вложение', async () => {
    const { db, app } = mkFiles();
    const t = addTask(db, { title: 'снять' }, user);
    const res = await app.request(`/api/tasks/${t.id}/files`,
      { method: 'POST', body: upload('a.png', 'image/png', 'X') });
    const f = (await res.json()) as { id: number };
    expect((await app.request(`/api/files/${f.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await app.request(`/api/files/${f.id}`)).status).toBe(404);
  });

  // I4: заявленный (не обязательно честный) content-length больше капа отбивается ДО
  // c.req.parseBody() — она буферизует всё тело в память, и без этой проверки честный клиент
  // на гигабайты уронил бы процесс до того, как attachFile успел бы его отбить по CAPS.fileBytes.
  it('content-length больше капа — 413, тело не буферизуется', async () => {
    const { db, app } = mkFiles();
    const t = addTask(db, { title: 'великан' }, user);
    const res = await app.request(`/api/tasks/${t.id}/files`, {
      method: 'POST',
      headers: { 'content-length': String(CAPS.fileBytes + 1024 * 1024) },
      body: 'irrelevant, guard fires before this is read',
    });
    expect(res.status).toBe(413);
  });

  it('загрузка без поля file — 400, а не пятисотка', async () => {
    const { db, app } = mkFiles();
    const t = addTask(db, { title: 'пусто' }, user);
    const fd = new FormData();
    fd.set('description', 'без файла');
    const res = await app.request(`/api/tasks/${t.id}/files`, { method: 'POST', body: fd });
    expect(res.status).toBe(400);
  });

  it('строка есть, а байтов нет — 404, не пятисотка', async () => {
    const { dir, db, app } = mkFiles();
    const t = addTask(db, { title: 'потерянный blob' }, user);
    const res = await app.request(`/api/tasks/${t.id}/files`,
      { method: 'POST', body: upload('a.png', 'image/png', 'X') });
    const f = (await res.json()) as { id: number; sha256: string; ext: string };
    rmSync(join(dir, 'files', `${f.sha256}.${f.ext}`));
    expect((await app.request(`/api/files/${f.id}`)).status).toBe(404);
  });

  // NUL в имени переживает basename() и доходит до writeFileSync, которая на нём бросает
  // ERR_INVALID_ARG_VALUE. Без finally, покрывающего mkdtemp+write вместе, каждый такой
  // запрос оставлял бы пустой каталог в os.tmpdir() навсегда.
  // CSRF: multipart — CORS-простой тип, кросс-доменный POST уходит без preflight, а Host
  // (единственное, на что смотрит loopback-проверка) в нём остаётся нашим. Отбивает Origin.
  it('кросс-доменный POST отбивается по Origin, свой — проходит', async () => {
    const { db, app } = mkFiles();
    const t = addTask(db, { title: 'csrf' }, user);
    const evil = await app.request(`/api/tasks/${t.id}/files`, {
      method: 'POST', headers: { origin: 'https://evil.example' },
      body: upload('a.png', 'image/png', 'X'),
    });
    expect(evil.status).toBe(403);
    const own = await app.request(`/api/tasks/${t.id}/files`, {
      method: 'POST', headers: { origin: 'http://localhost' },
      body: upload('a.png', 'image/png', 'X'),
    });
    expect(own.status).toBe(200);
    // GET не трогаем: ответ кросс-доменно не прочитать, а <img src="/api/files/..."> должен жить.
    const f = (await own.json()) as { id: number };
    const read = await app.request(`/api/files/${f.id}`, { headers: { origin: 'https://evil.example' } });
    expect(read.status).toBe(200);
  });

  it('имя с NUL-байтом — 4xx, а не 500, и temp-каталог не остаётся', async () => {
    const { db, app } = mkFiles();
    const t = addTask(db, { title: 'nul' }, user);
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('kdd-upload-')).length;
    const res = await app.request(`/api/tasks/${t.id}/files`,
      { method: 'POST', body: upload('a\0b.png', 'image/png', 'X') });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith('kdd-upload-')).length;
    expect(after).toBe(before);
  });
});

describe('GET /api/tracks', () => {
  // Закрытый трек обязан оставаться называемым: его id может лежать в фильтре доски
  // или на задаче, и без имени поверхность показывает голое число.
  it('returns done tracks too, and only active ones with ?status=active', async () => {
    const { db, app } = mk();
    createTrack(db, { name: 'live' });
    const closed = createTrack(db, { name: 'closed' });
    editTrack(db, closed.id, { status: 'done' });

    const all = (await (await app.request('/api/tracks')).json()) as { name: string }[];
    expect(all.map((t) => t.name).sort()).toEqual(['closed', 'live']);

    const active = (await (await app.request('/api/tracks?status=active')).json()) as
      { name: string }[];
    expect(active.map((t) => t.name)).toEqual(['live']);
  });

  it('?status=done returns only closed tracks', async () => {
    const { db, app } = mk();
    createTrack(db, { name: 'live' });
    const closed = createTrack(db, { name: 'closed' });
    editTrack(db, closed.id, { status: 'done' });

    const done = (await (await app.request('/api/tracks?status=done')).json()) as { name: string }[];
    expect(done.map((t) => t.name)).toEqual(['closed']);
  });

  it('?status=<unknown> returns all tracks — unrecognised values fall through to show everything', async () => {
    const { db, app } = mk();
    createTrack(db, { name: 'live' });
    const closed = createTrack(db, { name: 'closed' });
    editTrack(db, closed.id, { status: 'done' });

    const all = (await (await app.request('/api/tracks?status=nonsense')).json()) as { name: string }[];
    expect(all.map((t) => t.name).sort()).toEqual(['closed', 'live']);
  });
});
