import { useEffect, useRef } from 'react';
import { Plus, Search, Settings, Trash2, Check, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
  EMPTY_FILTERS, FILTER_STATES, NO_AREA, isActive, trackLabel, type Filters,
} from '../filters';
import { KINDS, PRIORITIES, STATUSES, type Board, type Track } from '../api';

interface Option { value: string; label: string; count?: number }

// Значения одного фасета: тумблер по клику, порядок сохраняется — фильтр в URL стабилен.
const toggle = <T extends string | number>(list: T[], v: T): T[] =>
  list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

function FacetChip({
  name, options, selected, onToggle, loading = false, children, orphanLabel = (v) => v,
}: {
  name: string;
  options: Option[];
  selected: string[];
  onToggle: (value: string) => void;
  loading?: boolean; // список ещё не загружен — «нет такого значения» пока неизвестно
  children?: React.ReactNode; // подвал поповера (например «New track…»)
  // Как назвать значение, для которого нет строки в options (см. ниже). По умолчанию — само
  // значение; area подставляет свой резолвер, чтобы сирота не рисовала сентинел '~none'.
  // FacetChip остаётся общим — про области он ничего не знает.
  orphanLabel?: (value: string) => string;
}) {
  const label = selected.length
    ? `${name}: ${selected.map((v) => options.find((o) => o.value === v)?.label ?? orphanLabel(v)).join(', ')}`
    : name;
  // Выбранное значение может исчезнуть из списка (трек закрыли, у области кончились задачи),
  // а из фильтра — нет: чип показывает выбор, снять который нечем, и доска молча показывает
  // 0 / N. Держим строку для каждого такого значения — снять его должно быть можно там же,
  // где выбрали, а не только через Clear.
  const rows: Option[] = loading ? options : [
    ...selected.filter((v) => !options.some((o) => o.value === v))
      .map((v) => ({ value: v, label: orphanLabel(v) })),
    ...options,
  ];
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            size="sm" variant={selected.length ? 'default' : 'outline'}
            className="max-w-64 justify-start truncate"
          >
            {label}
          </Button>
        }
      />
      <PopoverContent align="start" className="w-56 gap-0.5 p-1">
        {rows.length === 0 && (
          <span className="px-2 py-1.5 text-xs text-muted-foreground">nothing to filter by</span>
        )}
        {rows.map((o) => (
          // Не <label>: Base UI Checkbox всегда держит рядом со span[role=checkbox] скрытый
          // нативный <input>, и родной <label> неявно связывает текст с ОБОИМИ — getByLabelText
          // находит два элемента. div + явный aria-label на Checkbox оставляют один.
          <div
            key={o.value}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
            // Base UI Checkbox на мышином клике сам жмёт preventDefault на span[role=checkbox]
            // и синтетически передёргивает click на скрытый input рядом (нативная семантика
            // формы) — тот же клик доходит сюда двумя bubbling-событиями, span и input.
            // На Space/Enter с фокуса на чекбоксе событие на span вообще не летит — useButton
            // зовёт тот же обработчик напрямую, и до строки долетает только событие с input.
            // Значит именно input — единственный источник, который есть всегда (мышь и
            // клавиатура); span же при мышином клике — гарантированный дубликат. Игнорируем
            // клик, если он произошёл внутри span[role=checkbox] (сам чекбокс или иконка
            // внутри него), берём всё остальное — включая input и пустое место строки.
            onClick={(e) => {
              if ((e.target as HTMLElement).closest('[role="checkbox"]')) return;
              onToggle(o.value);
            }}
          >
            {/* presentational: checked отражает filters, а не собственное состояние. */}
            <Checkbox
              aria-label={o.label}
              checked={selected.includes(o.value)}
            />
            <span className="min-w-0 flex-1 truncate">{o.label}</span>
            {o.count != null && <span className="text-xs text-muted-foreground">{o.count}</span>}
          </div>
        ))}
        {children}
      </PopoverContent>
    </Popover>
  );
}

// area не словарь, а данные: значения и их частота берутся из самой доски, чтобы в фильтре
// не висели области, которых на доске нет.
function areaOptions(board: Board): Option[] {
  const count = new Map<string, number>();
  for (const s of STATUSES) {
    for (const t of board[s]) {
      const key = t.area ?? NO_AREA;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, n]) => ({ value, label: areaLabel(value), count: n }));
}

// Одно правило подписи area — строка нужна и списку, и осиротевшей строке чипа.
const areaLabel = (v: string): string => (v === NO_AREA ? '(no area)' : v);

const STATE_LABEL: Record<(typeof FILTER_STATES)[number], string> = {
  ready: 'ready', no_criteria: 'no criteria',
};

