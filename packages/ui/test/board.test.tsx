// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Board } from '../src/web/components/Board';
import { STATUSES, type Board as BoardData, type Status, type Task } from '../src/web/api';

const task = (over: Partial<Task> = {}): Task => ({
  id: 1, title: 'do a thing', body: null, status: 'new', blocked: 0, block_reason: null,
  priority: 'medium', kind: 'feature', area: null, track_id: null, ready: 1,
  criteria_checked: 0, criteria_total: 0, created_at: 0, updated_at: 0, ...over,
});

const board = (t: Task): BoardData => {
  const b = Object.fromEntries(STATUSES.map((s) => [s, []])) as unknown as BoardData;
  b[t.status as Status].push(t);
  return b;
};

const show = (t: Task) => render(
  <Board board={board(t)} trackName={new Map()} onMove={vi.fn()} onOpen={vi.fn()} />);

afterEach(cleanup);

// #87: за одну сессию об это споткнулись трижды. Задача без критериев лежит в new, выглядит
// готовой — а claimNext её не видит, и авто-тик молча рапортует spawned 0.
describe('«no criteria» marker', () => {
  it('is on a ready card with zero criteria', () => {
    show(task());
    expect(screen.getByText('no criteria')).toBeTruthy();
  });

  it('is gone as soon as a criterion is added', () => {
    show(task({ criteria_total: 1 }));
    expect(screen.queryByText('no criteria')).toBeNull();
    expect(screen.getByText('0/1')).toBeTruthy(); // на его месте обычный счётчик критериев
  });

  // У заблокированной своя пометка, и агент её и так не возьмёт — вторая рядом была бы шумом.
  it('is not shown on a blocked card', () => {
    show(task({ blocked: 1, ready: 0 }));
    expect(screen.queryByText('no criteria')).toBeNull();
    expect(screen.getByText('blocked')).toBeTruthy();
  });

  // Доделанная задача без критериев — не проблема: агент не должен её брать.
  it('is not shown outside the ready queue', () => {
    show(task({ status: 'done', ready: 0 }));
    expect(screen.queryByText('no criteria')).toBeNull();
  });

  // READY_SQL (core/queries.ts) теперь исключает kind='research' тем же условием, что
  // CLAIMABLE_SQL — сервер никогда не отдаёт research с ready=1, значит эта карточка (new,
  // не blocked, не archived) реально приходит с ready=0, и условие бейджа (task.ready === 1)
  // само гасит его без отдельного kind-исключения на клиенте.
  it('is not shown on a new research card even with zero criteria', () => {
    show(task({ kind: 'research', ready: 0, criteria_total: 0 }));
    expect(screen.queryByText('no criteria')).toBeNull();
  });
});

// research лежит в new и выглядит готовой, но ready теперь честно 0 (READY_SQL её исключает) —
// единственная подсказка о том, что агент её не возьмёт, это сам kind-бейдж.
describe('research kind badge', () => {
  it('warns that an agent will never take it', () => {
    show(task({ kind: 'research', ready: 0, criteria_total: 1, criteria_checked: 0 }));
    expect(screen.getByTitle('an agent will never pick up this task')).toBeTruthy();
  });
});

// Исходная жалоба: «понять где баг, а где задача, сложно». Бейдж — единственное место,
// где это видно без открытия карточки.
describe('kind badge', () => {
  it('names a bug on the card', () => {
    show(task({ kind: 'bug' }));
    expect(screen.getByText('bug')).toBeTruthy();
  });

  it('names a chore and a research task too', () => {
    show(task({ kind: 'chore' }));
    expect(screen.getByText('chore')).toBeTruthy();
    cleanup();
    show(task({ kind: 'research' }));
    expect(screen.getByText('research')).toBeTruthy();
  });

  // Дефолт молчит намеренно: 84 задачи, заведённые до типизации, получили 'feature' от
  // миграции. Нарисовать его — значит заставить доску уверенно утверждать то, чего никто
  // не выбирал.
  it('says nothing about a feature — the silent default', () => {
    show(task({ kind: 'feature' }));
    expect(screen.queryByText('feature')).toBeNull();
  });
});
