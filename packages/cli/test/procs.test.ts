import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findWorker, killWorker, killWorkers, workerAlive, workerTag, type PsFn,
} from '../src/procs.js';

const TAG = workerTag(85, '/store/a/kdd.db');
const OTHER_BOARD = workerTag(85, '/store/b/kdd.db'); // та же задача, другая доска
const PREFIX = workerTag(8, '/store/a/kdd.db');
// Канон вывода `ps -eo pid=,pgid=,args=`: два числовых поля, потом args с пробелами.
const PS = [
  `  501   501 /bin/zsh -lc '/usr/bin/node /a/b/dist/index.js worker 85 --tag ${TAG}'`,
  `  502   501 /usr/bin/node /a/b/dist/index.js worker 85 --tag ${TAG}`,
  // сирота: супервизор умер, claude жив. В его argv нет ни пути к index.js, ни ' worker 85' —
  // только метка из промпта. Ровно этот процесс раньше был невидим для findWorker.
  `  503   501 claude -p You are a kdd agent worker ... marker: ${TAG}. --output-format stream-json`,
  `  600   600 /usr/bin/node /a/b/dist/index.js worker 8 --tag ${PREFIX}`,
  `  700   700 /usr/bin/node /a/b/dist/index.js worker 85 --tag ${OTHER_BOARD}`,
  `  800   800 vim notes-worker 85.md`,
  `  900   900 /usr/bin/node /a/b/dist/index.js tick --json`,
].join('\n');

describe('findWorker', () => {
  it('matches the shell, the supervisor AND the orphaned claude of that task, one pgid', () => {
    const found = findWorker(TAG, () => PS);
    expect(found.map((p) => p.pid).sort()).toEqual([501, 502, 503]);
    expect(new Set(found.map((p) => p.pgid))).toEqual(new Set([501]));
  });

  it('does not match a prefix task id', () => {
    expect(findWorker(PREFIX, () => PS).map((p) => p.pid)).toEqual([600]);
  });

  it('does not match the same task id on another board', () => {
    expect(findWorker(TAG, () => PS).map((p) => p.pid)).not.toContain(700);
    expect(findWorker(OTHER_BOARD, () => PS).map((p) => p.pid)).toEqual([700]);
  });

  it('ignores unrelated processes', () => {
    const pids = findWorker(TAG, () => PS).map((p) => p.pid);
    expect(pids).not.toContain(800); // просто текст со словом worker
    expect(pids).not.toContain(900); // наш же tick, но не worker
  });

  it('empty ps output yields nothing, no throw', () => {
    expect(findWorker(TAG, () => '')).toEqual([]);
    expect(workerAlive(TAG, () => '')).toBe(false);
  });
});

// A3: «ps не запустился» — не то же самое, что «воркеров нет». Проглоченная ошибка делала
// пустой мир: слот отдавался живому процессу, а sweep сносил worktree под работающим агентом.
describe('a ps scan that cannot run', () => {
  const boom: PsFn = () => { throw new Error('spawnSync ps ENOENT'); };

  it('propagates out of findWorker and killWorker', () => {
    expect(() => findWorker(TAG, boom)).toThrow(/ENOENT/);
    // драйвер ловит это исключение и трактует как 'stuck' — слот не реклеймится
    expect(() => killWorker(TAG, { ps: boom, termWaitMs: 1, killWaitMs: 1 })).toThrow(/ENOENT/);
  });

  it('makes workerAlive report busy, so sweep never deletes an unproven-idle worktree', () => {
    expect(workerAlive(TAG, boom)).toBe(true);
  });
});

describe('killWorker', () => {
  it('reports absent (not gone) when there was no such process to kill', () => {
    expect(killWorker(TAG, { ps: () => '', termWaitMs: 1, killWaitMs: 1 })).toBe('absent');
  });

  it('never signals its own process group', () => {
    // Ребёнок БЕЗ detached живёт в нашей группе — как tick-child планировщика в группе
    // UI-сервера. Подсовываем ps-строку, где он выглядит воркером: без гварда killWorker
    // послал бы SIGKILL -pgid и снёс бы заодно себя и весь ранннер.
    const kid = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)],
        { encoding: 'utf8' }).trim());
      const ps = [
        `  ${process.pid} ${pgid} node vitest`, // строка про нас самих — из неё берётся own
        `  ${kid.pid} ${pgid} sleep 30 --tag ${TAG}`,
      ].join('\n');
      // 'stuck': «пережил» оба сигнала — потому что ни одного не послали.
      expect(killWorker(TAG, { ps: () => ps, termWaitMs: 1, killWaitMs: 1 })).toBe('stuck');
      expect(() => process.kill(kid.pid as number, 0)).not.toThrow(); // сосед по группе жив
    } finally {
      kid.kill('SIGKILL');
    }
  });
});

