import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTERS, NO_AREA, applyFilters, isActive, matchTask, orderWithHidden, parseFilters,
  serializeFilters, stripFilterKeys, trackLabel, trackOptions, type Filters,
} from '../src/web/filters';
import { STATUSES, type Board, type Task, type Track } from '../src/web/api';

const parse = (s: string) => parseFilters(new URLSearchParams(s));

describe('parseFilters', () => {
  it('reads every facet from the query string', () => {
    const f = parse('q=воркер&track=3&track=4&area=ui&area=core&kind=bug&priority=high&state=ready');
    expect(f).toEqual({
      q: 'воркер', track: [3, 4], area: ['ui', 'core'],
      kind: ['bug'], priority: ['high'], state: ['ready'],
    } satisfies Filters);
  });

  it('is empty when the query string is', () => {
    expect(parse('')).toEqual(EMPTY_FILTERS);
    expect(parse('project=94a99e3bba1c50dd')).toEqual(EMPTY_FILTERS);
  });

  // Ссылку правят руками и присылают из чата — мусор в параметре обязан сузить фильтр,
  // а не уронить доску.
  it('drops values outside the vocabulary instead of throwing', () => {
    const f = parse('kind=bug&kind=nonsense&priority=extreme&state=ready&state=whatever'
      + '&track=abc&track=0&track=-2&track=5');
    expect(f.kind).toEqual(['bug']);
    expect(f.priority).toEqual([]);
    expect(f.state).toEqual(['ready']);
    expect(f.track).toEqual([5]);
  });

  it('keeps the no-area sentinel', () => {
    expect(parse(`area=${NO_AREA}&area=ui`).area).toEqual([NO_AREA, 'ui']);
  });
});

describe('serializeFilters', () => {
  it('round-trips a full filter', () => {
    const f: Filters = {
      q: 'воркер', track: [3], area: ['ui', NO_AREA],
      kind: ['bug', 'chore'], priority: ['high'], state: ['no_criteria'],
    };
    expect(parseFilters(serializeFilters(f))).toEqual(f);
  });

  it('emits no key for an empty facet', () => {
    expect([...serializeFilters(EMPTY_FILTERS).keys()]).toEqual([]);
    expect([...serializeFilters({ ...EMPTY_FILTERS, kind: ['bug'] })]).toEqual([['kind', 'bug']]);
  });
});

// Ревью: смена проекта тащила ?q=/?track=... за собой — track id per-database, новая доска
// показывала "0 / N" без причины. Свою фильтрацию каждый проект собирает заново.
describe('stripFilterKeys', () => {
  it('drops every filter param but keeps project and token', () => {
    const out = stripFilterKeys('?project=new&token=s3cret&q=воркер&track=1&track=2&kind=bug');
    const q = new URLSearchParams(out);
    expect(q.get('project')).toBe('new');
    expect(q.get('token')).toBe('s3cret');
    expect(q.has('q')).toBe(false);
    expect(q.has('track')).toBe(false);
    expect(q.has('kind')).toBe(false);
  });

  it('is a no-op when there is nothing to strip', () => {
    expect(stripFilterKeys('?project=abc')).toBe('?project=abc');
  });
});

describe('isActive', () => {
  it('is false for the empty filter and for whitespace-only search', () => {
    expect(isActive(EMPTY_FILTERS)).toBe(false);
    expect(isActive({ ...EMPTY_FILTERS, q: '   ' })).toBe(false);
  });

  it('is true as soon as any facet has a value', () => {
    expect(isActive({ ...EMPTY_FILTERS, q: 'x' })).toBe(true);
    expect(isActive({ ...EMPTY_FILTERS, area: [NO_AREA] })).toBe(true);
    expect(isActive({ ...EMPTY_FILTERS, track: [1] })).toBe(true);
  });
});

const task = (over: Partial<Task> = {}): Task => ({
  id: 1, title: 'do a thing', body: null, status: 'new', blocked: 0, block_reason: null,
  priority: 'medium', kind: 'feature', area: null, track_id: null, ready: 1,
  criteria_checked: 0, criteria_total: 0, created_at: 0, updated_at: 0, ...over,
});

const f = (over: Partial<Filters> = {}): Filters => ({ ...EMPTY_FILTERS, ...over });

