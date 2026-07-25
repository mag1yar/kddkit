import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { getFeed, type AgentEvent } from '../api';
import { fmtOutput, mergeFeed } from '../lib/feed';

const fmtDate = (ts: number) => new Date(ts * 1000).toLocaleTimeString();

function Row({ e, first, startHead }: { e: AgentEvent; first?: boolean; startHead?: string | null }) {
  const d = e.detail ? (JSON.parse(e.detail) as Record<string, any>) : null;
  // border-t разделяет прогоны; у самого первого сверху ничего нет — линия была бы висячей
  if (e.kind === 'run_start') return <li className={cn('text-xs text-muted-foreground pt-1', !first && 'border-t')}>run started · {fmtDate(e.created_at)}</li>;
  // exit 0 = успех (muted); ненулевой ИЛИ null (спавн-фейл/сигнал) = провал (red)
  if (e.kind === 'run_end') return <li className={cn('text-xs border-t pt-1', d?.exitCode === 0 ? 'text-muted-foreground' : 'text-destructive')}>run ended · exit {d?.exitCode ?? 'killed'}{commitNote(d?.head, startHead)}</li>;
  if (e.kind === 'text') return <li className="text-sm whitespace-pre-wrap break-words">{d?.text}</li>;
  if (e.kind === 'tool_start') return <li className="text-sm font-mono whitespace-pre-wrap break-all">▸ {e.name} <span className="text-muted-foreground">{truncate(JSON.stringify(d?.input))}</span></li>;
  if (e.kind === 'tool_finish') return <li className={cn('text-sm font-mono pl-3 whitespace-pre-wrap break-all', d?.isError && 'text-destructive')}>{truncate(fmtOutput(d?.output))}</li>;
  if (e.kind === 'error') return <li className="text-sm text-destructive break-words">error: {d?.message}</li>;
  return null;
}
const truncate = (s: string, n = 120) => (s && s.length > n ? s.slice(0, n) + '…' : s);

// Воркер пишет HEAD в run_start и в run_end именно ради этого сравнения: без него
// «агент поработал» и «агент поговорил» выглядят в review одинаково, и разбирать колонку
// приходится через git. Оба head'а обязаны быть — прогон, у которого их нет (старая запись,
// упавший спавн), молчит, а не врёт «no commits».
function commitNote(endHead?: string, startHead?: string | null): string {
  if (!endHead || !startHead) return '';
  return endHead === startHead ? ' · no commits' : ` · committed ${endHead.slice(0, 7)}`;
}

// head последнего run_start выше по ленте — для каждой строки. Прогоны идут подряд, поэтому
// одного прохода достаточно.
function startHeads(feed: AgentEvent[]): (string | null)[] {
  let cur: string | null = null;
  return feed.map((e) => {
    if (e.kind === 'run_start' && e.detail) {
      try { cur = (JSON.parse(e.detail) as { head?: string }).head ?? null; } catch { cur = null; }
    }
    return cur;
  });
}

export function AgentFeed({ taskId }: { taskId: number }) {
  const [feed, setFeed] = useState<AgentEvent[]>([]);
  const last = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // follow-tail: держимся низа, ПОКА юзер не проскроллил вверх читать
  useEffect(() => {
    setFeed([]); last.current = 0; stick.current = true;
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
  const heads = startHeads(feed);
  return (
    <div ref={box} onScroll={onScroll} className="mt-2 max-h-96 overflow-y-auto overflow-x-hidden rounded-md border bg-muted/30 p-2">
      <ol className="flex flex-col gap-1">
        {feed.map((e, i) => <Row key={e.id} e={e} first={i === 0} startHead={heads[i]} />)}
      </ol>
    </div>
  );
}
