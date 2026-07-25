import { useEffect, useState } from 'react';
import { getReleases, type ReleaseInfo } from './api';

// Ретраи только до первого ответа — это не поллинг: пришёл ответ (в том числе с error
// внутри) — прекращаем навсегда, свежесть держит часовой кэш на сервере, а не частота
// запросов отсюда. Отклонение промиса значит «сервер не отвечает», а не «GitHub молчит»:
// типичный случай — перезапуск `kdd ui` с открытой доской, после которого чип иначе
// навсегда остаётся `v…`, а кнопка GitHub (она на releases?.repoUrl) не появляется.
// Шаг заведомо крупнее 2с-тика useVersion, чтобы рядом не завёлся второй поллер;
// три попытки перекрывают ~65 секунд — этого хватает на рестарт, и это максимум
// четыре запроса к своему же Hono, а не к GitHub.
const RETRY_MS = [5000, 15000, 45000];

export function useReleases(): ReleaseInfo | null {
  const [info, setInfo] = useState<ReleaseInfo | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (n: number) => {
      getReleases()
        .then((r) => { if (alive) setInfo(r); })
        .catch(() => {
          const delay = RETRY_MS[n];
          if (alive && delay !== undefined) timer = setTimeout(() => attempt(n + 1), delay);
          // попытки кончились — чип просто останется нейтральным
        });
    };
    attempt(0);
    return () => { alive = false; clearTimeout(timer); };
  }, []);
  return info;
}
