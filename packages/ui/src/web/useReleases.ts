import { useEffect, useState } from 'react';
import { getReleases, type ReleaseInfo } from './api';

// Один фетч на монтировании — сознательно без поллинга: лимит GitHub без токена
// 60 запросов в час на IP, а useVersion рядом тикает раз в 2 секунды. Свежесть
// обеспечивает часовой кэш на сервере, а не частота запросов отсюда.
export function useReleases(): ReleaseInfo | null {
  const [info, setInfo] = useState<ReleaseInfo | null>(null);
  useEffect(() => {
    let alive = true;
    getReleases()
      .then((r) => { if (alive) setInfo(r); })
      .catch(() => { /* чип просто останется нейтральным */ });
    return () => { alive = false; };
  }, []);
  return info;
}
