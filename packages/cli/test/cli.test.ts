import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '@kddkit/core';
import { makeEnv, kdd, kddFail } from './run.js';

let env: NodeJS.ProcessEnv;
beforeEach(() => { env = makeEnv(); });

describe('kdd add / board / show', () => {
  it('add prints #id, board shows columns, show prints detail', () => {
    expect(kdd(env, 'add', 'Первая задача', '--priority', 'high', '--area', 'договор'))
      .toContain('#1 created');
    const board = kdd(env, 'board');
    expect(board).toContain('new (1)');
    expect(board).toContain('#1 Первая задача [high] @договор');
    const show = kdd(env, 'show', '#1');
    expect(show).toContain('#1 Первая задача');
    expect(show).toContain('status: new');
  });

  it('--json returns machine-readable objects', () => {
    kdd(env, 'add', 'x');
    const out = JSON.parse(kdd(env, 'show', '1', '--json'));
    expect(out.task).toMatchObject({ id: 1, title: 'x' });
  });

  it('errors are one line on stderr with exit 1', () => {
    const r = kddFail(env, 'show', '#99');
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe('error: task #99 not found');
  });

  it('ai actor is recorded in events', () => {
    kdd({ ...env, KDD_ACTOR: 'ai', KDD_SESSION: 's7' }, 'add', 'от ии');
    const out = JSON.parse(kdd(env, 'show', '1', '--json'));
    expect(out.events[0]).toMatchObject({ actor_type: 'ai', actor_id: 's7' });
  });
});

// #34: доска из будущего (user_version больше, чем знает этот kdd). Раньше цикл миграций просто
// не выполнялся и kdd молча работал на незнакомой схеме — тихая порча данных. Проверяем не сам
// гвард (это тест ядра), а что человек в терминале видит внятную строку, а не голый стектрейс.
describe('a board from a newer kdd', () => {
  it('refuses to open, one readable line on stderr', () => {
    kdd(env, 'add', 'x');
    const db = openDb(env.KDD_DB as string);
    db.pragma('user_version = 99');
    db.close();

    const r = kddFail(env, 'board');
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^error: board at .* has schema v99, this kdd only knows v\d+/m);
    expect(r.stderr).not.toMatch(/\n\s+at /); // строка, а не кадры стека
  });
});

// #60: раньше `kdd ui` слушал все интерфейсы молча. Теперь выход за loopback — осознанный
// флаг, и без секрета он не проходит: голая доска в общей сети это чужие руки на кнопке
// «удалить», плюс список абсолютных путей всех проектов машины.
describe('kdd ui --host', () => {
  it('refuses a non-loopback bind without a token', () => {
    const r = kddFail({ ...env, KDD_UI_TOKEN: undefined }, 'ui', '--host', '0.0.0.0');
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--host 0\.0\.0\.0 exposes the board .*--token/);
  });
});
