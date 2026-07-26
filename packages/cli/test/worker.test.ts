import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb, runProduced } from '@kddkit/core';
import { kdd, kddFail, makeEnv, BIN } from './run.js';      // BIN — путь к собранному dist/index.js
import { findWorker, workerTag } from '../src/procs.js';

// фикстура-claude: печатает канон NDJSON, выходит с заданным кодом
function stubClaude(dir: string, lines: object[], exit = 0): string {
  const p = join(dir, 'stub-claude.mjs');
  writeFileSync(p, `#!/usr/bin/env node
${lines.map((l) => `console.log(${JSON.stringify(JSON.stringify(l))});`).join('\n')}
process.exit(${exit});
`);
  chmodSync(p, 0o755);
  return p;
}

function repo() {
  const env = makeEnv();
  const dir = dirname(env.KDD_DB as string);
  // настоящий git-репо: worker.ensureWorktree делает `git worktree add`.
  // worktree ложатся в dir/worktrees/ (store-корень = dirname(KDD_DB) = dir) — как в проде (~/.kdd/<hash>/).
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  execFileSync('git', ['-C', dir, 'commit', '--allow-empty', '-qm', 'root']);
  env.KDD_TOPLEVEL = dir;
  return { env, dir };
}

// CR-1 фикстура: static stubClaude сериализует строки на write-time и не может эхо-нуть
// рантайм-переменную окружения — этот .mjs читает process.env.KDD_TASK_ID В МОМЕНТ ЗАПУСКА.
function stubClaudeEnvEcho(dir: string): string {
  const p = join(dir, 'stub-claude-env-echo.mjs');
  writeFileSync(p, `#!/usr/bin/env node
const text = process.env.KDD_TASK_ID ?? '';
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }));
process.exit(0);
`);
  chmodSync(p, 0o755);
  return p;
}

// фикстура-claude: делает реальный коммит в СВОЁМ cwd (= worktree воркера), затем канон NDJSON.
function stubClaudeCommit(dir: string): string {
  const p = join(dir, 'stub-claude-commit.mjs');
  writeFileSync(p, `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
writeFileSync('work.txt', 'done');
execFileSync('git', ['add', 'work.txt']);
execFileSync('git', ['commit', '-qm', 'worker commit']);
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }));
process.exit(0);
`);
  chmodSync(p, 0o755);
  return p;
}

// фикстура-claude: как stubClaudeCommit, но коммитит ДРУГОЙ файл — для теста back-to-back
// ранов на переиспользуемом worktree (второй запуск stubClaudeCommit на том же work.txt
// не даст реального diff → `git commit` упадёт "nothing to commit").
function stubClaudeCommit2(dir: string): string {
  const p = join(dir, 'stub-claude-commit-2.mjs');
  writeFileSync(p, `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
writeFileSync('work2.txt', 'done2');
execFileSync('git', ['add', 'work2.txt']);
execFileSync('git', ['commit', '-qm', 'worker commit 2']);
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok2' }] } }));
process.exit(0);
`);
  chmodSync(p, 0o755);
  return p;
}

