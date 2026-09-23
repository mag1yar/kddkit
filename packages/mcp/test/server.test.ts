import { describe, it, expect } from 'vitest';
import { addTask, agentId, openDb, resolveDbPath, taskBrief } from '@kddkit/core';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, lazyCtx, mcpActor } from '../src/server.js';

const ai = { type: 'ai', id: 'smoke' } as const;

async function connectTo(getCtx: Parameters<typeof createServer>[0], actor?: typeof ai) {
  const server = createServer(getCtx, actor);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientT);
  return client;
}

async function connect(db: ReturnType<typeof openDb>) {
  const dir = mkdtempSync(join(tmpdir(), 'kdd-mcp-'));
  return connectTo(() => ({ db, dir }));
}

// Тот же путь добычи базы, что у боевого startServer, — иначе тест проверял бы не то.
const connectLazy = () => connectTo(lazyCtx());

const textOf = (res: any) => JSON.parse(res.content[0].text);
// сырой текст ответа: у ошибок в content лежит не JSON, а сообщение
const rawText = (res: any): string => res.content[0].text;

describe('mcp server over a real transport', () => {
  it('shares handoff history with a fresh CLI process on one board', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kdd-cli-mcp-'));
    const dbPath = join(dir, 'board.db');
    const decisionsDir = join(dir, 'decisions');
    const seed = openDb(dbPath, 'integration');
    const task = addTask(seed, { title: 'cross transport' }, { type: 'user' });
    seed.close();
    const cli = fileURLToPath(new URL('../../cli/dist/index.js', import.meta.url));
    const env = {
      ...process.env, KDD_DB: dbPath, KDD_DECISIONS_DIR: decisionsDir,
      CLAUDECODE: '', CLAUDE_CODE_SESSION_ID: '', KDD_SESSION: '', CODEX_THREAD_ID: '',
      CODEX_SESSION_ID: 'session-a',
    };
    execFileSync('node', [cli, 'edit', String(task.id), '--area', 'cli'], { env });

    const db = openDb(dbPath, 'integration');
    const client = await connectTo(() => ({ db, dir: decisionsDir }));
    const changed = await client.callTool({
      name: 'update_task', arguments: { id: task.id, edit: { area: 'mcp' } },
      _meta: { 'x-codex-turn-metadata': { session_id: 'session-b' } },
    });
    expect(changed.isError).not.toBe(true);
    const mcp = textOf(await client.callTool({ name: 'get_task', arguments: { id: task.id } }));
    const show = JSON.parse(execFileSync('node', [cli, 'show', String(task.id), '--json'], {
      env, encoding: 'utf8',
    }));
    const brief = JSON.parse(execFileSync('node', [cli, 'brief', String(task.id), '--json'], {
      env, encoding: 'utf8',
    }));
    expect(show.manual_provenance).toEqual(mcp.manual_provenance);
    expect(show.handoffs).toEqual(mcp.handoffs);
    expect(show.handoffs).toEqual([expect.objectContaining({
      from_session_id: 'session-a', to_session_id: 'session-b',
    })]);
    expect(brief.manual_provenance).toEqual(show.manual_provenance);
    db.close();
  });

  it('lists the six tools', async () => {
    const client = await connect(openDb(':memory:', 'x'));
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['get_task', 'list_projects', 'list_tasks', 'list_tracks', 'recall', 'update_task']);
  });

  it('list_tasks returns grouped rows', async () => {
    const db = openDb(':memory:', 'x');
    addTask(db, { title: 'hello' }, { type: 'user' });
    const client = await connect(db);
    const res = await client.callTool({ name: 'list_tasks', arguments: {} });
    expect(textOf(res).tasks.new[0].title).toBe('hello');
  });

  it('get_task syncs Markdown backlinks for ordinary and full reads', async () => {
    const db = openDb(':memory:', 'x');
    const task = addTask(db, { title: 'source' }, { type: 'user' });
    const dir = mkdtempSync(join(tmpdir(), 'kdd-mcp-decisions-'));
    writeFileSync(join(dir, '2026-09-20-linked.md'),
      '---\ncreated: 2026-09-20\nstatus: active\nsuperseded_by:\nsource_tasks: [1]\n---\n' +
      '# linked\n\n## Decision\nx\n');
    const client = await connectTo(() => ({ db, dir }));

    const capped = textOf(await client.callTool({ name: 'get_task', arguments: { id: task.id } }));
    const full = textOf(await client.callTool({
      name: 'get_task', arguments: { id: task.id, full: true },
    }));
    expect(capped.decisions[0].slug).toBe('2026-09-20-linked');
    expect(full.decisions).toEqual(capped.decisions);
  });

  it('get_task brief mode is exclusive and leaves ordinary/full modes unchanged', async () => {
    const db = openDb(':memory:', 'x');
    const task = addTask(db, { title: 'source', body: 'goal' }, { type: 'user' });
    const dir = mkdtempSync(join(tmpdir(), 'kdd-mcp-brief-'));
    const client = await connectTo(() => ({ db, dir }));
    const ordinary = textOf(await client.callTool({
      name: 'get_task', arguments: { id: task.id },
    }));
    const full = textOf(await client.callTool({
      name: 'get_task', arguments: { id: task.id, full: true },
    }));
    const brief = textOf(await client.callTool({
      name: 'get_task', arguments: { id: task.id, brief: true },
    }));
    const conflict = await client.callTool({
      name: 'get_task', arguments: { id: 999, brief: true, full: true },
    });

    expect(ordinary.comments_total).toBeDefined();
    expect(ordinary).not.toHaveProperty('budget');
    expect(full.task.body).toBe('goal');
    expect(full).not.toHaveProperty('budget');
    expect(brief).toEqual(taskBrief(db, dir, task.id));
    expect(brief.comments_total).toBeUndefined();
    expect(conflict.isError).toBe(true);
    expect(rawText(conflict)).toMatch(/brief.*full.*mutually exclusive/i);
  });

  it('update_task mutates and reports isError on bad input', async () => {
    const db = openDb(':memory:', 'x');
    const t = addTask(db, { title: 'm' }, { type: 'user' });
    const client = await connect(db);
    const ok = await client.callTool({
      name: 'update_task', arguments: { id: t.id, move: { to: 'in_progress' } },
    });
    expect(textOf(ok).status).toBe('in_progress');
    const bad = await client.callTool({
      name: 'update_task', arguments: { id: t.id, move: { to: 'done' } },
    });
    expect(bad.isError).toBe(true);
    expect(rawText(bad)).toMatch(/invalid transition/);
  });
});