describe('matchTask', () => {
  it('matches everything when no facet is set', () => {
    expect(matchTask(task(), EMPTY_FILTERS)).toBe(true);
  });

  // ИЛИ внутри фасета: второе значение расширяет выборку, а не обнуляет её.
  it('is OR within one facet', () => {
    const filter = f({ kind: ['bug', 'chore'] });
    expect(matchTask(task({ kind: 'bug' }), filter)).toBe(true);
    expect(matchTask(task({ kind: 'chore' }), filter)).toBe(true);
    expect(matchTask(task({ kind: 'feature' }), filter)).toBe(false);
  });

  // И между фасетами: «баги в ui», а не «баги или всё из ui».
  it('is AND across facets', () => {
    const filter = f({ kind: ['bug'], area: ['ui'] });
    expect(matchTask(task({ kind: 'bug', area: 'ui' }), filter)).toBe(true);
    expect(matchTask(task({ kind: 'bug', area: 'core' }), filter)).toBe(false);
    expect(matchTask(task({ kind: 'feature', area: 'ui' }), filter)).toBe(false);
  });

  it('matches a task with no area only through the sentinel', () => {
    expect(matchTask(task({ area: null }), f({ area: [NO_AREA] }))).toBe(true);
    expect(matchTask(task({ area: 'ui' }), f({ area: [NO_AREA] }))).toBe(false);
    expect(matchTask(task({ area: null }), f({ area: ['ui'] }))).toBe(false);
  });

  it('filters by track, including tasks with no track', () => {
    expect(matchTask(task({ track_id: 3 }), f({ track: [3] }))).toBe(true);
    expect(matchTask(task({ track_id: null }), f({ track: [3] }))).toBe(false);
  });

  // Те же два предиката, что рисуют бейджи на карточке (Board.tsx).
  it('filters by state', () => {
    expect(matchTask(task({ ready: 1 }), f({ state: ['ready'] }))).toBe(true);
    expect(matchTask(task({ ready: 0 }), f({ state: ['ready'] }))).toBe(false);
    expect(matchTask(task({ ready: 1, criteria_total: 0 }), f({ state: ['no_criteria'] }))).toBe(true);
    expect(matchTask(task({ ready: 1, criteria_total: 2 }), f({ state: ['no_criteria'] }))).toBe(false);
    expect(matchTask(task({ ready: 0, criteria_total: 0 }), f({ state: ['no_criteria'] }))).toBe(false);
  });

  it('searches the title case-insensitively', () => {
    expect(matchTask(task({ title: 'Воркер молча умирает' }), f({ q: 'воркер' }))).toBe(true);
    expect(matchTask(task({ title: 'Воркер молча умирает' }), f({ q: 'ВОРКЕР' }))).toBe(true);
    expect(matchTask(task({ title: 'что-то другое' }), f({ q: 'воркер' }))).toBe(false);
  });

  // Голое число — префикс id: поиск набирают по букве, и '1' обязан показать 1 и 11 разом,
  // иначе доска мигает не тем, пока дойдёшь до номера.
  it('searches by id prefix when the number is bare', () => {
    expect(matchTask(task({ id: 1, title: 'x' }), f({ q: '1' }))).toBe(true);
    expect(matchTask(task({ id: 11, title: 'x' }), f({ q: '1' }))).toBe(true);
    expect(matchTask(task({ id: 11, title: 'x' }), f({ q: '11' }))).toBe(true);
    expect(matchTask(task({ id: 21, title: 'x' }), f({ q: '1' }))).toBe(false); // префикс, не подстрока
    // id — не единственный способ совпасть: число в заголовке тоже считается.
    expect(matchTask(task({ id: 7, title: 'bump node 12' }), f({ q: '12' }))).toBe(true);
  });

  // Решётка — способ сказать «именно эта задача», иначе '#1' был бы неотличим от '1'.
  it('narrows to an exact id when the number carries a hash', () => {
    expect(matchTask(task({ id: 1, title: 'x' }), f({ q: '#1' }))).toBe(true);
    expect(matchTask(task({ id: 11, title: 'x' }), f({ q: '#1' }))).toBe(false);
    expect(matchTask(task({ id: 12, title: 'x' }), f({ q: '#12' }))).toBe(true);
  });

  it('ignores surrounding whitespace in the search', () => {
    expect(matchTask(task({ title: 'do a thing' }), f({ q: '  thing  ' }))).toBe(true);
  });
});

describe('applyFilters', () => {
  const board = (tasks: Task[]): Board => {
    const b = Object.fromEntries(STATUSES.map((s) => [s, [] as Task[]])) as Board;
    for (const t of tasks) b[t.status].push(t);
    return b;
  };

  it('keeps only matching tasks in each column', () => {
    const b = board([
      task({ id: 1, kind: 'bug', status: 'new' }),
      task({ id: 2, kind: 'feature', status: 'new' }),
      task({ id: 3, kind: 'bug', status: 'done', ready: 0 }),
    ]);
    const out = applyFilters(b, f({ kind: ['bug'] }));
    expect(out.new.map((t) => t.id)).toEqual([1]);
    expect(out.done.map((t) => t.id)).toEqual([3]);
    expect(out.review).toEqual([]);
  });

  it('returns the same board object when nothing is filtered', () => {
    const b = board([task()]);
    expect(applyFilters(b, EMPTY_FILTERS)).toBe(b);
  });
});