describe('kdd worker', () => {
  it('ingests stream into agent_events, run_start first, run_end last with exit code', () => {
    const { env, dir } = repo();
    kdd(env, 'add', 'do a thing'); // task #1
    const stub = stubClaude(dir, [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } },
    ], 0);
    kdd({ ...env, KDD_CLAUDE_CMD: `node ${stub}`, KDD_SESSION: 'tick:9-0' }, 'worker', '1');
    const feed = JSON.parse(kdd(env, 'feed', '1', '--json'));
    expect(feed.map((e: any) => e.kind)).toEqual(['run_start', 'text', 'tool_start', 'run_end']);
    expect(feed[0].worker_id).toBe('tick:9-0');
    expect(JSON.parse(feed.at(-1).detail).exitCode).toBe(0);
  });

  it('records nonzero exit', () => {
    const { env, dir } = repo();
    kdd(env, 'add', 't');
    const stub = stubClaude(dir, [], 3);
    kdd({ ...env, KDD_CLAUDE_CMD: `node ${stub}` }, 'worker', '1');
    const feed = JSON.parse(kdd(env, 'feed', '1', '--json'));
    expect(JSON.parse(feed.at(-1).detail).exitCode).toBe(3);
  });

  it('missing claude → error event + run_end, no crash', () => {
    const { env } = repo();
    kdd(env, 'add', 't');
    kdd({ ...env, KDD_CLAUDE_CMD: '/nonexistent/claude-xyz' }, 'worker', '1');
    const feed = JSON.parse(kdd(env, 'feed', '1', '--json'));
    expect(feed.some((e: any) => e.kind === 'error')).toBe(true);
    expect(feed.at(-1).kind).toBe('run_end');
  });

  it('CR-1: direct `kdd worker <id>` (no inherited KDD_TASK_ID) sets child env so $KDD_TASK_ID resolves', () => {
    const { env, dir } = repo();
    kdd(env, 'add', 'do a thing'); // task #1
    const stub = stubClaudeEnvEcho(dir);
    // deliberately WITHOUT KDD_TASK_ID / KDD_SESSION in the passed env — only KDD_TOPLEVEL + KDD_CLAUDE_CMD
    kdd({ ...env, KDD_CLAUDE_CMD: `node ${stub}` }, 'worker', '1');
    const feed = JSON.parse(kdd(env, 'feed', '1', '--json'));
    const textEvent = feed.find((e: any) => e.kind === 'text');
    expect(JSON.parse(textEvent.detail).text).toBe('1');
  });

  it('CR-2: bad id exits non-zero with a clean error: line, no stack', () => {
    const { env } = repo();
    const { code, stderr } = kddFail(env, 'worker', 'abc');
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/(^|\n)error:/);
    expect(stderr).not.toMatch(/at .*worker/); // no stack trace leaking through
  });

  it('CR-2: nonexistent task exits non-zero with a clean error: line, no stack', () => {
    const { env } = repo();
    const { code, stderr } = kddFail(env, 'worker', '999');
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/(^|\n)error:/);
  });

  it('runs claude in the per-task worktree (cwd = worktrees/task-<id>-*), not toplevel', () => {
    const { env, dir } = repo();
    kdd(env, 'add', 'wt task'); // task #1
    const p = join(dir, 'stub-cwd.mjs');
    writeFileSync(p, `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: process.cwd() }] } }));
process.exit(0);
`);
    chmodSync(p, 0o755);
    kdd({ ...env, KDD_CLAUDE_CMD: `node ${p}` }, 'worker', '1');
    const feed = JSON.parse(kdd(env, 'feed', '1', '--json'));
    const childCwd = JSON.parse(feed.find((e: any) => e.kind === 'text').detail).text;
    expect(childCwd).toContain(join('worktrees', 'task-1-'));
    expect(childCwd).not.toBe(dir); // не корень репо/стора
  });

  it('commit run: run_start/run_end carry head, runProduced.committed=true', () => {
    const { env, dir } = repo();
    kdd(env, 'add', 'x'); // task #1 — repo() не создаёт задачу
    const stub = stubClaudeCommit(dir);
    kdd({ ...env, KDD_CLAUDE_CMD: `node ${stub}` }, 'worker', '1');

    const d = openDb(env.KDD_DB as string, dir);
    const rows = d.prepare(
      `SELECT kind, detail FROM agent_events WHERE task_id = 1 AND kind IN ('run_start','run_end') ORDER BY id`,
    ).all() as { kind: string; detail: string }[];
    const start = JSON.parse(rows.find((r) => r.kind === 'run_start')!.detail);
    const end = JSON.parse(rows.find((r) => r.kind === 'run_end')!.detail);
    expect(typeof start.head).toBe('string');
    expect(typeof end.head).toBe('string');

    const rp = runProduced(d, 1);
    d.close();
    expect(rp).not.toBeNull();
    expect(rp!.committed).toBe(true);
    expect(rp!.before).not.toBe(rp!.after);
  });

  it('reused worktree: run 2 before_head == run 1 after_head, isolating run 2 own commit', () => {
    const { env, dir } = repo();
    kdd(env, 'add', 'x'); // task #1 — repo() не создаёт задачу

    // ран 1: коммитит work.txt в новом (только что созданном) worktree
    const stub1 = stubClaudeCommit(dir);
    kdd({ ...env, KDD_CLAUDE_CMD: `node ${stub1}` }, 'worker', '1');
    const d1 = openDb(env.KDD_DB as string, dir);
    const run1 = runProduced(d1, 1)!;
    d1.close();
    expect(run1.committed).toBe(true);

    // ран 2: тот же task id → ensureWorktree переиспользует ветку/worktree ран 1.
    // Коммитит work2.txt (другой файл — иначе второй `git commit` на идентичном diff упадёт).
    const stub2 = stubClaudeCommit2(dir);
    kdd({ ...env, KDD_CLAUDE_CMD: `node ${stub2}` }, 'worker', '1');

    const d = openDb(env.KDD_DB as string, dir);
    const rows = d.prepare(
      `SELECT kind, detail FROM agent_events WHERE task_id = 1 AND kind IN ('run_start','run_end') ORDER BY id`,
    ).all() as { kind: string; detail: string }[];
    const starts = rows.filter((r) => r.kind === 'run_start').map((r) => JSON.parse(r.detail));
    const ends = rows.filter((r) => r.kind === 'run_end').map((r) => JSON.parse(r.detail));
    expect(starts.length).toBe(2);
    expect(ends.length).toBe(2);
    // worktree переиспользован: before_head рана 2 == after_head рана 1
    expect(starts[1].head).toBe(ends[0].head);

    const rp = runProduced(d, 1);
    d.close();
    expect(rp).not.toBeNull();
    expect(rp!.committed).toBe(true);
    expect(rp!.before).toBe(run1.after); // ран 2 стартует с головы, оставленной раном 1
    expect(rp!.after).not.toBe(rp!.before); // ран 2 сам что-то закоммитил
  });

  it('empty run: no commit → runProduced.committed=false', () => {
    const { env, dir } = repo();
    kdd(env, 'add', 'x'); // task #1 — repo() не создаёт задачу
    const stub = stubClaude(dir, [{ type: 'assistant', message: { content: [{ type: 'text', text: 'noop' }] } }]);
    kdd({ ...env, KDD_CLAUDE_CMD: `node ${stub}` }, 'worker', '1');

    const d = openDb(env.KDD_DB as string, dir);
    const rp = runProduced(d, 1);
    d.close();
    expect(rp).not.toBeNull();
    expect(rp!.committed).toBe(false);
    expect(rp!.before).toBe(rp!.after);
  });
});

