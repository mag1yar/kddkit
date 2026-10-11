import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addTask, checkpointWal, commentTask, openDb, redact, taskDetail } from '../src/index.js';

const user = { type: 'user' } as const;

describe('redaction', () => {
  it.each([
    ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', '[redacted]'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', '[redacted]'],
    ['AKIAIOSFODNN7EXAMPLE', '[redacted]'],
    // форма нарочно нереальная: правдоподобная заглушка ловится push-protection'ом GitHub
    ['xoxb-not-a-real-slack-token', '[redacted]'],
  ])('replaces %s', (secret, marker) => {
    expect(redact(`token is ${secret} ok`)).toBe(`token is ${marker} ok`);
  });

  it('redacts a private key block whole, not line by line', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpQIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    expect(redact(key)).toBe('[redacted key]');
  });

  it('redacts env lines that name themselves a secret, and only those', () => {
    const out = redact('PATH=/usr/bin\nGITHUB_TOKEN=abcdef123456\nHOME=/Users/x');
    expect(out).toContain('PATH=/usr/bin');
    expect(out).toContain('HOME=/Users/x');
    expect(out).toContain('GITHUB_TOKEN=[redacted]');
    expect(out).not.toContain('abcdef123456');
  });

  // Редакция стоит на записи — испорченное не восстановить. Широкая версия съедала обычный код.
  it('leaves source code carrying secret-ish identifiers alone', () => {
    const src = 'interface C { API_KEY: string }\nconst GITHUB_TOKEN = cfg.token;\nexport const PASSWORD_MIN = 8;';
    expect(redact(src)).toBe(src);
  });

  it('still redacts the env dump form it exists for', () => {
    expect(redact('GITHUB_TOKEN=ghp_realvalue123456\nexport AWS_SECRET=abcdefghijkl'))
      .toBe('GITHUB_TOKEN=[redacted]\nexport AWS_SECRET=[redacted]');
  });

  // Env-регулярка с неограниченным именем откатывалась квадратично на длинном капсе.
  it('handles a huge uppercase blob fast instead of backtracking over it', () => {
    const blob = 'A_LONG_UPPERCASE_RUN_'.repeat(25_000); // ~500K символов, ни одного пробела
    const t0 = Date.now();
    redact(blob);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('redacts a comment written by an agent, but not one written by a human', () => {
    const d = openDb(':memory:');
    addTask(d, { title: 't' }, user);
    const leak = 'done, GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    commentTask(d, 1, leak, { type: 'ai', id: 'w1' });
    commentTask(d, 1, leak, user);
    const [byAgent, byHuman] = taskDetail(d, 1).comments;
    expect(byAgent.body).not.toContain('ghp_');
    expect(byHuman.body).toBe(leak);
  });
});

describe('checkpointWal', () => {
  it('shrinks the wal file that ordinary writes grew', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kdd-wal-'));
    const path = join(dir, 'kdd.db');
    const d = openDb(path, '/x/.git');
    addTask(d, { title: 't' }, user);
    for (let i = 0; i < 400; i++) commentTask(d, 1, 'x'.repeat(2_000), user);
    const grown = statSync(`${path}-wal`).size;
    expect(grown).toBeGreaterThan(64 * 1024);

    checkpointWal(d);
    expect(statSync(`${path}-wal`).size).toBeLessThan(grown);
    // и данные на месте — чекпоинт сливает WAL в базу, а не выбрасывает его
    expect(taskDetail(d, 1).comments).toHaveLength(400);
    d.close();
  });
});
