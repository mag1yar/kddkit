import type { Kind } from '@kddkit/core';

// Тип коммита детерминирован типом задачи. Тело GitHub Release генерится из conventional-
// субъектов, и неконвенциональный субъект МОЛЧА выпадает из changelog — воркер сам об этом
// не догадается, значит ему это говорят.
const COMMIT_TYPE: Record<Kind, string> = {
  feature: 'feat', bug: 'fix', chore: 'chore', research: 'docs',
};

// Середина промпта — единственное, что расходится по типу.
// Формулировка бага сознательно НЕ «сделай падающий тест зелёным»: одна тест-цель покрывает
// одно проявление, и агент отдаёт частичную заплату — то есть симптом вместо причины
// (SWE-Doctor, arXiv 2607.00990). Поэтому цель — причина, а тест лишь её фиксирует.
const BODY: Record<Kind, string> = {
  feature:
    'Read the acceptance criteria first — they are the definition of done — then implement them.',
  bug:
    'Reproduce the failure first, then find its cause. Fix the CAUSE, not the symptom: grep every '
    + 'caller of the function you are about to touch, because a guard in one caller leaves its '
    + 'siblings broken. Add a test that fails on that cause and passes after your fix, and make '
    + 'sure the whole suite is green — a fix that breaks a neighbour is not a fix.',
  chore:
    'Read the acceptance criteria first — they are the definition of done. No behaviour test is '
    + 'expected here; the existing suite must stay green.',
  research:
    'The deliverable is a written decision, not code. Investigate, then propose the outcome in your '
    + 'summary comment — decision, rationale, and alternatives considered — for a human to record with '
    + '`kdd decide`; decisions are human-gated, so do not run that command yourself.',
};

// scope годится в conventional-субъект только простой: пробел или двоеточие в area сломали бы
// разбор, и коммит выпал бы из changelog — ровно то, от чего этот маппинг и страхует.
const scopeOf = (area: string | null): string =>
  area && /^[a-z0-9._-]+$/i.test(area) ? `(${area})` : '';

export function workerPrompt(kind: Kind, area: string | null): string {
  return `You are a kdd agent worker. Read your task: run \`kdd show $KDD_TASK_ID\`. `
    + `Do the work in this repository. ${BODY[kind]} `
    + `Commit your work as \`${COMMIT_TYPE[kind]}${scopeOf(area)}: <subject>\` — the changelog is `
    + `generated from commit subjects, and a non-conventional subject is silently dropped. `
    // комментарий = durable-канал: он в taskDetail (get_task/kdd show), его читают люди и будущие
    // сессии. Activity-фид туда НЕ входит намеренно (не засоряет LLM-контекст). Потому итог — в коммент.
    + `When done, leave ONE concise summary comment `
    + `(\`kdd comment $KDD_TASK_ID "<what you changed and why; caveats or follow-ups>"\`) — this is the `
    + `durable note humans and future sessions read, so keep it tight, not a log. Then check acceptance `
    // Сигнатура полностью, с обоими аргументами: на «kdd criteria check» без них агент тратит
    // ходы на missing required argument и --help, прежде чем добирается до нужной формы.
    + `criteria (\`kdd criteria ls $KDD_TASK_ID\`, then \`kdd criteria check $KDD_TASK_ID <criterionId>\` `
    + `for each one) and \`kdd move $KDD_TASK_ID review\`. `
    + `If you get blocked or must stop early, comment the reason first.`;
}
