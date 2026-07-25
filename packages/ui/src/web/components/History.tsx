import {
  Archive, ArchiveRestore, ArrowRight, Ban, Bot, CircleCheck, CircleX, Dot, Link2, ListMinus,
  ListPlus, Lock, MessageSquare, Pencil, Plus, RefreshCw, RotateCcw, Square, SquareCheck,
  TriangleAlert, Unlock,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { groupHistory, type HistoryGroup, type HistoryRow } from '../lib/history';
import type { EventRow } from '../api';
import { Badge } from './ui/badge';

type Icon = typeof Dot;
const ICONS: Record<string, Icon> = {
  created: Plus, edited: Pencil, moved: ArrowRight, commented: MessageSquare,
  blocked: Ban, unblocked: CircleCheck, linked: Link2,
  archived: Archive, unarchived: ArchiveRestore,
  criterion_added: ListPlus, criterion_removed: ListMinus,
  criterion_checked: SquareCheck, criterion_unchecked: Square,
  claim: Lock, claimed: Lock, claim_renewed: RefreshCw, claim_rejected: CircleX,
  reclaimed: RotateCcw, released: Unlock, warn: TriangleAlert,
};

const fmtTime = (ts: number) => new Date(ts * 1000).toLocaleTimeString();
// Год печатаем только чужой: у задачи, прожитой один день, «2026» в каждом разделителе — шум.
const fmtDay = (ts: number) => {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString(undefined, d.getFullYear() === new Date().getFullYear()
    ? { day: 'numeric', month: 'long' }
    : { day: 'numeric', month: 'long', year: 'numeric' });
};

function Row({ row, showTime }: { row: HistoryRow; showTime: boolean }) {
  const I = ICONS[row.action] ?? Dot;
  return (
    // Колонки, а не flex-строка: время фиксированной ширины и таб-цифрами держит левый край,
    // иначе длинный текст растаскивает соседей и лента идёт лесенкой.
    <div className="grid grid-cols-[4.5rem_0.875rem_1fr] items-start gap-x-2 py-px">
      <span className="pt-0.5 text-right font-mono text-[11px] tabular-nums text-muted-foreground/60">
        {showTime ? fmtTime(row.at) : ''}
      </span>
      <I className={cn(
        'mt-0.5 size-3.5',
        row.level === 'error' ? 'text-destructive'
          : row.level === 'warn' ? 'text-amber-600 dark:text-amber-500'
            : 'text-muted-foreground/70',
      )} />
      <span className={cn(
        'text-sm break-words',
        row.level === 'error' && 'text-destructive',
        row.level === 'warn' && 'text-amber-700 dark:text-amber-500',
        // lease-бухгалтерия не изменение задачи: видна, но не спорит за внимание с moved/checked
        row.level === 'info' && row.mechanical && 'text-muted-foreground',
      )}>
        {row.text}
        {row.count > 1 && <span className="ml-1 font-mono text-[11px] text-muted-foreground/70">×{row.count}</span>}
      </span>
    </div>
  );
}

function Group({ group }: { group: HistoryGroup }) {
  const ai = group.actorType === 'ai';
  return (
    <div className="flex flex-col">
      {/* Актор один раз на пачку: воркер пишет подряд по десятку событий, и его
          id, повторённый в каждой строке, занимал треть ширины и рвался переносом. */}
      <div className="flex items-center gap-1.5 pb-0.5 pl-[5.375rem] text-xs text-muted-foreground">
        {ai && <Bot className="size-3" />}
        <span className="truncate font-medium">{ai ? (group.actorId ?? 'ai') : 'user'}</span>
      </div>
      {group.rows.map((r, i) => (
        // Время печатаем, когда оно изменилось: четыре критерия, добавленные одной командой,
        // делят одну секунду — четыре одинаковых штампа не говорят ничего.
        <Row key={r.id} row={r} showTime={i === 0 || fmtTime(r.at) !== fmtTime(group.rows[i - 1].at)} />
      ))}
    </div>
  );
}

export function History({ events }: { events: EventRow[] }) {
  if (!events.length) return <p className="text-sm text-muted-foreground">no history</p>;
  const days = groupHistory(events);
  return (
    <ol className="flex flex-col gap-3">
      {days.map((day) => (
        <li key={day.key} className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">{fmtDay(day.at)}</span>
            <span className="h-px flex-1 bg-border" />
          </div>
          {day.groups.map((g) => <Group key={g.id} group={g} />)}
        </li>
      ))}
    </ol>
  );
}