// фикстура-claude: живёт заданное число секунд, потом печатает строку и выходит
function stubClaudeSleep(dir: string, seconds: number, tag = 'slept'): string {
  const p = join(dir, `stub-claude-sleep-${seconds}.mjs`);
  writeFileSync(p, `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
execFileSync('sleep', ['${seconds}']);
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '${tag}' }] } }));
process.exit(0);
`);
  chmodSync(p, 0o755);
  return p;
}

describe('kdd worker heartbeat', () => {
  // B1: продление механическое — lease живёт в claimed_by/claim_expires, а окна событий
  // капированы (status ≤5, show ≤10). Удар раз в ttl/3 вытеснил бы из них всю настоящую
  // историю доски, и человек с Claude видели бы только «claim renewed».
  it('renews the lease it holds without writing board history', () => {
    const { env, dir } = repo();
    kdd(env, 'add', 'long one', '--criterion', 'done');
    const agent = { ...env, KDD_ACTOR: 'ai', KDD_SESSION: 'tick:1-0' };
    kdd(agent, 'claim', '1', '--ttl', '3');
    // `kdd show --json` — полный taskDetail: { task, criteria, comments, events, links }
    const before = Number(JSON.parse(kdd(env, 'show', '1', '--json')).task.claim_expires);

    const stub = stubClaudeSleep(dir, 4);
    kdd({ ...agent, KDD_CLAUDE_CMD: `node ${stub}`, KDD_WORKER_TTL: '3' }, 'worker', '1');

    const detail = JSON.parse(kdd(env, 'show', '1', '--json'));
    expect(Number(detail.task.claim_expires)).toBeGreaterThan(before); // heartbeat продлил
    expect(detail.events.some((e: any) => e.action === 'claim_renewed')).toBe(false);
  }, 30_000);

  it('a human `kdd claim --renew` is still a board action and is logged', () => {
    const { env } = repo();
    kdd(env, 'add', 'mine', '--criterion', 'done');
    kdd(env, 'claim', '1', '--ttl', '60');
    kdd(env, 'claim', '1', '--renew', '--ttl', '60');
    const detail = JSON.parse(kdd(env, 'show', '1', '--json'));
    expect(detail.events.some((e: any) => e.action === 'claim_renewed')).toBe(true);
  }, 30_000);

  it('stops the agent within one beat when the lease is taken away', async () => {
    const { env, dir } = repo();
    kdd(env, 'add', 'stolen', '--criterion', 'done');
    const agent = { ...env, KDD_ACTOR: 'ai', KDD_SESSION: 'tick:1-0' };
    kdd(agent, 'claim', '1', '--ttl', '3');

    // Воркер запускаем ФОНОМ: lease надо отобрать у уже работающего процесса. Отбери его до
    // старта — воркер увидит чужой claimed_by, heartbeat не заведёт (это ручной режим) и
    // тест проверил бы не то.
    const stub = stubClaudeSleep(dir, 30); // пережил бы тест, если бы его не убили
    const t0 = Date.now();
    const child = spawn('node', [BIN, 'worker', '1'], {
      env: { ...agent, KDD_CLAUDE_CMD: `node ${stub}`, KDD_WORKER_TTL: '3' }, stdio: 'ignore',
    });

    // ждём run_start — доказательство, что claude уже поднят
    for (let i = 0; i < 50; i++) {
      execFileSync('sleep', ['0.1']);
      const f = JSON.parse(kdd(env, 'feed', '1', '--json'));
      if (f.some((e: any) => e.kind === 'run_start')) break;
    }

    const d0 = openDb(env.KDD_DB as string, dir);
    d0.prepare(`UPDATE tasks SET claimed_by = 'ai:tick:9-9' WHERE id = 1`).run();
    d0.close();

    await new Promise<void>((res) => child.on('close', () => res()));
    const elapsed = (Date.now() - t0) / 1000;

    expect(elapsed).toBeLessThan(20); // умер по heartbeat, а не досидел свои 30 с
    const feed = JSON.parse(kdd(env, 'feed', '1', '--json'));
    expect(feed.some((e: any) => e.kind === 'error')).toBe(true);
    expect(feed.at(-1).kind).toBe('run_end');
  }, 60_000);

  // Брошенное исключение в колбэке setInterval — uncaught: супервизор умирает, а claude
  // остаётся жить сиротой. Ровно та сирота, которую этот бранч и чинит.
  it('a transient db failure in the heartbeat does not kill the supervisor', async () => {
    const { env, dir } = repo();
    kdd(env, 'add', 'busy board', '--criterion', 'done');
    const agent = { ...env, KDD_ACTOR: 'ai', KDD_SESSION: 'tick:1-0' };
    kdd(agent, 'claim', '1', '--ttl', '3'); // ttl 3 → удар раз в секунду

    const stub = stubClaudeSleep(dir, 12, 'survived');
    const child = spawn('node', [BIN, 'worker', '1'], {
      env: { ...agent, KDD_CLAUDE_CMD: `node ${stub}`, KDD_WORKER_TTL: '3' }, stdio: 'ignore',
    });
    for (let i = 0; i < 50; i++) { // ждём run_start — claude уже поднят
      execFileSync('sleep', ['0.1']);
      if (JSON.parse(kdd(env, 'feed', '1', '--json')).some((e: any) => e.kind === 'run_start')) break;
    }

    // Держим write-лок дольше busy_timeout (5 с) — renewClaim упирается в SQLITE_BUSY и бросает.
    const lock = openDb(env.KDD_DB as string, dir);
    lock.exec('BEGIN EXCLUSIVE');
    execFileSync('sleep', ['7']);
    lock.exec('COMMIT');
    lock.close();

    const code: number = await new Promise((r) => child.on('exit', (c) => r(c ?? -1)));
    expect(code).toBe(0); // супервизор пережил удар, а не свалился с uncaught
    const feed = JSON.parse(kdd(env, 'feed', '1', '--json'));
    expect(JSON.parse(feed.find((e: any) => e.kind === 'text').detail).text).toBe('survived');
    expect(feed.at(-1).kind).toBe('run_end');
  }, 90_000);

  // NaN-ttl раньше доезжал до setInterval: интервал NaN → удар через 1 мс → assertTtl бросает
  // из таймера → тот же uncaught. Валидируем на старте, до спауна claude.
  it('a non-numeric KDD_WORKER_TTL fails fast, before claude is spawned', () => {
    const { env, dir } = repo();
    kdd(env, 'add', 'bad ttl', '--criterion', 'done');
    const agent = { ...env, KDD_ACTOR: 'ai', KDD_SESSION: 'tick:1-0' };
    kdd(agent, 'claim', '1', '--ttl', '3');
    const stub = stubClaudeSleep(dir, 5);
    const { code, stderr } = kddFail(
      { ...agent, KDD_CLAUDE_CMD: `node ${stub}`, KDD_WORKER_TTL: 'abc' }, 'worker', '1');
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/(^|\n)error:/);
    expect(stderr).not.toMatch(/ at /); // не uncaught со стеком из таймера
  }, 30_000);

  it('a manual worker run without a claim is not killed by the heartbeat', () => {
    const { env, dir } = repo();
    kdd(env, 'add', 'manual');
    const stub = stubClaudeSleep(dir, 2, 'finished');
    // задача НЕ заклеймлена: heartbeat не заводится, ран доходит до конца
    kdd({ ...env, KDD_CLAUDE_CMD: `node ${stub}`, KDD_WORKER_TTL: '1' }, 'worker', '1');
    const feed = JSON.parse(kdd(env, 'feed', '1', '--json'));
    const text = feed.find((e: any) => e.kind === 'text');
    expect(JSON.parse(text.detail).text).toBe('finished');
  }, 30_000);
});

