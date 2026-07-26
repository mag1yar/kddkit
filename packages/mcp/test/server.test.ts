import { describe, it, expect } from 'vitest';
import { addTask, openDb } from '@kddkit/core';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, startServer } from '../src/server.js';

const ai = { type: 'ai', id: 'smoke' } as const;

async function connect(db: ReturnType<typeof openDb>) {
  const dir = mkdtempSync(join(tmpdir(), 'kdd-mcp-'));
  const server = createServer(db, dir, ai);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientT);
  return client;
}

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

// #34: MCP-сервер поднимается на той же общей базе. Доска, уже мигрированная более новым kdd,
// обязана уронить старт с внятной ошибкой (main.ts печатает её строкой и выходит 1), а не
// молча подняться на схеме, которой этот код не знает.
describe('a board from a newer kdd', () => {
  it('refuses to start, naming both schema versions', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'kdd-mcp-newer-')), 'kdd.db');
    const db = openDb(dbPath, 'x');
    db.pragma('user_version = 99');
    db.close();

    const prev = process.env.KDD_DB;
    process.env.KDD_DB = dbPath;
    try {
      await expect(startServer()).rejects.toThrow(/schema v99, this kdd only knows v\d+/);
    } finally {
      if (prev === undefined) delete process.env.KDD_DB; else process.env.KDD_DB = prev;
    }
  });
});