export function FilterBar({
  filters, onChange, board, visibleCount, totalCount, tracks,
  onNewTrack, onTrackDone, onTrackDelete,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  board: Board;
  visibleCount: number;
  totalCount: number;
  tracks: Track[] | null;
  onNewTrack: () => void;
  onTrackDone: (id: number) => void;
  onTrackDelete: (id: number) => void;
}) {
  const search = useRef<HTMLInputElement>(null);
  const active = isActive(filters);
  const oneTrack = filters.track.length === 1 ? filters.track[0] : null;

  // '/' — фокус в поиск, Esc — очистить его. Не перехватываем, когда пользователь уже печатает
  // (поле задачи, диалог): иначе '/' пропадал бы из текста.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Уступаем объявленной модалке, а не угадываем по DOM: Base UI вешает role="dialog"
      // и на Popover.Popup, так что по роли гвард ловил заодно каждый фасет и поповеры
      // шапки. data-slot="dialog-content" ставит только DialogContent — все три модалки
      // идут через него, ни один поповер туда не попадает.
      if (document.querySelector('[data-slot="dialog-content"]')) return;
      // Клавишу, которую уже обработал вложенный контрол, забирать нельзя.
      if (e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        || el?.isContentEditable === true;
      if (e.key === '/' && !typing) { e.preventDefault(); search.current?.focus(); }
      if (e.key === 'Escape' && el === search.current) onChange({ ...filters, q: '' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filters, onChange]);

  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={search} value={filters.q} placeholder="Search…" aria-label="Search tasks"
          className="h-8 w-56 pl-7"
          onChange={(e) => onChange({ ...filters, q: e.target.value })}
        />
      </div>

      <FacetChip
        name="Track" selected={filters.track.map(String)} loading={tracks === null}
        // Закрытый трек в списке не нужен, но выбранный — обязателен: фильтр должен уметь
        // назвать то, по чему фильтрует. Суффикс (done) — пометка устаревания, не удаление.
        options={(tracks ?? [])
          .filter((t) => t.status === 'active' || filters.track.includes(t.id))
          .map((t) => ({
            value: String(t.id),
            label: trackLabel(t),
            count: t.open_tasks,
          }))}
        onToggle={(v) => onChange({ ...filters, track: toggle(filters.track, Number(v)) })}
      >
        <Button size="sm" variant="ghost" className="w-full justify-start" onClick={onNewTrack}>
          <Plus className="size-3.5" /> New track
        </Button>
      </FacetChip>

      {oneTrack !== null && (
        <Popover>
          <PopoverTrigger
            render={<Button size="sm" variant="outline" aria-label="Track actions"><Settings className="size-3.5" /></Button>}
          />
          <PopoverContent align="start" className="w-44 gap-1 p-1">
            <Button size="sm" variant="ghost" className="w-full justify-start" onClick={() => onTrackDone(oneTrack)}>
              <Check className="size-3.5" /> Mark done
            </Button>
            <Button
              size="sm" variant="ghost"
              className="w-full justify-start text-destructive hover:text-destructive"
              onClick={() => onTrackDelete(oneTrack)}
            >
              <Trash2 className="size-3.5" /> Delete track
            </Button>
          </PopoverContent>
        </Popover>
      )}

      <FacetChip
        name="Area" selected={filters.area} options={areaOptions(board)}
        orphanLabel={areaLabel}
        onToggle={(v) => onChange({ ...filters, area: toggle(filters.area, v) })}
      />
      <FacetChip
        name="Kind" selected={filters.kind}
        options={KINDS.map((k) => ({ value: k, label: k }))}
        onToggle={(v) => onChange({ ...filters, kind: toggle(filters.kind, v as Filters['kind'][number]) })}
      />
      <FacetChip
        name="Priority" selected={filters.priority}
        options={PRIORITIES.map((p) => ({ value: p, label: p }))}
        onToggle={(v) => onChange({ ...filters, priority: toggle(filters.priority, v as Filters['priority'][number]) })}
      />
      <FacetChip
        name="State" selected={filters.state}
        options={FILTER_STATES.map((s) => ({ value: s, label: STATE_LABEL[s] }))}
        onToggle={(v) => onChange({ ...filters, state: toggle(filters.state, v as Filters['state'][number]) })}
      />

      {active && (
        <div className="ml-auto flex items-center gap-2">
          <Badge variant="outline" className={cn('rounded-sm', visibleCount === 0 && 'text-destructive')}>
            {visibleCount} / {totalCount}
          </Badge>
          <Button size="sm" variant="ghost" onClick={() => onChange(EMPTY_FILTERS)}>
            <X className="size-3.5" /> Clear
          </Button>
        </div>
      )}
    </div>
  );
}