describe('killWorker on real processes', () => {
  it('kills the whole process group, not just the supervisor', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kdd-procs-'));
    const script = join(dir, 'index.js');
    const pidFile = join(dir, 'grandchild.pid');
    const tag = workerTag(4242, join(dir, 'kdd.db'));
    // Стенд-супервизор: спаунит ребёнка (роль claude) и живёт. Ребёнок НЕ detached —
    // он в группе супервизора, ровно как настоящий claude.
    writeFileSync(script, `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const kid = spawn('sleep', ['300'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(pidFile)}, String(kid.pid));
setInterval(() => {}, 1000);
`);
    const sup = spawn(process.execPath, [script, 'worker', '4242', '--tag', tag],
      { detached: true, stdio: 'ignore' });
    sup.unref();

    // страховка: если любой expect ниже упадёт раньше killWorker, супервизор и внук
    // не должны пережить тест как сироты — finally бьёт по группе и по внуку напрямую.
    let kidPid = 0;
    try {
      // ждём, пока оба появятся (спаун асинхронный)
      for (let i = 0; i < 50 && !kidPid; i++) {
        execFileSync('sleep', ['0.1']);
        try { kidPid = Number(readFileSync(pidFile, 'utf8')); } catch { /* ещё не записан */ }
      }
      expect(kidPid).toBeGreaterThan(0);
      expect(workerAlive(tag)).toBe(true);

      expect(killWorker(tag, { termWaitMs: 500, killWaitMs: 500 })).toBe('gone');
      expect(workerAlive(tag)).toBe(false);
      // внук (роль claude) тоже мёртв — это и есть проверка группы
      expect(() => process.kill(kidPid, 0)).toThrow(/ESRCH/);
    } finally {
      // на happy path тут уже нечего убивать — ESRCH и есть ожидаемый случай
      try { process.kill(-(sup.pid as number), 'SIGKILL'); } catch { /* уже мёртв */ }
      if (kidPid) { try { process.kill(kidPid, 'SIGKILL'); } catch { /* уже мёртв */ } }
    }
  }, 20_000);
});

// Ревью: убийство шло по воркеру за раз — (2s + 0.5s) сна и три скана `ps` на каждого, и всё
// это внутри тик-лока. Пауза после сигнала обязана быть одна на весь набор.
describe('killWorkers (batch)', () => {
  const TAG_A = workerTag(1, '/store/a/kdd.db');
  const TAG_B = workerTag(2, '/store/a/kdd.db');
  const TAG_C = workerTag(3, '/store/a/kdd.db');

  it('scans ps three times total, not three times per worker', () => {
    let scans = 0;
    const ps: PsFn = () => {
      scans += 1;
      // все трое живы всегда — худший случай, доходит до последней фазы
      return [`  501   501 node worker --tag ${TAG_A}`,
        `  502   502 node worker --tag ${TAG_B}`,
        `  503   503 node worker --tag ${TAG_C}`].join('\n');
    };
    const tags = new Map([[1, TAG_A], [2, TAG_B], [3, TAG_C]]);
    // pgid'ы 501..503 не наши и не существуют → signalGroup ловит ESRCH и идёт дальше
    const out = killWorkers(tags, { ps, termWaitMs: 1, killWaitMs: 1 });
    expect(scans).toBe(3); // а не 9
    expect([...out.values()]).toEqual(['stuck', 'stuck', 'stuck']);
  });

  it('reports each worker on its own: absent, gone and stuck side by side', () => {
    let phase = 0;
    const ps: PsFn = () => {
      phase += 1;
      // A нет с самого начала; B исчезает после SIGTERM; C переживает всё
      const rows = [`  503   503 node worker --tag ${TAG_C}`];
      if (phase === 1) rows.push(`  502   502 node worker --tag ${TAG_B}`);
      return rows.join('\n');
    };
    const out = killWorkers(new Map([[1, TAG_A], [2, TAG_B], [3, TAG_C]]),
      { ps, termWaitMs: 1, killWaitMs: 1 });
    expect(out.get(1)).toBe('absent');
    expect(out.get(2)).toBe('gone');
    expect(out.get(3)).toBe('stuck');
  });

  it('an empty set does not touch ps at all', () => {
    let scans = 0;
    expect(killWorkers(new Map(), { ps: () => { scans += 1; return ''; } })).toEqual(new Map());
    expect(scans).toBe(0);
  });
});
