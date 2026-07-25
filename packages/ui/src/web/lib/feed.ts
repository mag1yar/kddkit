// append-only merge: дедуп по id, порядок сохранён. Чистый, без импортов —
// ui vitest импортирует ТОЛЬКО этот модуль (нет @-alias/jsdom для .tsx-компонента).
export function mergeFeed<T extends { id: number }>(prev: T[], incoming: T[]): T[] {
  if (!incoming.length) return prev;
  const seen = new Set(prev.map((e) => e.id));
  const fresh = incoming.filter((e) => !seen.has(e.id));
  return fresh.length ? [...prev, ...fresh] : prev;
}

// claude's tool_result.content — часто массив text-блоков, не строка; String(output)
// на нём даёт '[object Object]'. Разворачиваем в читаемый текст для Activity tab.
export function fmtOutput(output: unknown): string {
  if (output === null || output === undefined) return '';
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    // Read of image/PDF -> mixed content [{type:'text',...}, {type:'image',...}] — не все блоки
    // текстовые. Берём то, что есть текстом, игнорируя картинки/прочее; JSON только если текста нет.
    const texts = output.filter((b) => typeof b?.text === 'string').map((b) => b.text as string);
    return texts.length ? texts.join('\n') : JSON.stringify(output);
  }
  return JSON.stringify(output);
}

export interface RawEvent {
  id: number; kind: string; name: string | null; detail: string | null; created_at: number;
}

export interface ToolItem {
  id: number; kind: 'tool'; name: string; input: unknown; at: number;
  output: string | null; isError: boolean; done: boolean;
}
export interface TextItem { id: number; kind: 'text'; text: string; at: number }
export interface ErrorItem { id: number; kind: 'error'; message: string; at: number }
export type FeedItem = ToolItem | TextItem | ErrorItem;

export interface Run {
  id: number; startedAt: number | null; head: string | null;
  endedAt: number | null; exitCode: number | null; endHead: string | null;
  // null = сказать нечего (нет одного из head'ов): старая запись или упавший спавн.
  committed: boolean | null;
  ended: boolean; items: FeedItem[];
}

function parse(detail: string | null): Record<string, any> | null {
  if (!detail) return null;
  try { return JSON.parse(detail) as Record<string, any>; } catch { return null; }
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

// Плоская лента событий → прогоны с вызовом и его результатом в одной карточке.
// Вызов и результат — два отдельных события; пара определяется по tool_use_id, а у событий
// старее этого поля — порядком (FIFO), как их и присылает claude.
export function groupRuns(feed: RawEvent[]): Run[] {
  const runs: Run[] = [];
  let cur: Run | null = null;
  let byToolId = new Map<string, ToolItem>();
  let pending: ToolItem[] = [];

  for (const e of feed) {
    const d = parse(e.detail);
    // run_start открывает прогон; события без него (обрезанная лента, дозапись после run_end)
    // получают безымянный прогон, а не подшиваются к чужому.
    if (e.kind === 'run_start' || cur === null || cur.ended) {
      cur = {
        id: e.id, startedAt: null, head: null, endedAt: null,
        exitCode: null, endHead: null, committed: null, ended: false, items: [],
      };
      runs.push(cur);
      byToolId = new Map();
      pending = [];
      if (e.kind === 'run_start') {
        cur.startedAt = e.created_at;
        cur.head = str(d?.head);
        continue;
      }
    }
    if (e.kind === 'text') {
      cur.items.push({ id: e.id, kind: 'text', text: String(d?.text ?? ''), at: e.created_at });
    } else if (e.kind === 'tool_start') {
      const it: ToolItem = {
        id: e.id, kind: 'tool', name: e.name ?? 'tool', input: d?.input ?? null,
        at: e.created_at, output: null, isError: false, done: false,
      };
      cur.items.push(it);
      const id = str(d?.id);
      if (id) byToolId.set(id, it); else pending.push(it);
    } else if (e.kind === 'tool_finish') {
      const id = str(d?.id);
      const target = (id && byToolId.get(id)) || pending.shift() || null;
      if (id) byToolId.delete(id);
      const out = fmtOutput(d?.output);
      if (target) {
        target.output = out; target.isError = !!d?.isError; target.done = true;
      } else {
        // Результат без своего вызова (лента обрезана по since) — показываем как отдельный
        // блок, а не приклеиваем к случайному соседу.
        cur.items.push({
          id: e.id, kind: 'tool', name: 'result', input: null, at: e.created_at,
          output: out, isError: !!d?.isError, done: true,
        });
      }
    } else if (e.kind === 'error') {
      cur.items.push({ id: e.id, kind: 'error', message: String(d?.message ?? ''), at: e.created_at });
    } else if (e.kind === 'run_end') {
      cur.ended = true;
      cur.endedAt = e.created_at;
      cur.exitCode = typeof d?.exitCode === 'number' ? d.exitCode : null;
      cur.endHead = str(d?.head);
      cur.committed = cur.head && cur.endHead ? cur.head !== cur.endHead : null;
    }
  }
  return runs;
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

// Последняя реплика агента одной строкой — единственное, что свёрнутая карточка говорит о
// содержании. Без неё закрытый прогон — это «11 tools, exit 0» и ни слова о том, чем кончилось.
export function lastWord(run: Run): string {
  for (let i = run.items.length - 1; i >= 0; i -= 1) {
    const it = run.items[i];
    if (it.kind === 'text' && it.text.trim()) return oneLine(it.text);
  }
  return '';
}
const base = (p: string): string => p.split('/').filter(Boolean).pop() ?? p;

// Поля по убыванию человечности: description агент пишет сам и он короче команды;
// дальше — то, на чём вызов работает.
const SUMMARY_FIELDS = ['description', 'command', 'file_path', 'path', 'pattern', 'query', 'url'];
const PATH_FIELDS = new Set(['file_path', 'path']);

// Одна строка сути вызова для свёрнутой карточки. Сырой JSON входа с экранированными
// кавычками нечитаем, а description/command/файл — ровно то, что человек ищет глазами.
export function toolSummary(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  for (const f of SUMMARY_FIELDS) {
    const v = o[f];
    if (typeof v === 'string' && v.trim()) return oneLine(PATH_FIELDS.has(f) ? base(v) : v);
  }
  const first = Object.values(o).find((v) => typeof v === 'string' && v.trim());
  return typeof first === 'string' ? oneLine(first) : oneLine(JSON.stringify(o) ?? '');
}

// Развёрнутый вход. Bash-команду и содержимое файла печатаем как есть: в JSON они
// превращаются в одну строку с \n, то есть в нечитаемую кашу.
export function fmtInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  if (typeof o.command === 'string') return o.command;
  if (typeof o.content === 'string') {
    return `${typeof o.file_path === 'string' ? `${o.file_path}\n\n` : ''}${o.content}`;
  }
  return JSON.stringify(o, null, 2);
}
