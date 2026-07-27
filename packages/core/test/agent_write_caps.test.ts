import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAPS, addTask, appendAgentEvent, checkpointWal, commentTask, listAgentEvents, moveTask,
  openDb, pruneAgentEvents, redact, runProduced, taskDetail,
} from '../src/index.js';

const user = { type: 'user' } as const;

function db() {
  const d = openDb(':memory:');
  addTask(d, { title: 't' }, user);
  return d;
}
const detailOf = (d: ReturnType<typeof db>, i = 0): Record<string, unknown> =>
  JSON.parse(listAgentEvents(d, 1)[i].detail!) as Record<string, unknown>;

// Смысл этих капов — не «аккуратность», а то, что фид воркера принимает сырой вывод
// инструментов в базу, которую шарят все worktree и которая уезжает в бэкап и export.
describe('write caps on agent_events.detail', () => {
  it('cuts a huge tool output down to the leaf cap', () => {
    const d = db();
    appendAgentEvent(d, 1, 'w', 'tool_finish', { detail: { output: 'x'.repeat(500_000) } });
    const row = listAgentEvents(d, 1)[0];
    expect(row.detail!.length).toBeLessThan(CAPS.agentFieldChars + 200);
    expect(detailOf(d).output).toMatch(/^x+… \[\+\d+ chars\]$/);
  });

  // #92 (инлайн-дифф в фиде) собирает дифф из input.old_string/new_string. Кап, который
  // выкидывает поля вместо того, чтобы резать длину, закрыл бы #46 и сломал бы фид.
  it('keeps the shape of a tool input, capping only the long leaves', () => {
    const d = db();
    appendAgentEvent(d, 1, 'w', 'tool_start', {
      name: 'Edit',
      detail: { id: 'tu_1', input: { file_path: 'a.ts', old_string: 'y'.repeat(99_999), new_string: 'z' } },
    });
    const input = detailOf(d).input as Record<string, string>;
    expect(detailOf(d).id).toBe('tu_1');
    expect(input.file_path).toBe('a.ts');
    expect(input.new_string).toBe('z');
    expect(input.old_string.length).toBeLessThan(CAPS.agentFieldChars + 200);
  });

  it('caps the number of content blocks', () => {
    const d = db();
    const blocks = Array.from({ length: 500 }, (_, i) => ({ type: 'text', text: `b${i}` }));
    appendAgentEvent(d, 1, 'w', 'tool_finish', { detail: { output: blocks } });
    // capped + маркер отброшенного хвоста
    expect((detailOf(d).output as unknown[]).length).toBe(CAPS.agentDetailItems + 1);
  });

  // Форма, пролезающая мимо капа листьев: тысячи коротких полей.
  it('falls back to the size alone when the whole detail is still too big', () => {
    const d = db();
    const wide = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`k${i}`, 'v']));
    appendAgentEvent(d, 1, 'w', 'text', { detail: wide });
    expect(Object.keys(detailOf(d))).toEqual(['truncated']);
    expect(listAgentEvents(d, 1)[0].detail!.length).toBeLessThan(100);
  });

  // Короткое остаётся ровно собой: кап не должен переписывать обычный фид.
  it('leaves an ordinary event untouched', () => {
    const d = db();
    appendAgentEvent(d, 1, 'w', 'run_start', { detail: { head: 'abc123' } });
    expect(detailOf(d)).toEqual({ head: 'abc123' });
    expect(runProduced(d, 1)).toBeNull(); // ран не закрыт — но detail дошёл целым
  });
});

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

  // Главное: редакция стоит ДО записи, а не при рендере — в файле базы секрета быть не должно.
  it('a tool output carrying a token never reaches the column', () => {
    const d = db();
    appendAgentEvent(d, 1, 'w', 'tool_finish', {
      detail: { output: 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
    });
    expect(listAgentEvents(d, 1)[0].detail).not.toContain('ghp_');
  });
});