// #117: MCP жил под собственным id ('mcp'), CLI — под id сессии. Один агент выходил двумя
// авторами: сдал задачу через kdd, принял через MCP — гейт самоприёмки не срабатывал.
describe('actor identity', () => {
  it('matches the id the CLI derives from the same session', () => {
    const prev = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = 'abcdef12-3456-7890';
    try {
      expect(mcpActor()).toMatchObject({
        type: 'ai', id: agentId(),
        manualSession: { client: 'claude', sessionId: 'abcdef12-3456-7890' },
      });
      expect(mcpActor().id).toBe('cc:abcdef12');
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = prev;
    }
  });

  it('uses Codex turn metadata per request, accepting object and JSON forms', () => {
    expect(mcpActor({ 'x-codex-turn-metadata': { session_id: 'full-session' } }))
      .toMatchObject({
        type: 'ai', id: 'codex:full-session',
        manualSession: { client: 'codex', sessionId: 'full-session', cwd: process.cwd() },
      });
    expect(mcpActor({ 'x-codex-turn-metadata': '{"threadId":"full-thread"}' }))
      .toMatchObject({
        type: 'ai', id: 'codex:full-thread',
        manualSession: { client: 'codex', sessionId: 'full-thread' },
      });
  });

  it('uses the next valid turn ID while leaving actor attribution unchanged', () => {
    expect(mcpActor({ 'x-codex-turn-metadata': {
      session_id: 'invalid/session', thread_id: 'valid-thread',
    } })).toMatchObject({
      type: 'ai', id: 'codex:invalid/session',
      manualSession: { client: 'codex', sessionId: 'valid-thread' },
    });
    expect(mcpActor({ 'x-codex-turn-metadata': {
      session_id: 'x'.repeat(257), thread_id: 'invalid/thread', threadId: 'valid-last',
    } })).toMatchObject({
      manualSession: { client: 'codex', sessionId: 'valid-last' },
    });
  });

  it('uses the environment only when turn metadata is absent', () => {
    const previous = process.env.CODEX_SESSION_ID;
    process.env.CODEX_SESSION_ID = 'env-session';
    try {
      expect(mcpActor({})).toMatchObject({
        manualSession: { client: 'codex', sessionId: 'env-session' },
      });
      expect(mcpActor({ 'x-codex-turn-metadata': '{bad json' }))
        .toMatchObject({
          type: 'ai', id: 'codex:env-session',
          manualSession: { client: 'codex', cwd: process.cwd() },
        });
      expect(mcpActor({ 'x-codex-turn-metadata': '{bad json' }).manualSession)
        .not.toHaveProperty('sessionId');
    } finally {
      if (previous === undefined) delete process.env.CODEX_SESSION_ID;
      else process.env.CODEX_SESSION_ID = previous;
    }
  });

  it('does not turn a stale environment ID into a handoff for invalid turn IDs', async () => {
    const previous = process.env.CODEX_SESSION_ID;
    process.env.CODEX_SESSION_ID = 'stale-session';
    try {
      const db = openDb(':memory:', 'x');
      const task = addTask(db, { title: 'stale environment' }, { type: 'user' });
      const client = await connect(db);
      for (const [session_id, area] of [['current-session', 'first'], ['invalid/session', 'second']]) {
        const changed = await client.callTool({
          name: 'update_task', arguments: { id: task.id, edit: { area } },
          _meta: { 'x-codex-turn-metadata': { session_id } },
        });
        expect(changed.isError).not.toBe(true);
      }
      const detail = textOf(await client.callTool({ name: 'get_task', arguments: { id: task.id } }));
      expect(detail.handoffs).toEqual([]);
      expect(detail.manual_provenance).toMatchObject({
        client: 'codex',
        worktree: execFileSync('git', ['rev-parse', '--show-toplevel'], {
          encoding: 'utf8',
        }).trim(),
        head_commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      });
      expect(detail.manual_provenance).not.toHaveProperty('session_id');
    } finally {
      if (previous === undefined) delete process.env.CODEX_SESSION_ID;
      else process.env.CODEX_SESSION_ID = previous;
    }
  });

  it('attributes a mutation from turn metadata when no actor was injected', async () => {
    const db = openDb(':memory:', 'x');
    const task = addTask(db, { title: 'metadata' }, { type: 'user' });
    const client = await connectTo(() => ({ db, dir: mkdtempSync(join(tmpdir(), 'kdd-mcp-')) }), undefined);
    await client.callTool({
      name: 'update_task',
      arguments: { id: task.id, move: { to: 'in_progress' } },
      _meta: { 'x-codex-turn-metadata': { session_id: 'request-session' } },
    });
    expect(db.prepare("SELECT actor_id FROM events WHERE action = 'moved' ORDER BY id DESC LIMIT 1").get())
      .toEqual({ actor_id: 'codex:request-session' });
  });

  it('exposes full manual provenance and one handoff through get_task', async () => {
    const db = openDb(':memory:', 'x');
    const task = addTask(db, { title: 'handoff' }, { type: 'user' });
    const client = await connect(db);
    for (const [session_id, area] of [['session-a', 'one'], ['session-b', 'two']]) {
      const changed = await client.callTool({
        name: 'update_task', arguments: { id: task.id, edit: { area } },
        _meta: { 'x-codex-turn-metadata': { session_id } },
      });
      expect(changed.isError).not.toBe(true);
    }
    const detail = textOf(await client.callTool({ name: 'get_task', arguments: { id: task.id } }));
    const brief = textOf(await client.callTool({
      name: 'get_task', arguments: { id: task.id, brief: true },
    }));
    expect(detail.manual_provenance).toMatchObject({ client: 'codex', session_id: 'session-b' });
    expect(detail.handoffs).toEqual([expect.objectContaining({
      from_session_id: 'session-a', to_session_id: 'session-b',
    })]);
    expect(brief.manual_provenance).toEqual(detail.manual_provenance);
    expect(brief.handoffs.items).toEqual(detail.handoffs);
  });
});

