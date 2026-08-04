// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FilterBar } from '../src/web/components/FilterBar';
import { EMPTY_FILTERS, NO_AREA, type Filters } from '../src/web/filters';
import { STATUSES, type Board, type Task, type Track } from '../src/web/api';

const task = (over: Partial<Task> = {}): Task => ({
  id: 1, title: 'do a thing', body: null, status: 'new', blocked: 0, block_reason: null,
  priority: 'medium', kind: 'feature', area: null, track_id: null, ready: 1,
  criteria_checked: 0, criteria_total: 0, created_at: 0, updated_at: 0, ...over,
});

const board = (tasks: Task[]): Board => {
  const b = Object.fromEntries(STATUSES.map((s) => [s, [] as Task[]])) as Board;
  for (const t of tasks) b[t.status].push(t);
  return b;
};

const show = (
  filters: Filters, onChange = vi.fn(), visible = 3, total = 22,
  tracks: Track[] | null = [],
) => {
  render(
    <FilterBar
      filters={filters} onChange={onChange} board={board([task({ area: 'ui' }), task({ id: 2, area: 'core' })])}
      visibleCount={visible} totalCount={total} tracks={tracks}
      onNewTrack={vi.fn()} onTrackDone={vi.fn()} onTrackDelete={vi.fn()}
    />,
  );
  return onChange;
};

afterEach(cleanup);

