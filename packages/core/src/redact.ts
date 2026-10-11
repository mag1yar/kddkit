// Формы секретов, которые агент вытаскивает наружу обычной работой: `cat .env`, `env`,
// `gh auth token`, чтение ~/.aws/credentials — и потом пересказывает в комментарии или
// доказательстве критерия. Текст агента редактируется до записи в SQLite, которая
// копируется в бэкап, export и шаринг. Редакция по формам НЕ гарантия: цель — не
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
  // агент цитирует в комментарии. Редакция стоит ДО записи, то есть портила бы текст навсегда:
  // читающий не отличил бы аннотацию типа от секрета. Двоеточие ушло
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