// #116: раньше базу открывал startServer, и любая её проблема убивала процесс ДО хендшейка —
// клиент показывал «disconnected» и ни строчки причины. Объяснить можно только то, что успело
// подключиться, поэтому сервер поднимается всегда, а проблема приезжает ответом инструмента.
describe('a broken store', () => {
  const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
    const prev = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    const put = (v: Record<string, string | undefined>) => {
      for (const [k, val] of Object.entries(v)) {
        if (val === undefined) delete process.env[k]; else process.env[k] = val;
      }
    };
    put(env);
    try { await fn(); } finally { put(prev); }
  };

  const newerDb = () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'kdd-mcp-newer-')), 'kdd.db');
    const db = openDb(dbPath, 'x');
    db.pragma('user_version = 99');
    db.close();
    return dbPath;
  };

  // Симптом, с которого начали: «reconnect не помогает». Вне репо resolveDbPath бросает.
  it('connects and lists tools outside a git repository', async () => {
    await withEnv({ KDD_DB: undefined, KDD_DECISIONS_DIR: undefined }, async () => {
      const cwd = process.cwd();
      process.chdir(mkdtempSync(join(tmpdir(), 'kdd-mcp-nogit-')));
      try {
        const client = await connectLazy();
        expect((await client.listTools()).tools).toHaveLength(6);
        const res = await client.callTool({ name: 'list_tasks', arguments: {} });
        expect(rawText(res)).toContain(process.cwd());
        expect(rawText(res)).toMatch(/store.*git found no repository/i);
        expect(rawText(res)).not.toContain('.planning');
        expect((res as { isError?: boolean }).isError).toBe(true);
      } finally { process.chdir(cwd); }
    });
  });

  it('selects the requested repository when the server starts above two repositories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kdd-mcp-container-'));
    const repos = ['one', 'two'].map((name) => join(root, name));
    const previousCwd = process.cwd();
    await withEnv({ KDD_HOME: join(root, 'home'), KDD_DB: undefined, KDD_DECISIONS_DIR: undefined }, async () => {
      for (const repo of repos) {
        mkdirSync(repo);
        execFileSync('git', ['init', '-q'], { cwd: repo });
        const { dbPath, projectPath } = resolveDbPath(repo);
        const db = openDb(dbPath, projectPath);
        addTask(db, { title: repo }, { type: 'user' });
        db.close();
      }
      process.chdir(root);
      try {
        const client = await connectLazy();
        const projects = textOf(await client.callTool({ name: 'list_projects', arguments: {} }));
        expect(projects).toHaveLength(2);
        expect(projects.sort()).toEqual(repos.map((repo) => realpathSync(repo)).sort());
        for (const repo of repos) {
          const board = textOf(await client.callTool({
            name: 'list_tasks', arguments: { project: repo },
          }));
          expect(board.tasks.new.map((t: { title: string }) => t.title)).toEqual([repo]);
        }
        const changed = await client.callTool({
          name: 'update_task', arguments: { project: repos[1], id: 1, edit: { area: 'selected' } },
        });
        expect(changed.isError).not.toBe(true);
        const first = textOf(await client.callTool({
          name: 'get_task', arguments: { project: repos[0], id: 1 },
        }));
        const second = textOf(await client.callTool({
          name: 'get_task', arguments: { project: repos[1], id: 1 },
        }));
        expect(first.task.area).toBeNull();
        expect(second.task.area).toBe('selected');
      } finally { process.chdir(previousCwd); }
    });
  });

  it('refuses an explicit project when an environment override would select another store', async () => {
    await withEnv({ KDD_DB: join(tmpdir(), 'other-board.db') }, async () => {
      const res = await (await connectLazy()).callTool({
        name: 'list_tasks', arguments: { project: process.cwd() },
      });
      expect(res.isError).toBe(true);
      expect(rawText(res)).toMatch(/project cannot be used with KDD_DB/);
    });
  });

  it('opens the board for the Codex workspace instead of the plugin cwd', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kdd-mcp-workspace-'));
    const repo = join(root, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    await withEnv({ KDD_HOME: join(root, 'home'), KDD_DB: undefined, KDD_DECISIONS_DIR: undefined }, async () => {
      const { dbPath, projectPath } = resolveDbPath(repo);
      const db = openDb(dbPath, projectPath);
      addTask(db, { title: 'workspace task' }, { type: 'user' });
      db.close();

      const res = await (await connectLazy()).callTool({
        name: 'list_tasks',
        arguments: {},
        _meta: { 'x-codex-turn-metadata': { workspaces: { [repo]: { has_changes: false } } } },
      });
      expect(textOf(res).tasks.new[0].title).toBe('workspace task');
    });
  });

  // KDD_DB задан, а .planning искать негде: resolveDbPath проходит, resolveDecisionsDir нет.
  // Ресурсы в этой ветке ещё не заняты — база открывается только после него (см. lazyCtx).
  it('reports the decisions dir separately from the db path', async () => {
    await withEnv({ KDD_DB: newerDb(), KDD_DECISIONS_DIR: undefined }, async () => {
      const cwd = process.cwd();
      process.chdir(mkdtempSync(join(tmpdir(), 'kdd-mcp-nogit-')));
      try {
        const res = await (await connectLazy()).callTool({ name: 'list_tasks', arguments: {} });
        expect(rawText(res)).toMatch(/not in a git repository .*\.planning/);
      } finally { process.chdir(cwd); }
    });
  });

  // #34: доска, мигрированная более новым kdd, не открывается молча. Изменилось только то,
  // ГДЕ об этом узнают — сообщение то же самое.
  it('names both schema versions when the board is from a newer kdd', async () => {
    await withEnv({ KDD_DB: newerDb() }, async () => {
      const client = await connectLazy();
      const res = await client.callTool({ name: 'list_tasks', arguments: {} });
      expect(rawText(res)).toMatch(/schema v99, this kdd only knows v\d+/);
      expect((res as { isError?: boolean }).isError).toBe(true);
    });
  });
});
