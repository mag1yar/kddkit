import { useEffect, useRef, useState } from 'react';
import { Minus, Plus, Timer } from 'lucide-react';
import type { AutoTickState } from '../api';
import { Button } from './ui/button';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from './ui/field';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from './ui/input-group';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Separator } from './ui/separator';
import { Spinner } from './ui/spinner';
import { Switch } from './ui/switch';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';

// Подписи короткие намеренно: четыре сегмента должны уместиться в ширину поповера.
const INTERVALS: { value: number; label: string }[] = [
  { value: 30, label: '30s' }, { value: 60, label: '1m' },
  { value: 300, label: '5m' }, { value: 900, label: '15m' },
];

const MIN_WORKERS = 1;
const MAX_WORKERS = 10;

const label = (sec: number): string => INTERVALS.find((i) => i.value === sec)?.label ?? `${sec}s`;

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

type Health = 'off' | 'running' | 'error' | 'stuck' | 'armed';

function healthOf(s: AutoTickState): Health {
  if (s.running) return 'running';
  if (!s.enabled) return 'off';
  if (s.last?.error) return 'error';
  // stuck — не счётчик прошлого прохода, а состояние ПРЯМО СЕЙЧАС: воркер не умер ни от
  // SIGTERM, ни от SIGKILL и до сих пор занимает слот. Проход при этом «успешен», поэтому
  // без своего состояния индикатор горел бы зелёным над застрявшей доской.
  if (s.last?.stuck) return 'stuck';
  return 'armed';
}

const DOT: Record<Health, string> = {
  off: 'bg-muted-foreground/40',
  running: 'bg-primary',
  error: 'bg-destructive',
  stuck: 'bg-destructive',
  armed: 'bg-primary',
};

const HEADLINE: Record<Health, string> = {
  off: 'Off', running: 'Running…', error: 'Last run failed',
  stuck: 'Worker will not die', armed: 'Idle',
};

