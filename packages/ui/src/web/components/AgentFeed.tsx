import { useEffect, useRef, useState } from 'react';
import {
  Bot, ChevronRight, FilePen, FilePlus, FileText, FolderSearch, Globe, Search, SquareTerminal, Wrench,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { getFeed, type AgentEvent } from '../api';
import {
  fmtInput, groupRuns, lastWord, mergeFeed, toolSummary,
  type ErrorItem, type FeedItem, type Run, type TextItem, type ToolItem,
} from '../lib/feed';
import { Badge } from './ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { Spinner } from './ui/spinner';

const fmtTime = (ts: number) => new Date(ts * 1000).toLocaleTimeString();

type Icon = typeof Wrench;
// Bash — SquareTerminal, а не Terminal: голый `>_` в полутора сантиметрах от шеврона
// раскрытия читается как второй шеврон. Рамка отличает его с одного взгляда, и весь
// остальной ряд иконок тоже замкнутые фигуры.
const ICONS: Record<string, Icon> = {
  Bash: SquareTerminal, Read: FileText, Write: FilePlus, Edit: FilePen, NotebookEdit: FilePen,
  Glob: FolderSearch, Grep: Search, ToolSearch: Search, WebSearch: Search,
  WebFetch: Globe, Task: Bot, Agent: Bot,
};
const iconFor = (name: string): Icon => ICONS[name] ?? ICONS[name.replace(/^mcp__.*__/, '')] ?? Wrench;

// Пауза между шагами — единственное, что в ленте не видно вовсе: тридцать строк за минуту и
// тридцать за час выглядят одинаково. Печатаем только заметные (≥3 с), иначе это шум на каждой строке.
const gap = (at: number, prev: number | null): string | null => {
  if (prev === null) return null;
  const d = Math.round(at - prev);
  if (d < 3) return null;
  return d < 60 ? `+${d}s` : `+${Math.floor(d / 60)}m`;
};

function ToolRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const I = iconFor(item.name);
  const summary = toolSummary(item.input);
  const input = fmtInput(item.input);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={cn(
          'flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs hover:bg-muted',
          item.isError && 'text-destructive',
        )}
      >
        <ChevronRight className={cn('size-3 shrink-0 text-muted-foreground/60 transition-transform', open && 'rotate-90')} />
        {/* Провал несёт сама строка — иконка и имя красным. Значка ERROR справа не держим:
            он повторяет то же самое вторым способом и тянет глаз через всю ширину. */}
        <I className={cn('size-3 shrink-0', item.isError ? 'text-destructive' : 'text-muted-foreground')} />
        <span className="shrink-0 font-medium">{item.name}</span>
        <span className="truncate font-mono text-muted-foreground">{summary}</span>
        {/* Успех молчит: галка на каждой строке — тот же шум, что и цифры. Видно только
            то, что требует внимания: вызов ещё идёт. */}
        {!item.done && <Spinner className="ml-auto size-3 shrink-0 text-muted-foreground" />}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 mb-1 ml-4 flex flex-col gap-1">
          {input && (
            <pre className="max-h-40 overflow-auto rounded border bg-muted/40 p-1.5 font-mono text-[11px] whitespace-pre-wrap break-all">
              {input}
            </pre>
          )}
          {item.output !== null && (
            // Полный вывод без обрезки: раньше он резался на 120 символах — ровно там, где
            // у ошибки начинается причина. Длину держит скролл, а не потеря текста.
            <pre className={cn(
              'max-h-64 overflow-auto rounded border bg-muted/40 p-1.5 font-mono text-[11px] whitespace-pre-wrap break-all',
              item.isError && 'text-destructive',
            )}>
              {item.output || '(empty)'}
            </pre>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function Item({ item, prevAt }: { item: FeedItem; prevAt: number | null }) {
  const g = gap(item.at, prevAt);
  const mark = g && <span className="ml-1 align-middle font-mono text-[10px] text-muted-foreground/70">{g}</span>;
  if (item.kind === 'text') {
    // Речь агента — первичный слой: то, ради чего вкладку открывают. Инструменты вокруг мельче и глуше.
    return <p className="px-1 text-sm leading-relaxed break-words whitespace-pre-wrap">{(item as TextItem).text}{mark}</p>;
  }
  if (item.kind === 'error') {
    return <p className="px-1 text-sm break-words text-destructive">error: {(item as ErrorItem).message}{mark}</p>;
  }
  return <ToolRow item={item as ToolItem} />;
}

function RunBlock({ run, open, onOpenChange }: {
  run: Run; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const tools = run.items.filter((i) => i.kind === 'tool').length;
  const failed = run.ended && run.exitCode !== 0;
  const tail = lastWord(run);
  return (
    // Карточка на прогон, как у комментария: следующее пробуждение агента заводит свой блок
    // со своим временем, а не дописывает предыдущий.
    // overflow-clip, а не hidden: hidden сделал бы карточку скролл-контейнером, и шапка
    // липла бы к ней самой вместо ленты. clip только обрезает — sticky продолжает смотреть
    // на внешний скролл. Обрезка нужна, чтобы угол рисовала одна дуга, а не две.
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className="flex flex-col overflow-clip rounded-md border bg-background"
    >
      {/* Шапка липнет к верху ленты: прогон длиннее экрана, и без этого, прокрутив его
          середину, не понять, чей это вызов и чем прогон кончился. Свой фон обязателен —
          иначе сквозь неё едут строки. Своей рамки и скруглений у шапки нет: их рисовала
          бы вторая дуга поверх дуги карточки, и угол выходил зазубренным. Форму даёт
          обрезка карточкой, линию снизу — border-b. */}
      <CollapsibleTrigger className={cn(
        'sticky top-0 z-10 flex w-full flex-wrap items-center gap-x-1.5 bg-background px-2 pt-2 pb-1 text-left text-xs',
        open && 'border-b',
        !open && !tail && 'pb-2',
        failed ? 'text-destructive' : 'text-muted-foreground',
      )}>
        <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />
        {!run.ended && <Spinner className="size-3" />}
        <Badge variant="outline">ai</Badge>
        <span className="font-medium">run</span>
        {run.startedAt !== null && <span>{fmtTime(run.startedAt)}</span>}
        <span>· {tools} {tools === 1 ? 'tool' : 'tools'}</span>
        {run.ended
          ? <span>· exit {run.exitCode ?? 'killed'}</span>
          : <span>· running</span>}
        {/* Воркер пишет HEAD в run_start и run_end именно ради этого сравнения: без него
            «агент поработал» и «агент поговорил» в review выглядят одинаково. Прогон без
            обоих head'ов (старая запись, упавший спавн) молчит, а не врёт «no commits». */}
        {run.committed === true && <span>· committed {run.endHead?.slice(0, 7)}</span>}
        {run.committed === false && <span>· no commits</span>}
      </CollapsibleTrigger>
      {!open && tail && (
        <p className="truncate px-2 pb-2 text-xs text-muted-foreground">{tail}</p>
      )}
      <CollapsibleContent>
        <div className="flex flex-col gap-1.5 px-2 pt-1.5 pb-2">
          {run.items.map((it, i) => (
            <Item key={it.id} item={it} prevAt={i === 0 ? null : run.items[i - 1].at} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function AgentFeed({ taskId }: { taskId: number }) {
  const [feed, setFeed] = useState<AgentEvent[]>([]);
  // Только явные решения человека: раз тронул карточку — авто-правило её больше не трогает.
  // Ключ — id прогона (id его run_start), он переживает поллинг.
  const [pinned, setPinned] = useState<Record<number, boolean>>({});
  const last = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // follow-tail: держимся низа, ПОКА юзер не проскроллил вверх читать
  useEffect(() => {
    setFeed([]); setPinned({}); last.current = 0; stick.current = true;
    let alive = true;
    const poll = () => getFeed(taskId, last.current).then((rows) => {
      if (!alive || !rows.length) return;
      last.current = Math.max(last.current, ...rows.map((r) => r.id));
      setFeed((prev) => mergeFeed(prev, rows));
    }).catch(() => {});
    poll();
    // ponytail: poll-forever пока диалог открыт — Tier1-ceiling (localhost single-user);
    // живой стрим/reconnect — Tier2 (#18)
    const t = setInterval(poll, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [taskId]);

  // после дорисовки новых строк тянем вниз, если прилипли (иначе не трогаем чтение выше)
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [feed]);

  // юзер у низа (порог 40px) → снова прилипаем; проскроллил вверх → отлипаем
  const onScroll = () => {
    const el = box.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  if (!feed.length) return <p className="pt-2 text-sm text-muted-foreground">no agent activity</p>;
  const runs = groupRuns(feed);
  // Авто-правило: раскрыт тот, за которым сейчас смотрят — идущий прогон, а если никто не
  // идёт, последний. Старые свёрнуты: три прогона развёрнутыми — это простыня, в которой
  // не найти текущий.
  const autoOpen = (r: Run, i: number): boolean => !r.ended || i === runs.length - 1;
  return (
    // Рамка на самой ленте, а не на карточках: край прогона при прокрутке всё равно уезжает,
    // а видеть границы области нужно всегда. Скролл — во вложенном узле: полоса прокрутки
    // принадлежит скроллящемуся элементу и легла бы поверх скругления, торча за угол;
    // внешняя рамка её обрезает.
    <div className="mt-2 overflow-hidden rounded-md border bg-muted/30">
      {/* Падинги на списке, а не на контейнере: sticky считает верх от края скролла, и
          падинг оставил бы сверху щель, сквозь которую едут строки. */}
      <div ref={box} onScroll={onScroll} className="max-h-[60vh] overflow-y-auto overflow-x-hidden">
        <ol className="flex flex-col gap-2 p-2">
          {runs.map((r, i) => (
            <li key={r.id}>
              <RunBlock
                run={r}
                open={pinned[r.id] ?? autoOpen(r, i)}
                onOpenChange={(o) => setPinned((p) => ({ ...p, [r.id]: o }))}
              />
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
