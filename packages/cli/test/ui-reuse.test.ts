import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { storeIdentity } from '@kddkit/core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { BIN } from './run.js';

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as AddressInfo).port;
    server.close(() => resolve(port));
  });
});

describe('kdd ui reuse', () => {
  it('reuses the same store and refuses another KDD_HOME or KDD_DB on the same repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kdd-ui-reuse-'));
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', repo]);
    const port = await freePort();
    const env = { ...process.env, KDD_HOME: join(dir, 'first'), KDD_DB: undefined };
    const child = spawn(process.execPath, [BIN, 'ui', '--port', String(port)],
      { cwd: repo, env });
    const closed = once(child, 'close');
    try {
      await new Promise<void>((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 10000);
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes('kdd ui:')) { clearTimeout(timer); resolve(); }
        });
        child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`server exited ${code}: ${output}`)));
      });

      const run = (overrides: NodeJS.ProcessEnv) => spawnSync(
        process.execPath, [BIN, 'ui', '--port', String(port)],
        { cwd: repo, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10000 },
      );
      const same = run({});
      expect(same.status, same.stderr).toBe(0);
      expect(same.stdout).toContain('reusing running server');

      const otherHome = run({ KDD_HOME: join(dir, 'second') });
      expect(otherHome.status).toBe(1);
      expect(otherHome.stderr).toContain('different store');
      expect(otherHome.stdout).not.toContain('reusing running server');

      const otherDb = run({ KDD_DB: join(dir, 'other.db') });
      expect(otherDb.status).toBe(1);
      expect(otherDb.stderr).toContain('different store');
    } finally {
      child.kill();
      await closed;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Сервер прежней версии (или без поля version) на порту: переиспользовать его — показать
  // доску старым кодом. Тот же store, тот же режим — отличается только версия.
  it.each([['0.0.0-old', 'version 0.0.0-old'], [undefined, 'version unknown']])(
    'refuses to reuse a server of another version (%s)', async (version, message) => {
      const dir = mkdtempSync(join(tmpdir(), 'kdd-ui-version-'));
      const repo = join(dir, 'repo');
      mkdirSync(repo);
      execFileSync('git', ['init', '-q', repo]);
      const env = { ...process.env, KDD_HOME: join(dir, 'home'), KDD_DB: undefined };
      const saved = { home: process.env.KDD_HOME, db: process.env.KDD_DB };
      process.env.KDD_HOME = env.KDD_HOME; delete process.env.KDD_DB;
      const store = storeIdentity();
      process.env.KDD_HOME = saved.home; if (saved.db !== undefined) process.env.KDD_DB = saved.db;
      const server = createHttpServer((_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ kdd: true, default: 'x', needsToken: false, store, version }));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      try {
        const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
          const child = spawn(process.execPath, [BIN, 'ui', '--port', String(port)], { cwd: repo, env });
          let stdout = '', stderr = '';
          child.stdout.on('data', (c: Buffer) => { stdout += c; });
          child.stderr.on('data', (c: Buffer) => { stderr += c; });
          child.on('close', (status) => resolve({ status, stdout, stderr }));
        });
        expect(r.status).toBe(1);
        expect(r.stderr).toContain(`a kdd ui of ${message} already runs on :${port} — stop it and run kdd ui again`);
        expect(r.stdout).not.toContain('reusing running server');
        // Отказ — до openDb: доска не создана и не мигрирована под чужим сервером.
        const home = join(dir, 'home');
        const files = existsSync(home) ? readdirSync(home, { recursive: true }).map(String) : [];
        expect(files.filter((f) => f.endsWith('kdd.db'))).toEqual([]);
      } finally {
        server.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
});
