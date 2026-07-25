import { useEffect, useState } from 'react';
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

function lastLine(s: AutoTickState): string {
  if (!s.last) return 'last: never';
  const ago = `${human(Date.now() / 1000 - s.last.at)} ago`;
  if (s.last.error) return `last: ${ago} — ${s.last.error}`;
  if (s.last.skipped) return `last: ${ago} — skipped, another tick was running`;
  return `last: ${ago} · spawned ${s.last.spawned}, active ${s.last.active}`;
}

export function AutoTickPopover(
  { state, patch, error, clearError }: {
    state: AutoTickState | null;
    patch: (b: Partial<Pick<AutoTickState, 'enabled' | 'intervalSec' | 'maxWorkers'>>) => void;
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

  if (!state) return null;

  return (
    <Popover>
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
              setWorkersFocused(false);
              const n = Number(e.currentTarget.value);
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
            {state.enabled && state.nextAt !== null
              ? `next: in ${human(state.nextAt - Date.now() / 1000)}`
              : 'next: —'}
          </p>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </PopoverContent>
    </Popover>
  );
}
