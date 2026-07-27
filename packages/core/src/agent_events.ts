import type Database from 'better-sqlite3';
import { CAPS, capText } from './caps.js';
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

// Формы секретов, которые агент вытаскивает наружу обычной работой: `cat .env`, `env`,
// `gh auth token`, чтение ~/.aws/credentials. Всё это уходило в SQLite целиком и навсегда —
// а база копируется в бэкап, export и шаринг. Редакция по формам НЕ гарантия: цель — не
// хранить вечно очевидное, а не «доказать, что секретов нет».
const SECRETS: [RegExp, string][] = [
  [/-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g, '[redacted key]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted]'],                    // openai/anthropic
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted]'],               // github
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],                       // aws access key id
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[redacted]'],             // slack
  [/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, '[redacted jwt]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi, 'Bearer [redacted]'],
  // Только форма ДАМПА окружения: имя с начала строки, `=` без пробелов, значение без
  // пробелов. Не «любое упоминание» — ревью поймало, что широкая версия съедала
  // `API_KEY: string;` и `const GITHUB_TOKEN = cfg.token` в обычном исходнике, который
  // агент правит через Edit. Редакция стоит ДО записи, то есть портила бы файл навсегда:
  // читающий фид не отличил бы правку аннотации типа от правки секрета. Двоеточие ушло
  // целиком (YAML-секрет реже, чем TS-аннотация), длина имени ограничена — с ней regex
  // линеен, а прежний `[A-Z0-9_]*(?:TOKEN|…)` откатывался квадратично.
  [/^(export\s+)?([A-Z][A-Z0-9_]{0,48}(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIALS?))=(\S{8,})$/gm,
    '$1$2=[redacted]'],
];

export function redact(s: string): string {
  let out = s;
  for (const [re, to] of SECRETS) out = out.replace(re, to);
  return out;
}

// Рекурсивный кап листьев, а НЕ отбрасывание полей: форма detail — контракт для фида
// (`input` у Edit несёт old_string/new_string, из которых рендерится дифф). Резать надо
// длину, сохраняя структуру, иначе кап на записи ломает читателя.
function capValue(v: unknown, depth: number): unknown {
  // Сначала кап, ПОТОМ редакция: она гоняет восемь регулярок по строке, а сюда приезжает
  // сырой вывод инструмента — мегабайтный `Read` стоил бы минут CPU в колбэке readline
  // супервизора, то есть остановленного стрима и протухшего lease под живым агентом.
  // Цена — секрет ровно на границе реза уцелеет наполовину; он и так обрезан.
  if (typeof v === 'string') return redact(capText(v, CAPS.agentFieldChars));
  if (depth >= 8) return '… [too deep]'; // маркер, а не null: молчаливая потеря хуже видимой
  if (Array.isArray(v)) {
    const kept = v.slice(0, CAPS.agentDetailItems).map((x) => capValue(x, depth + 1));
    // Хвост режется молча — а лента склеивает text-блоки в один текст, и человек читает
    // оборванный вывод как полный. Маркер в форме блока: fmtOutput берёт всё, у чего есть .text.
    if (v.length > kept.length) kept.push({ type: 'text', text: `… [+${v.length - kept.length} items]` });
    return kept;
  }
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capValue(x, depth + 1)]));
  }
  return v;
}

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

// detail -> строка для колонки. Форма с тысячей коротких полей пролезла бы мимо капа
// листьев, поэтому финальный потолок — на весь JSON, и в БАЙТАХ: у строки .length считает
// UTF-16, а фид этого проекта наполовину кириллица — два байта на символ, то есть кап
// вдвое выше заявленного ровно там, где он нужен.
export function capDetail(detail: object): string {
  const capped = capValue(detail, 0);
  const json = JSON.stringify(capped);
  if (bytes(json) <= CAPS.agentDetailBytes) return json;
  // Не выбрасываем всё: скаляры верхнего уровня — это id вызова и isError, по которым лента
  // спаривает tool_start с tool_finish. Без них законченный вызов крутится «в процессе»
  // вечно, а упавший рендерится успешным. Схлопываем только то, что и раздулось.
  const shrunk = Object.fromEntries(Object.entries(capped as Record<string, unknown>).map(([k, v]) =>
    [k, v !== null && typeof v === 'object' ? { truncated: bytes(JSON.stringify(v)) } : v]));
  const small = JSON.stringify(shrunk);
  return bytes(small) <= CAPS.agentDetailBytes ? small : JSON.stringify({ truncated: bytes(json) });
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
      opts?.detail ? capDetail(opts.detail) : null, now());
    return Number(r.lastInsertRowid);
  })();
}

const PRUNE_MARK = 'agent_events_pruned_at';

// Ротация: подробности фида живут CAPS.agentEventDays после того, как задача стала терминальной.
// Скелет прогона (run_start/run_end/error) остаётся навсегда — он короткий, по нему читается
// история попыток, и из его detail работает runProduced (#10 reset берёт оттуда before_head).
// Вызывается из tick: agent_events рождаются только там, где ходят воркеры.
//
// Срок считается от МОМЕНТА ЗАВЕРШЕНИЯ задачи, а не от возраста строк: первая версия смотрела
// на created_at события, и задача, которую вели три недели назад, а закрыли сегодня, теряла весь
// фид первым же тиком — ровно тогда, когда человек садится его читать.
//
// Батч + водяной знак в meta: DELETE держит write-lock, а рядом пишут фид живые воркеры, у
// которых busy_timeout всего 5 секунд. Ограниченный кусок за раз и не чаще раза в сутки — иначе
// tick каждую минуту перечитывает фиды всех завершённых задач, чтобы удалить ноль строк.
export function pruneAgentEvents(
  db: Database.Database, days = CAPS.agentEventDays, opts: { force?: boolean } = {},
): number {
  const at = now();
  const last = Number((db.prepare(`SELECT value FROM meta WHERE key = ?`).get(PRUNE_MARK) as
    { value: string } | undefined)?.value ?? 0);
  if (!opts.force && at - last < 86_400) return 0;
  const cutoff = at - days * 86_400;
  return db.transaction(() => {
    const n = db.prepare(
      `DELETE FROM agent_events WHERE id IN (
         SELECT ae.id FROM agent_events ae JOIN tasks t ON t.id = ae.task_id
          WHERE ae.kind IN ('text','tool_start','tool_finish')
            AND (t.status = 'done' OR t.archived_at IS NOT NULL)
            AND COALESCE(t.archived_at, t.updated_at) < ?
          LIMIT ?)`,
    ).run(cutoff, CAPS.agentPruneBatch).changes;
    // Водяной знак ставим только когда вычистили всё: упёрлись в батч — значит осталось,
    // и следующий тик должен продолжить, а не спать сутки.
    if (n < CAPS.agentPruneBatch) {
      db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run(PRUNE_MARK, String(at));
    }
    return n;
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