// фикстура-claude: печатает одну строку, потом замолкает на 30 с — залипший агент.
// Пока поток шёл, супервизор считал его живым; клин видно ровно по тишине.
function stubClaudeWedge(dir: string): string {
  const p = join(dir, 'stub-claude-wedge.mjs');
  writeFileSync(p, `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'starting' }] } }));
execFileSync('sleep', ['30']);
process.exit(0);
`);
  chmodSync(p, 0o755);
  return p;
}

// B2: раньше клин ловил сам агент (промпт просил звать `kdd claim --renew`). Промпт этого больше
// не просит, а таймер супервизора продлевает lease, пока жив ОН — зависший claude держал бы слот
// вечно, и доска за ночь не двигалась бы вообще.
describe('kdd worker idle watchdog', () => {
  it('stops a silent agent and ends the run so the lease can expire', async () => {
    const { env, dir } = repo();
    kdd(env, 'add', 'wedges', '--criterion', 'done');
    const agent = { ...env, KDD_ACTOR: 'ai', KDD_SESSION: 'tick:1-0' };
    kdd(agent, 'claim', '1', '--ttl', '60');
    const stub = stubClaudeWedge(dir);
    const t0 = Date.now();
    const child = spawn('node', [BIN, 'worker', '1'], {
      env: { ...agent, KDD_CLAUDE_CMD: `node ${stub}`, KDD_WORKER_IDLE: '2' }, stdio: 'ignore',
    });
    try {
      await new Promise<void>((res) => child.on('close', () => res()));
      expect((Date.now() - t0) / 1000).toBeLessThan(20); // не досидел свои 30 с
      const feed = JSON.parse(kdd(env, 'feed', '1', '--json'));
      const err = feed.find((e: any) => e.kind === 'error');
      expect(err).toBeTruthy();
      expect(JSON.parse(err.detail).message).toMatch(/no output for 2s/);
      expect(feed.at(-1).kind).toBe('run_end');
    } finally {
      child.kill('SIGKILL');
    }
  }, 60_000);

  it('a non-numeric KDD_WORKER_IDLE fails fast, before claude is spawned', () => {
    const { env, dir } = repo();
    kdd(env, 'add', 'bad idle', '--criterion', 'done');
    const stub = stubClaudeSleep(dir, 5);
    const { code, stderr } = kddFail(
      { ...env, KDD_CLAUDE_CMD: `node ${stub}`, KDD_WORKER_IDLE: '30m' }, 'worker', '1');
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/KDD_WORKER_IDLE/);
  }, 30_000);
});

