import {
  KINDS, PRIORITIES, STATUSES, type Board, type Kind, type Priority, type Task, type Track,
} from './api';

// area IS NULL — тоже значение фильтра (таких задач на доске 9), но пустая строка в CSV
// неотличима от «параметр пуст». Сентинел с '~' не может быть настоящим area: они slug-и.
export const NO_AREA = '~none';

// Не поля задачи, а состояния, которые уже рисуют бейджи на карточке. Держим их теми же
// предикатами (см. matchTask), чтобы фильтр и карточка не могли разойтись.
export const FILTER_STATES = ['ready', 'no_criteria'] as const;
export type FilterState = (typeof FILTER_STATES)[number];

export interface Filters {
  q: string;
  track: number[];
  area: string[]; // NO_AREA — задача без area
  kind: Kind[];
  priority: Priority[];
  state: FilterState[];
}

// Ключи фильтра в URL. Один источник для «стереть эти параметры» — используется и при
// сохранении фильтра в адресную строку, и при переходе на другой проект (там их надо снять,
// а не унести с собой: track id — per-database, на новой доске он ничей).
export const FILTER_KEYS = ['q', 'track', 'area', 'kind', 'priority', 'state'] as const;

// Ссылка на другой проект без фильтра текущего. Отдельная функция (а не инлайн в App.tsx),
// чтобы это было проверяемо: window.location.assign нельзя подменить в jsdom (unforgeable),
// а чистую функцию — можно.
export function stripFilterKeys(href: string): string {
  const q = new URLSearchParams(href);
  for (const key of FILTER_KEYS) q.delete(key);
  return `?${q.toString()}`;
}

export const EMPTY_FILTERS: Filters = {
  q: '', track: [], area: [], kind: [], priority: [], state: [],
};

const values = (p: URLSearchParams, key: string): string[] =>
  p.getAll(key).filter((s) => s.length > 0);

const only = <T extends string>(vocab: readonly T[], raw: string[]): T[] =>
  raw.filter((s): s is T => (vocab as readonly string[]).includes(s));

export function parseFilters(p: URLSearchParams): Filters {
  return {
    q: p.get('q') ?? '',
    track: values(p, 'track').map(Number).filter((n) => Number.isInteger(n) && n > 0),
    area: values(p, 'area'),
    kind: only(KINDS, values(p, 'kind')),
    priority: only(PRIORITIES, values(p, 'priority')),
    state: only(FILTER_STATES, values(p, 'state')),
  };
}

// Повторяющийся ключ, а не CSV: area — свободный текст, и запятая в имени области
// на CSV разъезжается в два значения, которых никто не выбирал. getAll/append
// снимает класс целиком и кода требует меньше, чем split/join.
export function serializeFilters(f: Filters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set('q', f.q);
  for (const id of f.track) p.append('track', String(id));
  for (const a of f.area) p.append('area', a);
  for (const k of f.kind) p.append('kind', k);
  for (const pr of f.priority) p.append('priority', pr);
  for (const s of f.state) p.append('state', s);
  return p;
}

export const isActive = (f: Filters): boolean =>
  f.q.trim() !== '' || f.track.length > 0 || f.area.length > 0
  || f.kind.length > 0 || f.priority.length > 0 || f.state.length > 0;

// Ровно то, что рисуют бейджи карточки: ready — очередь агента, no_criteria — задача,
// которая выглядит готовой, а claimNext её не возьмёт.
const STATE_PREDICATE: Record<FilterState, (t: Task) => boolean> = {
  ready: (t) => t.ready === 1,
  no_criteria: (t) => t.ready === 1 && t.criteria_total === 0,
};

export function matchTask(t: Task, f: Filters): boolean {
  if (f.kind.length && !f.kind.includes(t.kind)) return false;
  if (f.priority.length && !f.priority.includes(t.priority)) return false;
  if (f.track.length && (t.track_id === null || !f.track.includes(t.track_id))) return false;
  if (f.area.length && !f.area.includes(t.area ?? NO_AREA)) return false;
  if (f.state.length && !f.state.some((s) => STATE_PREDICATE[s](t))) return false;
  const q = f.q.trim().toLowerCase();
  if (!q) return true;
  // Поиск набирают по букве: '1' обязан показать и 1, и 11, иначе доска мигает не тем,
  // пока дойдёшь до нужного номера. Поэтому голое число — префикс id, а решётка сужает
  // до точного совпадения: '#1' — это «именно первая». Заголовок ищется всегда, независимо
  // от id: '12' остаётся подстрокой и находит «bump node 12».
  const exact = q.startsWith('#');
  const digits = exact ? q.slice(1) : q;
  if (/^\d+$/.test(digits)) {
    const id = String(t.id);
    if (exact ? id === digits : id.startsWith(digits)) return true;
  }
  return t.title.toLowerCase().includes(q);
}

// Треки для выбора значения: закрытый не предлагают, но текущий показывают всегда —
// иначе у задачи в закрытом треке Select рисует пустоту вместо имени.
export const trackOptions = (tracks: Track[], keep: number | null): Track[] =>
  tracks.filter((t) => t.status === 'active' || t.id === keep);

// Суффикс ' (done)' — везде, где трек называют по имени (фасет, оба диалога задачи), одно
// правило, а не три копии одной строки.
export const trackLabel = (t: Track): string => (t.status === 'done' ? `${t.name} (done)` : t.name);

export function applyFilters(board: Board, f: Filters): Board {
  if (!isActive(f)) return board; // без фильтра не пересобираем доску: ссылка та же → нет лишних ререндеров
  return Object.fromEntries(
    STATUSES.map((s) => [s, board[s].filter((t) => matchTask(t, f))]),
  ) as Board;
}

/**
 * Порядок колонки для сервера при активном фильтре.
 * Опорой служит видимая карточка, под которой окажется перетаскиваемая; скрытые сохраняют
 * своё относительное положение, куда бы ни бросили.
 */
export function orderWithHidden(
  fullIds: number[], visibleIds: number[], id: number, overIndex: number,
): number[] {
  const rest = fullIds.filter((x) => x !== id);
  const vis = visibleIds.filter((x) => x !== id);
  const i = Math.min(Math.max(overIndex, 0), vis.length);
  let at: number;
  if (i < vis.length) at = rest.indexOf(vis[i]);              // перед видимым соседом
  else if (vis.length) {
    const last = rest.indexOf(vis[vis.length - 1]);           // сразу за последней видимой
    at = last < 0 ? -1 : last + 1;                            // -1 → страховка ниже
  } else at = rest.length;                                    // видимых нет — в конец колонки
  if (at < 0) at = rest.length; // опора исчезла между рендером и дропом — не вставляем вслепую
  const out = [...rest];
  out.splice(at, 0, id);
  return out;
}
