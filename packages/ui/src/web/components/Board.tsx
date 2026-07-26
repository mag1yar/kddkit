import { arrayMove } from '@dnd-kit/sortable';
import { ListChecks, ListX } from 'lucide-react';
import {
  Kanban, KanbanBoard, KanbanColumn, KanbanColumnContent, KanbanItem,
  KanbanItemHandle, KanbanOverlay, type KanbanMoveEvent,
} from '@/components/reui/kanban';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { STATUSES, type Board as BoardData, type Priority, type Status, type Task } from '../api';

const PRIORITY_VARIANT: Record<Priority, 'default' | 'secondary' | 'destructive' | 'outline'> =
  { urgent: 'destructive', high: 'default', medium: 'secondary', low: 'outline' };

const COLUMN_TITLE: Record<Status, string> = {
  backlog: 'Backlog', new: 'New', in_progress: 'In Progress', review: 'Review', done: 'Done',
};

export function Board({ board, trackName, onMove, onOpen }: {
  board: BoardData;
  trackName: Map<number, string>;
  onMove: (taskId: number, to: Status, order: number[]) => void;
  onOpen: (id: number) => void;
}) {
  const byId = (id: string) =>
    STATUSES.flatMap((s) => board[s]).find((t) => String(t.id) === id);

  const handleMove = (
    { activeContainer, overContainer, activeIndex, overIndex, event }: KanbanMoveEvent,
  ) => {
    const id = Number(event.active.id);
    const to = overContainer as Status;
    const destIds = board[to].map((t) => t.id);
    // Итоговый порядок колонки-назначения: reorder внутри → arrayMove; из другой → вставка по индексу.
    const order = activeContainer === overContainer
      ? arrayMove(destIds, activeIndex, overIndex)
      : (destIds.splice(Math.min(Math.max(overIndex, 0), destIds.length), 0, id), destIds);
    if (activeContainer === overContainer && activeIndex === overIndex) return; // ничего не двигали
    onMove(id, to, order);
  };

  return (
    <Kanban
      value={board}
      onValueChange={() => {}} // состояние доски ведёт App (оптимистично + рефетч), не local reorder
      getItemValue={(t) => String(t.id)}
      onMove={handleMove}
    >
      <KanbanBoard className="flex items-start gap-4 p-4">
        {STATUSES.map((s) => (
          <Column key={s} status={s} tasks={board[s]} trackName={trackName} onOpen={onOpen} />
        ))}
      </KanbanBoard>
      <KanbanOverlay>
        {({ value }) => {
          const t = byId(String(value));
          return t
            ? <div className="w-64"><TaskCard task={t} trackName={trackName} onOpen={onOpen} /></div>
            : null;
        }}
      </KanbanOverlay>
    </Kanban>
  );
}

function Column({ status, tasks, trackName, onOpen }: {
  status: Status; tasks: Task[]; trackName: Map<number, string>; onOpen: (id: number) => void;
}) {
  // Колонки семантические (backlog…done) — без drag: не рендерим KanbanColumnHandle.
  // disabled НЕ ставим: dnd-kit disabled вырубает и drop → пустая колонка перестаёт принимать карточки.
  return (
    <KanbanColumn value={status} className="w-64 shrink-0 rounded-xl bg-muted/40 p-2 ring-1 ring-foreground/10">
      <div className="flex items-center justify-between px-1.5 py-1">
        <span className="text-sm font-semibold">{COLUMN_TITLE[status]}</span>
        <Badge variant="outline" className="rounded-sm">{tasks.length}</Badge>
      </div>
      <KanbanColumnContent value={status} className="min-h-8 gap-2 p-0.5">
        {tasks.map((t) => (
          <TaskCard key={t.id} task={t} trackName={trackName} onOpen={onOpen} asHandle />
        ))}
      </KanbanColumnContent>
    </KanbanColumn>
  );
}

function TaskCard({ task, trackName, onOpen, asHandle }: {
  task: Task; trackName: Map<number, string>; onOpen: (id: number) => void; asHandle?: boolean;
}) {
  const track = task.track_id != null ? trackName.get(task.track_id) : undefined;
  const card = (
    <div
      className={cn(
        'cursor-grab rounded-lg bg-card p-2.5 text-sm shadow-sm ring-1 ring-foreground/10',
        'transition-shadow hover:shadow-md',
      )}
      onClick={() => onOpen(task.id)}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="line-clamp-2 font-medium">{task.title}</span>
        <Badge
          variant={PRIORITY_VARIANT[task.priority]}
          className="pointer-events-none h-5 shrink-0 rounded-sm px-1.5 text-xs capitalize"
        >
          {task.priority}
        </Badge>
      </div>
      {/* wrap + min-w-0: дети все shrink-0, и без переноса длинный трек вместе с бейджами
          вылезал за карточку на соседнюю колонку — карточка не режет overflow */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pt-2 text-xs text-muted-foreground">
        <span>#{task.id}</span>
        {track && (
          <Badge variant="outline" className="h-5 max-w-[9rem] truncate rounded-sm px-1.5 text-xs">
            {track}
          </Badge>
        )}
        {task.blocked === 1 && (
          <Badge variant="destructive" className="h-5 rounded-sm px-1.5 text-xs">blocked</Badge>
        )}
        {/* Голая дробь ничего не называла: '2/2' одинаково читается как критерии,
            комментарии и что угодно ещё. Иконка + sr-only подпись (title живёт только под
            мышью и не доходит ни до скринридера, ни до тача). Закрытый чеклист красим
            в primary: это состояние «можно в review», ради него счётчик и нужен. Оба
            состояния заданы явно — вариант outline и так несёт text-foreground, условный
            класс поверх него был бы no-op. */}
        {/* claimNext берёт только задачи хотя бы с одним критерием (core/claim.ts): критерии —
            единственное, чем агент не может объявить работу законченной по своему усмотрению.
            Доска об этом молчала: карточка лежит в new, выглядит готовой, счётчик критериев
            при нуле не рисуется вовсе, а тик рапортует spawned 0 без причины — наставил задач,
            ушёл спать, утром ни строчки объяснения. Условие — ready (new & не blocked & не
            archived): ровно то состояние, которое обманывает. У blocked своя пометка, вторая
            рядом была бы шумом. */}
        {task.ready === 1 && task.criteria_total === 0 && (
          <Badge
            variant="outline" title="agents only take tasks that have acceptance criteria"
            className="h-5 gap-1 rounded-sm border-dashed px-1.5 text-xs text-muted-foreground"
          >
            <ListX className="size-3" />
            no criteria
            <span className="sr-only"> — agents will not take this task</span>
          </Badge>
        )}
        {task.criteria_total > 0 && (
          <Badge
            variant="outline" title="acceptance criteria"
            className={cn(
              'h-5 gap-1 rounded-sm px-1.5 text-xs',
              task.criteria_checked === task.criteria_total
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'text-muted-foreground',
            )}
          >
            <ListChecks className="size-3" />
            {task.criteria_checked}/{task.criteria_total}
            <span className="sr-only"> acceptance criteria</span>
          </Badge>
        )}
      </div>
    </div>
  );
  return (
    <KanbanItem value={String(task.id)}>
      {asHandle ? <KanbanItemHandle className="cursor-grab">{card}</KanbanItemHandle> : card}
    </KanbanItem>
  );
}
