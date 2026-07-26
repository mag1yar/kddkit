import type { TickRun } from '@kddkit/core';

// Чистая функция: given что child написал в stdout/stderr и с каким кодом вышел, какой
// TickRun из этого получается. Отдельный модуль (не index.ts) ради теста: index.ts вызывает
// program.parse() на верхнем уровне, так что импорт index.ts в тесте убивает процесс через
// process.exit — см. git history / review round 1 для repro.
export function parseTickOutput(out: string, err: string, code: number | null, at: number): TickRun {
  const zero = { at, reclaimed: 0, killed: 0, stuck: 0, spawned: 0, active: 0, reaped: 0 };
  let parsed: unknown;
  try { parsed = JSON.parse(out); } catch { parsed = undefined; }
  // null и массивы — валидный JSON, но не объект настроек: JSON.parse('null') не бросает,
  // так что typeof-проверки одной не хватает — раньше это падало TypeError-ом на r.skipped.
  const obj = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined;

  if (code !== 0) {
    // `kdd tick --json`'s fail() пишет {"error": msg} в STDOUT (см. context.ts), не в stderr —
    // stdout первичен, stderr и код выхода только как запасной вариант.
    const stdoutError = obj && typeof obj.error === 'string' ? obj.error : undefined;
    return { ...zero, error: stdoutError || err.trim() || `kdd tick exited with code ${code}` };
  }
  if (!obj) return { ...zero, error: `unparsable tick output: ${out.slice(0, 200)}` };
  // skipped — не ошибка: лок держит другой tick (например `--watch` из терминала).
  if (obj.skipped) return { ...zero, skipped: true };
  const num = (v: unknown): number => typeof v === 'number' ? v : 0;
  return {
    at, reclaimed: num(obj.reclaimed), killed: num(obj.killed), stuck: num(obj.stuck),
    spawned: num(obj.spawned), active: num(obj.active), reaped: num(obj.reaped),
  };
}
