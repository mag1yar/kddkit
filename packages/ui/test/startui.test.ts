import { describe, it, expect } from 'vitest';
import { request } from 'node:http';
import { networkInterfaces } from 'node:os';
import { openDb } from '@kddkit/core';
import { startUi } from '../src/server.js';

describe('startUi', () => {
  it('serves the api on a real socket (port 0 = ephemeral)', async () => {
    const db = openDb(':memory:', 'x');
    const { url, close } = await startUi(() => db, 0);
    try {
      expect(url).toMatch(/^http:\/\/localhost:\d+$/);
      const res = await fetch(`${url}/api/version`);
      expect(await res.json()).toEqual({ version: 0 });
    } finally { close(); }
  });

  it('GET / without built frontend → 404 ui not built', async () => {
    const db = openDb(':memory:', 'x');
    const { url, close } = await startUi(() => db, 0);
    try {
      const res = await fetch(url + '/');
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('ui not built');
    } finally { close(); }
  });
});

// #60: hostname не задавался, node биндил '::' — доска была открыта всей локальной сети без
// единой проверки: чтение, правки и `/api/projects` с абсолютными путями всех проектов машины.
describe('bind address', () => {
  // Настоящий сокет по настоящему LAN-адресу этой машины: единственный способ отличить
  // «слушает loopback» от «слушает всё» — постучаться снаружи loopback.
  const lanIp = Object.values(networkInterfaces()).flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

  it.skipIf(!lanIp)('defaults to loopback: the LAN address refuses the connection', async () => {
    const db = openDb(':memory:', 'x');
    const { url, close } = await startUi(() => db, 0);
    try {
      const port = new URL(url).port;
      await expect(fetch(`http://${lanIp}:${port}/api/version`, { signal: AbortSignal.timeout(2000) }))
        .rejects.toThrow();
    } finally { close(); }
  });

  it('reaches the LAN address once asked to (--host)', async () => {
    const db = openDb(':memory:', 'x');
    const { url, close } = await startUi(() => db, 0, '', undefined,
      { host: '0.0.0.0', token: 's3cret' });
    try {
      const port = new URL(url).port;
      const res = await fetch(`http://${lanIp ?? '127.0.0.1'}:${port}/api/version?token=s3cret`,
        { signal: AbortSignal.timeout(2000) });
      expect(res.status).toBe(200);
    } finally { close(); }
  });
});

describe('token', () => {
  const withToken = () => startUi(() => openDb(':memory:', 'x'), 0, '', undefined,
    { host: '127.0.0.1', token: 's3cret' });

  it('rejects an /api call without it', async () => {
    const { url, close } = await withToken();
    try {
      const res = await fetch(`${url}/api/version`);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    } finally { close(); }
  });

  it('accepts it in the query (the link the server prints) and in the header', async () => {
    const { url, close } = await withToken();
    try {
      expect((await fetch(`${url}/api/version?token=s3cret`)).status).toBe(200);
      expect((await fetch(`${url}/api/version`, { headers: { 'x-kdd-token': 's3cret' } })).status)
        .toBe(200);
      expect((await fetch(`${url}/api/version?token=wrong`)).status).toBe(401);
    } finally { close(); }
  });

  // Статика без токена — сознательно: пустая оболочка SPA ничего не рассказывает, а человек
  // открывает присланную ссылку с ?token и сразу работает.
  it('does not gate the static shell', async () => {
    const { url, close } = await withToken();
    try {
      expect((await fetch(url + '/')).status).toBe(404); // 404 «ui not built», а не 401
    } finally { close(); }
  });
});

// Ревью: /api/ping был под токеном, и второй `kdd ui` из другого проекта получал 401,
// проваливался мимо ветки переиспользования и падал на EADDRINUSE.
describe('ping stays reachable', () => {
  it('answers without a token and says that one is required', async () => {
    const { url, close } = await startUi(() => openDb(':memory:', 'x'), 0, 'abc', undefined,
      { host: '127.0.0.1', token: 's3cret' });
    try {
      const res = await fetch(`${url}/api/ping`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ kdd: true, default: 'abc', needsToken: true });
      // всё остальное по-прежнему под замком
      expect((await fetch(`${url}/api/version`)).status).toBe(401);
    } finally { close(); }
  });

  it('reports needsToken false on a plain loopback server', async () => {
    const { url, close } = await startUi(() => openDb(':memory:', 'x'), 0, 'abc');
    try {
      expect(await (await fetch(`${url}/api/ping`)).json())
        .toEqual({ kdd: true, default: 'abc', needsToken: false });
    } finally { close(); }
  });
});

// #61: пара к loopback-биндингу. Сайт с TTL 0 перерезолвит свой домен в 127.0.0.1 — для
// браузера origin не менялся, same-origin policy не мешает, и его скрипт правит доску.
// Подделать он не может ровно одно: Host остаётся его доменом.
describe('Host check', () => {
  // node:http, а не fetch: undici считает Host forbidden header и молча его выкидывает,
  // так что подделать заголовок — единственное, что тесту тут и нужно, — через fetch нельзя.
  const getWithHost = (url: string, host: string): Promise<{ status: number; body: string }> =>
    new Promise((res, rej) => {
      const u = new URL(`${url}/api/version`);
      const req = request(
        { hostname: u.hostname, port: u.port, path: u.pathname, headers: { host } },
        (r) => {
          let body = '';
          r.on('data', (d: Buffer) => { body += d.toString(); });
          r.on('end', () => res({ status: r.statusCode ?? 0, body }));
        });
      req.on('error', rej);
      req.end();
    });

  it('rejects a request whose Host is not loopback', async () => {
    const db = openDb(':memory:', 'x');
    const { url, close } = await startUi(() => db, 0);
    try {
      const r = await getWithHost(url, 'evil.example.com');
      expect(r.status).toBe(403);
      expect(JSON.parse(r.body)).toEqual({ error: 'forbidden host' });
    } finally { close(); }
  });

  // Сосед по машине на другом порту не должен уметь притвориться нами в чужой вкладке.
  it("rejects a loopback Host carrying someone else's port", async () => {
    const db = openDb(':memory:', 'x');
    const { url, close } = await startUi(() => db, 0);
    try {
      expect((await getWithHost(url, '127.0.0.1:1')).status).toBe(403);
    } finally { close(); }
  });

  it('lets the real loopback origin through', async () => {
    const db = openDb(':memory:', 'x');
    const { url, close } = await startUi(() => db, 0);
    try {
      expect((await fetch(`${url}/api/version`)).status).toBe(200);
      expect((await getWithHost(url, new URL(url).host)).status).toBe(200);
    } finally { close(); }
  });
});
