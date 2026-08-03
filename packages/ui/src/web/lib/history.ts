// Аудит-лог задачи → дни / группы одного актора / строки. Чистый, без импортов —
// ui vitest импортирует ТОЛЬКО lib-модули (нет @-alias/jsdom для .tsx-компонента).
export interface RawEvent {
  id: number; actor_type: 'user' | 'ai'; actor_id: string | null;
  action: string; detail: string | null; created_at: number;
  type?: string | null; level?: 'info' | 'warn' | 'error' | null;
}

export interface HistoryRow {
  id: number; action: string; text: string; at: number;
  count: number; // подряд идущие одинаковые строки схлопнуты: 'claim renewed ×7'
  level: 'info' | 'warn' | 'error';
  mechanical: boolean; // lease-бухгалтерия: видна, но глушится — это не изменение задачи
}
export interface HistoryGroup {
  id: number; actorType: 'user' | 'ai'; actorId: string | null; at: number; rows: HistoryRow[];
}
export interface HistoryDay { key: string; at: number; groups: HistoryGroup[] }

function parse(detail: string | null): Record<string, any> | null {
  if (!detail) return null;
  try { return JSON.parse(detail) as Record<string, any>; } catch { return null; }
}

// Строка события человеческим языком. Раньше половина действий (claim*, released,
// reclaimed, archived) падала в default и печаталась сырым именем колонки.
export function fmtEvent(e: RawEvent): string {
  const d = parse(e.detail);
  switch (e.action) {
    case 'created': return 'created task';
    case 'edited': {
      const f = d?.fields;
      return Array.isArray(f) && f.length ? `edited ${f.join(', ')}` : 'edited';
    }
    // self_accepted ставится, когда задачу принял тот же актор, что её сдал (по просьбе человека).
    // Отметка существует, чтобы это было видно там, где смотрят, — то есть на доске.
    case 'moved': return `moved ${d?.from} → ${d?.to}${d?.self_accepted ? ' (accepted its own submission)' : ''}`;
    case 'blocked': return `blocked: ${d?.reason}`;
    case 'unblocked': return 'unblocked';
    case 'linked': return `linked #${d?.to} (${d?.kind})`;
    case 'commented': return 'commented';
    case 'archived': return 'archived';
    case 'unarchived': return 'unarchived';
    case 'criterion_added': return `added criterion: ${d?.text}`;
    case 'criterion_checked': return `checked: ${d?.text}`;
    case 'criterion_unchecked': return `unchecked: ${d?.text}`;
    case 'criterion_removed': return `removed criterion: ${d?.text}`;
    case 'claim': case 'claimed': return 'claimed';
    case 'claim_renewed': return 'claim renewed';
    case 'claim_rejected': return `claim rejected: ${d?.reason ?? '?'}`;
    case 'reclaimed': return `lease expired, reclaimed from ${d?.former ?? '?'}`;
    case 'released': return `released: ${d?.reason ?? '?'}`;
    case 'warn': return String(d?.reason ?? d?.message ?? 'warning');
    default: return e.action;
  }
}

// Ключ локального дня (не UTC: разделитель должен совпадать с датой на часах у человека).
const dayKey = (ts: number): string => {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

export function groupHistory(events: RawEvent[]): HistoryDay[] {
  const days: HistoryDay[] = [];
  let day: HistoryDay | null = null;
  let group: HistoryGroup | null = null;

  for (const e of events) {
    const key = dayKey(e.created_at);
    if (!day || day.key !== key) {
      day = { key, at: e.created_at, groups: [] };
      days.push(day);
      group = null; // новый день — новая группа, даже если актор тот же
    }
    if (!group || group.actorType !== e.actor_type || group.actorId !== e.actor_id) {
      group = { id: e.id, actorType: e.actor_type, actorId: e.actor_id, at: e.created_at, rows: [] };
      day.groups.push(group);
    }
    const text = fmtEvent(e);
    const prev = group.rows[group.rows.length - 1];
    // Повторы схлопываем по тексту, а не по action — два разных критерия с одним action
    // остаются двумя строками. (Heartbeat супервизора истории больше не пишет, но серию
    // одинаковых ручных действий человек всё равно читает как одну строку со счётчиком.)
    if (prev && prev.text === text) { prev.count += 1; continue; }
    group.rows.push({
      id: e.id, action: e.action, text, at: e.created_at, count: 1,
      level: e.level ?? 'info',
      mechanical: e.type === 'claim' && e.level !== 'error',
    });
  }
  return days;
}