describe('pruneAgentEvents', () => {
  // Задача «давно завершена»: срок отсчитывается от момента завершения, а не от возраста строк.
  const finishedLongAgo = (d: ReturnType<typeof db>) =>
    d.prepare(`UPDATE tasks SET updated_at = updated_at - ? WHERE id = 1`).run(30 * 86_400);

  it('drops the verbose feed of a finished task but keeps the run skeleton', () => {
    const d = db();
    appendAgentEvent(d, 1, 'w', 'run_start', { detail: { head: 'aaa' } });
    appendAgentEvent(d, 1, 'w', 'text', { detail: { text: 'thinking' } });
    appendAgentEvent(d, 1, 'w', 'tool_start', { name: 'Bash', detail: { input: { command: 'ls' } } });
    appendAgentEvent(d, 1, 'w', 'tool_finish', { detail: { output: 'a b c' } });
    appendAgentEvent(d, 1, 'w', 'run_end', { detail: { head: 'bbb', exitCode: 0 } });
    moveTask(d, 1, 'done', user);
    finishedLongAgo(d);

    expect(pruneAgentEvents(d)).toBe(3);
    expect(listAgentEvents(d, 1).map((r) => r.kind)).toEqual(['run_start', 'run_end']);
    // из скелета работает runProduced — #10 reset берёт оттуда before_head
    expect(runProduced(d, 1)).toEqual({ before: 'aaa', after: 'bbb', committed: true });
  });

  // Ревью: срок мерился по created_at события. Задача, которую вели три недели назад, а закрыли
  // сегодня, теряла весь фид первым же тиком — ровно когда человек садится его читать.
  it('counts the grace period from completion, not from when the events were written', () => {
    const d = db();
    const id = appendAgentEvent(d, 1, 'w', 'text', { detail: { text: 'three weeks of work' } });
    d.prepare(`UPDATE agent_events SET created_at = created_at - ? WHERE id = ?`).run(21 * 86_400, id);
    moveTask(d, 1, 'done', user); // закрыли ТОЛЬКО ЧТО

    expect(pruneAgentEvents(d)).toBe(0);
    expect(listAgentEvents(d, 1)).toHaveLength(1);
  });

  it('leaves a live task alone no matter how old its feed is', () => {
    const d = db();
    appendAgentEvent(d, 1, 'w', 'text', { detail: { text: 'x' } });
    moveTask(d, 1, 'in_progress', user);
    finishedLongAgo(d);
    expect(pruneAgentEvents(d)).toBe(0);
    expect(listAgentEvents(d, 1)).toHaveLength(1);
  });

  it('leaves a fresh feed alone even when the task is done', () => {
    const d = db();
    appendAgentEvent(d, 1, 'w', 'text', { detail: { text: 'x' } });
    moveTask(d, 1, 'done', user);
    expect(pruneAgentEvents(d)).toBe(0);
  });

  it('prunes an archived task the same way', () => {
    const d = db();
    appendAgentEvent(d, 1, 'w', 'text', { detail: { text: 'x' } });
    d.prepare(`UPDATE tasks SET archived_at = ? WHERE id = 1`).run(1);
    expect(pruneAgentEvents(d)).toBe(1);
  });

  // Ревью: без водяного знака tick каждую минуту перечитывал фиды всех завершённых задач,
  // чтобы удалить ноль строк — а перечитывание идёт через overflow-страницы detail.
  it('runs at most once a day', () => {
    const d = db();
    appendAgentEvent(d, 1, 'w', 'text', { detail: { text: 'a' } });
    moveTask(d, 1, 'done', user);
    finishedLongAgo(d);
    expect(pruneAgentEvents(d)).toBe(1);

    appendAgentEvent(d, 1, 'w', 'text', { detail: { text: 'b' } });
    expect(pruneAgentEvents(d)).toBe(0);          // спит до завтра
    expect(pruneAgentEvents(d, 7, { force: true })).toBe(1); // но не отказывается работать
  });

  // DELETE держит write-lock, а рядом фид пишут живые воркеры с busy_timeout в 5 секунд:
  // резать надо кусками, и остаток должен достаться следующему проходу, а не суткам сна.
  it('deletes in bounded batches and comes back for the rest', () => {
    const d = db();
    const ins = d.prepare(
      `INSERT INTO agent_events (task_id, worker_id, kind, detail, created_at) VALUES (1,'w','text','{}',?)`);
    d.transaction(() => { for (let i = 0; i < CAPS.agentPruneBatch + 10; i++) ins.run(1); })();
    moveTask(d, 1, 'done', user);
    finishedLongAgo(d);

    expect(pruneAgentEvents(d)).toBe(CAPS.agentPruneBatch);
    expect(pruneAgentEvents(d)).toBe(10); // водяной знак не поставлен — доедаем сразу
  });
});