// фикстура-claude: поднимает долгоживущего внука (роль dev-сервера, поднятого через Bash),
// пишет его pid и сам живёт. Внук НЕ detached — он в группе claude, как и в проде.
function stubClaudeGrandchild(dir: string, pidFile: string): string {
  const p = join(dir, 'stub-claude-grandchild.mjs');
  writeFileSync(p, `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const kid = spawn('sleep', ['300'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(pidFile)}, String(kid.pid));
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'up' }] } }));
// ждём таймером, а не вторым дочерним sleep: у теста должен быть pid КАЖДОГО потомка,
// иначе провалившийся ассерт оставляет за собой сироту, которую нечем добить.
setTimeout(() => {}, 300000);
`);
  chmodSync(p, 0o755);
  return p;
}

// B3: путь «lease отобрали» бил по одному pid claude. Всё, что claude поднял через Bash и что
// переживает родителя, оставалось жить — и метки рана в argv у него нет, значит ни findWorker,
// ни какой-либо будущий tick его уже не найдут: порты и CPU до перезагрузки.
describe('kdd worker stops the whole agent group', () => {
  it('a descendant of the agent dies with it when the lease is lost', async () => {
    const { env, dir } = repo();
    kdd(env, 'add', 'spawns a server', '--criterion', 'done');
    const agent = { ...env, KDD_ACTOR: 'ai', KDD_SESSION: 'tick:1-0' };
    kdd(agent, 'claim', '1', '--ttl', '3');

    const pidFile = join(dir, 'grandchild.pid');
    const stub = stubClaudeGrandchild(dir, pidFile);
    const child = spawn('node', [BIN, 'worker', '1'], {
      env: { ...agent, KDD_CLAUDE_CMD: `node ${stub}`, KDD_WORKER_TTL: '3' }, stdio: 'ignore',
    });
    let kidPid = 0;
    try {
      for (let i = 0; i < 100 && !kidPid; i++) {
        execFileSync('sleep', ['0.1']);
        try { kidPid = Number(readFileSync(pidFile, 'utf8')); } catch { /* ещё не записан */ }
      }
      expect(kidPid).toBeGreaterThan(0);
      expect(() => process.kill(kidPid, 0)).not.toThrow(); // внук жив

      const d0 = openDb(env.KDD_DB as string, dir);
      d0.prepare(`UPDATE tasks SET claimed_by = 'ai:tick:9-9' WHERE id = 1`).run();
      d0.close();

      await new Promise<void>((res) => child.on('close', () => res()));
      execFileSync('sleep', ['1']); // SIGTERM группе долетает не мгновенно
      expect(() => process.kill(kidPid, 0)).toThrow(/ESRCH/); // и внук ушёл вместе с группой
    } finally {
      child.kill('SIGKILL');
      if (kidPid) { try { process.kill(kidPid, 'SIGKILL'); } catch { /* уже мёртв */ } }
    }
  }, 60_000);
});

