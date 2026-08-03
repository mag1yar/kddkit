export type Status = 'backlog' | 'new' | 'in_progress' | 'review' | 'done';
export const STATUSES: Status[] = ['backlog', 'new', 'in_progress', 'review', 'done'];

export type Priority = 'low' | 'medium' | 'high' | 'urgent';
export const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'urgent'];

// Тип работы. От него расходятся форма готовности, промпт воркера и тип коммита —
// это не ярлык. Словарь закрытый: расширяется миграцией и осознанно.
export type Kind = 'feature' | 'bug' | 'chore' | 'research';
export const KINDS: Kind[] = ['feature', 'bug', 'chore', 'research'];

export type Actor = { type: 'user' | 'ai'; id?: string };

export const TRANSITIONS: Record<Status, Status[]> = {
  backlog: ['new'],
  new: ['backlog', 'in_progress'],
  in_progress: ['new', 'review'],
  review: ['in_progress', 'done'],
  done: ['review'],
};

export const authorOf = (a: Actor): string => (a.type === 'ai' ? `ai:${a.id ?? '?'}` : 'user');

/**
 * Личность агента из окружения. Общая для CLI и MCP: в одной сессии оба пути обязаны писаться
 * одним автором, иначе гейт «сдал — не принимаешь» обходится сменой транспорта, а две разные
 * сессии под общим id ловят ложный запрет.
 * KDD_SESSION — явное слово (его ставят tick/worker), дальше метки самого Claude Code. Без них
 * id нет, актор безымянный (`ai:?`) и неотличим от другого такого же — на этом сравнении держится
 * ещё и fence по lease, поэтому pid сессии берём как последнюю зацепку, а не как первую.
 */
export function agentId(): string | undefined {
  const e = process.env;
  const cc = e.CLAUDE_CODE_SESSION_ID ? `cc:${e.CLAUDE_CODE_SESSION_ID.slice(0, 8)}` : undefined;
  return e.KDD_SESSION || cc || (e.CLAUDE_PID ? `cc:pid-${e.CLAUDE_PID}` : undefined);
}

/**
 * @param submittedBy автор последнего перехода в review (`authorOf`), null — если его не было
 */
export function checkMove(
  from: Status, to: Status, actor: Actor, reason?: string, openCriteria = 0,
  claimedBy: string | null = null, submittedBy: string | null = null,
): { ok: true } | { ok: false; error: string } {
  if (from === to) return { ok: false, error: `task is already in ${to}` };
  if (actor.type === 'user') return { ok: true };
  if (reason) return { ok: true }; // явный «user попросил» обходит все ai-гейты, включая fence
  // Сдал — сам не принимаешь: по умолчанию агент не закрывает работу, которую сдал на проверку.
  // Гейт против молчаливого самозакрытия, не против просьбы — «закрой» словом проходит через
  // --reason, и moveTask помечает такой переход self_accepted, чтобы это было видно на доске.
  // Запрет именно на себя, а не на ai: любой другой актор принимает. Различать акторов стало
  // возможно только с честной атрибуцией (#117).
  if (from === 'review' && to === 'done' && submittedBy === authorOf(actor)) {
    return { ok: false,
      error: `you submitted this task for review yourself; accepting it is someone else's call — ask the user, and pass a reason if they told you to close it` };
  }
  // fence: задачу, занятую ЛЮБЫМ ai-актором (claimed_by 'ai:...'), не может двигать ДРУГОЙ актор.
  // Держит tick-воркеров (ai:tick:...) друг от друга + ai-vs-ai ручные сессии. user-held и unclaimed
  // (null) — НЕ трогаем (doc-режим). Свой токен -> allow. (reclaim-штраф отдельно keyed на ai:tick: в claim.ts.)
  if (from === 'in_progress' && claimedBy?.startsWith('ai:') && claimedBy !== `ai:${actor.id ?? '?'}`) {
    return { ok: false,
      error: `lease lost (held by ${claimedBy}); you no longer own this task — stop work` };
  }
  if (!TRANSITIONS[from].includes(to)) {
    return {
      ok: false,
      error: `invalid transition ${from} → ${to} for ai; allowed: ${TRANSITIONS[from].join(', ')}; pass a reason if the user requested a skip`,
    };
  }
  if (to === 'review' && openCriteria > 0) {
    return {
      ok: false,
      error: `cannot move to review: ${openCriteria} unchecked acceptance criteria; check them (kdd criteria check) or pass a reason if the user asked to skip`,
    };
  }
  return { ok: true };
}