// Вторая строка статуса — что было в прошлый проход. Ошибка вытесняет цифры: если проход
// упал, «spawned 0» — не новость, а причина падения новость.
function detailOf(s: AutoTickState): string {
  if (!s.last) return 'never run';
  const ago = `${human(Date.now() / 1000 - s.last.at)} ago`;
  if (s.last.error) return s.last.error;
  if (s.last.skipped) return `${ago} · skipped, another tick was running`;
  // killed показываем только когда есть что показать: ноль убитых — норма, а не новость.
  const killed = s.last.killed ? `, killed ${s.last.killed}` : '';
  // stuck — не цифра в ряду, а диагноз: слот занят процессом, который пережил SIGKILL, и
  // сам он не освободится. Поэтому словами и первым, а не хвостом после «active N».
  const stuck = s.last.stuck
    ? `${s.last.stuck} worker${s.last.stuck > 1 ? 's' : ''} survived SIGKILL and still hold`
      + `${s.last.stuck > 1 ? '' : 's'} a slot · ` : '';
  return `${stuck}${ago} · spawned ${s.last.spawned}, active ${s.last.active}${killed}`;
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

  // Строки статуса производны от Date.now(), а state приезжает раз в 5с (poll). Без
  // собственного тикера отсчёт двигался бы рывками по 5 секунд, а на интервалах от минуты
  // выглядел бы застывшим. Тикаем только пока поповер открыт: закрытый этих строк не
  // показывает, а лишние перерисовки доски задаром никому не нужны.
  const [, bump] = useState(0);
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => bump((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [open]);

  // Отсчёт дошёл до нуля — проход идёт прямо сейчас, но узнать об этом можно только с
  // сервера. Ждать очередного полла (5с) значит держать «0 s» мёртвой строкой, а потом
  // показать «next 25 s» на тридцатисекундном интервале: пять секунд утекли, пока никто
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

  const health = healthOf(state);
  const due = state.nextAt !== null && state.nextAt - Date.now() / 1000 <= 0;

  // Кламп вместо ошибки валидации: диапазон замкнутый, и «ввёл 25 — получил 10» честнее
  // красной строки, после которой в поле остаётся значение, которого на сервере нет.
  const commitWorkers = (n: number): void => {
    const clamped = Math.min(MAX_WORKERS, Math.max(MIN_WORKERS, Math.round(n)));
    setWorkersText(String(clamped));
    if (clamped !== state.maxWorkers) patch({ maxWorkers: clamped });
  };

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
            <Timer data-icon="inline-start" />
            {state.enabled ? `Auto · ${label(state.intervalSec)}` : 'Auto'}
            {/* Здоровье планировщика видно, не открывая поповер — ради ночного режима,
                где смотрят на доску мельком и не кликают. */}
            {state.enabled && (state.running
              ? <Spinner data-icon="inline-end" className="size-3" />
              : <span data-icon="inline-end" className={`size-1.5 rounded-full ${DOT[health]}`} />)}
          </Button>
        }
      />
      <PopoverContent align="end" sideOffset={4} className="w-72 gap-0 p-0">
        <div className="flex flex-col gap-1 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-sm font-medium">
              {state.running
                ? <Spinner className="size-3.5 text-muted-foreground" />
                : <span className={`size-2 rounded-full ${DOT[health]}`} />}
              {HEADLINE[health]}
            </span>
            {state.enabled && !state.running && state.nextAt !== null && (
              // tabular-nums: посекундный отсчёт иначе дёргает строку на каждой смене цифры.
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {due ? 'due now' : `next ${countdown(state.nextAt - Date.now() / 1000)}`}
              </span>
            )}
          </div>
          <p className={`text-xs ${health === 'error' || health === 'stuck'
            ? 'text-destructive' : 'text-muted-foreground'}`}>
            {detailOf(state)}
          </p>
        </div>

        <Separator />

        <FieldGroup className="gap-4 p-3">
          <Field orientation="horizontal">
            <FieldLabel htmlFor="autotick-enabled">Auto-tick</FieldLabel>
            <Switch
              id="autotick-enabled"
              checked={state.enabled}
              onCheckedChange={(checked) => patch({ enabled: checked })}
            />
          </Field>

          {/* Интервал НЕ запираем за тумблером: это сохранённая настройка, а не орган
              управления живым процессом. Иначе «поставить минуту» превращается в танец
              включи → поменяй → выключи. Что планировщик стоит, сказано словом Off наверху. */}
          <Field>
            <FieldLabel>Every</FieldLabel>
            <ToggleGroup
              className="w-full"
              value={[String(state.intervalSec)]}
              // Base UI отдаёт массив и разрешает снять последний выбранный — пустой
              // означает «ткнул в активный сегмент», а не «выбрал ничего».
              onValueChange={(v) => { if (v.length) patch({ intervalSec: Number(v[0]) }); }}
            >
              {INTERVALS.map((i) => (
                <ToggleGroupItem
                  key={i.value} value={String(i.value)}
                  variant="outline" size="sm" className="flex-1"
                >
                  {i.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>

          <Field orientation="horizontal">
            <FieldLabel htmlFor="autotick-workers">Max workers</FieldLabel>
            <InputGroup className="w-28">
              <InputGroupAddon align="inline-start">
                {/* На границе диапазона кнопку НЕ дизейблим: InputGroup красит серым весь
                    контрол, стоит одному ребёнку стать disabled (has-disabled:opacity-50), и
                    при max workers = 1 весь степпер выглядел бы выключенным. Клик по краю
                    просто упирается в кламп. */}
                <InputGroupButton
                  aria-label="one fewer worker"
                  disabled={state.maxWorkersEnvLocked}
                  onClick={() => commitWorkers(state.maxWorkers - 1)}
                >
                  <Minus />
                </InputGroupButton>
              </InputGroupAddon>
              <InputGroupInput
                id="autotick-workers"
                type="number" min={MIN_WORKERS} max={MAX_WORKERS}
                // Родные стрелки браузера прячем: рядом уже стоят свои −/+, и на фокусе
                // в поле оказывалось два комплекта органов управления сразу.
                className="text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                disabled={state.maxWorkersEnvLocked}
                value={workersText}
                onFocus={() => { setWorkersFocused(true); clearError(); }}
                onChange={(e) => setWorkersText(e.currentTarget.value)}
                onBlur={(e) => {
                  setWorkersFocused(false); // снятие фокуса возвращает буфер к серверному значению
                  const n = Number(e.currentTarget.value.trim());
                  // Пустое поле (человек стёр число, чтобы набрать новое) даёт Number('') === 0 —
                  // это не правка, а её начало: молча откатываем к серверному значению.
                  if (!Number.isFinite(n) || n === 0) { setWorkersText(String(state.maxWorkers)); return; }
                  commitWorkers(n);
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  aria-label="one more worker"
                  disabled={state.maxWorkersEnvLocked}
                  onClick={() => commitWorkers(state.maxWorkers + 1)}
                >
                  <Plus />
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </Field>
          {state.maxWorkersEnvLocked
            ? <FieldDescription>overridden by KDD_MAX_WORKERS</FieldDescription>
            : <FieldDescription>also applies to kdd tick in the terminal</FieldDescription>}
          {error && <FieldError>{error}</FieldError>}
        </FieldGroup>
      </PopoverContent>
    </Popover>
  );
}