// B4: с `$SHELL -lc` профиль пользователя грузится ПЕРЕД командой, и документированный
// `export KDD_ACTOR=...` в ~/.zprofile переписывал бы личность, которую подставил tick.
describe('worker identity survives a login shell profile', () => {
  it('tick-injected KDD_ACTOR/KDD_SESSION win over a profile that exports the same names', () => {
    const env = makeEnv();
    kdd(env, 'add', 'identity', '--criterion', 'c');
    kdd(env, 'criteria', 'check', '1', '1');
    const marker = join(dirname(env.KDD_DB!), 'ident.txt');
    // фейковый $SHELL = логин-шелл, чей профиль экспортирует ровно наши имена, потом eval'ит -lc строку
    const fakeShell = join(dirname(env.KDD_DB!), 'profile-shell.sh');
    writeFileSync(fakeShell,
      `#!/bin/sh\nexport KDD_ACTOR=user\nexport KDD_SESSION=from-zprofile\neval "$2"\n`);
    chmodSync(fakeShell, 0o755);
    env.SHELL = fakeShell;
    env.KDD_MAX_WORKERS = '1';
    env.KDD_SPAWN_CMD = `printf '%s|%s' "$KDD_ACTOR" "$KDD_SESSION" > ${marker}`;
    expect(kdd(env, 'tick')).toMatch(/spawned 1/);

    let written = '';
    for (let i = 0; i < 25 && !written; i++) {
      execFileSync('sleep', ['0.2']);
      try { written = readFileSync(marker, 'utf8'); } catch { /* not written yet */ }
    }
    expect(written).toMatch(/^ai\|tick:/); // а не 'user|from-zprofile'
  }, 30_000);

  // Молчаливо разоружённый heartbeat — худший исход: lease истекает под живым агентом, tick
  // убивает здоровый ран, и через три круга задача блокируется без единой подсказки почему.
  it('a run on a task held by someone else reports the mismatch (stderr + feed)', () => {
    const { env, dir } = repo();
    kdd(env, 'add', 'held', '--criterion', 'done');
    kdd({ ...env, KDD_ACTOR: 'ai', KDD_SESSION: 'tick:1-0' }, 'claim', '1', '--ttl', '60');
    const stub = stubClaudeSleep(dir, 1, 'ran anyway');
    // личность подменена (как это сделал бы профиль): claimed_by !== authorOf(actor)
    const r = spawnSync('node', [BIN, 'worker', '1'], {
      env: { ...env, KDD_ACTOR: 'ai', KDD_SESSION: 'clobbered', KDD_CLAUDE_CMD: `node ${stub}` },
      encoding: 'utf8',
    });
    expect(r.stderr).toMatch(/heartbeat disarmed/);
    const feed = JSON.parse(kdd(env, 'feed', '1', '--json'));
    const err = feed.find((e: any) => e.kind === 'error');
    expect(err).toBeTruthy();
    expect(JSON.parse(err.detail).message).toMatch(/held by ai:tick:1-0/);
  }, 30_000);

  it('a manual run on an UNCLAIMED task stays quiet', () => {
    const { env, dir } = repo();
    kdd(env, 'add', 'free');
    const stub = stubClaudeSleep(dir, 1, 'ok');
    const r = spawnSync('node', [BIN, 'worker', '1'],
      { env: { ...env, KDD_CLAUDE_CMD: `node ${stub}` }, encoding: 'utf8' });
    expect(r.stderr).not.toMatch(/heartbeat disarmed/);
    const feed = JSON.parse(kdd(env, 'feed', '1', '--json'));
    expect(feed.some((e: any) => e.kind === 'error')).toBe(false);
  }, 30_000);
});