describe('URL contract', () => {
  // area — свободный текст (ядро пишет input.area дословно), так что запятая в имени легальна.
  // На CSV такое имя разъезжалось на два значения, ни одно из которых не совпадало ни с чем.
  it('round-trips an area whose name contains a comma', () => {
    const f = { ...EMPTY_FILTERS, area: ['ui, web'] };
    expect(parseFilters(serializeFilters(f)).area).toEqual(['ui, web']);
  });

  it('reads repeated parameters as one multi-value facet', () => {
    expect(parseFilters(new URLSearchParams('area=ui&area=core')).area).toEqual(['ui', 'core']);
    expect(parseFilters(new URLSearchParams('track=3&track=4')).track).toEqual([3, 4]);
  });

  // Для фасета «ключ отсутствует», «ключ пустой» и «пустой массив» — одно и то же:
  // нет ограничения. Фильтра «не совпадает ничто» в этом UI нет.
  it('treats a present-but-empty key as no constraint', () => {
    expect(parseFilters(new URLSearchParams('area=&kind='))).toEqual(EMPTY_FILTERS);
    expect(serializeFilters(EMPTY_FILTERS).toString()).toBe('');
  });
});

describe('orderWithHidden', () => {
  // Без фильтра видимый список равен полному — старое поведение обязано сохраниться.
  it('reorders inside one column like a plain move', () => {
    expect(orderWithHidden([1, 2, 3], [1, 2, 3], 1, 2)).toEqual([2, 3, 1]);
    expect(orderWithHidden([1, 2, 3], [1, 2, 3], 3, 0)).toEqual([3, 1, 2]);
  });

  it('inserts a card from another column at the drop index', () => {
    expect(orderWithHidden([1, 2], [1, 2], 9, 1)).toEqual([1, 9, 2]);
    expect(orderWithHidden([1, 2], [1, 2], 9, 2)).toEqual([1, 2, 9]);
  });

  // Ядро задачи: 20 и 30 скрыты фильтром. Дроп между видимыми 1 и 2 не должен их трогать.
  it('lands before the visible neighbour and keeps hidden cards where they were', () => {
    expect(orderWithHidden([1, 20, 2, 30], [1, 2], 9, 1)).toEqual([1, 20, 9, 2, 30]);
  });

  it('lands right after the last visible card, not at the end of the column', () => {
    expect(orderWithHidden([1, 2, 30, 40], [1, 2], 9, 2)).toEqual([1, 2, 9, 30, 40]);
  });

  it('appends when the whole destination column is filtered out', () => {
    expect(orderWithHidden([10, 20], [], 9, 0)).toEqual([10, 20, 9]);
  });

  it('clamps a drop index outside the visible list', () => {
    expect(orderWithHidden([1, 2], [1, 2], 9, 99)).toEqual([1, 2, 9]);
    expect(orderWithHidden([1, 2], [1, 2], 9, -3)).toEqual([9, 1, 2]);
  });

  // Комментарий в функции обещает: опора исчезла между рендером и дропом — карточка уходит
  // в конец колонки, не наверх. В ветке «за последней видимой» страховка не срабатывала:
  // indexOf(...) + 1 даёт 0 для отсутствующего id, а ловят там только отрицательное.
  it('appends when the last visible anchor is gone from the full list', () => {
    expect(orderWithHidden([1, 2, 3], [9], 3, 5)).toEqual([1, 2, 3]);
  });
});

const track = (over: Partial<Track> = {}): Track => ({
  id: 1, name: 'agent mode', description: null, status: 'active', open_tasks: 2, ...over,
});

describe('trackOptions', () => {
  it('drops closed tracks', () => {
    const rows = trackOptions([track(), track({ id: 2, name: 'релиз 0.6', status: 'done' })], null);
    expect(rows.map((t) => t.id)).toEqual([1]);
  });

  // Задача внутри закрытого трека обязана показывать свой трек: иначе Select рисует пустоту
  // там, где у задачи есть значение, и «нет трека» неотличимо от «трек закрыт».
  it('keeps a closed track that is the current value', () => {
    const rows = trackOptions([track(), track({ id: 2, name: 'релиз 0.6', status: 'done' })], 2);
    expect(rows.map((t) => t.id)).toEqual([1, 2]);
  });
});

describe('trackLabel', () => {
  it('keeps the bare name for an active track, and adds exactly " (done)" for a closed one', () => {
    expect(trackLabel(track())).toBe('agent mode');
    expect(trackLabel(track({ name: 'релиз 0.6', status: 'done' }))).toBe('релиз 0.6 (done)');
  });
});