describe('FilterBar', () => {
  // Невидимый активный фильтр — классическая жалоба «задача пропала с доски».
  it('shows the counter and Clear only while a filter is active', () => {
    show(EMPTY_FILTERS);
    expect(screen.queryByText('3 / 22')).toBeNull();
    expect(screen.queryByRole('button', { name: /clear/i })).toBeNull();
    cleanup();
    show({ ...EMPTY_FILTERS, kind: ['bug'] });
    expect(screen.getByText('3 / 22')).toBeTruthy();
    expect(screen.getByRole('button', { name: /clear/i })).toBeTruthy();
  });

  it('names its selection on the chip', () => {
    show({ ...EMPTY_FILTERS, area: ['ui', 'core'] });
    expect(screen.getByRole('button', { name: 'Area: ui, core' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Kind' })).toBeTruthy(); // незатронутый фасет молчит
  });

  it('Clear resets every facet and the search', () => {
    const onChange = show({ q: 'воркер', track: [1], area: ['ui'], kind: ['bug'], priority: ['high'], state: ['ready'] });
    fireEvent.click(screen.getByRole('button', { name: /clear/i }));
    expect(onChange).toHaveBeenCalledWith(EMPTY_FILTERS);
  });

  it('typing in the search reports the new filter', () => {
    const onChange = show(EMPTY_FILTERS);
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'воркер' } });
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_FILTERS, q: 'воркер' });
  });

  it('toggling a facet value adds it, toggling again removes it', () => {
    const onChange = show(EMPTY_FILTERS);
    fireEvent.click(screen.getByRole('button', { name: 'Kind' }));
    fireEvent.click(screen.getByLabelText('bug'));
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_FILTERS, kind: ['bug'] });
    cleanup();
    const onChange2 = show({ ...EMPTY_FILTERS, kind: ['bug'] });
    fireEvent.click(screen.getByRole('button', { name: 'Kind: bug' }));
    fireEvent.click(screen.getByLabelText('bug'));
    expect(onChange2).toHaveBeenCalledWith(EMPTY_FILTERS);
  });

  // Ревью: строка опции несла hover:bg-accent, но реагировал только чекбокс — обещание
  // клика, которое не принималось. Клик по самому чекбоксу бабблится на onClick строки;
  // проверяем, что переключение срабатывает ровно один раз, а не дважды.
  it('toggles once whether you click the row or the checkbox itself', () => {
    const onChange = show(EMPTY_FILTERS);
    fireEvent.click(screen.getByRole('button', { name: 'Kind' }));
    fireEvent.click(screen.getByLabelText('bug'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_FILTERS, kind: ['bug'] });
  });

  it('toggles when the row is clicked outside the checkbox too', () => {
    const onChange = show(EMPTY_FILTERS);
    fireEvent.click(screen.getByRole('button', { name: 'Kind' }));
    fireEvent.click(screen.getByText('bug'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_FILTERS, kind: ['bug'] });
  });

  // Регрессия найденная ре-ревью: на Space useButton зовёт обработчик чекбокса напрямую,
  // без bubbling-события на span — до строки долетает только событие с input. Прошлый фильтр
  // (tagName !== 'INPUT') резал именно его и гасил тумблер с клавиатуры целиком. Enter не
  // проверяем: нативный чекбокс на Enter не переключается вообще (это форм-сабмит), тумблер
  // на Enter не должен срабатывать ни в старом, ни в новом коде — проверено отдельно на голом
  // Checkbox с оригинальным onCheckedChange, до этой правки.
  it('toggles once from the keyboard (Space), same as a click', () => {
    const onChange = show(EMPTY_FILTERS);
    fireEvent.click(screen.getByRole('button', { name: 'Kind' }));
    const checkbox = screen.getByLabelText('bug');
    checkbox.focus();
    fireEvent.keyDown(checkbox, { key: ' ' });
    fireEvent.keyUp(checkbox, { key: ' ' });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_FILTERS, kind: ['bug'] });
  });

  // Диалог поверх доски: '/' не должен красть фокус у его полей, Esc не должен трогать поиск.
  it('ignores / and Esc while a dialog is open', () => {
    render(<div data-slot="dialog-content"><input /></div>);
    const onChange = show({ ...EMPTY_FILTERS, q: 'воркер' });
    const search = screen.getByPlaceholderText('Search…') as HTMLInputElement;

    search.focus();
    fireEvent.keyDown(window, { key: 'Escape' }); // без гварда очистил бы q
    expect(onChange).not.toHaveBeenCalled();

    search.blur();
    fireEvent.keyDown(window, { key: '/' }); // без гварда увёл бы фокус в поиск за модалкой
    expect(document.activeElement).not.toBe(search);
  });

  // Ревью: гвард ловил любой [role="dialog"], а Base UI вешает эту роль и на Popover.Popup —
  // '/' переставал работать, пока открыт любой фасет, ReleasesPopover или AutoTickPopover.
  it('still focuses the search while a facet popover is open', () => {
    show(EMPTY_FILTERS);
    fireEvent.click(screen.getByRole('button', { name: 'Kind' }));
    const search = screen.getByPlaceholderText('Search…');
    fireEvent.keyDown(window, { key: '/' });
    expect(document.activeElement).toBe(search);
  });

  // Вложенный контрол, который уже обработал клавишу, владеет ею.
  it('yields the key when something already handled it', () => {
    show(EMPTY_FILTERS);
    const search = screen.getByPlaceholderText('Search…');
    // fireEvent.keyDown({ defaultPrevented: true }) не работает: defaultPrevented — не часть
    // KeyboardEventInit, конструктор события молча игнорирует лишнее поле. Ставим флаг по-настоящему.
    const event = new KeyboardEvent('keydown', { key: '/', cancelable: true, bubbles: true });
    event.preventDefault();
    fireEvent(window, event);
    expect(document.activeElement).not.toBe(search);
  });

  // Действие над треком требует одного трека: при множественном выборе анкера нет.
  it('offers track actions only when exactly one track is selected', () => {
    render(
      <FilterBar
        filters={{ ...EMPTY_FILTERS, track: [1] }} onChange={vi.fn()} board={board([task()])}
        visibleCount={1} totalCount={1} tracks={[{ id: 1, name: 'agent mode', description: null, status: 'active', open_tasks: 2 }]}
        onNewTrack={vi.fn()} onTrackDone={vi.fn()} onTrackDelete={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Track actions' })).toBeTruthy();
    cleanup();
    render(
      <FilterBar
        filters={{ ...EMPTY_FILTERS, track: [1, 2] }} onChange={vi.fn()} board={board([task()])}
        visibleCount={1} totalCount={1} tracks={[
          { id: 1, name: 'agent mode', description: null, status: 'active', open_tasks: 2 },
          { id: 2, name: 'ui', description: null, status: 'active', open_tasks: 1 },
        ]}
        onNewTrack={vi.fn()} onTrackDone={vi.fn()} onTrackDelete={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Track actions' })).toBeNull();
  });

  // Ревью: агент закрывает трек → /api/tracks его больше не отдаёт → чип показывает «Track: 7»,
  // строки в поповере нет, доска 0 / N, а снять фильтр можно только Clear, теряя остальные
  // фасеты. Неразрешимое значение хранится и помечается, а не роняется молча.
  it('keeps a row for a selected value that left the options list', () => {
    const onChange = show({ ...EMPTY_FILTERS, track: [7] }, vi.fn(), 0, 22, []);
    fireEvent.click(screen.getByRole('button', { name: 'Track: 7' }));
    fireEvent.click(screen.getByText('7'));
    expect(onChange).toHaveBeenCalledWith(EMPTY_FILTERS);
  });

  it('names a closed track and marks it done', () => {
    const tracks: Track[] = [
      { id: 1, name: 'agent mode', description: null, status: 'active', open_tasks: 2 },
      { id: 7, name: 'релиз 0.6', description: null, status: 'done', open_tasks: 0 },
    ];
    show({ ...EMPTY_FILTERS, track: [7] }, vi.fn(), 0, 22, tracks);
    expect(screen.getByRole('button', { name: 'Track: релиз 0.6 (done)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Track: релиз 0.6 (done)' }));
    expect(screen.getByLabelText('релиз 0.6 (done)')).toBeTruthy();
    expect(screen.getByLabelText('agent mode')).toBeTruthy(); // активные на месте
  });

  it('hides a closed track that is not selected', () => {
    const tracks: Track[] = [
      { id: 1, name: 'agent mode', description: null, status: 'active', open_tasks: 2 },
      { id: 7, name: 'релиз 0.6', description: null, status: 'done', open_tasks: 0 },
    ];
    show(EMPTY_FILTERS, vi.fn(), 3, 22, tracks);
    fireEvent.click(screen.getByRole('button', { name: 'Track' }));
    expect(screen.queryByLabelText('релиз 0.6 (done)')).toBeNull();
  });

  // «Ещё не загружено» — не «такого трека нет»: до первого ответа /api/tracks сирота
  // не рисуется, иначе список мигает значением, которое вот-вот получит имя.
  it('draws no orphan row while the tracks are still loading', () => {
    show({ ...EMPTY_FILTERS, track: [7] }, vi.fn(), 0, 22, null);
    fireEvent.click(screen.getByRole('button', { name: 'Track: 7' }));
    expect(screen.queryByLabelText('7')).toBeNull();
  });

  // Ревью: орфанная строка Area рисовала сырой сентинел '~none' вместо '(no area)' — тот же
  // баг, что и с треком, но area раскрывает свой internal-only сентинел, а не id.
  it('resolves the area orphan sentinel to its label, not the raw value', () => {
    show({ ...EMPTY_FILTERS, area: [NO_AREA] }, vi.fn(), 0, 22, []);
    expect(screen.getByRole('button', { name: 'Area: (no area)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Area: (no area)' }));
    expect(screen.getByLabelText('(no area)')).toBeTruthy();
    expect(screen.queryByLabelText(NO_AREA)).toBeNull();
    expect(screen.queryByText(NO_AREA)).toBeNull();
  });
});
