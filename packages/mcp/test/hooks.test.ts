import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDb, addTask, addCriterion, setCriterionChecked, moveTask } from '@kddkit/core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sessionStart = join(root, 'scripts', 'session-start.mjs');
const smartInstall = join(root, 'scripts', 'smart-install.mjs');
const stop = join(root, 'scripts', 'stop.mjs');

const runNode = (script: string, env: Record<string, string>) =>
  execFileSync(process.execPath, [script], {
    env: { ...process.env, ...env }, encoding: 'utf8',
  });

// Stop-хук читает stdin: без `input` execFileSync оставил бы дескриптор открытым и повис.
const runStop = (payload: object, env: Record<string, string>) =>
  execFileSync(process.execPath, [stop], {
    env: { ...process.env, KDD_SESSION: '', ...env },
    input: JSON.stringify(payload), encoding: 'utf8',
  });

// задача в работе, единственный критерий закрыт агентом сессии `cc:abcdef12`
const seeded = (): string => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'kdd-stop-')), 'kdd.db');
  const db = openDb(dbPath, 'x');
  const actor = { type: 'ai' as const, id: 'cc:abcdef12' };
  addTask(db, { title: 'работа' }, { type: 'user' });
  moveTask(db, 1, 'in_progress', actor);
  const c = addCriterion(db, 1, 'тест зелёный', actor);
  setCriterionChecked(db, 1, c.id, true, actor);
  db.close();
  return dbPath;
};

// `n` задач в работе, у каждой единственный критерий закрыт указанным актором.
const seededMany = (n: number, actorId = 'cc:abcdef12'): string => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'kdd-stop-')), 'kdd.db');
  const db = openDb(dbPath, 'x');
  const actor = { type: 'ai' as const, id: actorId };
  for (let i = 0; i < n; i++) {
    addTask(db, { title: `работа ${i}` }, { type: 'user' });
    moveTask(db, i + 1, 'in_progress', actor);
    const c = addCriterion(db, i + 1, 'тест зелёный', actor);
    setCriterionChecked(db, i + 1, c.id, true, actor);
  }
  db.close();
  return dbPath;
};

const IN = { session_id: 'abcdef12-3456-7890', hook_event_name: 'Stop', cwd: process.cwd() };

describe('session-start.mjs', () => {
  it('prints a short pointer and exits 0 on a healthy db', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'kdd-hook-')), 'kdd.db');
    openDb(dbPath, 'x').close();
    const out = runNode(sessionStart, { KDD_DB: dbPath });
    expect(out).toMatch(/KDD substrate active/);
    expect(out.trim().split('\n').length).toBeLessThanOrEqual(3);
  });

  it('exits 0 even when the db path is unusable', () => {
    // a directory as the db path makes better-sqlite3 throw
    const dir = mkdtempSync(join(tmpdir(), 'kdd-hook-'));
    const out = runNode(sessionStart, { KDD_DB: dir });
    expect(out).toMatch(/KDD substrate active/); // bare pointer still printed
  });
});

describe('smart-install.mjs', () => {
  it('is a no-op and exits 0 when better-sqlite3 already resolves', () => {
    // resolved from the workspace; must not throw and must print nothing noisy
    expect(() => runNode(smartInstall, {})).not.toThrow();
  });
});

describe('stop.mjs', () => {
  it('печатает одну строку про несданную задачу и выходит 0', () => {
    const out = runStop(IN, { KDD_DB: seeded() });
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('Stop');
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/#1/);
    expect(parsed.hookSpecificOutput.additionalContext.split('\n').length).toBe(1);
  });

  it('второй запуск подряд молчит: одно напоминание на задачу за сессию', () => {
    const dbPath = seeded();
    expect(runStop(IN, { KDD_DB: dbPath })).not.toBe('');
    expect(runStop(IN, { KDD_DB: dbPath }).trim()).toBe('');
  });

  it('молчит, когда напоминать нечего', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'kdd-stop-')), 'kdd.db');
    openDb(dbPath, 'x').close();
    expect(runStop(IN, { KDD_DB: dbPath }).trim()).toBe('');
  });

  it('молчит в сабагенте и на восстановительном ходу', () => {
    const dbPath = seeded();
    expect(runStop({ ...IN, agent_id: 'sub-1' }, { KDD_DB: dbPath }).trim()).toBe('');
    expect(runStop({ ...IN, stop_hook_active: true }, { KDD_DB: dbPath }).trim()).toBe('');
  });

  it('молчит и выходит 0, когда база недоступна', () => {
    // директория вместо файла базы: better-sqlite3 на таком бросает
    const dir = mkdtempSync(join(tmpdir(), 'kdd-stop-'));
    expect(() => runStop(IN, { KDD_DB: dir })).not.toThrow();
    expect(runStop(IN, { KDD_DB: dir }).trim()).toBe('');
  });

  it('молчит вне git-репозитория: базу там не найти', () => {
    // KDD_DB пустой — resolveDbPath идёт в git rev-parse и падает во временной директории
    const out = runStop({ ...IN, cwd: mkdtempSync(join(tmpdir(), 'kdd-nogit-')) }, { KDD_DB: '' });
    expect(out.trim()).toBe('');
  });

  it('молчит на мусорном stdin', () => {
    const out = execFileSync(process.execPath, [stop], {
      env: { ...process.env, KDD_DB: seeded() }, input: 'not json{', encoding: 'utf8',
    });
    expect(out.trim()).toBe('');
  });

  it('молчит на валидном, но не-объектном JSON (`null`)', () => {
    const out = execFileSync(process.execPath, [stop], {
      env: { ...process.env, KDD_DB: seeded() }, input: 'null', encoding: 'utf8',
    });
    expect(out.trim()).toBe('');
  });

  it('KDD_SESSION важнее stdin session_id: критерии на доске под ним — напоминание находится', () => {
    // критерии закрыты актором `worker-9` (как их закрыл бы tick-воркер), stdin несёт другой
    // session_id — если бы хук слушал только stdin, совпадения бы не было и хук молчал.
    const dbPath = seededMany(1, 'worker-9');
    const out = runStop(IN, { KDD_DB: dbPath, KDD_SESSION: 'worker-9' });
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/#1/);
  });

  it('кап сообщения: четыре задачи — три номера и "+1 more"', () => {
    const out = runStop(IN, { KDD_DB: seededMany(4) });
    const parsed = JSON.parse(out);
    const msg = parsed.hookSpecificOutput.additionalContext;
    expect(msg).toMatch(/#1, #2, #3 \+1 more/);
    expect(msg).not.toMatch(/#4/);
  });
});
