import type Database from 'better-sqlite3';
import { now } from './db.js';

export type AgentEventKind = 'run_start' | 'text' | 'tool_start' | 'tool_finish' | 'error' | 'run_end';

export interface AgentEvent {
  id: number; task_id: number; worker_id: string;
  kind: AgentEventKind; name: string | null; detail: string | null; created_at: number;
}

export interface ParsedEvent { kind: AgentEventKind; name?: string; detail?: object }

// Парсит одну NDJSON-строку `claude -p --output-format stream-json`.
// Одно assistant-сообщение может нести несколько content-блоков → 0+ событий.
// Неизвестное/битое → []. НИКОГДА не бросает (битый JSON = []).
// run_end воркер эмитит из exit-кода, не из stream (result → []): убитый воркер всё равно закроет ран.
export function parseClaudeStreamLine(line: string): ParsedEvent[] {
  const s = line.trim();
  if (!s) return [];
  let msg: any;
  try { msg = JSON.parse(s); } catch { return []; }
  if (msg?.type === 'assistant' && Array.isArray(msg.message?.content)) {
    const out: ParsedEvent[] = [];
    for (const b of msg.message.content) {
      if (b?.type === 'text' && typeof b.text === 'string') out.push({ kind: 'text', detail: { text: b.text } });
      // id кладём рядом со входом: результаты параллельных вызовов приезжают пачкой
      // (start, start, finish, finish), и без него лента склеивает вывод не с тем вызовом.
      // undefined выпадает при JSON.stringify — старым событиям поле просто не появится.
      else if (b?.type === 'tool_use') out.push({ kind: 'tool_start', name: b.name, detail: { id: b.id, input: b.input } });
      // thinking и прочее — шум для feed, пропускаем
    }
    return out;
  }
  if (msg?.type === 'user' && Array.isArray(msg.message?.content)) {
    const out: ParsedEvent[] = [];
    for (const b of msg.message.content) {
      if (b?.type === 'tool_result') out.push({
        kind: 'tool_finish', detail: { id: b.tool_use_id, output: b.content, isError: !!b.is_error },
      });
    }
    return out;
  }
  return [];
}

export function appendAgentEvent(
  db: Database.Database, taskId: number, workerId: string,
  kind: AgentEventKind, opts?: { name?: string; detail?: object },
): number {
  return db.transaction(() => {
    const r = db.prepare(
      `INSERT INTO agent_events (task_id, worker_id, kind, name, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(taskId, workerId, kind, opts?.name ?? null,
      opts?.detail ? JSON.stringify(opts.detail) : null, now());
    return Number(r.lastInsertRowid);
  })();
}

export function listAgentEvents(
  db: Database.Database, taskId: number, opts?: { sinceId?: number; limit?: number },
): AgentEvent[] {
  return db.prepare(
    `SELECT * FROM agent_events WHERE task_id = ? AND id > ? ORDER BY id LIMIT ?`,
  ).all(taskId, opts?.sinceId ?? 0, opts?.limit ?? 500) as AgentEvent[];
}

// Тип новейшего agent_event для (task, worker) — или null, если событий нет.
// Проба формы осиротевшего рана: 'run_end' → уже закрыт; иное → висячий; null → не стартовал.
export function lastAgentEventKind(
  db: Database.Database, taskId: number, workerId: string,
): AgentEventKind | null {
  const r = db.prepare(
    `SELECT kind FROM agent_events WHERE task_id = ? AND worker_id = ? ORDER BY id DESC LIMIT 1`,
  ).get(taskId, workerId) as { kind: AgentEventKind } | undefined;
  return r?.kind ?? null;
}

export interface RunResult { before: string; after: string; committed: boolean }

// Результат ПОСЛЕДНЕГО рана задачи: снял ли он коммиты (before_head != after_head).
// null — рана нет, он не завершён, или отсутствует head. Никогда не возвращает СТАРЫЙ ран как результат:
// если поверх последнего run_end есть более свежий run_start (убитый воркер, не дописавший run_end),
// последний ран не завершён → null. Иначе #10 reset откатил бы ветку к устаревшему before, потеряв работу.
// Потребители (#10 reset, #12 chain) берут before для отката ветки.
export function runProduced(db: Database.Database, taskId: number): RunResult | null {
  const end = db.prepare(
    `SELECT id, detail FROM agent_events WHERE task_id = ? AND kind = 'run_end' ORDER BY id DESC LIMIT 1`,
  ).get(taskId) as { id: number; detail: string | null } | undefined;
  if (!end) return null;
  // более свежий run_start, чем последний run_end → последний ран в полёте/убит → не завершён.
  const dangling = db.prepare(
    `SELECT 1 FROM agent_events WHERE task_id = ? AND kind = 'run_start' AND id > ? LIMIT 1`,
  ).get(taskId, end.id);
  if (dangling) return null;
  const start = db.prepare(
    `SELECT detail FROM agent_events WHERE task_id = ? AND kind = 'run_start' AND id < ? ORDER BY id DESC LIMIT 1`,
  ).get(taskId, end.id) as { detail: string | null } | undefined;
  if (!start) return null;
  const before = headOf(start.detail);
  const after = headOf(end.detail);
  if (before === null || after === null) return null;
  return { before, after, committed: before !== after };
}

// detail — JSON или null; вытащить .head как строку. Битый JSON / нет head → null.
function headOf(detail: string | null): string | null {
  if (!detail) return null;
  try {
    const h = (JSON.parse(detail) as { head?: unknown }).head;
    return typeof h === 'string' ? h : null;
  } catch { return null; }
}
