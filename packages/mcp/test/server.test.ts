import { describe, it, expect } from 'vitest';
import { addTask, agentId, openDb, resolveDbPath } from '@kddkit/core';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  it('lists the four tools', async () => {
    const client = await connect(openDb(':memory:', 'x'));
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['get_task', 'list_tasks', 'list_tracks', 'recall', 'update_task']);
  });

  it('list_tasks returns grouped rows', async () => {
    const db = openDb(':memory:', 'x');
    addTask(db, { title: 'hello' }, { type: 'user' });
    const client = await connect(db);
    const res = await client.callTool({ name: 'list_tasks', arguments: {} });
    expect(textOf(res).tasks.new[0].title).toBe('hello');
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
      expect(mcpActor()).toEqual({ type: 'ai', id: agentId() });
      expect(mcpActor().id).toBe('cc:abcdef12');
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = prev;
    }
  });

  it('uses Codex turn metadata per request, accepting object and JSON forms', () => {
    expect(mcpActor({ 'x-codex-turn-metadata': { session_id: 'full-session' } }))
      .toEqual({ type: 'ai', id: 'codex:full-session' });
    expect(mcpActor({ 'x-codex-turn-metadata': '{"threadId":"full-thread"}' }))
      .toEqual({ type: 'ai', id: 'codex:full-thread' });
  });

  it('falls back safely for malformed Codex metadata', () => {
    const previous = process.env.CODEX_SESSION_ID;
    process.env.CODEX_SESSION_ID = 'env-session';
    try {
      expect(mcpActor({ 'x-codex-turn-metadata': '{bad json' }))
        .toEqual({ type: 'ai', id: 'codex:env-session' });
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
        expect((await client.listTools()).tools).toHaveLength(5);
        const res = await client.callTool({ name: 'list_tasks', arguments: {} });
        expect(rawText(res)).toMatch(/not in a git repository/);
        expect((res as { isError?: boolean }).isError).toBe(true);
      } finally { process.chdir(cwd); }
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
