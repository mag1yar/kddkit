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

export function checkMove(
  from: Status, to: Status, actor: Actor, reason?: string, openCriteria = 0,
  claimedBy: string | null = null,
): { ok: true } | { ok: false; error: string } {
  if (from === to) return { ok: false, error: `task is already in ${to}` };
  if (actor.type === 'user') return { ok: true };
  if (reason) return { ok: true }; // явный «user попросил» обходит все ai-гейты, включая fence
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
      error: `invalid transition ${from} → ${to} for ai; allowed: ${TRANSITIONS[from].join(', ')}; pass --reason if user requested a skip`,
    };
  }
  if (to === 'review' && openCriteria > 0) {
    return {
      ok: false,
      error: `cannot move to review: ${openCriteria} unchecked acceptance criteria; check them (kdd criteria check) or pass --reason if user asked to skip`,
    };
  }
  return { ok: true };
}