// фикстура-claude: эхо своего собственного `-p` промпта — единственный способ увидеть
// командную строку, с которой супервизор поднял агента.
function stubClaudePromptEcho(dir: string): string {
  const p = join(dir, 'stub-claude-prompt-echo.mjs');
  writeFileSync(p, `#!/usr/bin/env node
const prompt = process.argv[process.argv.indexOf('-p') + 1] ?? '';
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: prompt }] } }));
process.exit(0);
`);
  chmodSync(p, 0o755);
  return p;
}

const promptOf = (env: NodeJS.ProcessEnv): string =>
  JSON.parse(JSON.parse(kdd(env, 'feed', '1', '--json'))
    .find((e: any) => e.kind === 'text').detail).text;

// C1/C2. Метка в промпте — единственное, что делает самого claude видимым в `ps`: его argv не
// содержит ни пути к index.js, ни номера задачи. Без неё осиротевший claude (супервизор умер)
// не находится, tick считает слот свободным и сажает второго агента в ту же worktree.
describe('the run marker in claude own argv', () => {
  it('is there with the built-in prompt, and tick finds the run by it', () => {
    const { env, dir } = repo();
    kdd(env, 'add', 'tagged', '--criterion', 'done');
    const agent = { ...env, KDD_ACTOR: 'ai', KDD_SESSION: 'tick:1-0' };
    kdd(agent, 'claim', '1', '--ttl', '60');
    const p = stubClaudePromptEcho(dir);
    kdd({ ...agent, KDD_CLAUDE_CMD: `node ${p}` }, 'worker', '1');
    const prompt = promptOf(env);
    const tag = workerTag(1, env.KDD_DB as string);
    expect(prompt).toContain(tag);
    expect(findWorker(tag, () => `  1   1 claude -p ${prompt}`)).toHaveLength(1);
  }, 30_000);

  // C1: `??` отдавал свой промпт целиком — вместе с меткой. Свой промпт настраивает ИНСТРУКЦИИ,
  // а не lifecycle: маркер дописывается к любому.
  it('is appended to a custom KDD_WORKER_PROMPT too', () => {
    const { env, dir } = repo();
    kdd(env, 'add', 'custom prompt', '--criterion', 'done');
    const agent = { ...env, KDD_ACTOR: 'ai', KDD_SESSION: 'tick:1-0' };
    kdd(agent, 'claim', '1', '--ttl', '60');
    const p = stubClaudePromptEcho(dir);
    kdd({ ...agent, KDD_CLAUDE_CMD: `node ${p}`, KDD_WORKER_PROMPT: 'just do the thing' },
      'worker', '1');
    const prompt = promptOf(env);
    const tag = workerTag(1, env.KDD_DB as string);
    expect(prompt).toContain('just do the thing');
    expect(prompt).toContain(tag);
    expect(findWorker(tag, () => `  1   1 claude -p ${prompt}`)).toHaveLength(1);
  }, 30_000);

  // C2: ран без lease раньше считал ровно ту же метку сам — и следующий tick, реклеймив
  // истёкший чужой lease, слал SIGKILL ГРУППЕ этого рана: в скрипте или CI-шаге это
  // родительский скрипт со всеми его детьми.
  it('a run that does not hold the lease is NOT findable by the tag tick computes', () => {
    const { env, dir } = repo();
    kdd(env, 'add', 'manual repro', '--criterion', 'done');
    // lease у tick-воркера, ран запускает человек: holdsLease === false
    kdd({ ...env, KDD_ACTOR: 'ai', KDD_SESSION: 'tick:9-0' }, 'claim', '1', '--ttl', '60');
    const p = stubClaudePromptEcho(dir);
    kdd({ ...env, KDD_CLAUDE_CMD: `node ${p}` }, 'worker', '1');
    const prompt = promptOf(env);
    const tag = workerTag(1, env.KDD_DB as string);
    expect(prompt).not.toContain(tag);
    expect(findWorker(tag, () => `  1   1 claude -p ${prompt}`)).toEqual([]);
    expect(prompt).toMatch(/kdd-worker-manual/); // личность у рана всё же есть
  }, 30_000);
});
