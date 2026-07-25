import { useEffect, useRef, useState } from 'react';
import { Timer } from 'lucide-react';
import type { AutoTickState } from '../api';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

const INTERVALS: { value: number; label: string }[] = [
  { value: 30, label: '30 s' }, { value: 60, label: '1 min' },
  { value: 300, label: '5 min' }, { value: 900, label: '15 min' },
];

const label = (sec: number): string => INTERVALS.find((i) => i.value === sec)?.label ?? `${sec} s`;

// Таймстемпы приходят в секундах, как везде в kdd.
function human(deltaSec: number): string {
  const d = Math.max(0, Math.round(deltaSec));
  if (d < 60) return `${d} s`;
  if (d < 3600) return `${Math.round(d / 60)} min`;
  return `${Math.round(d / 3600)} h`;
}

// Обратный отсчёт печатаем посекундно, а не через human(): та округляет до минут, и на
// 15-минутном интервале строка стояла бы неподвижно по полминуты подряд — отсчёт, который
// не отсчитывает, читается как зависший планировщик.
function countdown(deltaSec: number): string {
  const d = Math.max(0, Math.round(deltaSec));
  if (d < 60) return `${d} s`;
  return `${Math.floor(d / 60)}:${String(d % 60).padStart(2, '0')}`;
}

function lastLine(s: AutoTickState): string {
  if (!s.last) return 'last: never';
  const ago = `${human(Date.now() / 1000 - s.last.at)} ago`;
  if (s.last.error) return `last: ${ago} — ${s.last.error}`;
  if (s.last.skipped) return `last: ${ago} — skipped, another tick was running`;
  return `last: ${ago} · spawned ${s.last.spawned}, active ${s.last.active}`;
}

export function AutoTickPopover(
  { state, patch, refresh, error, clearError }: {
    state: AutoTickState | null;
    patch: (b: Partial<Pick<AutoTickState, 'enabled' | 'intervalSec' | 'maxWorkers'>>) => void;
    refresh: () => void;
    error: string | null;
    clearError: () => void;
  },
): React.ReactElement | null {
  // Буфер поля max workers живёт отдельно от state, пока в фокусе: иначе poll
  // (5с) или чужая правка (второй таб) стирают то, что человек ещё печатает.
  // Вне фокуса буфер всегда следует за сервером — в т.ч. откатывается сюда,
  // если PATCH отклонён, потому что state.maxWorkers в этом случае не менялся.
  const [workersText, setWorkersText] = useState('');
  const [workersFocused, setWorkersFocused] = useState(false);
  useEffect(() => {
    if (state && !workersFocused) setWorkersText(String(state.maxWorkers));
  }, [state?.maxWorkers, workersFocused]);

  // Open держим сами не ради вида, а чтобы знать момент закрытия: Escape размонтирует
  // содержимое, а onBlur для размонтированного узла React не шлёт — без этого флаг
  // «в фокусе» остаётся поднятым навсегда, буфер перестаёт следовать за сервером, и поле
  // до перезагрузки страницы показывает число, которого на сервере нет.
  const [open, setOpen] = useState(false);

  // Обе нижние строки — производные от Date.now(), а state приезжает раз в 5с (poll).
  // Без собственного тикера отсчёт двигался бы рывками по 5 секунд, а на интервалах от
  // минуты выглядел бы застывшим. Тикаем только пока поповер открыт: закрытый этих строк
  // не показывает, а лишние перерисовки доски задаром никому не нужны.
  const [, bump] = useState(0);
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => bump((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [open]);

  // Отсчёт дошёл до нуля — проход идёт прямо сейчас, но узнать об этом можно только с
  // сервера. Ждать очередного полла (5с) значит держать «0 s» мёртвой строкой, а потом
  // показать «next: in 25 s» на тридцатисекундном интервале: пять секунд утекли, пока никто
  // не спрашивал. Спрашиваем сразу и ровно один раз на каждый nextAt — на следующий проход
  // приедет новый, и запрос повторится уже для него.
  const dueAt = state?.enabled && !state.running ? state.nextAt : null;
  const refreshedFor = useRef<number | null>(null);
  useEffect(() => {
    if (dueAt === null || dueAt > Date.now() / 1000) return;
    if (refreshedFor.current === dueAt) return;
    refreshedFor.current = dueAt;
    refresh();
  });

  if (!state) return null;

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setWorkersFocused(false); }}>
      <PopoverTrigger
        render={
          <Button
            size="sm"
            variant={state.enabled ? 'secondary' : 'ghost'}
            className={state.enabled ? undefined : 'text-muted-foreground'}
            title="Auto-tick: run kdd tick on a schedule"
          >
            <Timer className="size-3.5" />
            {state.enabled ? `Auto · ${label(state.intervalSec)}` : 'Auto'}
          </Button>
        }
      />
      <PopoverContent align="end" sideOffset={4} className="w-72 gap-3 p-3">
        <Label className="cursor-pointer">
          <Checkbox
            checked={state.enabled}
            onCheckedChange={(checked) => patch({ enabled: Boolean(checked) })}
          />
          Auto-tick
        </Label>

        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-muted-foreground">Every</span>
          <Select
            value={String(state.intervalSec)}
            onValueChange={(v) => patch({ intervalSec: Number(v) })}
          >
            <SelectTrigger size="sm" className="w-28">
              <SelectValue>{(v) => label(Number(v))}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {INTERVALS.map((i) => (
                <SelectItem key={i.value} value={String(i.value)}>{i.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-muted-foreground">Max workers</span>
          <Input
            type="number" min={1} max={10} className="w-28"
            disabled={state.maxWorkersEnvLocked}
            value={workersText}
            onFocus={() => { setWorkersFocused(true); clearError(); }}
            onChange={(e) => setWorkersText(e.currentTarget.value)}
            onBlur={(e) => {
              setWorkersFocused(false); // снятие фокуса возвращает буфер к серверному значению
              const raw = e.currentTarget.value.trim();
              const n = Number(raw);
              // Пустое поле (человек стёр число, чтобы набрать новое) даёт Number('') === 0 —
              // это не правка, а её начало: молча откатываем к серверному значению вместо
              // PATCH'а нулём и красной ошибки валидации, которой человек не заслужил.
              if (raw === '' || !Number.isInteger(n)) return;
              if (n !== state.maxWorkers) patch({ maxWorkers: n });
            }}
          />
        </div>
        {state.maxWorkersEnvLocked && (
          <p className="text-xs text-muted-foreground">overridden by KDD_MAX_WORKERS</p>
        )}

        <div className="border-t pt-2 text-xs text-muted-foreground">
          <p>{lastLine(state)}</p>
          <p>
            {/* во время прохода nextAt смотрит в прошлое: показывать «in 0 s» — врать */}
            {state.running
              ? 'running now…'
              : state.enabled && state.nextAt !== null
                ? state.nextAt - Date.now() / 1000 <= 0
                  ? 'due now…' // проход стартовал; running приедет ответом на refresh выше
                  : `next: in ${countdown(state.nextAt - Date.now() / 1000)}`
                : 'next: —'}
          </p>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </PopoverContent>
    </Popover>
  );
}