// Авточекпоинт переиспользует место внутри WAL, но файл не уменьшает: у доски этого репо
// было 1.1M базы при 4.6M WAL. Проверяем на настоящем файле — на :memory: WAL не существует.
describe('checkpointWal', () => {
  it('shrinks the wal file that ordinary writes grew', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kdd-wal-'));
    const path = join(dir, 'kdd.db');
    const d = openDb(path, '/x/.git');
    addTask(d, { title: 't' }, user);
    for (let i = 0; i < 400; i++) {
      appendAgentEvent(d, 1, 'w', 'text', { detail: { text: 'x'.repeat(2_000) } });
    }
    const grown = statSync(`${path}-wal`).size;
    expect(grown).toBeGreaterThan(64 * 1024);

    checkpointWal(d);
    expect(statSync(`${path}-wal`).size).toBeLessThan(grown);
    // и данные на месте — чекпоинт сливает WAL в базу, а не выбрасывает его
    expect(listAgentEvents(d, 1, { limit: 1000 })).toHaveLength(400);
    d.close();
  });
});

// Все находки ревью по этому коммиту: каждая — про то, что кап или редакция ломали читателя
// или самого воркера, а не про аккуратность.
describe('review regressions', () => {
  // Редакция шла ДО капа, и env-регулярка откатывалась квадратично: 83K символов = 4.5s,
  // полмегабайта ≈ минуты — синхронно в колбэке readline супервизора, то есть остановленный
  // стрим и протухший под живым агентом lease.
  it('caps a huge uppercase blob fast instead of backtracking over it', () => {
    const d = db();
    const blob = 'A_LONG_UPPERCASE_RUN_'.repeat(25_000); // ~500K символов, ни одного пробела
    const t0 = Date.now();
    appendAgentEvent(d, 1, 'w', 'tool_finish', { detail: { output: blob } });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  // Кап листьев затевался ради #92 (дифф из input) — а fallback на переполнение выбрасывал
  // detail целиком вместе с id, по которому лента спаривает вызов с результатом.
  it('keeps the pairing id and isError when the detail overflows', () => {
    const d = db();
    const blocks = Array.from({ length: 200 }, () => ({ type: 'text', text: 'x'.repeat(4_000) }));
    appendAgentEvent(d, 1, 'w', 'tool_finish', { detail: { id: 'tu_42', isError: true, output: blocks } });
    const detail = detailOf(d);
    expect(detail.id).toBe('tu_42');
    expect(detail.isError).toBe(true);
    expect(detail.output).toHaveProperty('truncated');
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

  // Кап меряется в байтах: фид этого проекта наполовину кириллица, и .length занижал вдвое.
  it('measures the total cap in bytes, not in utf-16 units', () => {
    const d = db();
    // Ровно та щель, которую .length не видит: символов меньше капа, байт — вдвое больше.
    const cyr = Array.from({ length: 15 }, () => ({ type: 'text', text: 'я'.repeat(4_000) }));
    expect(JSON.stringify(cyr).length).toBeLessThan(CAPS.agentDetailBytes);
    appendAgentEvent(d, 1, 'w', 'text', { detail: { blocks: cyr } });
    expect(Buffer.byteLength(listAgentEvents(d, 1)[0].detail!, 'utf8'))
      .toBeLessThanOrEqual(CAPS.agentDetailBytes);
  });

  // Хвост массива резался молча, а лента склеивает text-блоки в один текст: человек читал
  // оборванный вывод как полный.
  it('marks the array tail it dropped', () => {
    const d = db();
    const blocks = Array.from({ length: 100 }, (_, i) => ({ type: 'text', text: `b${i}` }));
    appendAgentEvent(d, 1, 'w', 'tool_finish', { detail: { output: blocks } });
    const out = detailOf(d).output as { text: string }[];
    expect(out).toHaveLength(CAPS.agentDetailItems + 1);
    expect(out[out.length - 1].text).toBe(`… [+${100 - CAPS.agentDetailItems} items]`);
  });

  // Соседняя дверь: воркеру промптом велено оставить итоговый комментарий, и он шёл в ту же
  // базу мимо редакции фида.
  it('redacts a comment written by an agent, but not one written by a human', () => {
    const d = db();
    const leak = 'done, GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    commentTask(d, 1, leak, { type: 'ai', id: 'w1' });
    commentTask(d, 1, leak, user);
    const [byAgent, byHuman] = taskDetail(d, 1).comments;
    expect(byAgent.body).not.toContain('ghp_');
    expect(byHuman.body).toBe(leak);
  });
});
